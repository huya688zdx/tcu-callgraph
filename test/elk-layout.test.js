import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchServer } from '../scripts/lib/server.mjs';
import { layoutElk } from '../src/core/layout-elk.js';

test('默认只使用 ELK：旧模式和坐标不覆盖布局，手工关系参与排版', async (t) => {
  const srv = await launchServer();
  t.after(() => srv.close());
  const url = srv.baseUrl + '/api/view?root=main.c::main';
  const before = await (await fetch(url)).json();
  assert.equal(before.layoutEngine, 'elk');
  assert.ok(before.groups.length, '默认打开带文件层级的 ELK 布局');
  const node = before.nodes.find((n) => n.id === 'main.c::main');
  const manual = { from: node.id, to: 'can.c::Can_GetRpm' };
  const res = await fetch(srv.baseUrl + '/api/layout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: before.root, mode: 'group',
      nodes: { [node.id]: { x: 90000, y: 90000 } },
      edges: { [`${manual.from}->${manual.to}:0`]: { custom: true, points: [[1, 2], [3, 4]] } },
      manual: [manual] }),
  });
  assert.equal(res.status, 200);
  const after = await (await fetch(url)).json();
  assert.equal(after.edges.filter((e) => e.manual).length, 1, '保留手工关系');
  assert.notEqual(after.nodes.find((n) => n.id === node.id).x, 90000, '忽略旧固定坐标');
  const flagged = await (await fetch(url + '&fixed=1&optimal=0')).json();
  assert.deepEqual(flagged, after, '旧参数不能切回旧模式');
  const expected = await layoutElk(before.nodes, [...before.edges, {
    ...manual, callee: 'Can_GetRpm', kind: 'manual', line: 0, via: '手动', manual: true, change: 'existing',
  }], { group: true, rootLabel: before.containers.find((c) => c.root).label });
  assert.deepEqual(after.nodes.map(({ id, x, y }) => ({ id, x, y })),
    expected.nodes.map(({ id, x, y }) => ({ id, x, y })), '全部节点由 ELK 排版');
  assert.deepEqual(after.edges.map((e) => e.points), expected.edges.map((e) => e.points), '手工关系也使用 ELK 路径');
  const byId = new Map(after.nodes.map((n) => [n.id, n]));
  for (const e of after.edges) {
    for (const [id, point] of [[e.from, e.points[0]], [e.to, e.points.at(-1)]]) {
      const n = byId.get(id);
      assert.ok([[n.x + n.w / 2, n.y], [n.x + n.w / 2, n.y + n.h],
        [n.x, n.y + n.h / 2], [n.x + n.w, n.y + n.h / 2]]
        .some((q) => Math.hypot(q[0] - point[0], q[1] - point[1]) < 0.5), '端点仍在四个中点上');
    }
  }
});

test('ELK 自递归线保留可见回环和两个不同的居中端口', async () => {
  const view = await layoutElk([{ id: 'f', name: 'f', file: 'loop.c' }], [{ from: 'f', to: 'f', kind: 'direct' }]);
  const n = view.nodes[0], points = view.edges[0].points;
  const ports = [[n.x + n.w / 2, n.y], [n.x + n.w / 2, n.y + n.h],
    [n.x, n.y + n.h / 2], [n.x + n.w, n.y + n.h / 2]];
  assert.notDeepEqual(points[0], points.at(-1));
  for (const p of [points[0], points.at(-1)]) assert.ok(ports.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.5));
  assert.ok(new Set(points.map((p) => p[0])).size > 1 && new Set(points.map((p) => p[1])).size > 1,
    '不能退化为同一直线往返');
});
