// 分组视图长宽比测量：全入口 × 深度，报告画布 aspect 分布（>1 为扁宽，<1 为瘦高）
import { loadModel, subgraph } from '../src/core/index.js';
import { layoutGrouped } from '../src/core/layout.js';
import path from 'node:path';

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['samples/deep', 'samples/demo', 'samples/tcu', 'samples/large'];

for (const t of targets) {
  const MODEL = loadModel(t);
  const ROOT_LABEL = path.basename(path.resolve(t));
  const aspects = [];
  for (const fn of MODEL.functions) {
    for (const down of [2, 3, 5]) {
      const g = subgraph(MODEL, fn.id, { up: 0, down, maxNodes: 600 });
      if (!g.nodes.length) continue;
      const laid = layoutGrouped(
        g.nodes.map(({ bodyTokens, ...r }) => r),
        g.edges,
        { rootLabel: ROOT_LABEL }
      );
      aspects.push({ id: fn.id, down, a: laid.width / Math.max(1, laid.height), w: laid.width, h: laid.height, n: g.nodes.length });
    }
  }
  aspects.sort((x, y) => y.a - x.a);
  const worst = aspects.filter((x) => x.a > 2.2 || x.a < 0.45).length;
  console.log(`\n=== ${t}：${aspects.length} 个视图，离谱(aspect>2.2 或 <0.45) ${worst} 个 ===`);
  console.log('最扁（宽/高 大）:');
  for (const x of aspects.slice(0, 4)) console.log(`  ${x.a.toFixed(2)}  ${x.w.toFixed(0)}x${x.h.toFixed(0)}  n=${x.n}  ${x.id}`);
  console.log('最瘦（宽/高 小）:');
  for (const x of aspects.slice(-4).reverse()) console.log(`  ${x.a.toFixed(2)}  ${x.w.toFixed(0)}x${x.h.toFixed(0)}  n=${x.n}  ${x.id}`);
  const med = aspects.map((x) => x.a).sort((a, b) => a - b)[Math.floor(aspects.length / 2)];
  console.log(`中位 aspect: ${med.toFixed(2)}`);
}
