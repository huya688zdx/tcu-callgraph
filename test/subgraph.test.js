import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadModel, subgraph } from '../src/core/index.js';

// 手写最小 model：a -> b -> d，a -> c -> d，便于精确验证层数边界
function chainModel() {
  const functions = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, file: 'x.c' }));
  const byId = new Map(functions.map((fn) => [fn.id, fn]));
  const edges = [
    { from: 'a', to: 'b', kind: 'direct', line: 1 },
    { from: 'a', to: 'c', kind: 'direct', line: 2 },
    { from: 'b', to: 'd', kind: 'direct', line: 3 },
    { from: 'c', to: 'd', kind: 'direct', line: 4 },
  ];
  const outAdj = new Map(functions.map((fn) => [fn.id, []]));
  const inAdj = new Map(functions.map((fn) => [fn.id, []]));
  for (const e of edges) {
    outAdj.get(e.from).push(e);
    inAdj.get(e.to).push(e);
  }
  return { functions, edges, _index: { byId, outAdj, inAdj } };
}

const idsOf = (res) => res.nodes.map((n) => n.id).sort();

test('subgraph：down:0 只返回 root，且不带任何边', () => {
  const res = subgraph(chainModel(), 'a', { down: 0 });
  assert.equal(res.root, 'a');
  assert.deepEqual(idsOf(res), ['a']);
  assert.deepEqual(res.edges, []);
});

test('subgraph：down:1 只展开直接被调者，down:2 到第二层', () => {
  const model = chainModel();

  const one = subgraph(model, 'a', { down: 1 });
  assert.deepEqual(idsOf(one), ['a', 'b', 'c']);
  assert.equal(one.edges.length, 2);
  for (const e of one.edges) assert.equal(e.from, 'a');

  const two = subgraph(model, 'a', { down: 2 });
  assert.deepEqual(idsOf(two), ['a', 'b', 'c', 'd']);
  assert.equal(two.edges.length, 4);
});

test('subgraph：up 沿入边展开调用者', () => {
  const res = subgraph(chainModel(), 'd', { down: 0, up: 1 });
  assert.deepEqual(idsOf(res), ['b', 'c', 'd']);
  assert.equal(res.edges.length, 2);
  for (const e of res.edges) assert.equal(e.to, 'd');
});

test('subgraph：maxNodes 截断后所有边端点仍在节点集合内', () => {
  const res = subgraph(chainModel(), 'a', { down: 2, maxNodes: 2 });
  assert.ok(res.nodes.length <= 2, `maxNodes:2 时不应超过 2 个节点，实际 ${res.nodes.length}`);
  assert.ok(res.nodes.length >= 1, 'root 必须保留');
  assert.ok(res.nodes.some((n) => n.id === 'a'), 'root 必须在结果里');

  const ids = new Set(res.nodes.map((n) => n.id));
  for (const e of res.edges) {
    assert.ok(ids.has(e.from), `边 ${e.from}->${e.to} 的源端不在节点集合内`);
    assert.ok(ids.has(e.to), `边 ${e.from}->${e.to} 的目标端不在节点集合内`);
  }
});

test('subgraph：未知 root 返回空结果且不抛', () => {
  const model = chainModel();
  assert.doesNotThrow(() => subgraph(model, 'not-exist', { down: 2 }));
  const res = subgraph(model, 'not-exist', { down: 2 });
  assert.deepEqual(res.nodes, []);
  assert.deepEqual(res.edges, []);
});

test('subgraph：真实 samples/tcu —— main 的一层邻居', () => {
  const dir = path.join(import.meta.dirname, '..', 'samples', 'tcu');
  const model = loadModel(dir);
  const res = subgraph(model, 'main.c::main', { down: 1 });

  assert.ok(res.nodes.some((n) => n.id === 'main.c::main'));
  for (const id of [
    'can.c::Can_Init',
    'adc.c::Adc_Init',
    'gear.c::Gear_Init',
    'main.c::Task_10ms',
    'main.c::Task_100ms',
  ]) {
    assert.ok(res.nodes.some((n) => n.id === id), `down:1 应包含直接被调者 ${id}`);
  }
  const ids = new Set(res.nodes.map((n) => n.id));
  for (const e of res.edges) {
    assert.equal(e.from, 'main.c::main', 'down:1 的边都应从 root 出发');
    assert.ok(ids.has(e.to));
  }
});
