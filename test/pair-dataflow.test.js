import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModel } from '../src/core/index.js';
import { pairDataflow, comparisonPairDataflow } from '../src/core/pair-dataflow.js';
import { compareProjects } from '../src/core/compare.js';
import { launchServer } from '../scripts/lib/server.mjs';
import { pairFlowSegments, flowPulseColor } from '../web/lib/flow-geometry.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pair-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'flow.c'), `
int input, output, isolated;
typedef int Number;
Number deferred;
struct S { int a, b; } state;
struct Nested { struct S left, right; } nested, replacement;
void writer(void) { input = 1; }
int reader(void) { return input; }
void transform(void) { output = input + 1; }
int consumer(void) { return output; }
void caller(void) { consumer(); }
void write_field(void) { state.a = 1; }
int read_other_field(void) { return state.b; }
void write_mixed(void) { nested = replacement; nested.left.a = 1; }
int read_right(void) { return nested.right.b; }
void write_left(void) { nested.left.a = 1; }
void write_parent(void) { nested.left = replacement.left; }
int read_right_same_leaf(void) { return nested.right.a; }
int read_left(void) { return nested.left.a; }
int read_mixed(void) { struct Nested copy = nested; return nested.right.b; }
void bidirectional(void) { input = output; }
`);
  return dir;
}
const paths = result => result.paths.map(p => p.nodes);

test('两点数据流：支持函数/函数、函数/变量、变量/变量和真实读写方向，不用调用关系猜测数据流', async t => {
  const dir = fixture(t), model = loadModel(dir);
  const fn = name => `flow.c::${name}`;
  const functions = await pairDataflow(model, fn('writer'), fn('reader'));
  assert.deepEqual(paths(functions), [[fn('writer'), 'var::input', fn('reader')]]);
  assert.deepEqual(paths(await pairDataflow(model, 'var::input', fn('writer'))), [[fn('writer'), 'var::input']], '点击顺序不能改变方向');
  assert.deepEqual(paths(await pairDataflow(model, fn('reader'), 'var::input')), [['var::input', fn('reader')]]);
  const variables = await pairDataflow(model, 'var::input', 'var::output');
  assert.ok(paths(variables).some(p => JSON.stringify(p) === JSON.stringify(['var::input', fn('transform'), 'var::output'])));
  assert.ok(paths(variables).some(p => JSON.stringify(p) === JSON.stringify(['var::output', fn('bidirectional'), 'var::input'])));
  assert.equal((await pairDataflow(model, fn('caller'), fn('consumer'))).paths.length, 0, '仅有调用关系不算数据流');
  assert.equal((await pairDataflow(model, fn('write_field'), fn('read_other_field'))).paths.length, 0, '不混淆不同结构体成员');
  assert.equal((await pairDataflow(model, 'var::isolated', fn('reader'))).paths.length, 0);
  const indirect = await pairDataflow(model, fn('writer'), fn('consumer'));
  assert.ok(paths(indirect).some(p => p.length === 5 && p.includes(fn('transform'))));
});

test('结构体读写：整体与成员混用保留通配，嵌套字段区分分支并匹配父子路径', async t => {
  const model = loadModel(fixture(t)), fn = name => `flow.c::${name}`;
  assert.ok((await pairDataflow(model, fn('write_mixed'), fn('read_right'))).paths.length, '整体写入覆盖其他成员');
  assert.ok((await pairDataflow(model, fn('write_left'), fn('read_mixed'))).paths.length, '整体读取覆盖其他成员');
  assert.equal((await pairDataflow(model, fn('write_left'), fn('read_right_same_leaf'))).paths.length, 0, '同名叶字段不代表同一成员');
  assert.ok((await pairDataflow(model, fn('write_left'), fn('read_left'))).paths.length);
  assert.ok((await pairDataflow(model, fn('write_parent'), fn('read_left'))).paths.length, '父成员写入覆盖子成员');
});

test('联合体不同成员共享存储，包括嵌套及 typedef 引用', async t => {
  const dir = fixture(t);
  fs.appendFileSync(path.join(dir, 'flow.c'), `
typedef union U { unsigned a, b; } U;
struct Holder { int x; U shared; } holder;
U data;
void union_write(void) { data.a = 1; }
unsigned union_read(void) { return data.b; }
void nested_union_write(void) { holder.shared.a = 1; }
unsigned nested_union_read(void) { return holder.shared.b; }
`);
  const model = loadModel(dir), fn = name => `flow.c::${name}`;
  assert.ok((await pairDataflow(model, fn('union_write'), fn('union_read'))).paths.length);
  assert.ok((await pairDataflow(model, fn('nested_union_write'), fn('nested_union_read'))).paths.length);
  assert.equal((await pairDataflow(model, fn('write_left'), fn('read_right_same_leaf'))).paths.length, 0,
    '其他没有联合体的结构体仍区分成员');
});

test('比较两点数据流：before 和 after 各自独立查找，不拼接跨版本读写', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pair-compare-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const d of ['project', 'before', 'after']) fs.mkdirSync(path.join(dir, d));
  const before = 'int value; void writer(void){value=1;} int reader(void){return 0;}';
  const after = 'int value; void writer(void){} int reader(void){return value;}';
  for (const d of ['project', 'before']) fs.writeFileSync(path.join(dir, d, 'flow.c'), before);
  fs.writeFileSync(path.join(dir, 'after/flow.c'), after);
  let comparison = await compareProjects(path.join(dir, 'project'), path.join(dir, 'before'), path.join(dir, 'after'));
  assert.equal((await comparisonPairDataflow(comparison, 'flow.c::writer', 'flow.c::reader')).paths.length, 0);
  fs.writeFileSync(path.join(dir, 'after/flow.c'), before.replace('return 0;', 'return value;'));
  comparison = await compareProjects(path.join(dir, 'project'), path.join(dir, 'before'), path.join(dir, 'after'));
  assert.deepEqual((await comparisonPairDataflow(comparison, 'flow.c::writer', 'flow.c::reader')).paths[0].versions, ['after']);
});

test('两点接口：仅显式查询触发分析，不改画布；无效端点、旧工程和旧比较会话被拒绝', async t => {
  const dir = fixture(t), srv = await launchServer({ target: dir });
  t.after(() => srv.close());
  const get = url => fetch(srv.baseUrl + url).then(r => r.json());
  const post = async body => {
    const r = await fetch(srv.baseUrl + '/api/dataflow/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const project = await get('/api/project');
  const view = '/api/view?root=flow.c::writer&up=0&down=0';
  const original = (await get(view)).nodes.map(n => n.id);
  assert.equal((await fetch(srv.baseUrl + '/api/node?id=var::deferred')).status, 404);
  const request = { projectId: project.id, a: 'flow.c::writer', b: 'flow.c::reader' };
  assert.equal((await post({ ...request, projectId: -1 })).status, 409);
  assert.equal((await post({ ...request, comparisonId: 'old' })).status, 409);
  assert.equal((await post({ ...request, b: request.a })).status, 400);
  assert.equal((await post(null)).status, 400);
  assert.equal((await post({ ...request, b: 'missing' })).status, 400);
  const result = await post(request);
  assert.equal(result.status, 200); assert.equal(result.body.paths.length, 1);
  assert.deepEqual((await get(view)).nodes.map(n => n.id), original);
});

test('数据流展示：读取逆向沿原线播放，隐藏变量只形成临时段；脉冲与自定义选中色区分', () => {
  const view = { nodes: [{ id: 'reader' }, { id: 'var' }], edges: [{ from: 'reader', to: 'var', points: [[0, 0], [20, 0]] }] };
  const result = { nodes: [{ id: 'var', name: 'state' }, { id: 'reader' }], paths: [{ nodes: ['var', 'reader'] }] };
  const segment = pairFlowSegments(view, result)[0];
  assert.deepEqual(segment.points, [[20, 0], [0, 0]]);
  assert.deepEqual(view.edges[0].points, [[0, 0], [20, 0]], '不反转原图数据');
  const hidden = pairFlowSegments({ nodes: [{ id: 'writer' }, { id: 'reader' }], edges: [] },
    { ...result, paths: [{ nodes: ['writer', 'var', 'reader'] }] });
  assert.deepEqual(hidden.map(s => [s.from, s.to, s.via]), [['writer', 'reader', 'state']]);
  for (const color of ['#185FA5', '#FF8A00', '#00E5FF', '#7C2D12', '#FFFFFF', '#000000']) assert.notEqual(flowPulseColor(color), color);
});

test('两点路径查询有界：分支很多时限制路径数量，过深链路明确提示截断', async () => {
  const byId = new Map(), fnAccess = new Map(), readers = new Map(), writers = new Map();
  const nodes = new Map();
  const rec = () => ({ fields: new Set(), lines: new Set([1]), indirect: false });
  const add = (id, read, write) => {
    nodes.set(id, { id, name: id });
    fnAccess.set(id, { reads: new Map(read.map(v => [v, rec()])), writes: new Map(write.map(v => [v, rec()])) });
    for (const [vars, index] of [[read, readers], [write, writers]]) for (const v of vars) {
      byId.set(v, { id: v, name: v });
      if (!index.has(v)) index.set(v, new Set());
      index.get(v).add(id);
    }
  };
  add('source', [], ['x']); add('sink', ['y'], []);
  for (let i = 0; i < 100; i++) add('middle' + i, ['x'], ['y']);
  const model = { _df: { byId, fnAccess, readers, writers, failedFiles: 0 }, _index: { byId: nodes } };
  const result = await pairDataflow(model, 'source', 'sink');
  assert.equal(result.paths.length, 12); assert.equal(result.truncated, true);
  for (let i = 0; i < 12; i++) add('long' + i, i ? ['v' + (i - 1)] : [], ['v' + i]);
  const deep = await pairDataflow(model, 'long0', 'long11');
  assert.equal(deep.paths.length, 0); assert.equal(deep.truncated, true);
});
