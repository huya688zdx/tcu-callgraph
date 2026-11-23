// 分组视图长宽比测量：全入口 × 深度，报告画布 aspect 分布（>1 为扁宽，<1 为瘦高）
import fs from 'node:fs';
import { loadModel, subgraph } from '../src/core/index.js';
import { layoutElk } from '../src/core/layout-elk.js';
import path from 'node:path';

const defaults = ['samples/deep', 'samples/demo', 'samples/tcu', 'samples/shared-state'].filter((p) => fs.existsSync(p));
const targets = process.argv.slice(2).length ? process.argv.slice(2) : defaults;

for (const t of targets) {
  const MODEL = loadModel(t);
  const ROOT_LABEL = path.basename(path.resolve(t));
  const aspects = [];
  for (const fn of MODEL.functions) {
    for (const down of [2, 3, 5]) {
      const g = subgraph(MODEL, fn.id, { up: 0, down, maxNodes: 600 });
      if (!g.nodes.length) continue;
      const laid = await layoutElk(
        g.nodes.map(({ bodyTokens, ...r }) => r),
        g.edges,
        { rootLabel: ROOT_LABEL }
      );
      const byId = new Map(laid.nodes.map((n) => [n.id, n]));
      let distSum = 0, distCnt = 0;
      for (const e of laid.edges) {
        if (e.from === e.to) continue;
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) continue;
        distSum += Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));
        distCnt++;
      }
      const a = laid.width / Math.max(1, laid.height);
      aspects.push({ id: fn.id, down, a, ratio: Math.max(a, 1 / Math.max(0.01, a)),
        avgDist: distCnt ? distSum / distCnt : 0, w: laid.width, h: laid.height, n: g.nodes.length });
    }
  }
  aspects.sort((x, y) => y.a - x.a);
  const worst = aspects.filter((x) => x.a > 2.2 || x.a < 0.45).length;
  const ratios = aspects.map((x) => x.ratio).sort((x, y) => x - y);
  const p90 = ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.9))] || 1;
  const maxRatio = ratios.at(-1) || 1;
  const meanDist = aspects.reduce((s, x) => s + x.avgDist, 0) / Math.max(1, aspects.length);
  console.log(`\n=== ${t}：${aspects.length} 个视图，离谱(aspect>2.2 或 <0.45) ${worst} 个 ===`);
  console.log('最扁（宽/高 大）:');
  for (const x of aspects.slice(0, 4)) console.log(`  ${x.a.toFixed(2)}  ${x.w.toFixed(0)}x${x.h.toFixed(0)}  n=${x.n}  ${x.id}`);
  console.log('最瘦（宽/高 小）:');
  for (const x of aspects.slice(-4).reverse()) console.log(`  ${x.a.toFixed(2)}  ${x.w.toFixed(0)}x${x.h.toFixed(0)}  n=${x.n}  ${x.id}`);
  const med = aspects.map((x) => x.a).sort((a, b) => a - b)[Math.floor(aspects.length / 2)];
  console.log(`中位 aspect: ${med.toFixed(2)}  长短边 P90: ${p90.toFixed(2)}  最极端: ${maxRatio.toFixed(2)}  均连接距: ${meanDist.toFixed(0)}`);
}
