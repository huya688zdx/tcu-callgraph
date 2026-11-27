import test from 'node:test';
import assert from 'node:assert/strict';
import { traceVisiblePaths, visibleGraphKey, pathEdgeColors } from '../web/lib/visible-paths.js';

const graph = (nodes, pairs) => ({ nodes: nodes.map(id => ({ id, name: id })),
  edges: pairs.map(([from, to], i) => ({ from, to, kind: 'direct', points: [[i, 0], [i, 20]] })) });

test('当前图路径：没有变量读写也能沿调用线定位远端节点，旁支不高亮，不修改原图', () => {
  const nodes = Array.from({ length: 30 }, (_, i) => 'fn' + i);
  const view = graph([...nodes, 'side'], nodes.slice(1).map((id, i) => [nodes[i], id]).concat([['fn2', 'side']]));
  const before = JSON.stringify(view);
  const result = traceVisiblePaths(view, 'fn0', 'fn29');
  assert.deepEqual(result.paths[0].nodes, nodes);
  assert.equal(result.paths[0].steps.length, 29, '不沿用 AST 查询的 8 跳限制');
  assert.ok(result.paths[0].steps.every(s => s.forward));
  assert.equal(result.edgeIndices.length, 29);
  assert.deepEqual(result.flowEdgeIndices, result.edgeIndices);
  assert.equal(new Set(pathEdgeColors(result.paths).values()).size, 1, '连续路径保持同色');
  assert.ok(!result.nodes.some(n => n.id === 'side'));
  assert.equal(JSON.stringify(view), before);
});

test('反向选择保留原箭头；共同调用者属于连线关联，不伪称存在连续单向流', () => {
  const view = graph(['parent', 'a', 'b'], [['parent', 'a'], ['parent', 'b']]);
  const result = traceVisiblePaths(view, 'a', 'b');
  assert.deepEqual(result.paths[0].nodes, ['a', 'parent', 'b']);
  assert.deepEqual(result.paths[0].steps.map(s => s.forward), [false, true]);
  assert.equal(result.paths[0].mixed, true);
  const colors = pathEdgeColors(result.paths);
  assert.notEqual(colors.get(0), colors.get(1), '方向中断的两段使用不同颜色');
  assert.deepEqual(result.flowEdgeIndices, [], '共同调用目标的关联不能播放连续流动动画');
  const reverse = traceVisiblePaths(view, 'a', 'parent');
  assert.deepEqual(reverse.paths[0].steps, [{ edge: 0, forward: false }]);
  assert.deepEqual(reverse.flowEdgeIndices, [0], '反向选择仍沿原连线方向播放');
  assert.equal(view.edges[0].from, 'parent');
});

test('函数、变量和手工线共同参与，只在可见边中搜索，隐藏的连接不能补出假线', () => {
  const view = graph(['a', 'v', 'b', 'alone'], [['a', 'v'], ['b', 'v']]);
  view.nodes[1].kind = 'var'; view.edges[0].kind = 'var'; view.edges[1].kind = 'manual';
  assert.equal(traceVisiblePaths(view, 'a', 'b').paths.length, 1);
  assert.equal(traceVisiblePaths(view, 'a', 'alone').paths.length, 0);
  view.edges.push({ from: 'a', to: 'hidden' }, { from: 'hidden', to: 'alone' });
  assert.equal(traceVisiblePaths(view, 'a', 'alone').paths.length, 0);
  assert.equal(traceVisiblePaths(view, 'a', 'missing').paths.length, 0);
  assert.equal(traceVisiblePaths(view, 'a', 'a').paths.length, 0);
});

test('只列最短路径，支持并行线和环，路径数量有界且结果标明截断', () => {
  const view = graph(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['b', 'a']]);
  const result = traceVisiblePaths(view, 'a', 'd');
  assert.equal(result.paths.length, 3, 'b→a 的反向连线也是图上独立的一条路径');
  assert.ok(result.paths.every(p => p.steps.length === 2));
  const many = graph(['a', 'b'], Array.from({ length: 100 }, () => ['a', 'b']));
  const limited = traceVisiblePaths(many, 'a', 'b');
  assert.equal(limited.paths.length, 24); assert.equal(limited.truncated, true);
});

test('比较图显示的是当前连线结构：标明跨版本路径，不把它写成同一版本的单向流', () => {
  const view = graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
  view.comparison = { id: 'comparison' };
  view.edges[0].versions = ['before']; view.edges[1].versions = ['after'];
  assert.deepEqual(traceVisiblePaths(view, 'a', 'c').paths[0].versions, []);
  view.edges[1].versions.push('before');
  assert.deepEqual(traceVisiblePaths(view, 'a', 'c').paths[0].versions, ['before']);
});

test('结构缓存跟随节点、连线次序与版本变化；拖动节点不必重新遍历', () => {
  const view = graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
  const original = visibleGraphKey(view);
  view.nodes[0].x = 100;
  assert.equal(visibleGraphKey(view), original);
  view.edges.reverse(); assert.notEqual(visibleGraphKey(view), original);
  view.edges.reverse(); view.edges[0].versions = ['after']; assert.notEqual(visibleGraphKey(view), original);
});

test('共享边位于不同分段时，所有路径的方向中断仍有颜色区分', () => {
  const view = graph(['a', 'x', 'm', 'y', 'b'], [['a', 'x'], ['m', 'x'], ['m', 'b'], ['y', 'a'], ['y', 'm']]);
  const { paths } = traceVisiblePaths(view, 'a', 'b'), colors = pathEdgeColors(paths);
  assert.equal(paths.length, 2);
  for (const path of paths) for (let i = 1; i < path.steps.length; i++) {
    const [previous, current] = [path.steps[i - 1], path.steps[i]];
    assert.equal(colors.get(previous.edge) === colors.get(current.edge), previous.forward === current.forward);
  }
});

test('深层有向链路不被较短的共同调用者或无向混向近路掩盖', () => {
  const layers = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
  const pairs = layers.slice(1).map((id, i) => [layers[i], id]);
  pairs.push(['L1', 'helper'], ['L10', 'helper']);
  const view = graph([...layers, 'helper'], pairs);
  const forward = traceVisiblePaths(view, 'L1', 'L10');
  assert.equal(forward.paths.length, 1);
  assert.deepEqual(forward.paths[0].nodes, layers);
  assert.equal(forward.paths[0].mixed, false);
  assert.equal(forward.flowEdgeIndices.length, 9);
  const reverse = traceVisiblePaths(view, 'L10', 'L1');
  assert.equal(reverse.paths.length, 1);
  assert.deepEqual(reverse.paths[0].nodes, layers.toReversed());
  assert.equal(reverse.paths[0].mixed, false);
  assert.ok(reverse.paths[0].steps.every(s => !s.forward));
  assert.equal(reverse.flowEdgeIndices.length, 9);
});

test('经由变量读写及双向读写的深层链路不被更短无向旁路截断', () => {
  const nodes = ['f1', 'v1', 'f2', 'v2', 'f3', 'v3', 'f4', 'shared'];
  const view = {
    nodes: nodes.map(id => ({ id, name: id, kind: id.startsWith('v') || id === 'shared' ? 'var' : 'fn' })),
    edges: [
      { from: 'f1', to: 'v1', kind: 'var', via: '写', points: [[0, 0], [0, 20]] },
      { from: 'f2', to: 'v1', kind: 'var', via: '读', points: [[0, 0], [0, 20]] },
      { from: 'f2', to: 'v2', kind: 'var', via: '读写', points: [[0, 0], [0, 20]] },
      { from: 'f3', to: 'v2', kind: 'var', via: '读', points: [[0, 0], [0, 20]] },
      { from: 'f3', to: 'v3', kind: 'var', via: '写', points: [[0, 0], [0, 20]] },
      { from: 'f4', to: 'v3', kind: 'var', via: '读', points: [[0, 0], [0, 20]] },
      { from: 'f1', to: 'shared', kind: 'var', via: '读', points: [[0, 0], [0, 20]] },
      { from: 'f4', to: 'shared', kind: 'var', via: '读', points: [[0, 0], [0, 20]] },
    ],
  };
  const result = traceVisiblePaths(view, 'f1', 'f4');
  assert.equal(result.paths.length, 1);
  assert.deepEqual(result.paths[0].nodes, ['f1', 'v1', 'f2', 'v2', 'f3', 'v3', 'f4']);
  assert.equal(result.paths[0].mixed, false);
  assert.deepEqual(result.flowEdgeIndices, [0, 1, 2, 3, 4, 5]);
});

test('大量同长静态混向分支不会把真实单向流挤出上限', () => {
  const pairs = [];
  const mixedNodes = [];
  for (let i = 0; i < 30; i++) {
    const id = `mix${i}`;
    mixedNodes.push(id);
    pairs.push([id, 'a'], [id, 'b']);
  }
  pairs.push(['a', 'dir'], ['dir', 'b']);
  const view = graph(['a', 'b', 'dir', ...mixedNodes], pairs);
  const result = traceVisiblePaths(view, 'a', 'b');
  assert.equal(result.paths.length, 24);
  assert.equal(result.truncated, true);
  assert.equal(result.paths[0].mixed, false);
  assert.deepEqual(result.paths[0].nodes, ['a', 'dir', 'b']);
  assert.deepEqual(result.flowEdgeIndices, [60, 61]);
});

test('比较图中同版本长单向流不被跨版本短路径掩盖', () => {
  const view = graph(['a', 'x', 'c', 'd', 'b'], [['a', 'x'], ['x', 'b'], ['a', 'c'], ['c', 'd'], ['d', 'b']]);
  view.comparison = { id: 'comparison' };
  view.edges[0].versions = ['before'];
  view.edges[1].versions = ['after'];
  view.edges[2].versions = ['after'];
  view.edges[3].versions = ['after'];
  view.edges[4].versions = ['after'];
  const result = traceVisiblePaths(view, 'a', 'b');
  assert.equal(result.paths.length, 1);
  assert.deepEqual(result.paths[0].nodes, ['a', 'c', 'd', 'b']);
  assert.deepEqual(result.paths[0].versions, ['after']);
  assert.equal(result.paths[0].mixed, false);
  assert.deepEqual(result.flowEdgeIndices, [2, 3, 4]);
});
