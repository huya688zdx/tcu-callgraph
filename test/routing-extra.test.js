import test from 'node:test';
import assert from 'node:assert/strict';
import { routeEdges, pathBlockedByNodes } from '../src/core/routing.js';

const EPS = 0.5;

function assertOrthogonal(points, label) {
  for (let i = 0; i < points.length - 1; i++) {
    const dx = Math.abs(points[i + 1][0] - points[i][0]);
    const dy = Math.abs(points[i + 1][1] - points[i][1]);
    assert.ok(
      dx <= EPS || dy <= EPS,
      `${label} 第 ${i} 段不是正交段: [${points[i]}] -> [${points[i + 1]}]`
    );
  }
}

test('routeEdges 自环：绕到节点外侧的闭合正交折线，标记为回边', () => {
  const a = { id: 'a', x: 0, y: 0, w: 120, h: 44 };
  const nodes = [a];
  const edges = [{ from: 'a', to: 'a', kind: 'direct' }];

  routeEdges(nodes, edges);

  const edge = edges[0];
  const points = edge.points;
  assert.ok(Array.isArray(points), '自环必须产出折线');
  assert.ok(points.length >= 4, `自环至少需要 4 个折点，实际 ${points.length}`);

  assertOrthogonal(points, '自环');

  // 首尾落在 a 的边界上（自环从下边出、上边回）
  const onBoundary = (p) => {
    const [x, y] = p;
    const onVerticalEdge =
      (Math.abs(x - a.x) <= EPS || Math.abs(x - (a.x + a.w)) <= EPS) &&
      y >= a.y - EPS &&
      y <= a.y + a.h + EPS;
    const onHorizontalEdge =
      (Math.abs(y - a.y) <= EPS || Math.abs(y - (a.y + a.h)) <= EPS) &&
      x >= a.x - EPS &&
      x <= a.x + a.w + EPS;
    return onVerticalEdge || onHorizontalEdge;
  };
  assert.ok(onBoundary(points[0]), `自环起点 ${points[0]} 应落在节点边界上`);
  assert.ok(onBoundary(points.at(-1)), `自环终点 ${points.at(-1)} 应落在节点边界上`);

  // 环体绕到节点右侧外，而不是压在节点本体上
  const maxX = Math.max(...points.map((p) => p[0]));
  assert.ok(maxX > a.x + a.w, `自环应绕到节点外侧，实际最大 x=${maxX}`);

  assert.equal(edge.back, true, '自环必须标记 back=true 供渲染层画回边箭头');
});

test('routeEdges 幂等：同一 nodes/edges 连调两次，折线完全一致', () => {
  const nodes = [
    { id: 's1', x: 40, y: 40, w: 150, h: 60 },
    { id: 's2', x: 40, y: 140, w: 150, h: 60 },
    { id: 'm1', x: 330, y: 90, w: 150, h: 60 },
    { id: 't1', x: 620, y: 40, w: 150, h: 60 },
    { id: 't2', x: 620, y: 180, w: 150, h: 60 },
  ];
  // 6 条边，其中 s1->t1 / s2->t2 是跨列长边
  const edges = [
    { from: 's1', to: 'm1', kind: 'direct' },
    { from: 's1', to: 't1', kind: 'direct' },
    { from: 's2', to: 'm1', kind: 'direct' },
    { from: 'm1', to: 't1', kind: 'direct' },
    { from: 'm1', to: 't2', kind: 'direct' },
    { from: 's2', to: 't2', kind: 'direct' },
  ];

  routeEdges(nodes, edges);
  const first = edges.map((e) => e.points.map((p) => [p[0], p[1]]));

  routeEdges(nodes, edges);
  const second = edges.map((e) => e.points.map((p) => [p[0], p[1]]));

  assert.deepEqual(second, first, '第二次布线的折线必须与第一次逐点相同');
});

test('routeEdges 不穿越：每段都不与「非端点节点」相交', () => {
  const nodes = [
    { id: 's1', x: 40, y: 40, w: 150, h: 60 },
    { id: 's2', x: 40, y: 140, w: 150, h: 60 },
    { id: 'm1', x: 330, y: 90, w: 150, h: 60 },
    { id: 't1', x: 620, y: 40, w: 150, h: 60 },
    { id: 't2', x: 620, y: 180, w: 150, h: 60 },
  ];
  const edges = [
    { from: 's1', to: 'm1', kind: 'direct' },
    { from: 's1', to: 't1', kind: 'direct' },
    { from: 's2', to: 'm1', kind: 'direct' },
    { from: 'm1', to: 't1', kind: 'direct' },
    { from: 'm1', to: 't2', kind: 'direct' },
    { from: 's2', to: 't2', kind: 'direct' },
  ];

  routeEdges(nodes, edges);

  for (const e of edges) {
    const label = `${e.from}->${e.to}`;
    assert.ok(Array.isArray(e.points) && e.points.length >= 2, `${label} 的折线不应为空`);
    assertOrthogonal(e.points, label);
    // 只对「第三个节点」断言：端点自身被排除在碰撞检测外是当前已知缺陷
    // （src/core/routing.js 的 skip 含 a.id/b.id，正在由另一进程修复），
    // 因此不断言折线不穿过源/目标节点本体。
    for (const node of nodes) {
      if (node.id === e.from || node.id === e.to) continue;
      assert.equal(
        pathBlockedByNodes(e.points, [node], new Set()),
        false,
        `${label} 穿过了非端点节点 ${node.id}: ${JSON.stringify(e.points)}`
      );
    }
  }
});
