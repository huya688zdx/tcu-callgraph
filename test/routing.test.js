import test from 'node:test';
import assert from 'node:assert/strict';
import { routeEdges, routeOverlapConflicts } from '../src/core/routing.js';

test('小幅移动保留已有走廊，直线仅在端部补折弯且不变成手工线', () => {
  const nodes = [
    { id: 'a', x: 40, y: 100, w: 140, h: 60 },
    { id: 'b', x: 420, y: 300, w: 140, h: 60 },
    { id: 'c', x: 420, y: 100, w: 140, h: 60 },
  ];
  const edges = [
    { from: 'a', to: 'b', points: [[180, 130], [260, 130], [260, 330], [420, 330]] },
    { from: 'a', to: 'c', points: [[180, 130], [420, 130]] },
  ];
  nodes[0].y += 5;
  routeEdges(nodes, edges, { preservePaths: true });
  assert.deepEqual(edges[0].points, [[180, 135], [260, 135], [260, 330], [420, 330]]);
  assert.deepEqual(edges[1].points, [[180, 135], [300, 135], [300, 130], [420, 130]]);
  assert.ok(edges.every((e) => !e.custom), '自动路径不能被固化成手工线');
  nodes.push({ id: 'blocker', x: 220, y: 90, w: 30, h: 40 });
  nodes[0].y = 95;
  edges[0].points = [[180, 130], [260, 130], [260, 330], [420, 330]];
  routeEdges(nodes, [edges[0]], { preservePaths: true });
  assert.deepEqual(edges[0].points,
    [[180, 125], [195, 125], [195, 130], [260, 130], [260, 330], [420, 330]],
    '邻近函数挡住端部时，只加短连接，远处走廊不变');
});

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

test('每面一口制：目标入边方向不同也共用同一个源出口', () => {
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

  assert.deepEqual(
    edges[0].points[0],
    edges[1].points[0],
    '同源同类型即使目标入面不同也应共用一个源出口'
  );
  assert.equal(edges[0].points.at(-1)[0], nodes[1].x, '左向箭头应从目标左侧进入');
  assert.equal(edges[1].points.at(-1)[1], nodes[2].y, '上向箭头应从目标顶部进入');
});

test('每面一口制：同一目标的多个入口与同侧出口共用边中点', () => {
  const nodes = [
    { id: 't1', x: 40, y: 40, w: 150, h: 60 },
    { id: 't2', x: 40, y: 200, w: 150, h: 60 },
    { id: 'hub', x: 400, y: 120, w: 160, h: 60 },
  ];
  const edges = [
    { from: 't1', to: 'hub', kind: 'direct' },
    { from: 't2', to: 'hub', kind: 'direct' },
    { from: 'hub', to: 't1', kind: 'direct', fromSide: 'left' },
  ];

  routeEdges(nodes, edges);

  const ends = edges.slice(0, 2).map((edge) => edge.points.at(-1));
  assert.deepEqual(ends[0], ends[1], '同目标同类型的入边应共用一个入端口');
  assert.equal(ends[0][0], nodes[2].x, '入端口应落在 hub 左侧边界');
  assert.deepEqual(ends[0], [nodes[2].x, nodes[2].y + nodes[2].h / 2]);
  assert.deepEqual(edges[2].points[0], ends[0], '同侧出口不能再偏移出第二个连接点');
  const ys = ends.map((p) => p[1]);
  for (const y of ys) {
    assert.ok(y > nodes[2].y && y < nodes[2].y + nodes[2].h, `入端口须在边界上：${y}`);
  }
});

test('四个边中点：直连不绕弯，手工折线和节点移动后也不能增加连接点', () => {
  const nodes = [
    { id: 'a', x: 40, y: 40, w: 120, h: 44 },
    { id: 'b', x: 40, y: 220, w: 120, h: 44 },
    { id: 'c', x: 320, y: 220, w: 120, h: 44 },
  ];
  const edges = [
    { from: 'a', to: 'b', kind: 'direct' },
    { from: 'b', to: 'a', kind: 'direct' },
    { from: 'c', to: 'b', kind: 'direct', custom: true, points: [[320, 250], [160, 250]] },
    { from: 'b', to: 'b', kind: 'direct' },
  ];
  routeEdges(nodes, edges);
  assert.deepEqual(edges[0].points, [[100, 84], [100, 220]], '对齐且无遮挡时只保留两个端点');
  nodes[1].x += 27;
  routeEdges(nodes, edges);
  for (const e of edges) {
    for (const [id, point] of [[e.from, e.points[0]], [e.to, e.points.at(-1)]]) {
      const n = nodes.find((n) => n.id === id);
      const ports = [[n.x + n.w / 2, n.y], [n.x + n.w / 2, n.y + n.h],
        [n.x, n.y + n.h / 2], [n.x + n.w, n.y + n.h / 2]];
      assert.ok(ports.some((p) => p[0] === point[0] && p[1] === point[1]), `${id} 的端点必须是四个边中点之一`);
    }
  }
});

test('不同颜色、虚实线分开走，同样式的重复调用仍合并', () => {
  const nodes = [
    { id: 'a', x: 40, y: 100, w: 140, h: 60 },
    { id: 'b', x: 420, y: 100, w: 140, h: 60 },
    { id: 'v', x: 420, y: 300, w: 140, h: 60 },
  ];
  const edges = [
    { from: 'a', to: 'b', kind: 'direct', change: 'existing', line: 1 },
    { from: 'a', to: 'b', kind: 'direct', change: 'added', line: 2 },
    { from: 'a', to: 'v', kind: 'var', line: 3 },
    { from: 'a', to: 'v', kind: 'var', line: 4 },
  ];
  routeEdges(nodes, edges);
  assert.notDeepEqual(edges[0].points, edges[1].points, '红线不能盖在黑线上');
  assert.deepEqual(edges[2].points, edges[3].points, '同样式重复调用仍应合并');
  assert.equal(routeOverlapConflicts(edges).length, 0, '不同样式只能共用连接点附近的短引线');
});
