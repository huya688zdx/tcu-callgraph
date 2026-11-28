import { edgeDirection } from './edge-flow.js';

/** 构建可复用的路径对象，保留原始边方向语义并识别混合方向与跨版本边界。 */
function buildPath(view, ids, rawSteps, defaultForward = true) {
  const steps = rawSteps.map(s => ({ ...s }));
  const versions = view.comparison ? ['before', 'after'].filter(v => steps.every(s =>
    !view.edges[s.edge].versions?.length || view.edges[s.edge].versions.includes(v))) : undefined;
  const directed = steps.filter(s => edgeDirection(view.edges[s.edge]) !== 'both');
  for (const step of directed) {
    if (edgeDirection(view.edges[step.edge]) === 'reverse') step.forward = !step.forward;
  }
  // 双向边可顺着路径任一方向通过，不会独自产生换向点。
  for (const step of steps) {
    if (edgeDirection(view.edges[step.edge]) === 'both') step.forward = directed[0]?.forward ?? defaultForward;
  }
  const unknown = directed.some(s => edgeDirection(view.edges[s.edge]) === 'unknown');
  const mixed = unknown || versions?.length === 0 ||
    (directed.some(s => s.forward) && directed.some(s => !s.forward));
  return { nodes: ids, steps, versions, mixed };
}

/** 在指定邻接表上执行 BFS 最短路径回溯，最多收集 maxPaths 条路径。 */
function shortestPaths(view, adjacency, a, b, maxPaths, defaultForward = true) {
  const distance = new Map([[a, 0]]), parents = new Map(), queue = [a];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i], depth = distance.get(id);
    if (distance.has(b) && depth >= distance.get(b)) break;
    for (const step of adjacency.get(id) || []) {
      if (!distance.has(step.to)) { distance.set(step.to, depth + 1); queue.push(step.to); }
      if (distance.get(step.to) !== depth + 1) continue;
      if (!parents.has(step.to)) parents.set(step.to, []);
      parents.get(step.to).push({ from: id, edge: step.edge, forward: step.forward });
    }
  }
  if (!parents.has(b)) return { dist: Infinity, paths: [], truncated: false };
  const paths = [], stack = [{ id: b, nodes: [b], steps: [] }];
  while (stack.length && paths.length < maxPaths) {
    const path = stack.pop();
    if (path.id === a) {
      paths.push(buildPath(view, path.nodes.toReversed(), path.steps.toReversed(), defaultForward));
    } else {
      for (const parent of parents.get(path.id) || []) {
        stack.push({
          id: parent.from,
          nodes: [...path.nodes, parent.from],
          steps: [...path.steps, { edge: parent.edge, forward: parent.forward }],
        });
      }
    }
  }
  return { dist: distance.get(b), paths, truncated: stack.length > 0 };
}

/** 只在当前可见节点和已有连线中找最短连接路径，不读取源码、不推测隐藏关系。 */
export function traceVisiblePaths(view, a, b, limit = 24) {
  const nodes = new Map(view.nodes.map(n => [n.id, n]));
  if (!nodes.has(a) || !nodes.has(b) || a === b) {
    return { ok: true, a, b, paths: [], edgeIndices: [], flowEdgeIndices: [], nodes: [], truncated: false, basis: 'visible-edges' };
  }
  const add = (adj, from, to, edge, forward) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ to, edge, forward });
  };

  // 先按真实单向流搜索最短有向流（含双向读写的连续传递及同版本比较路径），避免被较短的无向旁路/共同调用者掩盖。
  const buildDirectedAdjacency = (flowSign, version) => {
    const adj = new Map();
    for (const [index, edge] of view.edges.entries()) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to) continue;
      if (version && edge.versions?.length && !edge.versions.includes(version)) continue;
      const dir = edgeDirection(edge);
      if (dir === 'unknown') continue;
      if (flowSign === 1) {
        if (dir === 'forward' || dir === 'both') add(adj, edge.from, edge.to, index, true);
        if (dir === 'reverse' || dir === 'both') add(adj, edge.to, edge.from, index, false);
      } else {
        if (dir === 'reverse' || dir === 'both') add(adj, edge.from, edge.to, index, true);
        if (dir === 'forward' || dir === 'both') add(adj, edge.to, edge.from, index, false);
      }
    }
    return adj;
  };

  const scopes = view.comparison ? ['before', 'after'] : [null];
  const directedResults = [];
  for (const version of scopes) {
    for (const flowSign of [1, -1]) {
      const adj = buildDirectedAdjacency(flowSign, version);
      directedResults.push(shortestPaths(view, adj, a, b, limit, flowSign === 1));
    }
  }
  const dDir = Math.min(...directedResults.map(r => r.dist));

  const paths = [];
  const seenEdgeKeys = new Set();
  let truncated = false;
  const appendUnique = (candidates, wasTruncated) => {
    if (wasTruncated) truncated = true;
    for (const p of candidates) {
      const key = p.steps.map(s => s.edge).join(',');
      if (seenEdgeKeys.has(key)) continue;
      if (paths.length >= limit) {
        truncated = true;
        break;
      }
      seenEdgeKeys.add(key);
      paths.push(p);
    }
  };

  if (Number.isFinite(dDir)) {
    for (const res of directedResults) {
      if (res.dist === dDir) appendUnique(res.paths, res.truncated);
    }
  }

  const undirAdj = new Map();
  for (const [index, edge] of view.edges.entries()) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to) continue;
    add(undirAdj, edge.from, edge.to, index, true);
    add(undirAdj, edge.to, edge.from, index, false);
  }
  const undir = shortestPaths(view, undirAdj, a, b, limit, true);

  if (!Number.isFinite(dDir)) {
    appendUnique(undir.paths, undir.truncated);
  } else if (undir.dist === dDir) {
    // 真实单向流优先排在前面，防止混合方向分支数量超过 limit 时挤掉单向流；同长静态关联补齐剩余槽位。
    appendUnique(undir.paths, undir.truncated);
  }

  return { ok: true, a, b, paths, edgeIndices: [...new Set(paths.flatMap(p => p.steps.map(s => s.edge)))],
    flowEdgeIndices: [...new Set(paths.filter(p => !p.mixed).flatMap(p => p.steps.map(s => s.edge)))],
    nodes: [...new Set(paths.flatMap(p => p.nodes))].map(id => ({ id, name: nodes.get(id).name })),
    truncated, basis: 'visible-edges' };
}

/** 路径使用连线下标，结构/顺序变化后重新查找；拖动和缩放无需重新遍历。 */
export const visibleGraphKey = view => JSON.stringify([view.nodes.map(n => n.id),
  view.edges.map(e => [e.from, e.to, e.kind, e.via, e.versions])]);

/** 最短路径中共用边的正反向一致，按方向赋色可同时保留连续段和换向边界；优先保留靠前（单向流）路径的方向颜色。 */
export function pathEdgeColors(paths) {
  const colors = new Map();
  for (const path of paths) {
    for (const step of path.steps) {
      if (!colors.has(step.edge)) colors.set(step.edge, step.forward ? '#2563EB' : '#C26A08');
    }
  }
  return colors;
}
