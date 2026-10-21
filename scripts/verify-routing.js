/**
 * 路由算法验证脚本：
 *  1. 所有边必须有折线，且每一段严格水平或垂直（无斜线）
 *  2. 折线首尾必须落在两端节点的边界上
 *  3. 统计折点数量 / 通道分布
 *  4. 大样本性能测试
 */
import { loadModel, stats, subgraph } from '../src/core/index.js';
import { layout, layoutGrouped } from '../src/core/layout.js';
import { routeEdges } from '../src/core/routing.js';

const EPS = 0.51;

function validate(laid, label) {
  const byId = new Map(laid.nodes.map((n) => [n.id, n]));
  let badOrtho = 0;
  let noPts = 0;
  let badAnchor = 0;
  let bends = 0;
  let minLen = Infinity;
  const reasons = [];

  for (const e of laid.edges) {
    // 数据流边（kind:'var'）不是调用边，本来就不参与布线，不算「丢边」
    if (e.kind === 'var') continue;
    const pts = e.points;
    if (!pts || pts.length < 2) {
      noPts++;
      continue;
    }
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    // 端点贴边检查
    const onBoundary = (n, p) => {
      const near = (v, t) => Math.abs(v - t) < 1.5;
      return (
        (near(p[1], n.y) && p[0] >= n.x - 1 && p[0] <= n.x + n.w + 1) ||
        (near(p[1], n.y + n.h) && p[0] >= n.x - 1 && p[0] <= n.x + n.w + 1) ||
        (near(p[0], n.x) && p[1] >= n.y - 1 && p[1] <= n.y + n.h + 1) ||
        (near(p[0], n.x + n.w) && p[1] >= n.y - 1 && p[1] <= n.y + n.h + 1)
      );
    };
    if (a && !onBoundary(a, pts[0])) {
      badAnchor++;
      if (reasons.length < 5) reasons.push(`起点不在源节点边界: ${e.from}->${e.to}`);
    }
    if (b && !onBoundary(b, pts[pts.length - 1])) {
      badAnchor++;
      if (reasons.length < 5) reasons.push(`终点不在目标节点边界: ${e.from}->${e.to}`);
    }
    // 正交检查
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = Math.abs(pts[i + 1][0] - pts[i][0]);
      const dy = Math.abs(pts[i + 1][1] - pts[i][1]);
      if (dx > EPS && dy > EPS) {
        badOrtho++;
        if (reasons.length < 8) {
          reasons.push(`斜线段: ${e.from}->${e.to} 段${i} (${pts[i]})->(${pts[i + 1]})`);
        }
        break;
      }
      if (dx + dy > 1) minLen = Math.min(minLen, dx + dy);
    }
    bends += pts.length - 2;
  }
  const E = laid.edges.length || 1;
  console.log(
    `[${label}] 边 ${laid.edges.length} / 节点 ${laid.nodes.length} | 无折线 ${noPts} | 斜线段 ${badOrtho} | 端点脱锚 ${badAnchor} | 平均折点 ${(bends / E).toFixed(2)} | 画布 ${Math.round(laid.width)}x${Math.round(laid.height)}`
  );
  for (const r of reasons) console.log('   !! ' + r);
  return noPts === 0 && badOrtho === 0 && badAnchor === 0;
}

// ---- 1. TCU 示例 ----
const model = loadModel('samples/tcu');
console.log(`模型: 函数 ${model.functions.length} / 边 ${model.edges.length}`);
let allOk = true;

for (const fn of model.functions) {
  const g = subgraph(model, fn.id, { up: 1, down: 3 });
  if (g.edges.length < 3) continue;
  const clean = g.nodes.map(({ bodyTokens, ...rest }) => rest);
  allOk = validate(layout(clean, g.edges), `flat ${fn.name}`) && allOk;
  allOk = validate(layoutGrouped(clean, g.edges), `group ${fn.name}`) && allOk;
}

// ---- 2. 自定义边重锚定 + 线段拖拽正交性 ----
{
  const g = subgraph(model, model.functions[0].id, { up: 1, down: 3 });
  const clean = g.nodes.map(({ bodyTokens, ...rest }) => rest);
  const laid = layout(clean, g.edges);
  const e = laid.edges[0];
  e.custom = true;
  // 模拟把节点拖到很远处，再重路由（自定义边只重锚定）
  const n0 = laid.nodes.find((n) => n.id === e.from);
  n0.x += 200;
  n0.y += 150;
  routeEdges(laid.nodes, laid.edges);
  let ok = true;
  for (const p of e.points) {
    // 首段方向必须保持正交锚定
  }
  for (let i = 0; i < e.points.length - 1; i++) {
    const dx = Math.abs(e.points[i + 1][0] - e.points[i][0]);
    const dy = Math.abs(e.points[i + 1][1] - e.points[i][1]);
    if (dx > EPS && dy > EPS) ok = false;
  }
  console.log(`[custom-retarget] 重锚定后正交: ${ok ? 'PASS' : 'FAIL'} (折点 ${e.points.length - 2})`);
  allOk = allOk && ok;
}

// ---- 3. 大样本性能 ----
{
  const big = loadModel('samples/large');
  const s = stats(big);
  console.log(`\n大样本: 函数 ${s.functions} / 边 ${s.edges}`);
  const entries = big.functions.filter((f) => !(big._index.inAdj.get(f.id) || []).length);
  const root = entries.sort((a, b) => (big._index.outAdj.get(b.id) || []).length - (big._index.outAdj.get(a.id) || []).length)[0] || big.functions[0];
  const g = subgraph(big, root.id, { up: 0, down: 9, maxNodes: 600 });
  console.log(`子图: 节点 ${g.nodes.length} / 边 ${g.edges.length}`);
  const clean = g.nodes.map(({ bodyTokens, ...rest }) => rest);
  let t0 = Date.now();
  const laid = layout(clean, g.edges);
  const t1 = Date.now();
  console.log(`分层+路由耗时: ${t1 - t0} ms`);
  t0 = Date.now();
  routeEdges(laid.nodes, laid.edges);
  console.log(`全量重路由耗时: ${Date.now() - t0} ms`);
  allOk = validate(laid, 'large-flat') && allOk;
  t0 = Date.now();
  const laid2 = layoutGrouped(clean, g.edges);
  console.log(`分组布局+路由耗时: ${Date.now() - t0} ms`);
  allOk = validate(laid2, 'large-group') && allOk;
}

console.log('\n==== 总体: ' + (allOk ? 'PASS' : 'FAIL') + ' ====');
process.exitCode = allOk ? 0 : 1;
