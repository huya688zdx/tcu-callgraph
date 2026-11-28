/** 工程解析入口与通用图查询 */
import fs from 'node:fs';
import path from 'node:path';
import { SRC_EXT, HDR_EXT } from './source-files.js';
import { getParser, resolveParserForTarget } from './parsers/registry.js';
import { normalizeGraphIR } from './parsers/ir.js';
export { decodeSource, listSourceFiles, scanSources } from './source-files.js';

/**
 * 从纯数据重建 _index。
 * 解析缓存反序列化后必须走这一步：JSON 留不住对象引用，
 * 直接把 _index 存下来会让 byId 里的函数和 functions 数组变成两份互不相干的副本，
 * 之后任何一处改字段，另一处都看不到。
 */
export function rebuildIndex(model) {
  const functions = model.functions || [];
  const externals = model.externals || [];
  const edges = model.edges || [];

  const byId = new Map();
  const byName = new Map();
  for (const fn of functions) {
    byId.set(fn.id, fn);
    if (!byName.has(fn.name)) byName.set(fn.name, []);
    byName.get(fn.name).push(fn);
  }
  for (const ex of externals) byId.set(ex.id, ex);
  for (const symbol of model.headerSymbols || []) byId.set(symbol.id, symbol);
  for (const v of model.variables || []) byId.set(v.id, v);

  const outAdj = new Map();
  const inAdj = new Map();
  for (const e of edges) {
    if (!outAdj.has(e.from)) outAdj.set(e.from, []);
    outAdj.get(e.from).push(e);
    if (!inAdj.has(e.to)) inAdj.set(e.to, []);
    inAdj.get(e.to).push(e);
  }

  const varWriters = new Map();
  const varReaders = new Map();
  for (const fn of functions) {
    for (const a of fn.varAccess || []) {
      if (a.write) {
        if (!varWriters.has(a.id)) varWriters.set(a.id, []);
        varWriters.get(a.id).push(fn.id);
      }
      if (a.read) {
        if (!varReaders.has(a.id)) varReaders.set(a.id, []);
        varReaders.get(a.id).push(fn.id);
      }
    }
  }

  model._index = { byId, byName, outAdj, inAdj, varWriters, varReaders };
  return model;
}

function parseWith(parser, target, context) {
  const status = parser.available(context.parserOptions);
  if (!status.ok) throw new Error(status.reason || `解析器不可用：${parser.id}`);
  const finish = (raw) => rebuildIndex(normalizeGraphIR(raw, {
    root: raw?.root ?? target, parserId: parser.id, parserName: parser.name,
    ...(context.sourceFiles ? { _sourceFiles: context.sourceFiles } : {}),
    ...(context.focusFile ? { focusFile: context.focusFile } : {}),
  }));
  const result = parser.parse(target, context);
  return typeof result?.then === 'function' ? result.then(finish) : finish(result);
}

/** 内置解析保留同步返回值，外部引擎可以返回 Promise。 */
export function buildIndex(root, sourceFiles = null, scan = null, options = {}) {
  if (sourceFiles && !(sourceFiles instanceof Map)) {
    options = sourceFiles;
    sourceFiles = null;
  } else if (scan && !Array.isArray(scan.files) && ('parserId' in scan || 'parserOptions' in scan)) {
    options = scan;
    scan = null;
  }
  const { parserId, parserOptions = {} } = options;
  const parser = getParser(parserId);
  if (!parser || parser.id === 'dot') throw new Error(`不可用于源码目录的解析器：${parserId}`);
  return parseWith(parser, root, { sourceFiles, scan, parserOptions });
}

export function loadModel(target, scan = null, options = {}) {
  if (scan && !Array.isArray(scan.files) && ('parserId' in scan || 'parserOptions' in scan)) {
    options = scan;
    scan = null;
  }
  const { parserId, parserOptions = {} } = options;
  const st = fs.statSync(target);
  if (st.isFile()) {
    const ext = path.extname(target).toLowerCase();
    if (ext === '.dot' || ext === '.gv') {
      return parseWith(resolveParserForTarget(target, parserId), target, { parserOptions });
    }
    if (!SRC_EXT.test(ext) && !HDR_EXT.test(ext)) {
      throw new Error(`不支持的文件类型: ${ext}（支持 .c / .h / .dot / .gv 或目录）`);
    }
    return parseWith(resolveParserForTarget(target, parserId), path.dirname(target),
      { scan, parserOptions, focusFile: path.basename(target) });
  }
  return buildIndex(target, null, scan, options);
}

/** 统计画像 */
export function stats(model) {
  // 统计口径与画布一致：同一对节点的多次调用只算一条关系边
  const pairs = new Set(model.edges.map((e) => `${e.from}|${e.to}`));
  const outSet = new Map();
  const inSet = new Map();
  for (const e of model.edges) {
    if (!outSet.has(e.from)) outSet.set(e.from, new Set());
    outSet.get(e.from).add(e.to);
    if (!inSet.has(e.to)) inSet.set(e.to, new Set());
    inSet.get(e.to).add(e.from);
  }

  let maxFanOut = 0;
  let maxFanOutFn = '';
  let maxFanIn = 0;
  let maxFanInFn = '';

  for (const [id, set] of outSet) {
    if (set.size > maxFanOut) {
      maxFanOut = set.size;
      maxFanOutFn = id;
    }
  }
  for (const [id, set] of inSet) {
    if (set.size > maxFanIn) {
      maxFanIn = set.size;
      maxFanInFn = id;
    }
  }

  const sccs = tarjan(model);
  // 自递归（函数直接调用自己）在 tarjan 里是单点分量，同样要算作一个环。
  // cycleGroups 保持「id 数组的数组」旧结构（cli/scan.js 直接 join 打印），
  // 自环另外在 selfLoops 里给出，便于界面区分「自递归」与「环组」。
  const outAdj = model._index?.outAdj;
  const cycleGroups = [];
  const selfLoops = [];
  for (const c of sccs) {
    if (c.length > 1) {
      cycleGroups.push(c);
    } else if (c.length === 1 && (outAdj?.get(c[0]) || []).some((e) => e.to === c[0])) {
      cycleGroups.push(c);
      selfLoops.push(c[0]);
    }
  }

  return {
    files: model.files.length,
    // 同名函数在 #if/#else 两分支各定义一次时会有重复 id，按 id 去重后再计数
    functions: new Set(model.functions.map((f) => f.id)).size,
    variables: model.variables?.length ?? 0,
    externals: model.externals?.length ?? 0,
    edges: pairs.size,
    calls: model.edges.length,
    macros: model.macros?.length ?? 0,
    macroEdges: model.edges.filter((e) => e.kind === 'macro').length,
    fnptrEdges: model.edges.filter((e) => e.kind === 'fnptr').length,
    unknownEdges: model.edges.filter((e) => e.kind === 'unknown').length,
    maxFanOut,
    maxFanOutFn,
    maxFanIn,
    maxFanInFn,
    cycles: cycleGroups.length,
    cycleGroups,
    selfLoops,
    elapsedMs: model.elapsedMs,
  };
}

/**
 * 数据流：经由同一个全局变量的「写者 → 读者」关系。
 * A 写 g_x、B 读 g_x，即使两者之间没有调用，也存在 A → B 的数据流。
 * 这种关系数量可能爆炸，所以默认不展开，只在用户对某个函数显式开启时计算。
 */
export function dataflowOf(model, nodeId) {
  const idx = model._index || {};
  const varWriters = idx.varWriters || new Map();
  const varReaders = idx.varReaders || new Map();
  const fn = idx.byId ? idx.byId.get(nodeId) : null;
  if (!fn || !fn.varAccess) return [];

  const out = [];
  const seen = new Set();
  const push = (from, to, a) => {
    if (from === to) return;
    const k = `${from}|${to}|${a.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ from, to, varId: a.id, varName: a.name, kind: 'dataflow' });
  };

  for (const a of fn.varAccess) {
    if (a.write) for (const r of varReaders.get(a.id) || []) push(fn.id, r, a);
    if (a.read) for (const w of varWriters.get(a.id) || []) push(w, fn.id, a);
  }
  return out;
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
 * 取子图：以 rootId 为中心，向下 down 层、向上 up 层。默认隐藏外部符号。
 */
export function subgraph(model, rootId, {
  up = 0, down = 2, maxNodes = 400, includeVariables = true, includeExternals = false, allowedIds = null,
} = {}) {
  let { byId, outAdj, inAdj } = model._index;
  if (!byId.has(rootId)) return { nodes: [], edges: [] };
  const showExternals = includeExternals || rootId.startsWith('ext::');

  // 仅选中头文件宏时加入定义映射，普通函数调用深度保持原来的语义。
  const header = byId.get(rootId);
  if (header.headerSymbol) {
    outAdj = new Map(outAdj);
    inAdj = new Map(inAdj);
    outAdj.set(rootId, (model.headerEdges || []).filter((e) => e.from === rootId));
    inAdj.set(rootId, (model.headerEdges || []).filter((e) => e.to === rootId));
  }

  const nodes = new Map();
  const edges = [];
  let truncated = false;
  const seenCall = new Set();
  // 同一对节点之间的多次调用合并成一条边，调用次数与行号记在 calls 里，
  // 避免画出并排的多条平行边
  const byPair = new Map();

  const addNode = (id) => {
    if (nodes.has(id)) return false;
    const n = byId.get(id);
    if (!n) return false;
    nodes.set(id, n);
    return true;
  };

  addNode(rootId);

  const kindRank = { direct: 3, macro: 2, fnptr: 1, unknown: 0 };

  const addEdge = (e) => {
    const callKey = `${e.from}|${e.to}|${e.line}|${e.kind}`;
    if (seenCall.has(callKey)) return;
    seenCall.add(callKey);
    const pairKey = e.comparison ? `${e.from}|${e.to}|${e.change}|${e.kind === 'var' ? e.via : ''}|${e.cond || ''}` : `${e.from}|${e.to}|${e.kind === 'dataflow' ? 'dataflow' : 'access'}`;
    let m = byPair.get(pairKey);
    if (!m) {
      m = { ...e, calls: [] };
      byPair.set(pairKey, m);
      edges.push(m);
    } else if ((kindRank[e.kind] ?? 0) > (kindRank[m.kind] ?? 0)) {
      // 同一对节点既有直接调用又有宏/函数指针调用时，以更具体的类型展示
      m.kind = e.kind;
      m.line = e.line;
      m.callee = e.callee;
      m.via = e.via;
      m.cond = e.cond;
      m.siteId = e.siteId;
      m.resolution = e.resolution;
      m.dynamicDispatch = e.dynamicDispatch;
    } else if (!m.resolution && e.resolution) {
      m.resolution = e.resolution;
      m.dynamicDispatch = e.dynamicDispatch;
      m.siteId = e.siteId;
    }
    m.calls.push({
      line: e.line,
      col: e.col,
      kind: e.kind,
      cond: e.cond,
      via: e.via,
      ...(e.resolution && { resolution: e.resolution }),
      ...(e.siteId && { siteId: e.siteId }),
    });
  };

  const walk = (adj, depth) => {
    let frontier = [rootId];
    // 两个方向分别记录已遍历节点：互相调用的节点可能已在另一方向中入图，
    // 仍须沿本方向继续查找它的上层/下层，不能用共享 nodes 提前截断。
    const visited = new Set(frontier);
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const id of frontier) {
        for (const e of adj.get(id) || []) {
          // 在遍历时排除变量，避免变量占满节点名额，或沿共享变量拉入无调用关系的函数。
          if (!includeVariables && e.kind === 'var') continue;
          const other = adj === outAdj ? e.to : e.from;
          if (!showExternals && other.startsWith('ext::')) continue;
          if (!byId.has(other)) continue;
          if (allowedIds && !allowedIds.has(other)) continue;
          if (!nodes.has(other) && nodes.size >= maxNodes) {
            truncated = true;
            continue;
          }
          addNode(other);
          addEdge(e);
          if (!visited.has(other)) {
            visited.add(other);
            next.push(other);
          }
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
    truncated,
    nodes: [...nodes.values()],
    edges: edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)),
  };
}

/** 按名字模糊搜索 */
export function search(model, q, limit = 30) {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const scored = [];
  for (const fn of [...model.functions, ...(model.headerSymbols || [])]) {
    const name = fn.name.toLowerCase();
    const targets = (fn.targetNames || []).join(' ').toLowerCase();
    const file = fn.file.toLowerCase();
    let score = 0;
    if (name === query) score = 100;
    else if (name.startsWith(query)) score = 80;
    else if (name.includes(query)) score = 60;
    else if (targets.includes(query)) score = 50;
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
