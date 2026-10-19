/**
 * 工程索引：扫描目录 → 解析 → 建立函数表 / 调用边 / 宏表 / 函数指针表
 * 提供搜索、上下游子图查询、统计画像
 */

import fs from 'node:fs';
import path from 'node:path';
import { lex } from './lexer.js';
import { preprocess } from './preproc.js';
import { findFunctions, findFnPtrTables, scanCalls } from './extract.js';
import { parseDot, modelFromDot } from './dot.js';

const SRC_EXT = /\.(c|cc|cpp)$/i;
const HDR_EXT = /\.(h|hh|hpp)$/i;

export function listSourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (SRC_EXT.test(e.name) || HDR_EXT.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * @param {string} root 工程根目录
 * @returns {object} model
 */
export function buildIndex(root) {
  const t0 = Date.now();
  const absFiles = listSourceFiles(root);
  const headers = absFiles.filter((f) => HDR_EXT.test(f));
  const sources = absFiles.filter((f) => !HDR_EXT.test(f));

  const macros = new Map();
  const parsed = [];
  const includes = [];

  const parseFile = (abs) => {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    const src = fs.readFileSync(abs, 'utf8');
    const toks = lex(src, rel);
    const { tokens, includes: inc } = preprocess(toks, macros, rel);
    includes.push(...inc);
    parsed.push({ abs, rel, tokens, isHeader: HDR_EXT.test(abs), bytes: src.length });
  };

  // 先头文件（宏定义先入表），再源文件
  for (const f of headers) parseFile(f);
  for (const f of sources) parseFile(f);

  const functions = [];
  const fnptrTables = new Map();

  for (const p of parsed) {
    for (const fn of findFunctions(p.tokens, p.rel)) {
      fn.id = `${fn.file}::${fn.name}`;
      fn.bodyTokens = p.tokens.slice(fn.bodyStart + 1, fn.bodyEnd);
      functions.push(fn);
    }
    for (const [name, map] of findFnPtrTables(p.tokens)) {
      fnptrTables.set(name, { ...map });
    }
  }

  const byId = new Map();
  const byName = new Map();
  for (const fn of functions) {
    byId.set(fn.id, fn);
    if (!byName.has(fn.name)) byName.set(fn.name, []);
    byName.get(fn.name).push(fn);
  }

  const resolveCallee = (name, fromFile) => {
    const all = byName.get(name);
    if (!all || !all.length) return `ext::${name}`;
    const local = all.filter((f) => f.file === fromFile);
    if (local.length === 1) return local[0].id;
    if (all.length === 1) return all[0].id;
    const nonStatic = all.filter((f) => !f.isStatic);
    if (nonStatic.length === 1) return nonStatic[0].id;
    return (local[0] || all[0]).id;
  };

  const edges = [];
  const ctx = { macros, fnptr: fnptrTables };
  for (const fn of functions) {
    const raw = [];
    scanCalls(fn.bodyTokens, ctx, raw);
    for (const c of raw) {
      if (!c.callee) continue;
      edges.push({
        from: fn.id,
        to: resolveCallee(c.callee, fn.file),
        callee: c.callee,
        kind: c.kind,
        line: c.line,
        cond: c.cond,
        via: c.via,
        macroChain: c.macroChain,
      });
    }
  }

  // 外部符号虚拟节点
  const externals = new Map();
  for (const e of edges) {
    if (e.to.startsWith('ext::')) {
      const name = e.to.slice(5);
      if (!externals.has(e.to)) {
        externals.set(e.to, {
          id: e.to,
          name,
          file: '<external>',
          line: 0,
          isStatic: false,
          external: true,
          params: [],
        });
      }
    }
  }

  // 邻接表
  const outAdj = new Map();
  const inAdj = new Map();
  for (const e of edges) {
    if (!outAdj.has(e.from)) outAdj.set(e.from, []);
    outAdj.get(e.from).push(e);
    if (!inAdj.has(e.to)) inAdj.set(e.to, []);
    inAdj.get(e.to).push(e);
  }

  const allNodes = new Map([...byId, ...externals]);

  const model = {
    root,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    files: parsed.map((p) => ({ rel: p.rel, isHeader: p.isHeader, bytes: p.bytes })),
    functions,
    externals: [...externals.values()],
    edges,
    macros: [...macros.values()],
    fnptrTables: [...fnptrTables.entries()].map(([name, map]) => ({ name, map })),
    includes,
    _index: { byId: allNodes, byName, outAdj, inAdj },
  };

  return model;
}

/** 统一入口：目录走 C 源码解析，.dot/.gv 文件走 DOT 解析，单个 .c 索引所在目录并聚焦该文件 */
export function loadModel(target) {
  const st = fs.statSync(target);
  if (st.isFile()) {
    const ext = path.extname(target).toLowerCase();
    if (ext === '.dot' || ext === '.gv') {
      const src = fs.readFileSync(target, 'utf8');
      return modelFromDot(parseDot(src), path.basename(target));
    }
    if (SRC_EXT.test(ext) || HDR_EXT.test(ext)) {
      const dir = path.dirname(target);
      const model = buildIndex(dir);
      model.focusFile = path.relative(dir, target).replace(/\\/g, '/');
      return model;
    }
    throw new Error(`不支持的文件类型: ${ext}（支持 .c / .h / .dot / .gv 或目录）`);
  }
  return buildIndex(target);
}

/** 统计画像 */
export function stats(model) {
  const { outAdj, inAdj } = model._index;
  let maxFanOut = 0;
  let maxFanOutFn = '';
  let maxFanIn = 0;
  let maxFanInFn = '';

  for (const [id, list] of outAdj) {
    if (list.length > maxFanOut) {
      maxFanOut = list.length;
      maxFanOutFn = id;
    }
  }
  for (const [id, list] of inAdj) {
    if (list.length > maxFanIn) {
      maxFanIn = list.length;
      maxFanInFn = id;
    }
  }

  const sccs = tarjan(model);

  return {
    files: model.files.length,
    functions: model.functions.length,
    externals: model.externals.length,
    edges: model.edges.length,
    macros: model.macros.length,
    macroEdges: model.edges.filter((e) => e.kind === 'macro').length,
    fnptrEdges: model.edges.filter((e) => e.kind === 'fnptr').length,
    unknownEdges: model.edges.filter((e) => e.kind === 'unknown').length,
    maxFanOut,
    maxFanOutFn,
    maxFanIn,
    maxFanInFn,
    cycles: sccs.filter((c) => c.length > 1).length,
    cycleGroups: sccs.filter((c) => c.length > 1),
    elapsedMs: model.elapsedMs,
  };
}

/** Tarjan 强连通分量 */
export function tarjan(model) {
  const { outAdj } = model._index;
  const ids = new Set();
  for (const fn of model.functions) ids.add(fn.id);
  for (const e of model.edges) {
    ids.add(e.from);
    ids.add(e.to);
  }

  let idx = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const result = [];

  const strong = (v) => {
    index.set(v, idx);
    low.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);
    for (const e of outAdj.get(v) || []) {
      const w = e.to;
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      result.push(comp);
    }
  };

  for (const v of ids) if (!index.has(v)) strong(v);
  return result;
}

/**
 * 取子图：以 rootId 为中心，向下 down 层、向上 up 层
 */
export function subgraph(model, rootId, { up = 0, down = 2, maxNodes = 400 } = {}) {
  const { byId, outAdj, inAdj } = model._index;
  if (!byId.has(rootId)) return { nodes: [], edges: [] };

  const nodes = new Map();
  const edges = [];
  const seenEdge = new Set();

  const addNode = (id) => {
    if (nodes.has(id)) return false;
    const n = byId.get(id);
    if (!n) return false;
    nodes.set(id, n);
    return true;
  };

  addNode(rootId);

  const walk = (adj, depth) => {
    let frontier = [rootId];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const id of frontier) {
        for (const e of adj.get(id) || []) {
          const other = adj === outAdj ? e.to : e.from;
          const key = `${e.from}->${e.to}:${e.line}`;
          if (!seenEdge.has(key)) {
            seenEdge.add(key);
            edges.push(e);
          }
          if (nodes.size >= maxNodes) continue;
          if (addNode(other)) next.push(other);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
  };

  walk(outAdj, down);
  if (up > 0) walk(inAdj, up);

  return {
    root: rootId,
    nodes: [...nodes.values()],
    edges: edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)),
  };
}

/** 按名字模糊搜索 */
export function search(model, q, limit = 30) {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const scored = [];
  for (const fn of model.functions) {
    const name = fn.name.toLowerCase();
    const file = fn.file.toLowerCase();
    let score = 0;
    if (name === query) score = 100;
    else if (name.startsWith(query)) score = 80;
    else if (name.includes(query)) score = 60;
    else if (file.includes(query)) score = 20;
    if (score) scored.push({ fn, score });
  }
  scored.sort((a, b) => b.score - a.score || a.fn.name.length - b.fn.name.length);
  return scored.slice(0, limit).map((s) => s.fn);
}

/** 两点之间的所有路径（用于高亮调用链） */
export function findPaths(model, from, to, maxDepth = 8, maxPaths = 20) {
  const { outAdj } = model._index;
  const results = [];
  const path = [];
  const onPath = new Set();

  const dfs = (v, d) => {
    if (results.length >= maxPaths || d > maxDepth) return;
    path.push(v);
    onPath.add(v);
    if (v === to) {
      results.push(path.slice());
    } else {
      for (const e of outAdj.get(v) || []) {
        if (!onPath.has(e.to)) dfs(e.to, d + 1);
      }
    }
    path.pop();
    onPath.delete(v);
  };

  dfs(from, 0);
  return results;
}
