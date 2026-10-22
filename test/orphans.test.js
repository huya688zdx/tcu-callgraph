import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadModel } from '../src/core/index.js';
import { buildDataflowIndex } from '../src/core/dataflow.js';
import { collectOrphans, countOrphans, validNodeIds, validEdgeKeys } from '../src/core/orphans.js';

const SAMPLE = path.resolve(import.meta.dirname, '../samples/tcu');

let cached = null;
async function model() {
  if (!cached) {
    cached = loadModel(SAMPLE);
    await buildDataflowIndex(cached);
  }
  return cached;
}

test('orphans：typedef / const 变量也算有效节点', async () => {
  const m = await model();
  const ids = validNodeIds(m);

  // 这两个变量只在 AST 数据流索引里，MODEL.variables 里没有。
  // 只看 MODEL.variables 会把它们的标注全判成孤儿——这是真实踩过的坑。
  assert.ok(ids.has('var::g_ops_4at'), 'ShiftOps const 应算有效');
  assert.ok(ids.has('var::g_gearCtx'), 'GearCtx 应算有效');
  assert.ok(ids.has('main.c::main'), '函数应算有效');
  assert.ok(!ids.has('gone.c::Nope'));
});

test('orphans：连线 key 与前端 edgeKey 同构', async () => {
  const m = await model();
  const keys = validEdgeKeys(m);
  const e = m.edges[0];
  assert.ok(keys.has(`${e.from}->${e.to}:${e.line}`));
  assert.ok(!keys.has('gone.c::A->gone.c::B:1'));
});

test('orphans：识别节点标注、连线标注、删除记录', async () => {
  const m = await model();
  const o = collectOrphans(m, {
    annotations: [
      { kind: 'node', id: 'main.c::main' },
      { kind: 'node', id: 'gone.c::X' },
      { kind: 'edge', id: 'gone.c::A->gone.c::B:12' },
    ],
    deleted: [{ kind: 'node', id: 'gone.c::Y' }],
    layouts: [],
  });
  assert.deepEqual(o.annotations, [
    { kind: 'node', id: 'gone.c::X' },
    { kind: 'edge', id: 'gone.c::A->gone.c::B:12' },
  ]);
  assert.deepEqual(o.deleted, [{ kind: 'node', id: 'gone.c::Y' }]);
  assert.equal(countOrphans(o), 3);
});

test('orphans：布局槽位——入口全丢才算作废，少一个只清死节点', async () => {
  const m = await model();
  const o = collectOrphans(m, {
    annotations: [],
    deleted: [],
    layouts: [
      // 入口还在，只是里面混了一个已删除的节点
      { viewKey: 'main.c::main', mode: 'flat', nodes: { 'main.c::main': {}, 'gone.c::X': {} } },
      // 多选入口丢了一个：槽位仍可用
      { viewKey: 'main.c::main+gone.c::X', mode: 'group', nodes: { 'main.c::main': {} } },
      // 入口全丢
      { viewKey: 'gone.c::X', mode: 'group', nodes: {} },
    ],
  });
  assert.deepEqual(o.layoutSlots, [{ viewKey: 'gone.c::X', mode: 'group' }]);
  assert.deepEqual(o.layoutNodes, [
    { viewKey: 'main.c::main', mode: 'flat', ids: ['gone.c::X'] },
  ]);
});

test('orphans：变量节点不会被误判（真实回归）', async () => {
  const m = await model();
  const o = collectOrphans(m, {
    annotations: [],
    deleted: [],
    layouts: [
      { viewKey: 'main.c::main', mode: 'flat', nodes: { 'var::g_ops_4at': { x: 1, y: 2 } } },
      { viewKey: 'can.c::Can_SendRaw', mode: 'group', nodes: { 'var::g_gearCtx': { x: 3, y: 4 } } },
    ],
  });
  assert.equal(countOrphans(o), 0, '变量节点不应被判成孤儿');
});
