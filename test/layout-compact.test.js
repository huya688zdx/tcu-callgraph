import test from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../src/core/layout.js';

// 层间隙压实（layoutBase 第 8b 步）通过 layout() 透传的 stats 暴露：
// gapTotalBefore = 估算间隙高度之和，gapTotalAfter = 按实测走线压实后之和。
// stats 描述的是胜出候选（上下 / 左右流向）自己的压实结果。

const TOL = 0.5;

function assertNoOverlap(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(!(ox > TOL && oy > TOL), `节点 ${a.id} 与 ${b.id} 重叠`);
    }
  }
}

function assertOrthogonalEdges(edges) {
  for (const e of edges) {
    assert.ok(
      Array.isArray(e.points) && e.points.length >= 2,
      `边 ${e.from}->${e.to} 的折线至少两个点`
    );
    for (let i = 0; i + 1 < e.points.length; i++) {
      const dx = Math.abs(e.points[i][0] - e.points[i + 1][0]);
      const dy = Math.abs(e.points[i][1] - e.points[i + 1][1]);
      assert.ok(dx < TOL || dy < TOL, `边 ${e.from}->${e.to} 第 ${i} 段不是水平/垂直线段`);
    }
  }
}

test('压实统计：常见多层图 gapTotalAfter ≤ gapTotalBefore，布局仍合法', () => {
  const nodes = [
    { id: 'n1', label: 'n1' },
    { id: 'n2', label: 'n2' },
    { id: 'n3', label: 'n3' },
    { id: 'n4', label: 'n4' },
    { id: 'n5', label: 'n5' },
    { id: 'n6', label: 'n6' },
  ];
  const edges = [
    { from: 'n1', to: 'n2', kind: 'direct' },
    { from: 'n1', to: 'n3', kind: 'direct' },
    { from: 'n2', to: 'n4', kind: 'direct' },
    { from: 'n3', to: 'n4', kind: 'direct' },
    { from: 'n2', to: 'n5', kind: 'direct' },
    { from: 'n4', to: 'n6', kind: 'direct' },
    { from: 'n5', to: 'n6', kind: 'direct' },
  ];
  const res = layout(nodes, edges);
  assert.ok(res.stats, '返回值应携带 stats');
  assert.ok(typeof res.stats.gapTotalBefore === 'number', 'gapTotalBefore 应为数值');
  assert.ok(typeof res.stats.gapTotalAfter === 'number', 'gapTotalAfter 应为数值');
  assert.ok(
    res.stats.gapTotalAfter <= res.stats.gapTotalBefore,
    `压实后间隙总和不应增大：${res.stats.gapTotalAfter} ≤ ${res.stats.gapTotalBefore}`
  );
  // 压实（含重路由）之后布局依旧合法
  assertNoOverlap(res.nodes);
  assertOrthogonalEdges(res.edges);
});

test('压实：被跨层长边撑高的间隙按实测收紧（严格变小）', () => {
  // 层结构 L0={a} L1={b1..b3} L2={c} L3={d1..d3}：
  // b1..b3 → d1..d3 的长边在估算里被计入 gap1（L1|L2 之间）的通道需求把它撑高，
  // 实际路由中这些长边在 gap1 里只剩贴近源层的引出段（近乎共线）→ gap1 收紧。
  const nodes = [
    { id: 'a', label: 'a' },
    { id: 'b1', label: 'b1' },
    { id: 'b2', label: 'b2' },
    { id: 'b3', label: 'b3' },
    { id: 'c', label: 'c' },
    { id: 'd1', label: 'd1' },
    { id: 'd2', label: 'd2' },
    { id: 'd3', label: 'd3' },
  ];
  const edges = [
    { from: 'a', to: 'b1', kind: 'direct' },
    { from: 'a', to: 'b2', kind: 'direct' },
    { from: 'a', to: 'b3', kind: 'direct' },
    { from: 'b1', to: 'c', kind: 'direct' },
    { from: 'b1', to: 'd1', kind: 'direct' },
    { from: 'b2', to: 'd2', kind: 'direct' },
    { from: 'b3', to: 'd3', kind: 'direct' },
    { from: 'c', to: 'd1', kind: 'direct' },
    { from: 'c', to: 'd2', kind: 'direct' },
    { from: 'c', to: 'd3', kind: 'direct' },
  ];
  const res = layout(nodes, edges);
  assert.equal(res.layers, 4, 'fixture 应分层为 4 层');
  assert.ok(
    res.stats.gapTotalAfter < res.stats.gapTotalBefore,
    `长边撑高的间隙应被收紧：${res.stats.gapTotalAfter} < ${res.stats.gapTotalBefore}`
  );
  assertNoOverlap(res.nodes);
  assertOrthogonalEdges(res.edges);
});

test('压实：扇入 + 回边图同样收紧且重路由后不产生斜线', () => {
  const nodes = [
    { id: 'f', label: 'f' },
    { id: 'g1', label: 'g1' },
    { id: 'g2', label: 'g2' },
    { id: 'g3', label: 'g3' },
    { id: 'h', label: 'h' },
  ];
  const edges = [
    { from: 'f', to: 'g1', kind: 'direct' },
    { from: 'f', to: 'g2', kind: 'direct' },
    { from: 'f', to: 'g3', kind: 'direct' },
    { from: 'g1', to: 'h', kind: 'direct' },
    { from: 'g2', to: 'h', kind: 'direct' },
    { from: 'g3', to: 'h', kind: 'direct' },
    { from: 'h', to: 'f', kind: 'direct' }, // 回边
  ];
  const res = layout(nodes, edges);
  assert.ok(
    res.stats.gapTotalAfter <= res.stats.gapTotalBefore,
    `间隙总和只缩不扩：${res.stats.gapTotalAfter} ≤ ${res.stats.gapTotalBefore}`
  );
  assertNoOverlap(res.nodes);
  assertOrthogonalEdges(res.edges);
});
