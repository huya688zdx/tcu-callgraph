import { children, initializer, typeOf, unwrap, walk } from './clang-ast.js';
import { emptyDataflow } from './ir.js';

export function collectDataflow(records, defs, resolveVariable, callTargets) {
  const df = emptyDataflow();
  df.defs = [...defs.values()];
  df.byId = defs;
  const bindings = new Map();
  const getBindings = (context, id) => bindings.get(context)?.get(id) || new Map();
  function bind(context, id, targets) {
    if (!id || !targets.length) return false;
    if (!bindings.has(context)) bindings.set(context, new Map());
    const byDecl = bindings.get(context);
    if (!byDecl.has(id)) byDecl.set(id, new Map());
    const values = byDecl.get(id), before = values.size;
    for (const target of targets) {
      // 按首个成员归并别名，确保递归转传与循环指针赋值只能增加有限个绑定。
      const field = target.field.split('.')[0];
      values.set(JSON.stringify([target.id, field]), { ...target, field });
    }
    return values.size !== before;
  }
  const member = (prefix, name) => [prefix, name].filter(Boolean).join('.');
  const isArray = (node) => /\[.*\]/.test(typeOf(unwrap(node)));

  function refer(node, context) {
    node = unwrap(node);
    if (!node) return [];
    const [base] = children(node);
    if (node.kind === 'DeclRefExpr') {
      const id = resolveVariable(node.referencedDecl, context);
      return id ? [{ id, field: '', indirect: false }] : [];
    }
    if (node.kind === 'MemberExpr' || node.kind === 'ArraySubscriptExpr') {
      const indirect = node.isArrow || (node.kind === 'ArraySubscriptExpr' && !isArray(base));
      const targets = indirect ? pointers(base, context) : refer(base, context);
      return targets.map((t) => ({
        ...t, field: node.kind === 'MemberExpr' ? member(t.field, node.name) : t.field, indirect: !!indirect || t.indirect,
      }));
    }
    if (node.kind === 'UnaryOperator' && node.opcode === '*') {
      return pointers(base, context).map((t) => ({ ...t, indirect: true }));
    }
    return [];
  }

  function pointers(node, context) {
    node = unwrap(node);
    if (!node) return [];
    const [base, left, right] = children(node);
    if (node.kind === 'UnaryOperator' && node.opcode === '&') return refer(base, context);
    if (node.kind === 'DeclRefExpr') {
      const local = [...getBindings(context, node.referencedDecl?.id).values()];
      return isArray(node) ? [...local, ...refer(node, context)] : local;
    }
    if (node.kind === 'ConditionalOperator') return [...pointers(left, context), ...pointers(right, context)];
    return isArray(node) ? refer(node, context) : [];
  }

  const accesses = records.map((record) => ({
    ...record, nodes: [...walk(record.body)].filter((n) =>
      n.kind === 'VarDecl' || n.kind === 'CallExpr' || (n.kind === 'BinaryOperator' && n.opcode === '=')),
  }));
  const params = new Map(records.map((r) => [r, children(r.node).filter((n) => n.kind === 'ParmVarDecl')]));
  const globalAliases = new Map(records.map(({ context }) => [context, context.globals.filter((n) => typeOf(n).includes('*'))]));
  let changed;
  do {
    changed = false;
    for (const [context, variables] of globalAliases) for (const variable of variables) {
      if (bind(context, variable.id, pointers(initializer(variable), context))) changed = true;
    }
    for (const { nodes, context } of accesses) for (const n of nodes) {
      const [lhs, rhs] = children(n).map(unwrap);
      if (n.kind === 'VarDecl' && typeOf(n).includes('*')) {
        if (bind(context, n.id, pointers(initializer(n), context))) changed = true;
      }
      if (n.kind === 'BinaryOperator' && lhs?.kind === 'DeclRefExpr' && typeOf(lhs).includes('*')) {
        if (bind(context, lhs.referencedDecl?.id, pointers(rhs, context))) changed = true;
      }
      if (n.kind === 'CallExpr') for (const target of callTargets.get(n) || []) {
        for (const [i, param] of params.get(target).entries()) {
          if (typeOf(param).includes('*') && bind(target.context, param.id, pointers(n.inner[i + 1], context))) changed = true;
        }
      }
    }
  } while (changed);

  for (const { fn, body, context } of records) {
    if (!df.fnAccess.has(fn.id)) df.fnAccess.set(fn.id, { reads: new Map(), writes: new Map(), addresses: new Map() });
    const acc = df.fnAccess.get(fn.id);
    const touch = (bucket, target, node, indirect = target.indirect) => {
      const { id, field } = target;
      if (!bucket.has(id)) bucket.set(id, { lines: new Set(), fields: new Set(), whole: false, indirect: false });
      const access = bucket.get(id);
      access.lines.add(context.loc.loc(node)?.line || fn.line);
      if (field) access.fields.add(field);
      else access.whole = true;
      access.indirect ||= indirect;
    };
    const modes = { read: [acc.reads], write: [acc.writes], rw: [acc.reads, acc.writes], address: [acc.addresses] };

    function visitAddressing(node) {
      if (!node) return;
      const [base, index] = children(node);
      if (node.kind === 'ArraySubscriptExpr') {
        visit(index);
        if (isArray(base)) visitAddressing(unwrap(base));
        else visit(base);
      } else if (node.kind === 'MemberExpr') {
        if (node.isArrow) visit(base);
        else visitAddressing(unwrap(base));
      } else if (node.kind === 'UnaryOperator' && node.opcode === '*') {
        visit(base);
      } else if (node.kind !== 'DeclRefExpr') {
        visit(node);
      }
    }

    function visit(node, mode = 'read') {
      if (!node) return;
      if (node.kind === 'ImplicitCastExpr' && node.castKind === 'ArrayToPointerDecay') {
        visit(children(node)[0], 'address');
        return;
      }
      node = unwrap(node);
      const [lhs, rhs] = children(node);
      const { kind, opcode } = node;
      if (kind === 'CompoundAssignOperator' || (kind === 'BinaryOperator' && opcode === '=')) {
        visit(lhs, kind === 'CompoundAssignOperator' ? 'rw' : 'write');
        visit(rhs);
      } else if (kind === 'UnaryOperator' && opcode === '&') {
        visit(lhs, 'address');
      } else if (kind === 'UnaryOperator' && (opcode === '++' || opcode === '--')) {
        visit(lhs, 'rw');
      } else if (kind === 'DeclRefExpr' || kind === 'MemberExpr' || kind === 'ArraySubscriptExpr'
          || (kind === 'UnaryOperator' && opcode === '*')) {
        for (const target of refer(node, context)) for (const bucket of modes[mode]) touch(bucket, target, node);
        // 下标和用来寻址的指针本身仍会被读取。
        visitAddressing(node);
      } else {
        for (const child of children(node)) visit(child);
        for (const child of node.array_filler || []) visit(child);
        if (kind === 'CallExpr' && !callTargets.get(node)?.length) {
          // 外部函数可能通过实参访问对象，保留保守的潜在读写。
          for (const arg of node.inner.slice(1)) for (const t of pointers(arg, context)) {
            touch(acc.reads, t, arg, true);
            if (!/^const\b/.test(typeOf(arg))) touch(acc.writes, t, arg, true);
          }
        }
      }
    }
    visit(body);
  }
  for (const [fn, access] of df.fnAccess) {
    for (const [index, bucket] of [[df.readers, access.reads], [df.writers, access.writes]]) {
      for (const id of bucket.keys()) {
        if (!index.has(id)) index.set(id, new Set());
        index.get(id).add(fn);
      }
    }
  }
  return df;
}
