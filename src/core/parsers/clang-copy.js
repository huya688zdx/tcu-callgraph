import { children, constIndexValue, evaluatedChildren, fnRef, initializer, initializerMembers, pointerExpression, transferredValues, typeOf, unwrap, walkEvaluated } from './clang-ast.js';

// 只匹配完整字段和下标。运行时下标可以匹配具体下标，不能越过一层数组或字段。
const parts = slot => slot.match(/\.[^.\[]+|\[[^\]]+\]/g) || [];
export function relativeSlot(prefix, slot) {
  if (!prefix) return { rest: slot, covers: true };
  const left = parts(prefix), right = parts(slot);
  let covers = true;
  for (let i = 0; i < left.length; i++) {
    if (right[i] === '.?') return { rest: '.?', covers: false };
    if (left[i] !== right[i] && left[i].startsWith('.|') && right[i]?.startsWith('.|')) {
      const a = left[i].split(':')[1].split(','), b = right[i].split(':')[1].split(',');
      let common = 0;
      while (a[common] && a[common] === b[common]) common++;
      const shared = part => part?.startsWith('.f') && Number(part.slice(2)) < common;
      if (shared(left[i + 1]) || shared(right[i + 1])) continue;
      // 布局不足以比较这两个分支。仅在同一联合体子对象内收集函数，不据此作必经覆盖。
      return { rest: '.?', covers: false };
    }
    if (left[i] === '[*]' || right[i] === '[*]') {
      if (!left[i].startsWith('[') || !right[i]?.startsWith('[')) return null;
      covers = false;
    } else if (left[i] !== right[i]) return null;
  }
  return { rest: right.slice(left.length).join(''), covers };
}

// 整记录写入还可能覆盖后代成员；标量写入只能覆盖自身或不确定的联合体重叠槽。
export function writeProjection(write, prefix, slot) {
  const match = relativeSlot(prefix, slot);
  return match && (write.aggregate || !match.rest || match.rest === '.?') ? match : null;
}

// 返回完整槽位的匹配程度，供未确认布局的候选做额外的类型检查。
export function matchingSlot(a, b) {
  if (a === b) return 'slot';
  if (!a.includes('[*]') && !b.includes('[*]') && !a.includes('.|') && !b.endsWith('.?')) return null;
  const match = relativeSlot(a, b);
  if (match?.rest === '') return 'slot';
  return match?.rest === '.?' ? 'overlap' : null;
}

// 将 p[i].field 对齐到 &rows[j] 的 rows[j+i].field；(*p)[i] 的下标属于对象本身。
function offsetSlot(base, index) {
  if (index === 0) return base;
  const last = /\[(-?\d+|\*)\]$/.exec(base);
  if (!last) return index == null ? base : null;
  const offset = index == null || last[1] === '*' ? '*' : BigInt(last[1]) + BigInt(index);
  return base.slice(0, last.index) + '[' + offset + ']';
}

function argumentSlot(base, write) {
  if (write.pointerIndex == null) return base + write.slot;
  const slot = offsetSlot(base, write.pointerIndex === '*' ? null : write.pointerIndex);
  return slot == null ? null : slot + write.slot.slice(write.slot.indexOf(']') + 1);
}

// 全局存储键是编译单元解析后的 ID；块内 static 以声明节点区分同名实例。
export const hasStaticStorage = key => typeof key === 'string' || (key?.kind === 'VarDecl' && key.storageClass === 'static');

// 将形参来源投影回一个已知调用点。指向对象的来源只接受可以确认的实参地址。
export function argumentSource(callee, call, parameter) {
  const formals = children(callee?.node).filter(n => n.kind === 'ParmVarDecl');
  const index = formals.indexOf(parameter.decl);
  const arg = unwrap(call && index >= 0 && children(call)[index + 1]);
  if (!parameter.pointee) return arg;
  return arg?.kind === 'UnaryOperator' && arg.opcode === '&' ? children(arg)[0] : null;
}

const isCase = node => node?.kind === 'CaseStmt' || node?.kind === 'DefaultStmt';
// 内层 switch 的标签只从该 switch 进入，外层 case 则可能跳进将被略过的语句。
function hasCaseEntry(node) {
  return isCase(node) || (node.kind !== 'SwitchStmt' && evaluatedChildren(node).some(hasCaseEntry));
}

// 以声明身份和调用点读取聚合成员。复制读取当时的源值，传址写入按覆盖范围合并。
export function callbackSlotReader(record, objectKey, resolveFunction, { ambient, parameterWrites, fieldWrites, writeValue, callWrites, writesByNode, initiallyEscaped }) {
  const unit = record.context, writes = new Map(), tracked = new Map(), escapes = new Map(), points = new WeakMap();
  const designators = new WeakMap(), addressed = new Map();
  function noteAddressWrite(key, slot, write) {
    if (!hasStaticStorage(key)) return;
    if (!addressed.has(key)) addressed.set(key, []);
    addressed.get(key).push({ slot, write });
  }
  const indirectActions = [], events = [], held = new Map(), rebound = new Map();
  let addressCache = new WeakMap();
  // 同一块中无条件向前跳转时可以直接跳过中间语句。其他跳转不能依赖源码中的先后顺序。
  const forwardJumps = new Map();
  let unstructuredJump = false;
  // 精确绑定以声明和完整槽位为界。可能改写或传址的槽仍能提供候选，不能作为必经覆盖。
  function mayRebind(expr) {
    const p = pointerExpression(expr, unit);
    if (!p?.decl || p.throughPointer) return;
    const key = objectKey(p.decl, unit);
    if (!rebound.has(key)) rebound.set(key, new Set());
    rebound.get(key).add(p.slot);
  }
  for (const n of walkEvaluated(record.body)) {
    if (n.kind === 'CompoundStmt' && children(n).some(s => s.kind === 'GotoStmt') && !hasCaseEntry(n)) {
      const statements = children(n), labels = new Map();
      for (let i = statements.length - 1; i >= 0; i--) {
        const s = statements[i];
        if (s.kind === 'LabelStmt' && s.declId) labels.set(s.declId, i);
        if (s.kind === 'GotoStmt' && labels.has(s.targetLabelDeclId)) forwardJumps.set(s, labels.get(s.targetLabelDeclId));
      }
    }
    if (n.kind === 'IndirectGotoStmt' || (n.kind === 'GotoStmt' && !forwardJumps.has(n))) unstructuredJump = true;
    if (n.kind === 'CompoundAssignOperator' || (n.kind === 'UnaryOperator' && ['&', '++', '--'].includes(n.opcode))) {
      mayRebind(children(n)[0]);
    }
    for (const value of transferredValues(n)) {
      const raw = unwrap(value);
      if (typeOf(raw).endsWith(']') && typeOf(raw) !== typeOf(value)) mayRebind(raw);
    }
  }
  // 沿用回调值的写入顺序和分支规则。复制载体时，地址来自复制当时的源槽。
  function contents(key, path, at, trace = { active: new Set(), cycles: 0 }) {
    if (!at) return [];
    const entries = [], shadowed = [], possible = [];
    for (const store of writesAt(held.get(key) || [], at)) {
      if (!reaches(store.point, at)) continue;
      if (trace.active.has(store)) { trace.cycles++; continue; }
      const whole = relativeSlot(store.path, path);
      if (!whole && !relativeSlot(path, store.path)) continue;
      const mandatory = !store.weak && !unstructuredJump && store.point.order < at.order && !unordered(store.point, at) &&
        [...store.point.guards].every(([g, a]) => sameArm(g, a, store.point, at) === true);
      trace.active.add(store);
      for (const item of carried(store.value, store.point, trace)) {
        const full = store.path + item.path, match = relativeSlot(path, full);
        if (!match || shadowed.some(p => relativeSlot(p, full)?.covers)) continue;
        const mutable = [...(rebound.get(key) || [])].some(p => relativeSlot(p, full));
        entries.push({ ...item, path: match.rest, unknown: item.unknown || mutable,
          weak: item.weak || !match.covers || !mandatory || mutable || possible.some(p => relativeSlot(p, full)) });
      }
      trace.active.delete(store);
      if (mandatory && whole?.covers) break;
      (mandatory ? shadowed : possible).push(store.path);
    }
    return entries;
  }
  function objectSlots(pointer, at, trace) {
    if (!pointer?.decl) return [];
    if (!pointer.throughPointer) return [{ ...pointer, key: objectKey(pointer.decl, unit) }];
    const { operand, prefix, index } = pointer.indirection;
    const tail = { slot: pointer.slot.slice(prefix.length), pointerIndex: index };
    const result = [];
    for (const addr of carried(operand, at, trace)) {
      if (addr.path) continue;
      const slot = argumentSlot(addr.slot, tail);
      if (slot != null) result.push({ ...pointer, key: addr.key, slot, bounds: undefined, weak: addr.weak, unknown: addr.unknown });
    }
    return result;
  }
  function canCarry(value) {
    const raw = unwrap(value);
    return typeOf(value).includes('*') || typeOf(raw).endsWith(']') || unit.valueRecords.has(raw);
  }
  function remember(key, path, value, point, weak = false) {
    if (!canCarry(value)) return;
    if (!held.has(key)) held.set(key, []);
    const list = held.get(key), store = { path, value, point, weak };
    if (!list.length || list.at(-1).point.order <= point.order) list.push(store);
    else list.splice(list.findIndex(w => w.point.order > point.order), 0, store);
  }
  let order = 0;
  function add(key, slot, value, point, assignment = false, weak = false) {
    value = unwrap(value);
    // 字面函数初始化可以沿用不可变表的精确槽位。其他来源和后续赋值要按读取位置求值。
    if (assignment || (!fnRef(value) && value?.kind !== 'InitListExpr')) {
      if (!tracked.has(key)) tracked.set(key, new Set());
      tracked.get(key).add(slot);
    }
    if (value?.kind === 'CompoundLiteralExpr') value = unwrap(children(value)[0]);
    if (!writes.has(key)) writes.set(key, []);
    const list = writes.get(key);
    if (value?.kind === 'InitListExpr') {
      list.push({ slot, value: null, point, weak }); // 未显式初始化的成员为零。
      for (const { child, suffix } of initializerMembers(value, unit)) {
        add(key, slot + suffix, child, point, false, weak);
      }
    } else {
      list.push({ slot, value, point, weak });
    }
  }

  // 只传播表达式结果携带的地址。函数调用的实参、逗号左侧和未求值分支不是结果。
  function carried(expr, at, trace = { active: new Set(), cycles: 0 }) {
    if (!at || !canCarry(expr)) return [];
    const cached = addressCache.get(expr);
    if (cached?.has(at)) return cached.get(at);
    const cycles = trace.cycles, found = addressValues(expr, at, trace);
    // 条件分支和复制可反复指向同一槽，按存储身份合并，避免路径数量随复制链倍增。
    const keys = new Map();
    const result = found.length < 2 ? found : found.filter(item => {
      if (!keys.has(item.key)) keys.set(item.key, new Set());
      const values = keys.get(item.key);
      const id = JSON.stringify([item.path,item.slot,item.region,!!item.weak,!!item.unknown,!!item.readOnly]);
      if (values.has(id)) return false;
      values.add(id);
      return true;
    });
    if (trace.cycles === cycles) {
      if (!cached) addressCache.set(expr, new WeakMap());
      addressCache.get(expr).set(at, result);
    }
    return result;
  }
  function addressValues(expr, at, trace) {
    const addr = unwrap(expr);
    if (addr.kind === 'CompoundLiteralExpr') return carried(children(addr)[0], at, trace);
    if (addr.kind === 'InitListExpr') return initializerMembers(addr, unit).flatMap(({ child, suffix }) =>
      carried(child, at, trace).map(item => ({ ...item, path: suffix + item.path })));
    if (addr.kind === 'ConditionalOperator') return children(addr).slice(1).flatMap(alt =>
      carried(alt, at, trace).map(item => ({ ...item, weak: true })));
    if (addr.kind === 'BinaryOperator' && [',','='].includes(addr.opcode)) return carried(children(addr)[1], at, trace);
    if (addr.kind === 'BinaryOperator' && ['+', '-'].includes(addr.opcode) && typeOf(addr).includes('*')) {
      const [left, right] = children(addr);
      const leftPointer = typeOf(left).includes('*');
      const n = constIndexValue(leftPointer ? right : left, unit);
      return carried(leftPointer ? left : right, at, trace).flatMap(base => {
        const slot = offsetSlot(base.slot, n == null ? null : addr.opcode === '-' ? -n : n);
        return slot == null ? [] : [{ ...base, slot }];
      });
    }
    const decay = typeOf(addr).endsWith(']') && typeOf(expr) !== typeOf(addr) && typeOf(expr).includes('*');
    const takes = addr.kind === 'UnaryOperator' && addr.opcode === '&';
    const result = [];
    for (const obj of objectSlots(pointerExpression(takes ? children(addr)[0] : addr, unit), at, trace)) {
      if (takes || decay) {
        if (!['VarDecl','ParmVarDecl','CompoundLiteralExpr'].includes(obj.decl.kind)) continue;
        result.push({ key: obj.key, path: '', slot: obj.slot + (decay ? '[0]' : ''), region: obj.slot,
          readOnly: /\bconst\b[^*]*\*\s*$/.test(typeOf(addr)), weak: obj.weak, unknown: obj.unknown });
      } else {
        for (const item of contents(obj.key, obj.slot, at, trace)) {
          result.push({ ...item, weak: item.weak || obj.weak, unknown: item.unknown || obj.unknown });
        }
      }
    }
    return result;
  }

  function noteEscape(expr, point, call, index) {
    const values = carried(expr, point);
    if (!values.length) return;
    const readOnly = /\bconst\b[^*]*\*\s*$/.test(typeOf(expr));
    const effects = call ? parameterWrites(children(call)[0], index) : [null];
    for (const item of values) {
      transfer(item, item.readOnly || (!item.path && readOnly));
      // 即使形参指向 const 结构体，结构体中保存的指针仍可改写其指向的对象。
      if (!item.path) for (const child of contents(item.key, item.slot, point)) transfer(child, child.readOnly);
    }
    function transfer(base, onlyRead) {
      for (const effect of effects) {
        if (!effect && onlyRead) continue;
        const prefix = effect?.indirection?.prefix || '';
        if (effect && !matchingSlot(prefix, base.path)) continue;
        const tail = effect && { slot: effect.slot.slice(prefix.length), pointerIndex: effect.indirection?.index };
        const slot = effect ? argumentSlot(base.slot, tail) : base.region;
        if (slot == null) continue;
        const definite = effect?.replacesPointee && !base.weak && !base.path && unwrap(expr)?.opcode === '&';
        // 跨调用读取时用传址调用的实际参数绑定形参。
        noteAddressWrite(base.key, slot, effect && { record, node: call, effect, aggregate: effect.aggregate });
        const entry = { slot, point, effect, call, definite, viaMember: !!base.path };
        if (!escapes.has(base.key)) escapes.set(base.key, []);
        escapes.get(base.key).push(entry);
        if (effect) {
          if (!writes.has(base.key)) writes.set(base.key, []);
          writes.get(base.key).push(entry);
        }
      }
    }
  }

  const irregularSwitches = new Set();
  function endsCase(n) {
    while (n?.kind === 'CompoundStmt') n = children(n).at(-1);
    return ['BreakStmt','ReturnStmt','ContinueStmt'].includes(n?.kind);
  }
  function visitSwitch(node, guards, loop) {
    const parts = children(node), body = parts.at(-1);
    for (const expr of parts.slice(0, -1)) visit(expr, guards, loop);
    let section = 0, arm = null;
    for (let statement of body?.kind === 'CompoundStmt' ? children(body) : [body]) {
      if (isCase(statement)) {
        arm = { section };
        while (isCase(statement)) statement = children(statement).at(-1);
      }
      visit(statement, new Map(guards).set(node, arm), loop);
      if (endsCase(statement)) section++;
    }
  }
  // true 为同一必经分支，false 为互斥，null 为可能（包括 case 贯穿或难以判定的标签）。
  function sameArm(guard, arm, point, at) {
    if (!at.guards.has(guard)) return null;
    const other = at.guards.get(guard);
    if (guard.kind === 'SwitchStmt') {
      if (!arm || !other || irregularSwitches.has(guard)) return null;
      if (arm !== other && arm.section === other.section) return null;
    }
    if (arm === other) return true;
    return point.loop && point.loop.outer === at.loop?.outer ? null : false;
  }
  function visitLoop(node, guards, parent) {
    const parts = children(node), isFor = node.kind === 'ForStmt';
    if (isFor) visit(parts[0], guards, parent); // 初始化只在进入循环时执行一次。
    const loop = { parent, outer: parent?.outer || node, start: order };
    const bodyGuards = new Map(guards).set(node, true);
    if (isFor) {
      // Clang 将步进放在循环体之前，并为省略的子句保留空位。
      const [, conditionVar, condition, step, body] = parts;
      visit(conditionVar, guards, loop);
      visit(condition, guards, loop);
      visit(body, bodyGuards, loop);
      visit(step, loop.continued ? new Map(guards).set(node, 'step') : bodyGuards, loop);
    } else {
      for (const child of parts) visit(child, bodyGuards, loop);
    }
    loop.end = order;
  }
  // 函数指示符与实参之间未规定求值顺序；函数体的调用点则在全部操作数之后。
  let operand = null;
  function unordered(point, at) {
    const a = point.operand, b = at.operand;
    if (!a || !b || a === b || a.root !== b.root) return false;
    for (let x = a; x; x = x.parent) {
      for (let y = b; y; y = y.parent) {
        if (x === y) return false;
        if (x.call === y.call) return true;
      }
    }
    return false;
  }
  function visit(node, guards, loop) {
    if (!node?.kind) return;
    if (node.kind === 'SwitchStmt') return visitSwitch(node, guards, loop);
    if (['ForStmt', 'WhileStmt', 'DoStmt'].includes(node.kind)) return visitLoop(node, guards, loop);
    if (loop && node.kind === 'ContinueStmt') loop.continued = true;
    if (!unstructuredJump && forwardJumps.size && node.kind === 'CompoundStmt') {
      const statements = children(node);
      for (let i = 0; i < statements.length; i++) {
        i = forwardJumps.get(statements[i]) ?? i;
        visit(statements[i], guards, loop);
      }
      return;
    }
    if (isCase(node)) {
      // 嵌入其他控制流的标签允许直接跳入块内；不要把该处的条件当成必经写入。
      const parent = [...guards.keys()].findLast(g => g.kind === 'SwitchStmt');
      if (parent) irregularSwitches.add(parent);
    }
    const branch = ['IfStmt', 'ConditionalOperator'].includes(node.kind);
    const shortCircuit = node.kind === 'BinaryOperator' && ['&&', '||'].includes(node.opcode);
    const items = evaluatedChildren(node);
    const nested = node.array_filler ? [...items, ...node.array_filler] : items;
    const call = node.kind === 'CallExpr' && node;
    const siblings = call && nested.length > 1;
    const parent = operand;
    nested.forEach((child, i) => {
      if (siblings) operand = { call, parent, root: parent?.root || call };
      const guarded = i > 0 && (branch || shortCircuit);
      const next = guarded ? new Map(guards).set(node, branch ? i : true) : guards;
      visit(child, next, loop);
      if (siblings && i === 0 && !fnRef(child)) designators.set(call, { order: ++order, guards, loop, operand });
      operand = parent;
    });
    const point = { order: ++order, guards, loop, operand };
    if (call) {
      point.call = call;
      indirectActions.push(point);
    }
    if (call || (node.kind === 'BinaryOperator' && node.opcode === '=')) points.set(node, point);
    if ((node.kind === 'VarDecl' && node.storageClass !== 'extern') || node.kind === 'CompoundLiteralExpr') {
      point.declaration = node;
      const value = node.kind === 'CompoundLiteralExpr' ? children(node)[0] : node.init && initializer(node);
      const key = objectKey(node, unit);
      remember(key, '', value, point);
      events.push({ key, value, point });
    } else if (node.kind === 'BinaryOperator' && node.opcode === '=') {
      const [target, value] = children(node), lhs = pointerExpression(target, unit);
      if (lhs && !lhs.throughPointer) remember(objectKey(lhs.decl, unit), lhs.slot, value, point);
      events.push({ node, lhs, value, point });
    } else if (call || node.kind === 'ReturnStmt') events.push({ node, call, point });
  }
  visit(record.body, new Map(), null);
  // 先取得完整程序点，再按真实写入顺序投影。循环回边和同一调用的兄弟实参可读到源码靠后的地址。
  for (const { lhs, value, point } of events) if (lhs?.throughPointer && canCarry(value)) {
    const destinations = objectSlots(lhs, point);
    for (const dest of destinations) remember(dest.key, dest.slot, value, point, dest.weak || destinations.length > 1);
    if (destinations.length) addressCache = new WeakMap();
  }
  for (const { node, key, lhs, value, point, call } of events) {
    if (point.declaration) {
      add(key, '', value, point);
      if (hasStaticStorage(key)) noteEscape(value, point);
    } else if (node.kind === 'BinaryOperator') {
      const destinations = objectSlots(lhs, point);
      for (const dest of destinations) {
        add(dest.key, dest.slot, value, point, true, dest.weak || destinations.length > 1);
        if (lhs.throughPointer && writesByNode.has(node)) noteAddressWrite(dest.key, dest.slot, writesByNode.get(node));
      }
      if (lhs?.throughPointer && (!destinations.length || destinations.some(d => d.unknown))) indirectActions.push(point);
      if (!destinations.length || destinations.some(d => d.unknown || hasStaticStorage(d.key))) noteEscape(value, point);
    } else transferredValues(node).forEach((arg, index) => noteEscape(arg, point, call, index));
  }

  function reaches(point, at) {
    if (!at) return false;
    if (unstructuredJump) return true;
    if (point.order >= at.order && !unordered(point, at)) return at.loop && at.loop.outer === point.loop?.outer;
    for (const [guard, arm] of point.guards) {
      if (sameArm(guard, arm, point, at) === false) return false;
    }
    return true;
  }

  // 从读取点倒推：本轮已执行的写入优先，然后是上一轮可能的尾部，再向外层追溯。
  function* writesAt(history, at) {
    if (unstructuredJump) { yield* history; return; }
    let before = history.length - 1;
    while (before >= 0 && history[before].point.order >= at.order) before--;
    let after = before + 1;
    // 同一调用中源码靠后的兄弟实参也可能先执行。不要越过调用本身。
    const end = at.operand ? points.get(at.operand.root).order : -1;
    for (let i = after; i < history.length && history[i].point.order < end; i++) {
      if (unordered(history[i].point, at)) yield history[i];
    }
    for (let loop = at.loop; loop; loop = loop.parent) {
      while (before >= 0 && history[before].point.order > loop.start) yield history[before--];
      const start = after;
      while (after < history.length && history[after].point.order <= loop.end) after++;
      for (let i = after - 1; i >= start; i--) if (!unordered(history[i].point, at)) yield history[i];
    }
    while (before >= 0) yield history[before--];
  }

  // 将有界的动态下标逐槽读取。一个槽的覆盖或清空不会复活该槽的旧值。
  function paths(pointer) {
    let slots = [pointer.slot];
    for (const n of pointer.bounds || []) {
      if (!Number.isSafeInteger(n) || n < 1 || n * slots.length > 512) return [pointer.slot];
      slots = slots.flatMap(slot => Array.from({ length: n }, (_, i) => slot.replace('[*]', '[' + i + ']')));
    }
    return slots;
  }

  function resolve(sources, value, at, valueSlot = '', effect = null) {
    const targets = new Set(), parameters = [];
    let budget = 512, unknown = false, uncertainLayout = false;
    function merge(result) {
      for (const id of result.targets) targets.add(id);
      unknown ||= result.unknown;
      uncertainLayout ||= result.uncertainLayout;
    }
    function evaluate(value, rest, point, depth, fieldId, unionId) {
      value = unwrap(value);
      if (!value) return;
      if (rest === '.?') uncertainLayout = true;
      if (--budget < 0 || depth > 32) { unknown = true; return; }
      if (value.kind === 'ImplicitValueInitExpr' || value.kind === 'GNUNullExpr' ||
          (value.kind === 'IntegerLiteral' && value.value === '0')) return;
      if (value.kind === 'ConditionalOperator') {
        for (const alt of children(value).slice(1)) evaluate(alt, rest, point, depth + 1, fieldId, unionId);
        return;
      }
      if (value.kind === 'BinaryOperator' && value.opcode === ',') {
        evaluate(children(value)[1], rest, point, depth + 1, fieldId, unionId);
        return;
      }
      if (value.kind === 'CompoundLiteralExpr') {
        evaluate(children(value)[0], rest, point, depth + 1, fieldId, unionId);
        return;
      }
      if (value.kind === 'InitListExpr') {
        for (const { child, suffix } of initializerMembers(value, unit)) {
          const match = relativeSlot(suffix, rest);
          if (match) evaluate(child, match.rest, point, depth + 1, fieldId, unionId);
        }
        return;
      }
      if (value.kind === 'BinaryOperator' && value.opcode === '=') value = children(value)[0];
      const direct = fnRef(value);
      if (direct && (!rest || rest === '.?')) { targets.add(resolveFunction(direct.referencedDecl, unit)); return; }
      const pointer = pointerExpression(value, unit);
      const inputs = objectSlots(pointer, point);
      if (inputs.length) {
        for (const src of inputs) {
          unknown ||= src.unknown;
          for (const slot of paths(src)) read(src.key, slot + rest, point, depth + 1, rest ? fieldId : src.fieldId, rest ? unionId : src.unionId);
        }
      } else if (!rest || value.kind === 'CallExpr' || unstructuredJump ||
          (valueSlot && (pointer?.throughPointer || unit.valueRecords.has(value)))) {
        unknown = true;
      }
    }
    function evaluateResult(result, callee, call, point, depth) {
      merge(result);
      for (const parameter of result.parameters) {
        const arg = argumentSource(callee, call, parameter);
        if (arg) evaluate(arg, parameter.slot, point, depth + 1);
        else unknown = true;
      }
    }
    function evaluateWrite(effect, rest, call, point, depth) {
      evaluateResult(writeValue(effect, rest), effect.record, call, point, depth);
    }
    function read(source, path, at, depth, fieldId, unionId) {
      const exposed = escapes.get(source)?.filter(w => !w.effect && reaches(w.point, at) && relativeSlot(w.slot, path));
      function possibleAliasWrite(since) {
        if (initiallyEscaped(source, path) && indirectActions.some(p => !p.call && (!since || reaches(since, p)) && reaches(p, at))) unknown = true;
        if (!exposed?.length) return;
        // 明确覆盖之后，只有新的传址、调用或间接写才可能再次通过别名改变值。
        if (since && !exposed.some(w => reaches(since, w.point)) &&
            !indirectActions.some(p => p !== at && reaches(since, p) && reaches(p, at))) return;
        if (fieldId) merge(fieldWrites(fieldId, path, unionId));
        if (!fieldId || exposed.some(e => e.viaMember || matchingSlot(e.slot, path))) unknown = true;
      }
      function mergeInterveningCalls(since) {
        if (!hasStaticStorage(source)) return;
        for (const action of indirectActions) {
          if (!action.call || action === at || (since && !reaches(since, action)) || !reaches(action, at)) continue;
          const effects = callWrites(action.call, unit, source, path);
          evaluateResult(effects, effects.direct, action.call, action, depth);
        }
      }
      const history = writes.get(source) || [];
      // 大数组或未知长度保留符号下标。某个具体槽一旦被必经赋值覆盖，就不再取它更早的值。
      const shadowed = path.includes('[*]') ? new Set() : null;
      for (const { slot, value, point, effect, call, definite, weak } of writesAt(history, at)) {
        if (shadowed?.has(slot)) continue;
        const match = effect ? writeProjection(effect, slot, path) : relativeSlot(slot, path);
        if (!match) continue;
        // 未建模的跳转下只收集同一对象和槽位的可能来源，不用任一赋值覆盖其他证据。
        let mandatory = !weak && !unstructuredJump && point.order < at.order && !unordered(point, at), excluded = false;
        if (mandatory) for (const [guard, arm] of point.guards) {
          const same = sameArm(guard, arm, point, at);
          if (same !== true) mandatory = false;
          if (same === false) excluded = true;
        }
        if (excluded) continue;
        uncertainLayout ||= match.rest === '.?';
        if (effect) {
          evaluateWrite(effect, match.rest, call, point, depth);
          if (!definite) continue;
        } else evaluate(value, match.rest, point, depth, fieldId);
        if (mandatory && !slot.includes('[*]')) shadowed?.add(slot);
        if ((mandatory && match.covers) || budget < 0) {
          possibleAliasWrite(point);
          mergeInterveningCalls(point);
          // 块内 static 初始化只执行一次。前次调用留下的写入同样可达。
          if (source?.storageClass === 'static' && point.declaration === source) merge(ambient(source, path));
          return;
        }
      }
      possibleAliasWrite();
      if (unstructuredJump) mergeInterveningCalls();
      if (source?.kind === 'ParmVarDecl') {
        if (!parameters.some(p => p.decl === source && p.slot === path)) parameters.push({ decl: source, slot: path });
      } else merge(ambient(source, path));
    }
    if (!at) return { targets: [], parameters: [], unknown: true };
    if (sources) for (const src of sources) {
      unknown ||= src.unknown;
      for (const slot of paths(src)) read(src.key, slot, at, 0, src.fieldId, src.unionId);
    }
    else if (effect) evaluateWrite(effect, valueSlot, at.call, at, 0);
    else evaluate(value, valueSlot, at, 0);
    return { targets: [...targets], unknown, uncertainLayout, parameters };
  }
  return {
    calls: indirectActions.filter(p => p.call).map(p => p.call),
    isEvaluated: node => points.has(node),
    *addressWrites(key, slot) {
      for (const { slot: prefix, write } of addressed.get(key) || []) {
        const match = write ? writeProjection(write, prefix, slot) : relativeSlot(prefix, slot);
        if (match) yield { write, rest: match.rest };
      }
    },
    atCall(pointer, call) {
      const at = designators.get(call) || points.get(call);
      const sources = objectSlots(pointer, at);
      if (!sources.length) return null;
      const trackedSource = sources.some(src => src.throughPointer || src.decl.kind === 'CompoundLiteralExpr' ||
        [...(tracked.get(src.key) || [])].some(prefix => relativeSlot(prefix, src.slot)) ||
        escapes.get(src.key)?.some(w => relativeSlot(w.slot, src.slot) && reaches(w.point, at)));
      return trackedSource ? resolve(sources, null, at) : null;
    },
    atAssignment(write, slot) {
      if (write.effect) return resolve(null, null, points.get(write.node), slot, write.effect);
      const value = unwrap(write.value);
      // 在单条 *dst = *src 里，源成员来自调用者传入的对象，缓存中只保存形参和路径。
      if (slot && write.replacesPointee && value?.kind === 'UnaryOperator' && value.opcode === '*') {
        const ref = unwrap(children(value)[0])?.referencedDecl;
        if (ref?.kind === 'ParmVarDecl') {
          return { targets: [], unknown: false, parameters: [{ decl: objectKey(ref, unit), slot, pointee: true }] };
        }
      }
      return resolve(null, value, points.get(write.node), slot);
    },
  };
}
