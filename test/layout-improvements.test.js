import test from 'node:test';
import assert from 'node:assert/strict';
import { graphOf, layoutElk, validLayout } from '../src/core/layout-elk.js';
import { routeEdges, pathCrossesBody, routeOverlapConflicts } from '../src/core/routing.js';
import { mergeSharedRoutes, routeLengthAndCrossings } from '../src/core/layout-metrics.js';
import { beginHierarchyMove } from '../web/lib/hierarchy.js';

function geometry(view) {
  if (view.groups) assert.ok(validLayout(view));
  const byId = new Map(view.nodes.map(n => [n.id, n]));
  for (let i = 0; i < view.nodes.length; i++) {
    const a = view.nodes[i];
    for (const b of view.nodes.slice(i + 1)) {
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y,
        `${a.id} 与 ${b.id} 重叠`);
    }
  }
  for (const e of view.edges) {
    for (const [id, p] of [[e.from, e.points[0]], [e.to, e.points.at(-1)]]) {
      const { x, y, w, h } = byId.get(id);
      assert.ok([[x + w/2, y], [x + w/2, y+h], [x, y+h/2], [x+w, y+h/2]]
        .some(q => Math.hypot(p[0]-q[0], p[1]-q[1]) < 0.5));
    }
    assert.ok(e.points.slice(1).every((p, i) => p[0] === e.points[i][0] || p[1] === e.points[i][1]));
    assert.ok(view.nodes.every(n => !pathCrossesBody(e.points, n)), `${e.from} → ${e.to} 穿框`);
  }
  return byId;
}

test('同面虚实线优先使用不同物理中点，多次同样式调用仍共用端口', () => {
  const nodes = ['a', 'b'].map(id => ({ id, w: 120, h: 40 }));
  const edges = ['direct', 'fnptr', 'df-signal'].map(kind => ({ from: 'a', to: 'b', kind }));
  const graph = graphOf(nodes, edges, 'RIGHT', edges.map(() => ['EAST', 'WEST']), true, false);
  const position = new Map(graph.children.flatMap(n => n.ports.map(p => [p.id, [p.x, p.y]])));
  const [call, repeat, data] = edges.map((_, i) => graph.edges.find(e => e.id === 'e' + i));
  for (const end of ['sources', 'targets']) {
    assert.deepEqual(call[end], repeat[end]);
    assert.notDeepEqual(position.get(call[end][0]), position.get(data[end][0]));
    for (const e of [call, data]) assert.ok([[0,20],[120,20],[60,0],[60,40]]
      .some(([x,y]) => position.get(e[end][0])[0] === x && position.get(e[end][0])[1] === y));
  }
});

test('文件成员增多时加宽层间、状态侧翼和标题边距，调用者仍直连被调函数', async () => {
  const distances = [];
  for (const count of [3, 9]) {
    const nodes = [], edges = [];
    for (let i = 0; i < count; i++) {
      nodes.push({ id: 'f'+i, file: 'dense.c', w: 90, h: 44 }, { id: 'v'+i, kind: 'var', file: 'dense.c', w: 90, h: 44 });
      if (i) edges.push({ from: 'f'+(i-1), to: 'f'+i, kind: 'direct' });
      edges.push({ from: 'f'+i, to: 'v'+i, kind: 'var', via: '写' });
    }
    const view = await layoutElk(nodes, edges);
    const byId = geometry(view);
    const group = view.groups[0], vertical = (group.layoutDirection || view.layoutDirection) === 'DOWN';
    const [main, size, cross, breadth] = vertical ? ['y','h','x','w'] : ['x','w','y','h'];
    const layers = [], wing = [];
    for (let i = 0; i < count; i++) {
      const f = byId.get('f'+i), v = byId.get('v'+i);
      assert.equal(f[main], v[main]);
      wing.push(Math.abs(f[cross] - v[cross]) - f[breadth]);
      if (i) layers.push(f[main] - byId.get('f'+(i-1))[main] - f[size]);
    }
    assert.ok(view.edges.filter(e => e.kind === 'direct').every(e => e.points.length === 2));
    distances.push([Math.min(...layers), Math.min(...wing), Math.min(...view.nodes.map(n => n.y)) - group.y]);
  }
  for (let i = 0; i < 3; i++) assert.ok(distances[1][i] > distances[0][i], JSON.stringify(distances));
});

test('文件内缺少直接边时，通过外部调用者和被调者恢复文件内三个函数的层次', async () => {
  const fn = (id, file = 'core.c') => ({ id, file, w: 88, h: 40 });
  const nodes = [...Array.from({ length: 10 }, (_, i) => fn('free'+i)), ...['last','middle','first'].map(id => fn(id)),
    ...['entry','stage1','stage2','exit'].map(id => fn(id, 'outside.c'))];
  const chain = ['entry','first','stage1','middle','stage2','last','exit'];
  const edges = chain.slice(1).map((to, i) => ({ from: chain[i], to, kind: 'direct' }));
  const view = await layoutElk(nodes, edges);
  const positions = geometry(view);
  const direction = view.groups.find(g => g.id === 'core.c').layoutDirection || view.layoutDirection;
  const axis = direction === 'RIGHT' ? 'x' : 'y', size = direction === 'RIGHT' ? 'w' : 'h';
  for (const [from, to] of [['first','middle'], ['middle','last']]) {
    assert.ok(positions.get(from)[axis] + positions.get(from)[size] < positions.get(to)[axis]);
  }
  assert.deepEqual(view.edges.map(({points, ...e}) => e), edges);
});

test('几何校验拒绝穿过第三方空文件框和异样式占用同一走廊', () => {
  const nodes = [{ id: 'a', group: 'a.c', x: 15, y: 30, w: 40, h: 40 },
    { id: 'b', group: 'b.c', x: 300, y: 30, w: 40, h: 40 }];
  const groups = [{ id: 'a.c', x: 0, y: 0, w: 70, h: 90 }, { id: 'b.c', x: 280, y: 0, w: 80, h: 90 }];
  const call = { from: 'a', to: 'b', kind: 'direct', points: [[55,50],[300,50]] };
  const view = { nodes, groups, containers: [], edges: [call] };
  assert.equal(validLayout(view), true);
  assert.equal(validLayout({ ...view, groups: [...groups, { id: 'empty.c', x: 130, y: 10, w: 80, h: 70 }] }), false);
  assert.equal(validLayout({ ...view, edges: [call, { ...call, kind: 'var' }] }), false);
});

test('恢复旧画布时在原位修正端口折钩和虚实重线，再次恢复保持一致', async () => {
  const nodes = [{ id: 'a', x: 52, y: 120, w: 260, h: 122 }, { id: 'b', x: 452, y: 56, w: 360, h: 122 },
    { id: 'c', x: 60, y: 370, w: 120, h: 40 }, { id: 'd', x: 450, y: 370, w: 120, h: 40 }];
  const calls = [{ from: 'a', to: 'b', kind: 'direct' }, { from: 'c', to: 'd', kind: 'direct', custom: true },
    { from: 'c', to: 'd', kind: 'var', via: '读' }];
  const straight = [[180,390], [450,390]];
  const previous = { nodes, groups: [], containers: [], width: 860, height: 470, layoutDirection: 'DOWN',
    edges: calls.map((e, i) => ({ ...e, points: i ? structuredClone(straight) : [[182,120],[182,117],[452,117]] })) };
  const view = await layoutElk(nodes, calls, { group: false, previous });
  geometry(view);
  assert.deepEqual([view.edges[0].points[0], view.edges[0].points.at(-1)], [[312,181],[452,117]]);
  assert.deepEqual(view.edges[1].points, straight);
  assert.equal(routeOverlapConflicts(view.edges).length, 0);
  assert.deepEqual(view.nodes.map(n => [n.x, n.y]), nodes.map(n => [n.x, n.y]));
  const again = await layoutElk(nodes, calls, { group: false, previous: view });
  assert.deepEqual(again.edges.map(e => e.points), view.edges.map(e => e.points));
});

test('192 节点跨文件链保持紧凑，正向调用使用左右中点', async () => {
  const nodes = Array.from({ length: 192 }, (_, i) => ({ id: 'f' + i, file: 'module' + Math.floor(i / 16) + '.c' }));
  const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id, kind: 'direct' }));
  const view = await layoutElk(nodes, edges);
  const byId = geometry(view);
  assert.equal(view.groups.length, 12);
  assert.equal(view.layoutDirection, 'RIGHT');
  assert.ok(Math.max(view.width / view.height, view.height / view.width) < 3);
  const downstream = view.edges.filter(e => byId.get(e.to).x >= byId.get(e.from).x + byId.get(e.from).w - 4);
  assert.ok(downstream.length >= 180);
  assert.ok(downstream.every(e => e.points[0][0] === byId.get(e.from).x + byId.get(e.from).w &&
    e.points.at(-1)[0] === byId.get(e.to).x));
  for (const e of view.edges) for (const file of view.groups) {
    if (file.id !== byId.get(e.from).group && file.id !== byId.get(e.to).group) {
      assert.ok(!pathCrossesBody(e.points, file), `${e.from} → ${e.to} 穿过 ${file.id}`);
    }
  }
});

test('同文件状态节点排在连续控制链的侧翼', async () => {
  const nodes = ['step1', 'step2', 'step3', 'v1', 'v2'].map(id => ({
    id, file: 'task.c', kind: id.startsWith('v') ? 'var' : 'function',
  }));
  const edges = [['step1', 'step2'], ['step2', 'step3'], ['step1', 'v1'], ['step2', 'v2']]
    .map(([from, to]) => ({ from, to, kind: to.startsWith('v') ? 'var' : 'direct' }));
  const view = await layoutElk(nodes, edges);
  const byId = geometry(view);
  const vertical = view.layoutDirection === 'DOWN';
  const axis = vertical ? 'y' : 'x', across = vertical ? 'x' : 'y', size = vertical ? 'w' : 'h';
  const steps = nodes.slice(0, 3).map(n => byId.get(n.id));
  assert.ok(steps.every((n, i) => !i || steps[i-1][axis] < n[axis]));
  for (const id of ['v1', 'v2']) {
    assert.ok(byId.get(id)[across] >= Math.max(...steps.map(n => n[across] + n[size])));
  }
});

test('周期泳道排序、共享信号归属和层级拖动使用同一分组路径', async () => {
  const fn = (id, file, ...us) => ({ id, file, taskPeriods: us.map(us => ({ task: id, us })) });
  const nodes = [fn('slow', 'a.c', 100000), fn('mid', 'b.c', 10000), fn('fast', 'a.c', 2000),
    fn('step', 'a.c', 2000, 2000), fn('other', 'c.c', 2000), fn('common', 'a.c', 2000, 10000),
    fn('main', 'main.c'), fn('ADC_IRQHandler', 'irq.c'), fn('timedHandler', 'irq.c', 10000),
    ...['local', 'shared', 'moduleState'].map(id => ({ id, kind: 'var', file: 'a.c' }))];
  const edges = [['fast','step'], ['fast','common'], ['mid','common'], ['main','slow'], ['ADC_IRQHandler','slow'],
    ['fast','local'], ['fast','shared'], ['mid','shared'], ['other','moduleState'], ['fast','moduleState']]
    .map(([from,to], i) => ({ from, to, kind: i < 5 ? 'direct' : 'var' }));
  const view = await layoutElk(nodes, edges, { groupMode: 'period', rootLabel: 'TCU' });
  const byId = geometry(view);
  const lanes = view.containers.filter(b => b.kind === 'period-lane');
  const bus = view.containers.find(b => b.kind === 'signal-bus');
  assert.deepEqual(lanes.map(l => l.periodUs), [null, 2000, 10000, 100000, null, null]);
  assert.ok(lanes.every((l,i) => !i || lanes[i-1].y + lanes[i-1].h <= l.y));
  const group = id => byId.get(id).group;
  assert.ok(group('fast').startsWith(lanes[1].id + '/'));
  assert.equal(group('step'), group('fast'));
  assert.ok(byId.get('step').x > byId.get('fast').x);
  assert.equal(group('timedHandler'), group('mid'));
  assert.ok(group('common').startsWith(lanes[4].id + '/'));
  assert.ok(group('main').startsWith(lanes[5].id + '/'));
  assert.ok(group('ADC_IRQHandler').startsWith(lanes[0].id + '/'));
  assert.ok(group('local').startsWith(lanes[1].id + '/') && group('local') !== group('fast'));
  assert.ok(group('shared').startsWith(bus.id + '/'));
  assert.equal(group('moduleState'), group('shared'));
  assert.ok(lanes[1].y < bus.y && bus.y < lanes[2].y);
  assert.deepEqual(beginHierarchyMove(view, { kind: 'dir', box: bus }).ids, new Set(['shared','moduleState']));
  for (const e of view.edges) for (const box of [...view.groups, ...view.containers]) {
    if (box.root || [group(e.from), group(e.to)].some(id => id === box.id || id.startsWith(box.id + '/'))) continue;
    assert.ok(!pathCrossesBody(e.points, box), `${e.from} → ${e.to} 穿过 ${box.label}`);
  }
});

test('横向和纵向布局的调用与变量访问使用各自主轴', () => {
  for (const layoutDirection of ['RIGHT', 'DOWN']) {
    const horizontal = layoutDirection === 'RIGHT';
    const nodes = [['s', 0, 0], ['t', 200, 320], ['v', 100, 140]]
      .map(([id,x,y]) => ({ id, x: horizontal ? x : y, y: horizontal ? y : x, w: 60, h: 60 }));
    const edges = [{ from: 's', to: 't', kind: 'fnptr' }, { from: 's', to: 'v', kind: 'df-write' }];
    routeEdges(nodes, edges, { layoutDirection });
    assert.deepEqual(edges[0].points[0], horizontal ? [60,30] : [30,60]);
    assert.deepEqual(edges[1].points[0], horizontal ? [30,60] : [60,30]);
    geometry({ nodes, edges });
  }
});

test('独立调用保留距离 60px 的平行走廊', () => {
  const nodes = [['a',0,0], ['b',60,0], ['c',300,300], ['d',360,300]].map(([id,x,y]) => ({ id,x,y,w:40,h:40 }));
  const edges = [{ from:'a', to:'c', kind:'direct', points:[[20,40],[20,100],[320,100],[320,300]] },
    { from:'b', to:'d', kind:'direct', points:[[80,40],[80,160],[380,160],[380,300]] }];
  const original = structuredClone(edges);
  mergeSharedRoutes({ nodes, edges });
  assert.deepEqual(edges, original);
});

test('纵向控制链连接横向分支文件，跨框调用不穿第三方框', async () => {
  const nodes = [], edges = [];
  const add = (id, file) => nodes.push({ id, file: 'fw/' + file + '.c' });
  const call = (from, to) => edges.push({ from, to, kind: 'direct' });
  for (let i = 0; i < 8; i++) {
    add('a' + i, 'loop');
    if (i) call('a' + (i-1), 'a' + i);
  }
  for (let i = 0; i < 4; i++) {
    add('b' + i, 'io');
    if (i) call('b0', 'b' + i);
  }
  add('z', 'boot');
  call('z', 'a0');
  call('a7', 'b0');
  const view = await layoutElk(nodes, edges, { rootLabel: 'TCU' });
  const byId = geometry(view);
  for (let i = 1; i < 8; i++) {
    assert.equal(byId.get('a' + i).x, byId.get('a0').x);
    assert.ok(byId.get('a' + i).y > byId.get('a' + (i-1)).y);
  }
  for (let i = 1; i < 4; i++) assert.ok(byId.get('b' + i).x >= byId.get('b0').x + byId.get('b0').w);
  for (const e of view.edges) for (const g of view.groups) {
    if (![byId.get(e.from).group, byId.get(e.to).group].includes(g.id)) assert.ok(!pathCrossesBody(e.points, g));
  }
  const metrics = routeLengthAndCrossings(view.edges);
  assert.equal(metrics.crossings, 0);
  assert.ok(metrics.length < 560, `统一方向基线线长为 604，当前为 ${metrics.length}`);
  // 浏览器的增量请求仅在文件框中保留局部方向。
  const previous = { ...view, nodes: view.nodes.map(({ layoutDirection, ...n }) => n) };
  const restored = await layoutElk(nodes, edges, { previous });
  const geometryOf = v => v.nodes.map(n => [n.id, n.x, n.y, n.layoutDirection]).sort();
  assert.deepEqual(geometryOf(restored), geometryOf(view));
  assert.deepEqual(restored.edges.map(e => e.points), view.edges.map(e => e.points));
});

test('单文件宽扇出保留入口层，目标在两个维度折行', async () => {
  const nodes = Array.from({ length: 25 }, (_, i) => ({ id: 'f' + i, file: 'main.c' }));
  const edges = nodes.slice(1).map(n => ({ from: 'f0', to: n.id, kind: 'direct' }));
  const view = await layoutElk(nodes, edges);
  const byId = geometry(view);
  const hub = byId.get('f0'), targets = edges.map(e => byId.get(e.to));
  const horizontal = view.layoutDirection === 'RIGHT';
  assert.ok(targets.every(n => horizontal ? n.x >= hub.x + hub.w : n.y >= hub.y + hub.h));
  assert.ok(new Set(targets.map(n => n.x)).size > 1 && new Set(targets.map(n => n.y)).size > 1);
  assert.ok(Math.max(view.width/view.height, view.height/view.width) < 2);
});

test('变量侧翼和纯变量文件按跨文件访问函数的空间顺序摆放', async () => {
  const nodes = [], edges = [];
  for (let file = 0; file < 3; file++) {
    for (let i = 0; i < 5; i++) {
      const id = `f${file}${i}`;
      nodes.push({ id, file: `src/${file}.c` });
      if (i) edges.push({ from: `f${file}${i-1}`, to: id, kind: 'direct' });
    }
    if (file) edges.push({ from: `f${file-1}4`, to: `f${file}0`, kind: 'direct' });
  }
  for (let i = 4; i >= 0; i--) {
    const id = 'v' + i;
    nodes.push({ id, kind: 'var', file: i < 3 ? 'src/1.c' : 'data/vars.h' });
    for (let file = 0; file < 3; file++) edges.push({ from: `f${file}${i}`, to: id, kind: 'var', via: file ? '读' : '写' });
  }
  const view = await layoutElk(nodes, edges);
  const byId = geometry(view);
  for (let i = 0; i < 3; i++) {
    const user = byId.get('f1' + i), state = byId.get('v' + i);
    assert.equal(user.y, state.y);
    assert.ok(user.x + user.w <= state.x || state.x + state.w <= user.x);
  }
  assert.ok(byId.get('v3').y < byId.get('v4').y);
  const metrics = routeLengthAndCrossings(view.edges);
  assert.ok(metrics.length < 4000 && metrics.bends < 46);
});

test('混合方向跨文件边使用一个直角，亚像素错位的端口保留正交短段', () => {
  const nodes = [
    { id: 'a', group: 'ctl', x: 0, y: 0, w: 120.4, h: 44 },
    { id: 'b', group: 'io', x: 240, y: 160, w: 120, h: 44 },
    { id: 'c', group: 'ctl', x: 0, y: 80, w: 120, h: 44 },
  ];
  const opts = { layoutDirection: 'RIGHT', groupDirections: new Map([['ctl','DOWN'], ['io','RIGHT']]) };
  const mixed = [{ from: 'a', to: 'b', kind: 'direct' }];
  routeEdges(nodes.slice(0, 2), mixed, opts);
  assert.deepEqual(mixed[0].points, [[60.2,44], [60.2,182], [240,182]]);
  const straight = [{ from: 'a', to: 'c', kind: 'direct' }];
  routeEdges(nodes, straight, opts);
  geometry({ nodes, edges: straight });
});

test('不同自定义颜色的平行调用和自递归各自避让', () => {
  const nodes = [{ id: 's', x: 0, y: 0, w: 100, h: 44 }, { id: 't', x: 240, y: 0, w: 100, h: 44 }];
  const edges = ['#aa0000', '#0000aa'].flatMap(color => ['s','t'].map(to => ({ from:'s', to, kind:'direct', color })));
  routeEdges(nodes, edges, { layoutDirection: 'RIGHT', searchGaps: true });
  geometry({ nodes, edges });
  assert.equal(routeOverlapConflicts(edges, { differentStylesOnly: true }).length, 0);
});
