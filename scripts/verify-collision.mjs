// 全量碰撞回归：遍历所有入口 × 深度，检查文件框/目录容器是否物理重叠
// 用法: node scripts/verify-collision.mjs [样本目录]
import path from 'node:path';
import { loadModel, subgraph } from '../src/core/index.js';
import { layoutGrouped } from '../src/core/layout.js';

const TARGET = process.argv[2] || 'samples/deep';
const MODEL = loadModel(TARGET);
const ROOT_LABEL = path.basename(path.resolve(TARGET));

const inter = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);
const overlapBox = (a, b) => {
  const ox = inter(a.x, a.x + a.w, b.x, b.x + b.w);
  const oy = inter(a.y, a.y + a.h, b.y, b.y + b.h);
  return ox > 0.5 && oy > 0.5 ? { ox, oy } : null;
};
const isAncestor = (a, b) => b.id.startsWith(a.id + '/');

function checkView(rootId, down) {
  const g = subgraph(MODEL, rootId, { up: 0, down, maxNodes: 600 });
  const laid = layoutGrouped(
    g.nodes.map(({ bodyTokens, ...r }) => r),
    g.edges,
    { rootLabel: ROOT_LABEL }
  );
  const files = laid.groups || [];
  const conts = laid.containers || [];
  const bad = [];

  // 根容器包住一切，不算「交叉」；其余容器仍按路径前缀判断父子
  const rootC = conts.find((c) => c.root);
  const dirs = conts.filter((c) => !c.root);

  for (let i = 0; i < files.length; i++)
    for (let j = i + 1; j < files.length; j++) {
      const o = overlapBox(files[i], files[j]);
      if (o) bad.push(`文件框重叠 ${files[i].id} <-> ${files[j].id} (${o.ox.toFixed(0)}x${o.oy.toFixed(0)})`);
    }

  for (let i = 0; i < dirs.length; i++)
    for (let j = i + 1; j < dirs.length; j++) {
      const A = dirs[i];
      const B = dirs[j];
      if (isAncestor(A, B) || isAncestor(B, A)) continue;
      const o = overlapBox(A, B);
      if (o) bad.push(`容器交叉 ${A.id} <-> ${B.id} (${o.ox.toFixed(0)}x${o.oy.toFixed(0)})`);
    }

  for (const c of dirs)
    for (const f of files) {
      if (f.id.startsWith(c.id + '/')) continue;
      const o = overlapBox(c, f);
      if (o) bad.push(`文件被容器压住 ${c.id} 压 ${f.id} (${o.ox.toFixed(0)}x${o.oy.toFixed(0)})`);
    }

  // 根容器必须包住所有文件框与子容器
  if (rootC) {
    const inside = (b) =>
      b.x >= rootC.x - 1 &&
      b.y >= rootC.y - 1 &&
      b.x + b.w <= rootC.x + rootC.w + 1 &&
      b.y + b.h <= rootC.y + rootC.h + 1;
    for (const b of [...files, ...dirs]) {
      if (!inside(b)) bad.push(`根容器没包住 ${b.id || b.label}`);
    }
    if (rootC.x < 0 || rootC.y < 0) bad.push(`根容器坐标越界 (${rootC.x.toFixed(0)},${rootC.y.toFixed(0)})`);
  }

  return { bad, files: files.length, conts: conts.length };
}

let views = 0;
let badViews = 0;
const samples = [];
const maxBoxes = { files: 0, conts: 0 };

for (const fn of MODEL.functions) {
  for (const down of [1, 2, 3, 4]) {
    const r = checkView(fn.id, down);
    views++;
    maxBoxes.files = Math.max(maxBoxes.files, r.files);
    maxBoxes.conts = Math.max(maxBoxes.conts, r.conts);
    if (r.bad.length) {
      badViews++;
      if (samples.length < 6) samples.push({ root: fn.id, down, bad: r.bad });
    }
  }
}

console.log(`样本 ${TARGET}：检查 ${views} 个视图（最多 ${maxBoxes.files} 个文件框 / ${maxBoxes.conts} 个容器）`);
if (!badViews) {
  console.log('✅ 全部无碰撞');
} else {
  console.log(`❌ ${badViews} 个视图存在碰撞：`);
  for (const s of samples) {
    console.log(`  [root=${s.root} down=${s.down}]`);
    for (const b of s.bad.slice(0, 4)) console.log(`    ${b}`);
  }
}
