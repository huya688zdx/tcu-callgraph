/** 只在当前可见节点和已有连线中找最短连接路径，不读取源码、不推测隐藏关系。 */
export function traceVisiblePaths(view, a, b, limit = 24) {
  const nodes = new Map(view.nodes.map(n => [n.id, n])), adjacency = new Map();
  const add = (from, to, edge, forward) => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push({ to, edge, forward });
  };
  for (const [index, edge] of view.edges.entries()) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to) continue;
    add(edge.from, edge.to, index, true);
    add(edge.to, edge.from, index, false);
  }
  const distance = new Map([[a, 0]]), parents = new Map(), queue = [a];
  for (let i = 0; i < queue.length && nodes.has(a) && nodes.has(b) && a !== b; i++) {
    const id = queue[i], depth = distance.get(id);
    if (distance.has(b) && depth >= distance.get(b)) break;
    for (const step of adjacency.get(id) || []) {
      if (!distance.has(step.to)) { distance.set(step.to, depth + 1); queue.push(step.to); }
      if (distance.get(step.to) !== depth + 1) continue;
      if (!parents.has(step.to)) parents.set(step.to, []);
      parents.get(step.to).push({ from: id, edge: step.edge, forward: step.forward });
    }
  }
  const paths = [], stack = a !== b && parents.has(b) ? [{ id: b, nodes: [b], steps: [] }] : [];
  while (stack.length && paths.length < limit) {
    const path = stack.pop();
    if (path.id === a) {
      const ids = path.nodes.toReversed(), steps = path.steps.toReversed();
      const versions = view.comparison ? ['before', 'after'].filter(v => steps.every(s =>
        !view.edges[s.edge].versions?.length || view.edges[s.edge].versions.includes(v))) : undefined;
      paths.push({ nodes: ids, steps, versions, mixed: steps.some(s => s.forward) && steps.some(s => !s.forward) });
    } else {
      for (const parent of parents.get(path.id) || []) stack.push({ id: parent.from,
        nodes: [...path.nodes, parent.from], steps: [...path.steps, { edge: parent.edge, forward: parent.forward }] });
    }
  }
  return { ok: true, a, b, paths, edgeIndices: [...new Set(paths.flatMap(p => p.steps.map(s => s.edge)))],
    flowEdgeIndices: [...new Set(paths.filter(p => !p.mixed).flatMap(p => p.steps.map(s => s.edge)))],
    nodes: [...new Set(paths.flatMap(p => p.nodes))].map(id => ({ id, name: nodes.get(id).name })),
    truncated: stack.length > 0, basis: 'visible-edges' };
}

/** 路径使用连线下标，结构/顺序变化后重新查找；拖动和缩放无需重新遍历。 */
export const visibleGraphKey = view => JSON.stringify([view.nodes.map(n => n.id),
  view.edges.map(e => [e.from, e.to, e.kind, e.versions])]);

/** 方向中断时换色；共用边只保留一种颜色，连续有向路径优先。 */
export function pathEdgeColors(paths) {
  const colors = new Map(), palette = ['#2563EB', '#C26A08', '#0F766E', '#BE185D'];
  for (const path of paths) if (!path.mixed) for (const step of path.steps) colors.set(step.edge, '#7C3AED');
  for (const path of paths) {
    let section = 0;
    path.steps.forEach((step, i) => {
      if (i && step.forward !== path.steps[i - 1].forward) section++;
      if (!colors.has(step.edge)) colors.set(step.edge, palette[section % palette.length]);
    });
  }
  return colors;
}
