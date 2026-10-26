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

test('完整布局将细长调用链折成接近正方形，仍使用四中点端口', async () => {
  const nodes = Array.from({ length: 16 }, (_, i) => ({ id: 'n' + i, name: 'Task_' + i, file: 'chain.c' }));
  const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id, kind: 'direct', line: i }));
  const view = await layoutElk(nodes, edges);
  assert.ok(view.width / view.height > 0.75 && view.width / view.height < 1.34, '不能仍是一条细长横排或竖排');
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  for (const e of view.edges) for (const [id, p] of [[e.from, e.points[0]], [e.to, e.points.at(-1)]]) {
    const n = byId.get(id);
    assert.ok([[n.x + n.w / 2, n.y], [n.x + n.w / 2, n.y + n.h], [n.x, n.y + n.h / 2],
      [n.x + n.w, n.y + n.h / 2]].some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.5));
  }
});

test('跨文件变量布局减少向右绕行的台阶', async () => {
  const nodes = [['f', 'bsw/can.c'], ['buf', 'bsw/can.c'], ['len', 'bsw/can.c'],
    ['state', 'bsw/can.c'], ['fail', 'bsw/can.c'], ['gear', 'app/control.c'],
    ['tick', 'main.c'], ['rpm', 'main.c'], ['speed', 'main.c']]
    .map(([id, file]) => ({ id, file, name: id, w: id === 'f' ? 180.8 : 120, h: 44 }));
  const edges = nodes.slice(1).filter((n) => n.id !== 'len').map((n, line) => ({ from: 'f', to: n.id, kind: 'var', line }));
  const view = await layoutElk(nodes, edges);
  assert.ok(view.edges.find((e) => e.to === 'gear').points.length < 6, '比原先向右绕行的六点路径更简洁');
});

test('增量布局保留已有顺序，删除新增项后其余坐标和路径不变', async () => {
  const srv = await launchServer();
  try {
    const before = await (await fetch(srv.baseUrl + '/api/view?root=main.c::main')).json();
    const nodes = [...before.nodes, { id: 'v', name: 'global_var', kind: 'var', file: 'main.c', w: 120, h: 44 }];
    const edges = [...before.edges, { from: before.root, to: 'v', kind: 'var', line: 0 }];
    const added = await layoutElk(nodes, edges, { previous: before });
    const byId = new Map(added.nodes.map((n) => [n.id, n]));
    const main = before.nodes.find((n) => n.id === before.root);
    assert.ok(Math.abs(byId.get(main.id).y - main.y) < 60, '加入变量不应让入口函数大幅跳动');
    for (const a of before.nodes) for (const b of before.nodes) {
      if (a.group === b.group && a.y < b.y - 1) {
        assert.ok(byId.get(a.id).y < byId.get(b.id).y, '保留同一文件中已有节点的纵向顺序');
      }
    }
    const removed = await layoutElk(before.nodes, before.edges, { previous: added });
    for (const n of removed.nodes) {
      assert.deepEqual([n.x, n.y], [byId.get(n.id).x, byId.get(n.id).y], '删除不挪动剩余节点');
    }
    assert.deepEqual(removed.edges.map((e) => e.points), added.edges.slice(0, -1).map((e) => e.points));
    let cycled = removed;
    for (let round = 0; round < 4; round++) {
      // 页面通过 JSON 传回 previous，空位快照也必须能往返。
      cycled = await layoutElk(nodes, edges, { previous: JSON.parse(JSON.stringify(cycled)) });
      assert.deepEqual(cycled.nodes.map((n) => [n.id, n.x, n.y]), added.nodes.map((n) => [n.id, n.x, n.y]),
        '反复取消、加入同一变量，函数不能逐轮下移');
      assert.deepEqual(cycled.groups, added.groups, '文件框不能逐轮增高');
      assert.equal(cycled.height, added.height, '画布不能逐轮增高');
      cycled = await layoutElk(before.nodes, before.edges, { previous: cycled });
    }
  } finally { await srv.close(); }
});

test('增量布局拒绝其他工程的画面坐标', async (t) => {
  const srv = await launchServer();
  t.after(() => srv.close());
  const url = srv.baseUrl + '/api/view?root=main.c::main';
  const previous = await (await fetch(url)).json();
  previous.projectId++;
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previous }) });
  assert.equal(response.status, 409);
});

test('变量关系可单独移出并恢复，不影响同一函数的其他变量引用', async (t) => {
  const srv = await launchServer({ target: 'samples/shared-state' });
  t.after(() => srv.close());
  const query = new URLSearchParams({
    roots: 'producer.c::Sensor_Update,consumer.c::Control_Read', down: '0',
    vars: 'var::g_rpm,var::g_index',
  });
  const view = () => fetch(`${srv.baseUrl}/api/view?${query}`).then((r) => r.json());
  const edge = 'consumer.c::Control_Read->var::g_rpm:0';
  const toggle = async (restore) => {
    const response = await fetch(`${srv.baseUrl}/api/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edges: [edge], restore }),
    });
    assert.equal(response.status, 200);
  };
  assert.equal((await view()).edges.length, 4);
  await toggle(false);
  const removed = await view();
  assert.equal(removed.edges.length, 3);
  assert.ok(!removed.edges.some((e) => `${e.from}->${e.to}:${e.line}` === edge));
  assert.ok(removed.edges.some((e) => e.from === 'consumer.c::Control_Read' && e.to === 'var::g_index'));
  await toggle(true);
  const restored = await view();
  assert.equal(restored.edges.length, 4);
  assert.equal(restored.layoutEngine, 'elk');
});
