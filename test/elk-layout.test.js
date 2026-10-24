import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchServer } from '../scripts/lib/server.mjs';

test('ELK 默认布局：移动节点后存档仍保持连接，未受影响的路径不变', async (t) => {
  const srv = await launchServer();
  t.after(() => srv.close());
  const url = srv.baseUrl + '/api/view?root=main.c::main&group=0&down=3&fixed=1';
  const before = await (await fetch(url)).json();
  assert.equal(before.layoutEngine, 'elk');
  const node = before.nodes.find((n) => n.id === 'main.c::main');
  const position = { x: Math.round(node.x), y: Math.ceil(before.height + 100) };
  const res = await fetch(srv.baseUrl + '/api/layout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: before.root, mode: 'flat', nodes: { [node.id]: position } }),
  });
  assert.equal(res.status, 200);
  const after = await (await fetch(url)).json();
  const moved = after.nodes.find((n) => n.id === node.id);
  assert.deepEqual({ x: moved.x, y: moved.y }, position);
  const automatic = await (await fetch(url.replace('fixed=1', 'optimal=1'))).json();
  assert.equal(automatic.nodes.find((n) => n.id === node.id).y, node.y, '自动模式直接使用 ELK，不套用旧固定坐标');
  const byId = new Map(after.nodes.map((n) => [n.id, n]));
  for (const e of after.edges) {
    for (const [id, p] of [[e.from, e.points[0]], [e.to, e.points.at(-1)]]) {
      const n = byId.get(id);
      assert.ok([[n.x + n.w / 2, n.y], [n.x + n.w / 2, n.y + n.h],
        [n.x, n.y + n.h / 2], [n.x + n.w, n.y + n.h / 2]]
        .some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.5), '端点必须仍在四个中点上');
    }
    if (e.from !== node.id && e.to !== node.id) {
      const original = before.edges.find((x) => x.from === e.from && x.to === e.to && x.line === e.line);
      assert.deepEqual(e.points, original.points, '不重排未受影响的连线');
    }
  }
});
