import { buildDataflowIndex } from './dataflow.js';

const MAX_HOPS = 8, MAX_PATHS = 12, MAX_VISITED = 4096, MAX_EDGES = 50000;
const accessMetadata = new WeakMap();
function metadata(rec) {
  if (!accessMetadata.has(rec)) {
    let line = 0;
    for (const value of rec.lines) if (!line || value < line) line = value;
    accessMetadata.set(rec, { line, fields: rec.indirect || rec.whole ? [] : [...rec.fields].sort() });
  }
  return accessMetadata.get(rec);
}
const overlap = (a, b) => !a.length || !b.length || a.some(x => b.some(y =>
  x === y || x.startsWith(y + '.') || y.startsWith(x + '.')));

/** 有向读写图中的最短路径；函数内读写只代表潜在传递关系，不推断执行顺序。 */
function pathsBetween(index, from, to) {
  const keyOf = (id, fields = []) => JSON.stringify([id, fields]);
  const start = keyOf(from), states = new Map([[start, { id: from, fields: [], depth: 0, parents: [] }]]);
  const queue = [start], ends = [];
  let targetDepth = Infinity, inspected = 0, truncated = false;
  for (let head = 0; head < queue.length; head++) {
    const key = queue[head], state = states.get(key);
    if (state.depth >= targetDepth) continue;
    const variable = index.byId.has(state.id);
    const accesses = variable ? index.readers.get(state.id) || [] : index.fnAccess.get(state.id)?.writes.keys() || [];
    if (state.depth >= MAX_HOPS) { if ([...accesses].length) truncated = true; continue; }
    for (const id of accesses) {
      if (++inspected > MAX_EDGES) { truncated = true; break; }
      const rec = variable ? index.fnAccess.get(id)?.reads.get(state.id) : index.fnAccess.get(state.id)?.writes.get(id);
      if (!rec) continue;
      const { fields, line } = metadata(rec);
      if (variable && !overlap(state.fields, fields)) continue;
      const next = keyOf(id, variable ? [] : fields);
      const edge = { from: state.id, to: id, kind: variable ? 'df-read' : 'df-write',
        variable: variable ? state.id : id, fields, indirect: !!rec.indirect,
        line };
      if (!states.has(next)) {
        if (states.size >= MAX_VISITED) { truncated = true; continue; }
        states.set(next, { id, fields: variable ? [] : fields, depth: state.depth + 1, parents: [] });
        queue.push(next);
      }
      const found = states.get(next);
      if (found.depth !== state.depth + 1) continue;
      found.parents.push({ key, edge });
      if (id === to && found.depth <= targetDepth) {
        targetDepth = found.depth;
        if (!ends.includes(next)) ends.push(next);
      }
    }
    if (inspected > MAX_EDGES) break;
  }
  const paths = [], stack = ends.map(key => ({ key, edges: [] }));
  while (stack.length && paths.length < MAX_PATHS) {
    const item = stack.pop();
    if (item.key === start) {
      const edges = item.edges.toReversed();
      paths.push({ nodes: [from, ...edges.map(e => e.to)], edges });
    } else {
      for (const parent of states.get(item.key).parents) stack.push({ key: parent.key, edges: [...item.edges, parent.edge] });
    }
  }
  return { paths, truncated: truncated || stack.length > 0 };
}

export async function pairDataflow(model, a, b) {
  const index = await buildDataflowIndex(model);
  const node = id => index.byId.get(id) || model._index.byId.get(id);
  if (!node(a) || !node(b)) throw new Error('所选函数或变量不存在');
  const forward = pathsBetween(index, a, b), backward = pathsBetween(index, b, a);
  const paths = [...forward.paths, ...backward.paths];
  const ids = new Set([a, b, ...paths.flatMap(p => p.nodes)]);
  return { ok: true, a, b, paths, nodes: [...ids].map(id => {
    const n = node(id);
    return { id, name: n.name, file: n.file, line: n.line, kind: index.byId.has(id) ? 'var' : 'fn' };
  }), truncated: forward.truncated || backward.truncated, partial: index.failedFiles > 0,
  limits: { hops: MAX_HOPS, paths: MAX_PATHS * 2 }, basis: 'read-write' };
}

/** 分版本查找完整路径，绝不把 before 的写入和 after 的读取拼成一条链。 */
export async function comparisonPairDataflow(comparison, a, b) {
  const paths = new Map(), nodes = new Map();
  let truncated = false, partial = false;
  for (const [version, model] of [['before', comparison.beforeModel], ['after', comparison.afterModel]]) {
    if (!model._index.byId.has(a) || !model._index.byId.has(b)) continue;
    const result = await pairDataflow(model, a, b);
    truncated ||= result.truncated; partial ||= result.partial;
    for (const n of result.nodes) nodes.set(n.id, n);
    for (const p of result.paths) {
      const key = JSON.stringify(p.nodes);
      if (!paths.has(key)) paths.set(key, { ...p, versions: [] });
      paths.get(key).versions.push(version);
    }
  }
  return { ok: true, a, b, paths: [...paths.values()], nodes: [...nodes.values()], truncated, partial,
    limits: { hops: MAX_HOPS, paths: MAX_PATHS * 4 }, basis: 'read-write' };
}
