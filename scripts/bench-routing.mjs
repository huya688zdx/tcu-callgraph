// node scripts/bench-routing.mjs [每层函数数，默认 16]。预热一次，取三次完整布局的中位数。
import { layoutElk } from '../src/core/layout-elk.js';
import { routeLengthAndCrossings } from '../src/core/layout-metrics.js';

const rows = Number(process.argv[2] ?? 16);
if (!Number.isInteger(rows) || rows < 5) throw new Error('每层至少需要 5 个函数');
const edges = [];
for (let layer = 0; layer < 5; layer++) {
  for (let row = 0; row < rows; row++) {
    for (const offset of [0, 1, 4]) {
      const target = (row + offset) % rows;
      edges.push({ from: 'f' + (layer * rows + row), to: 'f' + ((layer + 1) * rows + target),
        kind: 'direct', line: offset + 1 });
    }
  }
}

for (const separateFiles of [false, true]) {
  const nodes = Array.from({ length: 6 * rows }, (_, i) => ({
    id: 'f' + i, name: 'Fn_' + i, file: separateFiles ? 'src/l' + Math.floor(i / rows) + '.c' : 'calls.c',
  }));
  await layoutElk(nodes, edges);
  const times = [];
  let view;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    view = await layoutElk(nodes, edges);
    times.push(performance.now() - start);
  }
  const { overlapLength, crossings } = routeLengthAndCrossings(view.edges);
  const median = times.sort((a, b) => a - b)[1];
  console.log(JSON.stringify({ files: separateFiles ? 6 : 1, nodes: view.nodes.length, edges: view.edges.length,
    medianMs: Math.round(median), overlapLength, crossings }));
}
