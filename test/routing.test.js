import test from 'node:test';
import assert from 'node:assert/strict';
import { routeEdges } from '../src/core/routing.js';

test('同源同类型的右侧扇出共用出口，同时保留各自的目标箭头端点', () => {
  const nodes = [
    { id: 'source', x: 40, y: 120, w: 150, h: 60 },
    { id: 'target-a', x: 330, y: 30, w: 140, h: 52 },
    { id: 'target-b', x: 330, y: 124, w: 140, h: 52 },
    { id: 'target-c', x: 330, y: 218, w: 140, h: 52 },
  ];
  const edges = ['target-a', 'target-b', 'target-c'].map((to) => ({
    from: 'source',
    to,
    kind: 'direct',
  }));

  routeEdges(nodes, edges);

  const starts = edges.map((edge) => edge.points[0]);
  assert.deepEqual(starts[1], starts[0]);
  assert.deepEqual(starts[2], starts[0]);

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    const target = nodeById.get(edge.to);
    const end = edge.points.at(-1);
    const beforeEnd = edge.points.at(-2);
    assert.ok(
      end[0] === target.x || end[0] === target.x + target.w ||
      end[1] === target.y || end[1] === target.y + target.h,
      `箭头端点应落在 ${edge.to} 的边界上，实际为 ${end}`
    );
    if (end[0] === target.x) assert.ok(beforeEnd[0] < end[0], '左侧箭头必须朝右进入目标');
    else if (end[0] === target.x + target.w) assert.ok(beforeEnd[0] > end[0], '右侧箭头必须朝左进入目标');
    else if (end[1] === target.y) assert.ok(beforeEnd[1] > end[1], '上侧箭头必须朝下进入目标');
    else assert.ok(beforeEnd[1] < end[1], '下侧箭头必须朝上进入目标');
    assert.notDeepEqual(edge.points[0], end, '箭头方向不能退化成零长度');
  }
  assert.equal(new Set(edges.map((edge) => edge.points.at(-1).join(','))).size, edges.length);
});

test('目标入边方向不同时不合并源出口', () => {
  const nodes = [
    { id: 'source', x: 40, y: 120, w: 150, h: 60 },
    { id: 'target-left', x: 330, y: 124, w: 140, h: 52 },
    { id: 'target-top', x: 330, y: 218, w: 140, h: 52 },
  ];
  const edges = [
    { from: 'source', to: 'target-left', kind: 'direct' },
    { from: 'source', to: 'target-top', kind: 'direct', toSide: 'top' },
  ];

  routeEdges(nodes, edges);

  assert.notDeepEqual(
    edges[0].points[0],
    edges[1].points[0],
    '目标箭头方向不同时应保留独立源出口'
  );
  assert.equal(edges[0].points.at(-1)[0], nodes[1].x, '左向箭头应从目标左侧进入');
  assert.equal(edges[1].points.at(-1)[1], nodes[2].y, '上向箭头应从目标顶部进入');
});
