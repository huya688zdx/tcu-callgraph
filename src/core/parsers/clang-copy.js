import { children, fnRef, initializer, initializerMembers, pointerExpression, unwrap } from './clang-ast.js';

// 只匹配完整字段和下标。运行时下标可以匹配具体下标，不能越过一层数组或字段。
const parts = slot => slot.match(/\.[^.\[]+|\[[^\]]+\]/g) || [];
function relativeSlot(prefix, slot) {
  if (!prefix) return { rest: slot, covers: true };
  const left = parts(prefix), right = parts(slot);
  if (left.length > right.length) return null;
  let covers = true;
  for (let i = 0; i < left.length; i++) {
    if (left[i] === '[*]' || right[i] === '[*]') {
      if (!left[i].startsWith('[') || !right[i].startsWith('[')) return null;
      covers = false;
    } else if (left[i] !== right[i]) return null;
  }
  return { rest: right.slice(left.length).join(''), covers };
}

export function matchingSlot(a, b) {
  return a === b || ((a.includes('[*]') || b.includes('[*]')) && relativeSlot(a, b)?.rest === '');
}

// 聚合按值复制。某一成员只读取复制发生时的源值，不让后续源写入污染副本。
// 只跟踪本函数中由声明身份确定的对象，间接地址、函数返回值和超出预算的链保持未知。
export function aggregateCopyReader(record, objectKey, resolveFunction, ambientTargets) {
  const unit = record.context, writes = new Map(), copies = new Map(), callSites = new WeakMap();
  let order = 0, hasGoto = false;
  function add(key, slot, value, point, aggregate) {
    value = unwrap(value);
    if (aggregate && value && !['InitListExpr', 'ImplicitValueInitExpr'].includes(value.kind)) {
      if (!copies.has(key)) copies.set(key, new Set());
      copies.get(key).add(slot);
    }
    if (value?.kind === 'CompoundLiteralExpr') value = unwrap(children(value)[0]);
    if (!writes.has(key)) writes.set(key, []);
    const list = writes.get(key);
    if (value?.kind === 'InitListExpr') {
      list.push({ slot, value: null, point }); // 未显式初始化的成员为零。
      for (const { child, suffix } of initializerMembers(value, unit)) {
        add(key, slot + suffix, child, point, unit.valueRecords.has(unwrap(child)));
      }
    } else {
      list.push({ slot, value, point });
    }
  }

  function visit(node, guards, loop) {
    if (!node?.kind) return;
    if (node.kind === 'GotoStmt' || node.kind === 'IndirectGotoStmt') hasGoto = true;
    const branch = ['IfStmt', 'ConditionalOperator'].includes(node.kind);
    const iteration = ['ForStmt', 'WhileStmt', 'DoStmt'].includes(node.kind);
    const optional = iteration || node.kind === 'SwitchStmt';
    const shortCircuit = node.kind === 'BinaryOperator' && ['&&', '||'].includes(node.opcode);
    const nested = node.array_filler ? [...children(node), ...node.array_filler] : children(node);
    nested.forEach((child, i) => {
      const guarded = optional || (i > 0 && (branch || shortCircuit));
      const next = guarded ? new Map(guards).set(node, branch ? i : true) : guards;
      visit(child, next, iteration ? (loop || node) : loop);
    });
    const point = { order: ++order, guards, loop };
    if (node.kind === 'CallExpr') callSites.set(node, point);
    if (node.kind === 'VarDecl' && node.storageClass !== 'extern') {
      add(objectKey(node, unit), '', node.init && initializer(node), point, unit.valueRecords.has(node));
    } else if (node.kind === 'BinaryOperator' && node.opcode === '=') {
      const lhs = pointerExpression(children(node)[0], unit);
      if (lhs?.decl && !lhs.throughPointer) {
        add(objectKey(lhs.decl, unit), lhs.slot, children(node)[1], point, unit.valueRecords.has(node));
      }
    }
  }
  visit(record.body, new Map(), null);

  return (pointer, call) => {
    const key = objectKey(pointer.decl, unit), slot = pointer.slot;
    if (!copies.has(key) || ![...copies.get(key)].some(prefix => relativeSlot(prefix, slot))) return null;
    const at = callSites.get(call);
    if (!at || hasGoto) return []; // 无已知位置或非结构化跳转时不猜测可达定义。
    const targets = new Set();
    let budget = 512;
    function evaluate(value, rest, point, depth) {
      value = unwrap(value);
      if (!value || --budget < 0 || depth > 32) return;
      if (value.kind === 'ConditionalOperator') {
        for (const alt of children(value).slice(1)) evaluate(alt, rest, point, depth + 1);
        return;
      }
      if (value.kind === 'CompoundLiteralExpr') {
        evaluate(children(value)[0], rest, point, depth + 1);
        return;
      }
      if (value.kind === 'InitListExpr') {
        for (const { child, suffix } of initializerMembers(value, unit)) {
          const match = relativeSlot(suffix, rest);
          if (match) evaluate(child, match.rest, point, depth + 1);
        }
        return;
      }
      // C 的链式赋值表达式取内层赋入的值。其写入在外层复制之前已经完成。
      if (value.kind === 'BinaryOperator' && value.opcode === '=') value = children(value)[0];
      const direct = fnRef(value);
      if (direct && !rest) targets.add(resolveFunction(direct.referencedDecl, unit));
      else {
        const source = pointerExpression(value, unit);
        if (source && !source.throughPointer) read(objectKey(source.decl, unit), source.slot + rest, point, depth + 1);
      }
    }
    function read(source, path, at, depth) {
      const history = writes.get(source) || [];
      for (let i = history.length - 1; i >= 0; i--) {
        const { slot, value, point } = history[i];
        // 循环中较晚的赋值可能来自上一轮。它不是本次读取的必经写入。
        const previousIteration = point.order >= at.order;
        if (previousIteration && (!at.loop || at.loop !== point.loop)) continue;
        const match = relativeSlot(slot, path);
        if (!match) continue;
        let definite = match.covers && !previousIteration, excluded = false;
        for (const [guard, arm] of point.guards) {
          if (guard.kind === 'SwitchStmt' && at.guards.has(guard)) return; // case 之间可能跳转或贯穿。
          if (!at.guards.has(guard)) definite = false;
          else if (!previousIteration && at.guards.get(guard) !== arm) excluded = true;
        }
        if (excluded) continue;
        evaluate(value, match.rest, point, depth);
        if (definite || budget < 0) return;
      }
      for (const target of ambientTargets(source, path)) targets.add(target);
    }
    read(key, slot, at, 0);
    return [...targets];
  };
}
