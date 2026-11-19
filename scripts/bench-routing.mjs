// node scripts/bench-routing.mjs [每层函数数，默认 16] [mixed]。预热一次，取三次完整布局的中位数。
import { layoutElk } from '../src/core/layout-elk.js';
import { routeLengthAndCrossings } from '../src/core/layout-metrics.js';
import { pathCrossesBody } from '../src/core/routing.js';

const rows = Number(process.argv[2] ?? 16);
const mixed = process.argv[3] === 'mixed';
if (!Number.isInteger(rows) || rows < 5) throw new Error('每层至少需要 5 个函数');
const edges = [];
for (let layer = 0; layer < 5; layer++) {
  for (let row = 0; row < rows; row++) {
    for (const offset of [0, 1, 4]) {
      const target = (row + offset) % rows;
      const edge = { from: 'f' + (layer * rows + row), to: 'f' + ((layer + 1) * rows + target),
        kind: 'direct', line: offset + 1 };
      if (mixed && offset === 4) {
        edge.kind = row % 2 ? 'macro' : 'fnptr';
        if (row % 7 === 0) edge.change = layer % 2 ? 'deleted' : 'added';
      }
      edges.push(edge);
    }
  }
}
if (mixed) {
  for (let layer = 0; layer < 6; layer++) {
    const first = layer * rows;
    for (let row = 0; row < rows; row += 3) {
      edges.push({ from: 'f' + (first + row), to: 'v' + layer, kind: 'var', line: 10 });
    }
    if (layer > 0) edges.push({ from: 'f' + (first + 1), to: 'f' + (first - rows), kind: 'fnptr', line: 12 });
    if (layer % 2 === 0) edges.push({ from: 'f' + first, to: 'f' + first, kind: 'direct', line: 13 });
    if (layer < 4) edges.push({ from: 'f' + first, to: 'f' + (first + 2 * rows), kind: 'direct', line: 14 });
  }
}

for (const separateFiles of [false, true]) {
  const nodes = Array.from({ length: 6 * rows }, (_, i) => ({
    id: 'f' + i, name: 'Fn_' + i, file: separateFiles ? 'src/l' + Math.floor(i / rows) + '.c' : 'calls.c',
  }));
  if (mixed) for (let layer = 0; layer < 6; layer++) {
    nodes.push({ id: 'v' + layer, name: 'State_' + layer, kind: 'var', file: nodes[layer * rows].file });
  }
  await layoutElk(nodes, edges);
  const times = [];
  let view;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    view = await layoutElk(nodes, edges);
    times.push(performance.now() - start);
  }
  const { length, overlapLength, styleOverlapLength, crossings } = routeLengthAndCrossings(view.edges);
  const throughNodes = view.edges.filter((e) => view.nodes.some((n) => pathCrossesBody(e.points, n))).length;
  const median = times.sort((a, b) => a - b)[1];
  console.log(JSON.stringify({ mixed, files: separateFiles ? 6 : 1, nodes: view.nodes.length, edges: view.edges.length,
    medianMs: Math.round(median), visibleLength: Math.round(length), overlapLength, styleOverlapLength, crossings, throughNodes }));
}
