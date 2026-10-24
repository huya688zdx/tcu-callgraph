import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutPartitioned, layoutGrouped, routeLengthAndCrossings } from '../src/core/layout.js';
import { routeEdges } from '../src/core/routing.js';

// forceR：固定列内单元数时只排这一种结构，返回值带 R 与列数
test('layoutPartitioned 支持 forceR 固定列结构', () => {
  const items = [
    { id: 'a', name: 'a', w: 200, h: 100 },
    { id: 'b', name: 'b', w: 200, h: 100 },
    { id: 'c', name: 'c', w: 200, h: 100 },
    { id: 'd', name: 'd', w: 200, h: 100 },
  ];
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
  ];
  const laid = layoutPartitioned(items, edges, { forceR: items.length });
  assert.equal(laid.R, items.length, 'forceR=单元数 应单列');
  assert.equal(laid.columns, 1, '单列时列数为 1');
  const pos = [...laid.pos.values()];
  const sameX = new Set(pos.map((p) => p.x)).size === 1;
  assert.ok(sameX, '单列时所有单元同一起始 x');
});

// 度量驱动微调冒烟：两文件互调可降交叉的 fixture，layoutGrouped 正常产出且框不重叠
test('layoutGrouped 文件框排布微调正常产出', () => {
  const nodes = [
    { id: 'f1', label: 'f1', file: 'app/main.c' },
    { id: 'g1', label: 'g1', file: 'lib/util.c' },
    { id: 'g2', label: 'g2', file: 'lib/util.c' },
  ];
  const edges = [
    { from: 'f1', to: 'g1', kind: 'direct' },
    { from: 'f1', to: 'g2', kind: 'direct' },
  ];
  const res = layoutGrouped(nodes, edges, { rootLabel: 'proj' });
  assert.equal(res.groups.length, 2);
  for (let i = 0; i < res.groups.length; i++) {
    for (let j = i + 1; j < res.groups.length; j++) {
      const a = res.groups[i];
      const b = res.groups[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(ox <= 0.5 || oy <= 0.5, `文件框 ${a.id} 与 ${b.id} 不应重叠`);
    }
  }
});

// ---- 文件框交换局部搜索的 fixture ----
// 三个文件：a.c 调 c2（c.c 右目标）、b.c 调 c1（左目标）。a、b 之间没有直接调用边 →
// 同 rank 相邻；级内重心对两者并列，初排保持输入序 [a, b]。
// c1/c2 给 h:150 压掉「竖排」旋转候选，保证 c.c 内部 c1 左、c2 右并排。
// 于是初排 [a,b] 的两条线互相对穿（1 交叉），交换成 [b,a] 后各接近端（0 交叉）。
const mkNodes = (callerOrder) =>
  callerOrder === 'bad'
    ? [
        { id: 'a1', label: 'a1', file: 'm/a.c', w: 60 },
        { id: 'b1', label: 'b1', file: 'm/b.c', w: 60 },
        { id: 'c1', label: 'c1', file: 'm/c.c', h: 150 },
        { id: 'c2', label: 'c2', file: 'm/c.c', h: 150 },
      ]
    : [
        { id: 'b1', label: 'b1', file: 'm/b.c', w: 60 },
        { id: 'a1', label: 'a1', file: 'm/a.c', w: 60 },
        { id: 'c1', label: 'c1', file: 'm/c.c', h: 150 },
        { id: 'c2', label: 'c2', file: 'm/c.c', h: 150 },
      ];
const mkEdges = () => [
  { from: 'a1', to: 'c2', kind: 'direct' },
  { from: 'b1', to: 'c1', kind: 'direct' },
];

// 复刻 measureGroupPlacement 的组装口径：按落位平移文件内函数节点 → 统一路由 → 实测 crossings
function measureArrangement(posA, posB) {
  const inner = new Map([
    ['m/a.c', { nodes: [{ id: 'a1', x: 14, y: 40, w: 60, h: 44 }] }],
    ['m/b.c', { nodes: [{ id: 'b1', x: 14, y: 40, w: 60, h: 44 }] }],
    ['m/c.c', { nodes: [{ id: 'c1', x: 14, y: 40, w: 120, h: 150 }, { id: 'c2', x: 160, y: 40, w: 120, h: 150 }] }],
  ]);
  const pos = new Map([
    ['m/a.c', posA],
    ['m/b.c', posB],
    ['m/c.c', { x: 0, y: 158 }], // 下排被调框，两种次序下位置相同
  ]);
  const tempNodes = [];
  for (const [file, laid] of inner) {
    const base = pos.get(file);
    for (const fn of laid.nodes) {
      tempNodes.push({ ...fn, x: base.x + fn.x, y: base.y + fn.y, group: file });
    }
  }
  const tempEdges = mkEdges();
  routeEdges(tempNodes, tempEdges);
  return routeLengthAndCrossings(tempEdges).crossings;
}

// 采纳判据：交换后实测 crossings 必须低于不交换的对照
test('layoutGrouped 文件框交换采纳后实测 crossings 低于不交换对照', () => {
  // 对照实测：同一落位几何下，不交换的初排 [a左b右] 与交换后 [b左a右]
  const controlCross = measureArrangement({ x: 14, y: 14 }, { x: 142, y: 14 });
  const swappedCross = measureArrangement({ x: 142, y: 14 }, { x: 14, y: 14 });
  assert.ok(swappedCross < controlCross, `fixture 前提不成立：交换后 ${swappedCross} 应低于对照 ${controlCross}`);

  // 端到端：初排 [a,b] 走交换搜索，应采纳交换并达到交换后的交叉数
  const res = layoutGrouped(mkNodes('bad'), mkEdges(), {});
  const finalCross = routeLengthAndCrossings(res.edges).crossings;
  assert.ok(finalCross < controlCross, `采纳交换后 crossings ${finalCross} 应低于不交换对照 ${controlCross}`);
  assert.equal(finalCross, swappedCross, '搜索应恢复到交换后的最优落位');

  // 交换确实发生：调左目标的 b.c 排到了调右目标的 a.c 左边（同排比 x）
  const byId = new Map(res.groups.map((g) => [g.id, g]));
  assert.ok(byId.get('m/b.c').x < byId.get('m/a.c').x, 'b.c 应被换到 a.c 左侧');
});

// 预排成最优序时无可改善空间，交换不采纳，产出与搜索恢复的解一致
test('layoutGrouped 已是最优次序时不交换且交叉数一致', () => {
  const res = layoutGrouped(mkNodes('good'), mkEdges(), {});
  const cross = routeLengthAndCrossings(res.edges).crossings;
  assert.equal(cross, 0, '预排最优序应为 0 交叉');
  const byId = new Map(res.groups.map((g) => [g.id, g]));
  assert.ok(byId.get('m/b.c').x < byId.get('m/a.c').x, '最优序保持 b.c 在左');
});
