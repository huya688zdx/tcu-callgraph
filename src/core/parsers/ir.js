const collections = ['files', 'functions', 'variables', 'externals', 'headerSymbols',
  'headerEdges', 'edges', 'macros', 'fnptrTables', 'includes', 'warnings'];
const text = (v) => typeof v === 'string' && v.length > 0;
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function requireIR(condition, field) {
  if (!condition) throw new TypeError(`GraphIR 字段无效：${field}`);
}

export function emptyDataflow() {
  return { failedFiles: 0, defs: [], byId: new Map(), fnAccess: new Map(), readers: new Map(), writers: new Map() };
}

export function validateDataflow(df) {
  requireIR(object(df) && Number.isInteger(df.failedFiles) && df.failedFiles >= 0, '_df.failedFiles');
  requireIR(Array.isArray(df.defs) && df.defs.every((d) => text(d?.id) && text(d.name)), '_df.defs');
  for (const key of ['byId', 'fnAccess', 'readers', 'writers']) requireIR(df[key] instanceof Map, `_df.${key}`);
  for (const [id, acc] of df.fnAccess) {
    requireIR(text(id) && acc?.reads instanceof Map && acc.writes instanceof Map, '_df.fnAccess');
    if (acc.addresses != null) requireIR(acc.addresses instanceof Map, '_df.fnAccess.addresses');
    for (const bucket of [acc.reads, acc.writes, acc.addresses]) for (const [varId, access] of bucket || []) {
      requireIR(df.byId.has(varId) && access?.lines instanceof Set && access.lines.size > 0
        && access.fields instanceof Set, '_df.fnAccess 记录');
    }
  }
  for (const bucket of [df.readers, df.writers]) for (const [id, ids] of bucket) {
    requireIR(df.byId.has(id) && ids instanceof Set, '_df.readers / writers 记录');
  }
  return df;
}

export function validateGraphIR(model) {
  requireIR(object(model), 'model');
  for (const key of ['root', 'parserId', 'parserName']) requireIR(text(model[key]), key);
  for (const key of collections) requireIR(Array.isArray(model[key]) && model[key].every(object), key);
  for (const file of model.files) requireIR(text(file.rel), 'files.rel');
  const ids = new Set();
  for (const key of ['functions', 'variables', 'externals', 'headerSymbols']) for (const node of model[key]) {
    requireIR(text(node.id) && text(node.name) && !ids.has(node.id), `${key}.id / name`);
    ids.add(node.id);
  }
  for (const key of ['edges', 'headerEdges']) for (const edge of model[key]) {
    requireIR(ids.has(edge.from) && ids.has(edge.to) && text(edge.kind), `${key}.from / to / kind`);
  }
  if (model._df != null) validateDataflow(model._df);
  return model;
}

export function normalizeGraphIR(rawModel, meta = {}) {
  requireIR(object(rawModel), 'model');
  const model = { ...rawModel, ...meta };
  for (const field of collections) model[field] ??= [];
  model.indirectCalls ??= [];
  model.generatedAt ??= new Date().toISOString();
  model.elapsedMs ??= 0;
  return validateGraphIR(model);
}

/** 将解析器生成的读写索引投影为普通图上的变量节点与边。 */
export function applyDataflow(model, df) {
  const manualVars = (model.variables || []).filter((v) => v.manual && !df.byId.has(v.id));
  for (const v of manualVars) {
    df.defs.push(v);
    df.byId.set(v.id, v);
  }
  model.variables = df.defs.map((d) => ({ ...d, kind: 'var', params: [] }));
  model.edges = model.edges.filter((e) => e.kind !== 'var');
  for (const fn of model.functions) {
    const acc = df.fnAccess.get(fn.id);
    fn.varAccess = [...new Set([...(acc?.writes.keys() || []), ...(acc?.reads.keys() || [])])].map((id) => {
      const write = acc.writes.has(id), read = acc.reads.has(id);
      return { id, name: df.byId.get(id).name, write, read,
        line: Math.min(...(acc.writes.get(id)?.lines || []), ...(acc.reads.get(id)?.lines || [])) };
    });
    for (const a of fn.varAccess) {
      model.edges.push({ from: fn.id, to: a.id, callee: a.name, kind: 'var', line: a.line,
        via: a.write ? (a.read ? '读写' : '写') : '读' });
    }
  }
}

/** 按稳定符号 ID、调用关系与变量访问比较，忽略行号和重复调用点。 */
export function diffParserModels(modelA, modelB) {
  const key = (...parts) => JSON.stringify(parts);
  const functions = (model) => model.functions.map(({ id, name, file, line }) => ({ id, name, file, line }));
  const calls = (model) => model.edges.filter((e) => e.kind !== 'var').map(({ from, to, kind }) => ({ from, to, kind }));
  const accesses = (model) => model.functions.flatMap((f) => {
    const acc = model._df?.fnAccess.get(f.id);
    return (acc
      ? [['read', acc.reads.keys()], ['write', acc.writes.keys()]]
      : ['read', 'write'].map((kind) => [kind, (f.varAccess || []).filter((a) => a[kind]).map((a) => a.id)])
    ).flatMap(([kind, ids]) => Array.from(ids, (to) => ({ from: f.id, to, kind })));
  });
  const pairs = (records) => {
    const result = new Map();
    for (const { from, to, kind } of records) {
      const id = key(from, to);
      if (!result.has(id)) result.set(id, { from, to, kinds: new Set() });
      result.get(id).kinds.add(kind);
    }
    return result;
  };
  const onlyInA = {}, onlyInB = {}, summary = {}, kindDiffs = [];
  const edgesA = calls(modelA), edgesB = calls(modelB);
  for (const [name, a, b, identity] of [
    ['functions', functions(modelA), functions(modelB), (f) => f.id],
    ['edges', edgesA, edgesB, (e) => key(e.from, e.to, e.kind)],
    ['variableAccess', accesses(modelA), accesses(modelB), (e) => key(e.from, e.to, e.kind)],
  ]) {
    const A = new Map(a.map((item) => [identity(item), item]));
    const B = new Map(b.map((item) => [identity(item), item]));
    const missing = (left, right) => [...left.keys()].filter((id) => !right.has(id)).sort().map((id) => left.get(id));
    onlyInA[name] = missing(A, B);
    onlyInB[name] = missing(B, A);
    summary[name] = { a: A.size, b: B.size, onlyInA: onlyInA[name].length, onlyInB: onlyInB[name].length };
  }
  const A = pairs(edgesA), B = pairs(edgesB);
  for (const id of [...A.keys()].sort()) {
    if (!B.has(id)) continue;
    const { from, to, kinds } = A.get(id);
    const a = [...kinds].sort(), b = [...B.get(id).kinds].sort();
    if (key(a) !== key(b)) kindDiffs.push({ from, to, a, b });
  }
  return { onlyInA, onlyInB, kindDiffs, summary: { ...summary, kindDiffs: kindDiffs.length } };
}
