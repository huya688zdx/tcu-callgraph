import test from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../src/core/layout.js';

// ---- 用例 1：长边拉直 ----
// 三层图（按 1 起数）：层1 = a + 孤立节点 i1/i2（a 不居中），层2 = b + 4 个宽节点，
// 层3 = c + 伴生节点 g1/g2（c 不居中）；主链边 a→b、b→c。
// 注意：Kahn 分层里无边节点全部落在层 0，所以宽节点/伴生节点要用最少的辅助边送到目标层：
// h1..h4 只负责把 w1..w4 抬到层2（与 b 同层），w1/w2 顺带把 g1/g2 抬到层3；i1/i2 保持真孤立不连边。
// BK 对齐后 b 只有一个前驱一个后继，其中心应落在 a、c 中心的中点（长边拉直成一条竖线）。
test('BK 中位对齐：长边拉直 —— b 的中心落在 a、c 中点', () => {
  const nodes = [
    { id: 'a', label: 'a' },
    { id: 'i1', label: 'i1' },
    { id: 'i2', label: 'i2' },
    { id: 'h1', label: 'h1', w: 150 },
    { id: 'h2', label: 'h2', w: 150 },
    { id: 'h3', label: 'h3', w: 150 },
    { id: 'h4', label: 'h4', w: 150 },
    { id: 'b', label: 'b' },
    { id: 'w1', label: 'w1', w: 150 },
    { id: 'w2', label: 'w2', w: 150 },
    { id: 'w3', label: 'w3', w: 150 },
    { id: 'w4', label: 'w4', w: 150 },
    { id: 'c', label: 'c' },
    { id: 'g1', label: 'g1' },
    { id: 'g2', label: 'g2' },
  ];
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'h1', to: 'w1' },
    { from: 'h2', to: 'w2' },
    { from: 'h3', to: 'w3' },
    { from: 'h4', to: 'w4' },
    { from: 'w1', to: 'g1' },
    { from: 'w2', to: 'g2' },
  ];
  // 关掉超宽层拆行（与本用例无关），专注考察 x 对齐
  const res = layout(nodes, edges, { maxRowWidth: 4000 });
  const byId = new Map(res.nodes.map((n) => [n.id, n]));
  const cx = (id) => byId.get(id).x + byId.get(id).w / 2;
  const dev = Math.abs(cx('b') - (cx('a') + cx('c')) / 2);
  assert.ok(dev <= 12, `b 中心偏离 a、c 中点 ${dev.toFixed(1)}px（应 ≤ 12）`);
});

// ---- 用例 2：层内不重叠 ----
// 漏斗形图：4 源 → 2 中（宽节点）→ 2 汇，外加孤立节点与宽节点制造挤压。
// placeLayer 的右推消叠保证同层节点两两不相交，这里直接对最终结果断言。
test('BK 中位对齐：层内不重叠 —— 任意两节点不相交', () => {
  const nodes = [
    { id: 's1', label: 's1' },
    { id: 's2', label: 's2' },
    { id: 's3', label: 's3' },
    { id: 's4', label: 's4' },
    { id: 'm1', label: 'm1', w: 200 },
    { id: 'm2', label: 'm2', w: 200 },
    { id: 't1', label: 't1' },
    { id: 't2', label: 't2' },
    { id: 'x1', label: 'x1' },
    { id: 'x2', label: 'x2', w: 220 },
  ];
  const edges = [
    { from: 's1', to: 'm1' },
    { from: 's2', to: 'm1' },
    { from: 's3', to: 'm2' },
    { from: 's4', to: 'm2' },
    { from: 'm1', to: 't1' },
    { from: 'm1', to: 't2' },
    { from: 'm2', to: 't1' },
    { from: 'm2', to: 't2' },
  ];
  const res = layout(nodes, edges);
  const TOL = 0.5;
  for (let i = 0; i < res.nodes.length; i++) {
    for (let j = i + 1; j < res.nodes.length; j++) {
      const a = res.nodes[i];
      const b = res.nodes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(!(ox > TOL && oy > TOL), `节点 ${a.id} 与 ${b.id} 重叠（交叠 ${ox.toFixed(1)}x${oy.toFixed(1)}）`);
    }
  }
});

// ---- 用例 3：长宽比护栏 ----
// 20 层链不折行会排成 1:N 细长条；层带折行机制应把长宽比拉回 1:1 附近。
// 守住 BK 改造没有破坏第 7 步的拆行/折行。
test('BK 中位对齐：长宽比护栏 —— 20 层链 |log(width/height)| ≤ 1.2', () => {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < 20; i++) nodes.push({ id: `n${i}`, label: `n${i}` });
  for (let i = 0; i < 19; i++) edges.push({ from: `n${i}`, to: `n${i + 1}` });
  const res = layout(nodes, edges);
  const ratio = Math.abs(Math.log(res.width / res.height));
  assert.ok(
    ratio <= 1.2,
    `长宽比 |log(${res.width.toFixed(0)}/${res.height.toFixed(0)})| = ${ratio.toFixed(2)} 超出 1.2`
  );
});
