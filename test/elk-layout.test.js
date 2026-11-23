import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchServer } from '../scripts/lib/server.mjs';
import { graphOf, layoutElk } from '../src/core/layout-elk.js';
import { routeLengthAndCrossings } from '../src/core/layout-metrics.js';
import { pathCrossesBody } from '../src/core/routing.js';

function assertMidpointPorts(view) {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  for (const e of view.edges) for (const [id, p] of [[e.from, e.points[0]], [e.to, e.points.at(-1)]]) {
    const n = byId.get(id);
    assert.ok([[n.x + n.w / 2, n.y], [n.x + n.w / 2, n.y + n.h], [n.x, n.y + n.h / 2],
      [n.x + n.w, n.y + n.h / 2]].some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.5));
  }
}

test('多个调用方调用同一批目标时共用干线，所有调用记录及端点仍完整', async () => {
  const nodes = ['a', 'b', 'x', 'y'].map((id) => ({ id, name: id, file: 'dispatch.c' }));
  const edges = ['a', 'b'].flatMap((from) => ['x', 'y'].map((to) => ({ from, to, kind: 'direct' })));
  edges.push({ from: 'a', to: 'x', kind: 'fnptr' });
  edges.forEach((e, i) => { e.line = i + 1; });
  for (const group of [true, false]) {
    const view = await layoutElk(nodes, edges, { group });
    assert.deepEqual(view.edges.map(({ points, ...e }) => e), edges);
    const metrics = routeLengthAndCrossings(view.edges);
    assert.ok(metrics.length < metrics.rawLength, '画面实际占线长度小于分别铺线');
    assert.equal(metrics.overlapLength, 0, '同样式走廊不计为冲突');
    assert.deepEqual(view.edges[0].points, view.edges.at(-1).points, '同端点同线型的调用保留同一条路径');
    assert.ok(view.edges.every((e) => view.nodes.every((n) => !pathCrossesBody(e.points, n))));
    assertMidpointPorts(view);
  }
});

test('密集跨文件调用共用收发通道，并保留不同线型、方向及递归', async () => {
  const nodes = Array.from({ length: 24 }, (_, i) => ({ id: 'f' + i, file: 'layer' + Math.floor(i / 8) + '.c' }));
  nodes.push({ id: 'state', kind: 'var', file: 'layer1.c' });
  const edges = [];
  for (let i = 0; i < 16; i++) for (const d of [0, 1, 3]) {
    const to = 8 * (1 + Math.floor(i / 8)) + (i + d) % 8;
    edges.push({ from: 'f' + i, to: 'f' + to, kind: d === 3 ? 'fnptr' : 'direct', line: 10 + d });
  }
  edges.push({ from: 'f0', to: 'f8', kind: 'direct', change: 'added', line: 20 },
    { from: 'f8', to: 'state', kind: 'var', line: 21 }, { from: 'f9', to: 'state', kind: 'var', line: 22 },
    { from: 'f16', to: 'f8', kind: 'fnptr', line: 23 }, { from: 'f10', to: 'f10', kind: 'direct', line: 24 });
  const faces = edges.map(() => ['EAST', 'WEST']);
  faces[edges.findIndex((e) => e.line === 23)][0] = 'WEST';
  const ports = new Map(graphOf(nodes, edges, 'RIGHT', faces, true).edges.map((e) => [e.id, e]));
  const port = (from, line) => ports.get('e' + edges.findIndex((e) => e.from === from && e.line === line));
  assert.equal(port('f0', 10).sources[0], port('f0', 13).sources[0], '普通调用与函数指针同型');
  assert.equal(port('f0', 10).targets[0], port('f7', 11).targets[0], '两个调用方可在同一目标汇合');
  assert.notEqual(port('f0', 10).sources[0], port('f0', 20).sources[0], '变更颜色有独立端口');
  assert.notEqual(port('f8', 10).sources[0], port('f8', 21).sources[0], '同面的变量虚线有独立端口');
  assert.notEqual(port('f8', 10).targets[0], port('f16', 23).sources[0], '同一面接收与发出仍有方向');
  const view = await layoutElk(nodes, edges);
  assert.deepEqual(view.edges.map(({ points, ...e }) => e), edges);
  const m = routeLengthAndCrossings(view.edges);
  assert.ok(m.length * 2 < m.rawLength, '大部分可见线段应当合并');
  assert.ok(m.crossings < edges.length, '多对多调用不能因分道而成倍增加可见交叉');
  assert.ok(view.edges.every((e) => view.nodes.every((n) => !pathCrossesBody(e.points, n))));
});

test('默认只使用 ELK：旧模式和坐标不覆盖布局，手工关系参与排版', async (t) => {
  const srv = await launchServer();
  t.after(() => srv.close());
  const url = srv.baseUrl + '/api/view?root=main.c::main&down=3&up=0';
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

test('细长调用链沿主流向单调排布，仍使用四中点端口', async () => {
  const nodes = Array.from({ length: 16 }, (_, i) => ({ id: 'n' + i, name: 'Task_' + i, file: 'chain.c' }));
  const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id, kind: 'direct', line: i }));
  const view = await layoutElk(nodes, edges);
  const axis = view.layoutDirection === 'RIGHT' ? 'x' : 'y';
  const position = new Map(view.nodes.map((n) => [n.id, n[axis]]));
  assert.ok(edges.every((e) => position.get(e.from) < position.get(e.to)));
  assertMidpointPorts(view);
});

test('同一调用方的目标按调用先后沿横切轴排布，输出仍保留输入边顺序', async () => {
  const ids = ['caller', 'step3', 'step1', 'step2'];
  const calls = [3, 1, 2].map((rank) => ({
    from: 'caller', to: 'step' + rank, kind: 'direct', line: rank * 10, orderGroup: rank,
  }));
  for (const mode of ['同文件', '分文件', '有跨文件入边']) {
    const nodes = ids.map((id) => ({ id, file: mode === '分文件' ? id + '.c' : 'task.c', taskEntry: id === 'caller' }));
    const edges = [...calls];
    if (mode === '有跨文件入边') {
      nodes.push({ id: 'bootstrap', file: 'bootstrap.c' });
      edges.push({ from: 'bootstrap', to: 'caller', kind: 'direct', line: 1 });
    }
    const view = await layoutElk(nodes, edges);
    const axis = view.layoutDirection === 'RIGHT' ? 'y' : 'x';
    const position = new Map(view.nodes.map((n) => [n.id, n[axis]]));
    assert.ok(position.get('step1') < position.get('step2') && position.get('step2') < position.get('step3'), mode);
    assert.deepEqual(view.edges.map(({ points, ...e }) => e), edges);
    assertMidpointPorts(view);
  }
});

test('数据流从写入函数经变量到读取函数，输出路径仍按存储端点顺序', async () => {
  const nodes = [{ id: 'reader', file: 'reader.c' }, { id: 'writer', file: 'writer.c' },
    { id: 'var::g', kind: 'var', file: 'state.c' }];
  for (const kind of ['var', 'df-read']) {
    const edges = [{ from: 'reader', to: 'var::g', kind, via: '读' },
      { from: 'writer', to: 'var::g', kind: 'var', via: '写' }];
    const view = await layoutElk(nodes, edges);
    const axis = view.layoutDirection === 'RIGHT' ? 'x' : 'y';
    const position = new Map(view.nodes.map((n) => [n.id, n[axis]]));
    assert.ok(position.get('writer') < position.get('var::g') && position.get('var::g') < position.get('reader'));
    assert.deepEqual(view.edges.map(({ points, ...e }) => e), edges);
    assertMidpointPorts(view);
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

test('新增节点自动使用完整排版，删除与恢复后坐标和路径不漂移', async () => {
  const srv = await launchServer();
  try {
    const before = await (await fetch(srv.baseUrl + '/api/view?root=main.c::main')).json();
    const nodes = [...before.nodes, { id: 'v', name: 'global_var', kind: 'var', file: 'main.c', w: 120, h: 44 }];
    const edges = [...before.edges, { from: before.root, to: 'v', kind: 'var', line: 0 }];
    const added = await layoutElk(nodes, edges, { previous: before });
    const arranged = await layoutElk(nodes, edges);
    assert.deepEqual(added.nodes.map((n) => [n.id, n.x, n.y]), arranged.nodes.map((n) => [n.id, n.x, n.y]),
      '新增节点后的排版应与点击重新排版一致');
    const byId = new Map(added.nodes.map((n) => [n.id, n]));
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
    roots: 'producer.c::Sensor_Update,consumer.c::Control_Read', down: '0', up: '0',
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


test('删除最后节点后恢复空图快照中的坐标', async (t) => {
  const srv = await launchServer();
  t.after(() => srv.close());
  const url = srv.baseUrl + '/api/view?root=main.c::main&up=0&down=0';
  const before = await (await fetch(url)).json();
  before.nodes[0].x += 90;
  const post = (endpoint, body) => fetch(srv.baseUrl + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/delete', { nodes: [before.root] })).status, 200);
  const empty = await (await post('/api/view?root=main.c::main&up=0&down=0', { previous: before })).json();
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.layoutSlots.nodes[0].x, before.nodes[0].x);
  assert.equal((await post('/api/delete', { nodes: [before.root], restore: true })).status, 200);
  const restored = await (await post('/api/view?root=main.c::main&up=0&down=0', { previous: empty })).json();
  assert.deepEqual(restored.nodes.map((n) => [n.id, n.x, n.y]), before.nodes.map((n) => [n.id, n.x, n.y]));
});
