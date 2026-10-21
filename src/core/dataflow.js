/**
 * 数据流分析（按需触发）
 *
 * 调用关系图只能看到「谁调用了谁」。共享全局变量的隐式耦合看不到：
 * A 写 g_state、B 读 g_state，两者之间没有任何调用边，但存在真实的数据依赖。
 *
 * 这里基于 AST 做 def-use：
 *   1) 全工程扫一遍全局变量定义（typedef 类型 / 无初始化 / 一行多声明符都能认）
 *   2) 每个函数体里区分「写」「读」「取地址转义」
 *   3) 给定函数，沿它写/读的变量一跳找到对端函数，生成 写者 → 变量 → 读者 的链路
 *
 * 全工程扫描只在第一次请求时做一次，结果缓存在 model._df 上。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseFile, collectGlobals, collectFunctions, collectAccesses } from './cparse.js';

const MAX_VARS = 16;
const MAX_PEERS = 24;
const MAX_NODES = 90;

function decode(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('shift_jis').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

/** 建立全工程的变量表 + 读写索引（带缓存） */
export async function buildDataflowIndex(model) {
  if (model._df) return model._df;
  if (model._dfPending) return model._dfPending;

  const pending = (async () => {
    const defs = [];
    let failedFiles = 0;
    const defsByName = new Map();
    const fnAccess = new Map(); // fnId -> { writes: Map, reads: Map }
    const readers = new Map(); // varId -> Set<fnId>
    const writers = new Map(); // varId -> Set<fnId>
    const addTo = (map, key, val) => {
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(val);
    };

    const fnsByFile = new Map();
    for (const fn of model.functions) {
      if (!fnsByFile.has(fn.file)) fnsByFile.set(fn.file, []);
      fnsByFile.get(fn.file).push(fn);
    }

    for (const f of model.files) {
      const abs = path.join(model.root, f.rel);
      let rec;
      try {
        rec = await parseFile(abs, f.rel, decode(fs.readFileSync(abs)));
      } catch (err) {
        failedFiles += 1;
        console.warn(`[数据流] 解析失败，已跳过 ${f.rel}：`, err.message);
        continue; // 单个文件解析失败不影响整体
      }

      for (const g of collectGlobals(rec.root)) {
        const id = g.isStatic ? `var::${f.rel}::${g.name}` : `var::${g.name}`;
        const def = { ...g, id, file: f.rel };
        const prev = defsByName.get(g.name) || [];
        const same = prev.find((d) => d.id === id);
        if (same) {
          // extern 只是声明，真实定义优先
          if (same.isExtern && !g.isExtern) Object.assign(same, def);
          continue;
        }
        defs.push(def);
        defsByName.set(g.name, [...prev, def]);
      }

      const fns = collectFunctions(rec.root);
      const resolve = (name) => {
        const list = defsByName.get(name);
        if (!list || !list.length) return null;
        // 本文件的 static 优先，其次同名全局
        return list.find((d) => d.isStatic && d.file === f.rel) || list.find((d) => !d.isStatic) || list[0];
      };

      for (const fn of fnsByFile.get(f.rel) || []) {
        const node = fns.get(fn.name);
        if (!node) continue;
        const acc = collectAccesses(node, (name) => !!resolve(name));
        const w = new Map();
        const r = new Map();
        for (const [name, rec2] of acc.writes) {
          const d = resolve(name);
          if (d) w.set(d.id, rec2);
        }
        for (const [name, rec2] of acc.reads) {
          const d = resolve(name);
          if (d) r.set(d.id, rec2);
        }
        fnAccess.set(fn.id, { writes: w, reads: r });
        for (const id of w.keys()) addTo(writers, id, fn.id);
        for (const id of r.keys()) addTo(readers, id, fn.id);
      }
    }

    const idx = {
      defs,
      byId: new Map(defs.map((d) => [d.id, d])),
      fnAccess,
      readers,
      writers,
    };
    if (failedFiles) {
      console.warn(`[数据流] 共跳过 ${failedFiles} 个文件，变量面板可能不完整`);
    }
    model._df = idx;
    return idx;
  })();

  model._dfPending = pending;
  try {
    return await pending;
  } catch (err) {
    // 失败后清空占位：否则 rejected promise 会被永久复用，面板直到重启都不可用
    model._dfPending = null;
    throw err;
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

  const pushEdge = (from, to, kind, via, line) => {
    const k = `${from}|${to}|${kind}|${via}`;
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    edges.push({ from, to, kind, via, line, callee: via, df: true });
  };

  const firstLine = (rec) => (rec && rec.lines.size ? Math.min(...rec.lines) : 0);

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
        pushEdge(def.id, peer, 'df-read', def.name, 0);
        entry.peers.push({ id: peer, name: pn?.name || peer, file: pn?.file || '' });
      }
    } else {
      for (const peer of list) {
        const pn = fnNodeOf(model, peer);
        if (pn) addNode(pn);
        pushEdge(peer, def.id, 'df-write', def.name, 0);
        entry.peers.push({ id: peer, name: pn?.name || peer, file: pn?.file || '' });
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
  keep.add(fnId);

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
