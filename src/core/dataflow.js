/** 基于 GraphIR 的全局变量与跨函数数据流查询。 */
import { rebuildIndex } from './index.js';
import { taskPeriods } from './task-periods.js';
import { getParser } from './parsers/registry.js';
import { applyDataflow, validateDataflow } from './parsers/ir.js';

const MAX_VARS = 16;
const MAX_PEERS = 24;
const MAX_NODES = 90;

export async function buildDataflowIndex(model) {
  if (model._df) return model._df;
  if (model._dfPending) return model._dfPending;
  const parser = getParser(model.parserId);
  const analyze = parser?.buildDataflow || getParser('builtin').buildDataflow;
  const pending = Promise.resolve().then(async () => {
    const df = validateDataflow(await analyze.call(parser, model));
    if (!parser || parser.id === 'builtin' || parser.buildDataflow) {
      applyDataflow(model, df);
      rebuildIndex(model);
    }
    model._df = df;
    return df;
  });
  model._dfPending = pending;
  try {
    return await pending;
  } finally {
    model._dfPending = null;
  }
}

const fnNodeOf = (model, id) => {
  const n = model._index.byId.get(id);
  if (!n) return null;
  const { bodyTokens, ...rest } = n;
  return { ...rest, kind: rest.kind === 'var' ? 'var' : 'fn' };
};

/**
 * 查询一个函数的数据流关系
 * @param {object} model
 * @param {string} fnId 函数节点 id
 * @param {'out'|'in'|'both'} dir out=它的写影响到谁；in=谁的状态影响它
 */
export async function dataflowFor(model, fnId, dir = 'out') {
  const fn = model._index.byId.get(fnId);
  if (!fn) throw new Error('函数不存在');

  const idx = await buildDataflowIndex(model);
  const acc = idx.fnAccess.get(fnId);
  if (!acc) return { ok: true, fn: { id: fn.id, name: fn.name }, vars: [], nodes: [], edges: [], empty: true };

  const nodes = new Map();
  const edges = [];
  const vars = [];
  const seenEdge = new Set();
  const addNode = (n) => {
    if (!n || nodes.has(n.id)) return;
    nodes.set(n.id, n);
  };
  addNode(fnNodeOf(model, fnId));

  const pushEdge = (from, to, kind, via, line) => {
    const k = `${from}|${to}|${kind}|${via}`;
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    edges.push({ from, to, kind, via, line, callee: via, df: true });
  };

  const firstLine = (rec) => (rec && rec.lines.size ? Math.min(...rec.lines) : 0);

  const periods = taskPeriods(model);
  const emitVar = (varId, rec, mode) => {
    const def = idx.byId.get(varId);
    if (!def) return null;
    const peers = (mode === 'write' ? idx.readers.get(varId) : idx.writers.get(varId)) || new Set();
    const list = [...peers].filter((id) => id !== fnId).slice(0, MAX_PEERS);
    if (!list.length) return null;

    addNode({
      id: def.id,
      name: def.name,
      kind: 'var',
      file: def.file,
      line: def.line,
      typeText: def.typeText,
      isStatic: def.isStatic,
      isConst: def.isConst,
      params: [],
      dfVar: true,
    });

    const entry = {
      fnTaskPeriods: periods.get(fnId) || [],
      id: def.id,
      name: def.name,
      typeText: def.typeText,
      file: def.file,
      line: def.line,
      mode,
      fields: [...(rec?.fields || [])],
      indirect: !!rec?.indirect,
      peers: [],
      truncated: peers.size - (peers.has(fnId) ? 1 : 0) > list.length,
    };

    if (mode === 'write') {
      pushEdge(fnId, def.id, 'df-write', def.name, firstLine(rec));
      for (const peer of list) {
        const pn = fnNodeOf(model, peer);
        if (pn) addNode(pn);
        pushEdge(def.id, peer, 'df-read', def.name, firstLine(idx.fnAccess.get(peer)?.reads.get(varId)));
        entry.peers.push({ id: peer, name: pn?.name || peer, file: pn?.file || '', taskPeriods: periods.get(peer) || [] });
      }
    } else {
      for (const peer of list) {
        const pn = fnNodeOf(model, peer);
        if (pn) addNode(pn);
        pushEdge(peer, def.id, 'df-write', def.name, firstLine(idx.fnAccess.get(peer)?.writes.get(varId)));
        entry.peers.push({ id: peer, name: pn?.name || peer, file: pn?.file || '', taskPeriods: periods.get(peer) || [] });
      }
      pushEdge(def.id, fnId, 'df-read', def.name, firstLine(rec));
    }
    return entry;
  };

  const wantOut = dir === 'out' || dir === 'both';
  const wantIn = dir === 'in' || dir === 'both';

  if (wantOut) {
    for (const [varId, rec] of acc.writes) {
      if (vars.length >= MAX_VARS) break;
      const e = emitVar(varId, rec, 'write');
      if (e) vars.push(e);
    }
  }
  if (wantIn) {
    for (const [varId, rec] of acc.reads) {
      if (vars.length >= MAX_VARS) break;
      const e = emitVar(varId, rec, 'read');
      if (e) vars.push(e);
    }
  }

  // 节点上限：超出时截断，保留被分析函数本身
  let list = [...nodes.values()];
  let truncated = false;
  if (list.length > MAX_NODES) {
    list = list.slice(0, MAX_NODES);
    truncated = true;
  }
  const keep = new Set(list.map((n) => n.id));

  return {
    ok: true,
    fn: { id: fn.id, name: fn.name, file: fn.file, line: fn.line },
    dir,
    vars,
    nodes: list,
    edges: edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    writes: acc.writes.size,
    reads: acc.reads.size,
    truncated,
  };
}

/**
 * 全工程的全局变量 / 常量清单（供右侧面板勾选）
 * 与 sharedVariables 不同：不过滤「有没有跨函数共享」，常量、只在单个函数里用到的也算
 */
export async function listGlobals(model) {
  const idx = await buildDataflowIndex(model);
  const nameOf = (id) => model._index.byId.get(id)?.name || id;
  return idx.defs
    .map((d) => ({
      id: d.id,
      name: d.name,
      typeText: d.typeText,
      file: d.file,
      line: d.line,
      isConst: d.isConst,
      isStatic: d.isStatic,
      writers: [...(idx.writers.get(d.id) || [])].map((id) => ({ id, name: nameOf(id) })),
      readers: [...(idx.readers.get(d.id) || [])].map((id) => ({ id, name: nameOf(id) })),
    }))
    .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** 全局共享变量清单（供报告/统计用） */
export async function sharedVariables(model) {
  const idx = await buildDataflowIndex(model);
  const out = [];
  for (const def of idx.defs) {
    const w = idx.writers.get(def.id) || new Set();
    const r = idx.readers.get(def.id) || new Set();
    if (!w.size && !r.size) continue;
    const crossFn = [...w].some((id) => [...r].some((rid) => rid !== id));
    if (!crossFn) continue;
    out.push({
      id: def.id,
      name: def.name,
      typeText: def.typeText,
      file: def.file,
      line: def.line,
      isConst: def.isConst,
      writers: [...w].map((id) => model._index.byId.get(id)?.name || id),
      readers: [...r].map((id) => model._index.byId.get(id)?.name || id),
    });
  }
  return out.sort((a, b) => b.readers.length + b.writers.length - (a.readers.length + a.writers.length));
}
