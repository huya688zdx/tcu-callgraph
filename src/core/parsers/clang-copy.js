import { children, fnRef, initializer, initializerMembers, pointerExpression, transferredValues, typeOf, unwrap } from './clang-ast.js';

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

// 将 p[i].field 对齐到 &rows[j] 的 rows[j+i].field；(*p)[i] 的下标属于对象本身。
function argumentSlot(base, write) {
  if (write.pointerIndex == null) return base + write.slot;
  const index = String(write.pointerIndex), suffix = write.slot.slice(write.slot.indexOf(']') + 1);
  if (index === '0') return base + suffix;
  const last = /\[(-?\d+|\*)\]$/.exec(base);
  if (!last) return index === '*' ? base + suffix : null;
  const offset = index === '*' || last[1] === '*' ? '*' : BigInt(last[1]) + BigInt(index);
  return base.slice(0, last.index) + '[' + offset + ']' + suffix;
}

// 以声明身份和调用点读取聚合成员。复制读取当时的源值；传址写入只作为可能值。
export function aggregateCopyReader(record, objectKey, resolveFunction, ambientTargets, { parameterWrites, fieldWrites }) {
  const unit = record.context, writes = new Map(), copies = new Map(), escapes = new Map(), callSites = new WeakMap();
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

  function noteEscape(expr, point, callee, index) {
    const readOnly = /\bconst\b[^*]*\*\s*$/.test(typeOf(expr));
    const addr = unwrap(expr);
    if (addr?.kind === 'ConditionalOperator') {
      for (const alt of children(addr).slice(1)) noteEscape(alt, point, callee, index);
      return;
    }
    // 数组作为实参退化为首元素地址；&array 则仍指向整个数组。
    const decay = /\]$/.test(typeOf(addr)) && typeOf(expr).includes('*');
    if (!decay && !(addr?.kind === 'UnaryOperator' && addr.opcode === '&')) return;
    const obj = pointerExpression(decay ? addr : children(addr)[0], unit);
    if (obj?.decl?.kind !== 'VarDecl' || obj.throughPointer) return;
    const key = objectKey(obj.decl, unit);
    for (const effect of callee ? parameterWrites(callee, index) : [null]) {
      if (!effect && readOnly) continue;
      const slot = effect ? argumentSlot(obj.slot + (decay ? '[0]' : ''), effect) : obj.slot;
      if (slot == null) continue;
      const entry = { slot, point, targets: effect?.targets };
      if (!escapes.has(key)) escapes.set(key, []);
      escapes.get(key).push(entry);
      if (effect) {
        if (!writes.has(key)) writes.set(key, []);
        writes.get(key).push(entry);
      }
    }
  }

  function visit(node, guards, loop) {
    if (!node?.kind || (node.kind === 'UnaryExprOrTypeTraitExpr' && !node.argType)) return;
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
    const callee = node.kind === 'CallExpr' && children(node)[0];
    if (callee) callSites.set(node, point);
    transferredValues(node).forEach((arg, index) => noteEscape(arg, point, callee, index));
    if (node.kind === 'VarDecl' && node.storageClass !== 'extern') {
      const init = node.init && initializer(node);
      add(objectKey(node, unit), '', init, point, unit.valueRecords.has(node));
    } else if (node.kind === 'BinaryOperator' && node.opcode === '=') {
      const lhs = pointerExpression(children(node)[0], unit);
      if (lhs?.decl && !lhs.throughPointer) {
        add(objectKey(lhs.decl, unit), lhs.slot, children(node)[1], point, unit.valueRecords.has(node));
      }
    }
  }
  visit(record.body, new Map(), null);

  function reaches(point, at) {
    if (!at) return false;
    if (point.order >= at.order) return at.loop && at.loop === point.loop;
    for (const [guard, arm] of point.guards) {
      if (at.guards.has(guard) && at.guards.get(guard) !== arm) return false;
    }
    return true;
  }

  return (pointer, call) => {
    const key = objectKey(pointer.decl, unit), slot = pointer.slot;
    const at = callSites.get(call);
    const copied = [...(copies.get(key) || [])].some(prefix => relativeSlot(prefix, slot));
    const escaped = escapes.get(key)?.some(w => relativeSlot(w.slot, slot) &&
      (hasGoto || reaches(w.point, at)));
    if (!copied && !escaped) return null;
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
      // 未知函数或已保存的别名可能在以后再次写入。只加入有间接写入证据的同一声明字段。
      if (escapes.get(source)?.some(w => !w.targets && reaches(w.point, at) && relativeSlot(w.slot, path))) {
        for (const id of fieldWrites(pointer.fieldId, pointer.slot)) targets.add(id);
      }
      const history = writes.get(source) || [];
      for (let i = history.length - 1; i >= 0; i--) {
        const { slot, value, point, targets: written } = history[i];
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
        if (written) {
          for (const id of written) targets.add(id); // 被调者的可能写入不会抹去传址前的值。
        } else {
          evaluate(value, match.rest, point, depth);
          if (definite || budget < 0) return;
        }
      }
      for (const target of ambientTargets(source, path)) targets.add(target);
    }
    read(key, slot, at, 0);
    return [...targets];
  };
}
