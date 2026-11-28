import { children, constIndexValue, fnRef, initializer, initializerMembers, pointerExpression, transferredValues, typeOf, unwrap, walk } from './clang-ast.js';

// 只匹配完整字段和下标。运行时下标可以匹配具体下标，不能越过一层数组或字段。
const parts = slot => slot.match(/\.[^.\[]+|\[[^\]]+\]/g) || [];
function relativeSlot(prefix, slot) {
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

const isCase = node => node?.kind === 'CaseStmt' || node?.kind === 'DefaultStmt';
// 内层 switch 的标签只从该 switch 进入，外层 case 则可能跳进将被略过的语句。
function hasCaseEntry(node) {
  return isCase(node) || (node.kind !== 'SwitchStmt' && children(node).some(hasCaseEntry));
}

// 以声明身份和调用点读取聚合成员。复制读取当时的源值；传址写入只作为可能值。
export function callbackSlotReader(record, objectKey, resolveFunction, { ambient, parameterWrites, fieldWrites, writeValue, globalWritesFrom }) {
  const unit = record.context, writes = new Map(), tracked = new Map(), escapes = new Map(), points = new WeakMap();
  const designators = new WeakMap();
  const indirectActions = [], aliases = new Map(), rebound = new Set();
  // 同一块中无条件向前跳转时可以直接跳过中间语句。其他跳转不能依赖源码中的先后顺序。
  const forwardJumps = new Map();
  let unstructuredJump = false;
  // 只绑定初始化后既不改写、也不按地址传出的局部指针。其他别名保持保守。
  for (const n of walk(record.body)) {
    if (n.kind === 'CompoundStmt' && children(n).some(s => s.kind === 'GotoStmt') && !hasCaseEntry(n)) {
      const statements = children(n), labels = new Map();
      for (let i = statements.length - 1; i >= 0; i--) {
        const s = statements[i];
        if (s.kind === 'LabelStmt' && s.declId) labels.set(s.declId, i);
        if (s.kind === 'GotoStmt' && labels.has(s.targetLabelDeclId)) forwardJumps.set(s, labels.get(s.targetLabelDeclId));
      }
    }
    if (n.kind === 'IndirectGotoStmt' || (n.kind === 'GotoStmt' && !forwardJumps.has(n))) unstructuredJump = true;
    if (n.kind === 'CompoundAssignOperator' || (n.kind === 'BinaryOperator' && n.opcode === '=') ||
        (n.kind === 'UnaryOperator' && ['&', '++', '--'].includes(n.opcode))) {
      const target = unwrap(children(n)[0]);
      if (target?.kind === 'DeclRefExpr') rebound.add(objectKey(target.referencedDecl, unit));
    }
  }
  function objectSlot(pointer) {
    if (!pointer?.decl) return null;
    const key = objectKey(pointer.decl, unit);
    if (!pointer.throughPointer) return { ...pointer, key };
    const alias = aliases.get(key);
    if (!alias) return null;
    const slot = argumentSlot(alias.slot, pointer);
    return slot == null ? null : { ...pointer, key: alias.key, slot };
  }
  let order = 0;
  function add(key, slot, value, point, assignment = false) {
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
      list.push({ slot, value: null, point }); // 未显式初始化的成员为零。
      for (const { child, suffix } of initializerMembers(value, unit)) {
        add(key, slot + suffix, child, point);
      }
    } else {
      list.push({ slot, value, point });
    }
  }

  function addressOf(expr) {
    const addr = unwrap(expr);
    if (addr?.kind === 'BinaryOperator' && ['+', '-'].includes(addr.opcode) && typeOf(addr).includes('*')) {
      const [left, right] = children(addr);
      const leftPointer = typeOf(left).includes('*');
      const base = addressOf(leftPointer ? left : right);
      if (!base) return null;
      const n = constIndexValue(leftPointer ? right : left, unit);
      const slot = offsetSlot(base.slot, n == null ? null : addr.opcode === '-' ? -n : n);
      return slot == null ? null : { ...base, slot };
    }
    const decay = /\]$/.test(typeOf(addr)) && typeOf(expr).includes('*');
    if (!decay && addr?.kind === 'DeclRefExpr') return aliases.get(objectKey(addr.referencedDecl, unit));
    if (!decay && !(addr?.kind === 'UnaryOperator' && addr.opcode === '&')) return null;
    const obj = objectSlot(pointerExpression(decay ? addr : children(addr)[0], unit));
    if (obj?.decl.kind !== 'VarDecl') return null;
    return { key: obj.key, slot: obj.slot + (decay ? '[0]' : ''), region: obj.slot };
  }

  function noteEscape(expr, point, call, index) {
    const addr = unwrap(expr);
    if (addr?.kind === 'ConditionalOperator') {
      for (const alt of children(addr).slice(1)) noteEscape(alt, point, call, index);
      return;
    }
    const base = addressOf(expr);
    if (!base) return;
    const readOnly = /\bconst\b[^*]*\*\s*$/.test(typeOf(expr));
    for (const effect of call ? parameterWrites(children(call)[0], index) : [null]) {
      if (!effect && readOnly) continue;
      const slot = effect ? argumentSlot(base.slot, effect) : base.region;
      if (slot == null) continue;
      const entry = { slot, point, effect, call };
      if (!escapes.has(base.key)) escapes.set(base.key, []);
      escapes.get(base.key).push(entry);
      if (effect) {
        if (!writes.has(base.key)) writes.set(base.key, []);
        writes.get(base.key).push(entry);
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
    if (!node?.kind || (node.kind === 'UnaryExprOrTypeTraitExpr' && !node.argType)) return;
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
    const nested = node.array_filler ? [...children(node), ...node.array_filler] : children(node);
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
    const localPointer = node.kind === 'VarDecl' && !['static', 'extern'].includes(node.storageClass) &&
      node.init && !rebound.has(node) && typeOf(node).includes('*');
    const alias = localPointer && addressOf(initializer(node));
    if (alias) aliases.set(node, alias);
    else transferredValues(node).forEach((arg, index) => noteEscape(arg, point, call, index));
    if (node.kind === 'VarDecl' && node.storageClass !== 'extern') {
      point.declaration = node;
      const init = node.init && initializer(node);
      add(objectKey(node, unit), '', init, point);
    } else if (node.kind === 'BinaryOperator' && node.opcode === '=') {
      const lhs = pointerExpression(children(node)[0], unit);
      const dest = objectSlot(lhs);
      if (dest) add(dest.key, dest.slot, children(node)[1], point, true);
      else if (lhs?.throughPointer) indirectActions.push(point);
    }
  }
  visit(record.body, new Map(), null);

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

  function resolve(pointer, value, at) {
    const targets = new Set(), parameters = new Set();
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
      if (value.kind === 'ConditionalOperator') {
        for (const alt of children(value).slice(1)) evaluate(alt, rest, point, depth + 1, fieldId, unionId);
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
      const src = objectSlot(pointerExpression(value, unit));
      if (src) {
        for (const slot of paths(src)) read(src.key, slot + rest, point, depth + 1, rest ? fieldId : src.fieldId, rest ? unionId : src.unionId);
      } else if ((!rest || value.kind === 'CallExpr' || unstructuredJump) && value.kind !== 'ImplicitValueInitExpr' && value.kind !== 'GNUNullExpr' &&
          !(value.kind === 'IntegerLiteral' && value.value === '0')) {
        unknown = true;
      }
    }
    function evaluateWrite(effect, call, point, depth) {
      const result = writeValue(effect);
      merge(result);
      if (!result.parameters.length) return;
      const formals = children(effect.record.node).filter(n => n.kind === 'ParmVarDecl');
      for (const param of result.parameters) {
        const index = formals.indexOf(param);
        const arg = call && index >= 0 && children(call)[index + 1];
        if (arg) evaluate(arg, '', point, depth + 1);
        else unknown = true;
      }
    }
    function read(source, path, at, depth, fieldId, unionId) {
      const exposed = escapes.get(source)?.filter(w => !w.effect && reaches(w.point, at) && relativeSlot(w.slot, path));
      function possibleAliasWrite(since) {
        if (!exposed?.length) return;
        // 明确覆盖之后，只有新的传址、调用或间接写才可能再次通过别名改变值。
        if (since && !exposed.some(w => reaches(since, w.point)) &&
            !indirectActions.some(p => p !== at && reaches(since, p) && reaches(p, at))) return;
        if (fieldId) merge(fieldWrites(fieldId, path, unionId));
        else unknown = true;
      }
      function mergeInterveningCalls(since) {
        if (typeof source !== 'string') return;
        for (const action of indirectActions) {
          if (!action.call || action === at || (since && !reaches(since, action)) || !reaches(action, at)) continue;
          const effects = globalWritesFrom(action.call, unit, source, path);
          unknown ||= effects.unknown;
          uncertainLayout ||= effects.uncertainLayout;
          for (const w of effects.writes) evaluateWrite(w, w.record === effects.direct ? action.call : null, action, depth);
        }
      }
      const history = writes.get(source) || [];
      // 大数组或未知长度保留符号下标。某个具体槽一旦被必经赋值覆盖，就不再取它更早的值。
      const shadowed = path.includes('[*]') ? new Set() : null;
      for (const { slot, value, point, effect, call } of writesAt(history, at)) {
        if (shadowed?.has(slot)) continue;
        const match = relativeSlot(slot, path);
        if (!match) continue;
        // 未建模的跳转下只收集同一对象和槽位的可能来源，不用任一赋值覆盖其他证据。
        let mandatory = !unstructuredJump && point.order < at.order && !unordered(point, at), excluded = false;
        if (mandatory) for (const [guard, arm] of point.guards) {
          const same = sameArm(guard, arm, point, at);
          if (same !== true) mandatory = false;
          if (same === false) excluded = true;
        }
        if (excluded) continue;
        uncertainLayout ||= match.rest === '.?';
        if (effect) {
          evaluateWrite(effect, call, point, depth);
        } else {
          evaluate(value, match.rest, point, depth, fieldId);
          if (mandatory && !slot.includes('[*]')) shadowed?.add(slot);
          if ((mandatory && match.covers) || budget < 0) {
            possibleAliasWrite(point);
            mergeInterveningCalls(point);
            // 块内 static 初始化只执行一次。前次调用留下的写入同样可达。
            if (source?.storageClass === 'static' && point.declaration === source) merge(ambient(source, path));
            return;
          }
        }
      }
      possibleAliasWrite();
      if (unstructuredJump) mergeInterveningCalls();
      if (source?.kind === 'ParmVarDecl' && !path) parameters.add(source);
      else merge(ambient(source, path));
    }
    if (!at) return { targets: [], parameters: [], unknown: true };
    if (pointer) for (const slot of paths(pointer)) read(pointer.key, slot, at, 0, pointer.fieldId, pointer.unionId);
    else evaluate(value, '', at, 0);
    return { targets: [...targets], unknown, uncertainLayout, parameters: [...parameters] };
  }
  return {
    calls: indirectActions.filter(p => p.call).map(p => p.call),
    isEvaluated: node => points.has(node),
    addressWrites: (key, slot) => (escapes.get(key) || []).filter(w => relativeSlot(w.slot, slot)),
    atCall(pointer, call) {
      const src = objectSlot(pointer), at = designators.get(call) || points.get(call);
      if (!src) return null;
      const changed = [...(tracked.get(src.key) || [])].some(prefix => relativeSlot(prefix, src.slot));
      const escaped = escapes.get(src.key)?.some(w => relativeSlot(w.slot, src.slot) && reaches(w.point, at));
      return src.throughPointer || changed || escaped ? resolve(src, null, at) : null;
    },
    atAssignment(write) { return resolve(null, write.value, points.get(write.node)); },
  };
}
