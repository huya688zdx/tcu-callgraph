import test from 'node:test';
import assert from 'node:assert/strict';
import { routeEdges } from '../src/core/routing.js';

// 出线面统一：源 4 条出边，3 条几何朝右、1 条几何朝下（目标在其右下方），
// 统一后应全部并到右面同一个出口；折线不得穿过任何节点。
test('少数出线面并入多数面，共用同一出口', () => {
  const nodes = [
    { id: 'src', x: 100, y: 200, w: 120, h: 44 },
    { id: 't1', x: 420, y: 80, w: 140, h: 44 },
    { id: 't2', x: 420, y: 200, w: 140, h: 44 },
    { id: 't3', x: 420, y: 320, w: 140, h: 44 },
    { id: 't4', x: 230, y: 430, w: 140, h: 44 },
  ];
  const edges = ['t1', 't2', 't3', 't4'].map((to) => ({ from: 'src', to, kind: 'direct' }));

  routeEdges(nodes, edges);

  const starts = edges.map((e) => e.points[0]);
  for (let i = 1; i < starts.length; i++) {
    assert.deepEqual(starts[i], starts[0], `第 ${i} 条边应与第 0 条共用出口`);
  }
  assert.equal(starts[0][0], nodes[0].x + nodes[0].w, '出口应在源右面边界上');

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    for (const n of nodes) {
      if (n.id === e.from || n.id === e.to) continue;
      for (const [x, y] of e.points) {
        assert.ok(
          x <= n.x + 0.5 || x >= n.x + n.w - 0.5 || y <= n.y + 0.5 || y >= n.y + n.h - 0.5,
          `边 ${e.from}->${e.to} 的点 (${x},${y}) 穿过节点 ${n.id}`
        );
      }
    }
  }
});

// 入侧对称：4 个源指向同一目标，3 条几何从左侧进入、1 条从正下方进入
// （下方源与目标横向重叠，从左进入不构成绕行），统一后共用左面同一个入口。
test('少数入线面并入多数面，共用同一入口', () => {
  const nodes = [
    { id: 'hub', x: 500, y: 200, w: 140, h: 44 },
    { id: 's1', x: 100, y: 80, w: 140, h: 44 },
    { id: 's2', x: 100, y: 200, w: 140, h: 44 },
    { id: 's3', x: 100, y: 320, w: 140, h: 44 },
    { id: 's4', x: 500, y: 420, w: 140, h: 44 },
  ];
  const edges = ['s1', 's2', 's3', 's4'].map((from) => ({ from, to: 'hub', kind: 'direct' }));

  routeEdges(nodes, edges);

  const ends = edges.map((e) => e.points[e.points.length - 1]);
  for (let i = 1; i < ends.length; i++) {
    assert.deepEqual(ends[i], ends[0], `第 ${i} 条边应与第 0 条共用入口`);
  }
});
