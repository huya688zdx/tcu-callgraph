import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { compareProjects } from '../src/core/compare.js';
import { launchServer } from '../scripts/lib/server.mjs';

const beforePath = path.resolve('samples/diff/before');
const afterPath = path.resolve('samples/diff/after');
const projectPath = path.resolve('samples/diff/project');
const requests = (srv) => ({
  get: (url) => fetch(srv.baseUrl + url).then((r) => r.json()),
  post: (url, body) => fetch(srv.baseUrl + url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
});

test('总代码加局部差分：保留对照外的调用者和读取者，退出仍回总代码工程', async (t) => {
  const result = await compareProjects(projectPath, beforePath, afterPath);
  assert.deepEqual(result.summary.functions, { existing: 4, modified: 2, added: 1, deleted: 1 });
  assert.deepEqual(result.summary.variables, { existing: 1, modified: 1, added: 1, deleted: 1 });
  const fn = (name) => result.model.functions.find((f) => f.name === name);
  assert.equal(fn('Sensor_Update').change, 'modified');
  assert.ok(fn('Sensor_Update').reasons.includes('宏展开变化'));
  assert.equal(fn('Legacy_Log').change, 'deleted');
  assert.equal(fn('Monitor_Read').change, 'existing');
  assert.ok(fn('Monitor_Read').impact);
  assert.ok(fn('Supervisor_Read').impact, '不在 before/after 中的读取者也要从总代码工程找到');
  assert.equal(fn('Supervisor_Read').change, 'existing');
  assert.ok(fn('main').impact, '对照外的主工程调用者不能丢失');
  assert.ok(fn('Normalize').context);
  assert.ok(result.model.edges.some((e) => e.to === 'control.c::Legacy_Log' && e.change === 'deleted'));
  assert.ok(result.model.edges.some((e) => e.to === 'control.c::Diagnostics' && e.change === 'added'));

  const srv = await launchServer({ target: projectPath }); t.after(() => srv.close());
  const { get, post } = requests(srv);
  await post('/api/overlay', { nodeId: 'var::g_limit', data: { change: 'existing' } });
  const project = await get('/api/project');
  await post('/api/page', { roots: ['main.c::main'], projectId: project.id, down: 2, group: true });
  assert.equal((await post('/api/compare', { beforePath, afterPath })).ok, true);
  const view = await get('/api/view');
  assert.equal(view.nodes.length, 12);
  assert.equal(typeof (await get('/api/orphans')).total, 'number');
  assert.equal((await get('/api/node?id=var::g_limit')).node.change, 'modified', '失效标注检查不能重建并覆盖比较模型');
  assert.equal((await get('/api/project')).path, projectPath);
  assert.equal((await get('/api/compare')).comparison.projectPath, projectPath);
  assert.ok(view.nodes.some((n) => n.id === 'observer.c::Supervisor_Read'));
  assert.equal(view.nodes.find((n) => n.id === 'var::g_limit').change, 'modified', '普通人工标注不覆盖比较分类');
  assert.ok(view.nodes.some((n) => n.id === 'control.c::Legacy_Log' && n.change === 'deleted'));
  assert.ok(view.edges.some((e) => e.change === 'added') && view.edges.some((e) => e.change === 'deleted'));
  const focused = await get('/api/view?root=control.c::Diagnostics&down=0&vars=var::g_fault');
  assert.equal(focused.nodes.find((n) => n.id === 'var::g_fault').change, 'added');
  assert.ok(focused.edges.some((e) => e.to === 'var::g_fault' && e.change === 'added'));
  assert.equal((await post('/api/delete', { nodes: ['main.c::main'] })).ok, false);
  assert.equal((await post('/api/overlay', { nodeId: 'var::g_limit', data: { change: 'added' } })).ok, false);
  await post('/api/page', { roots: ['control.c::Legacy_Log'], projectId: project.id });
  assert.equal((await get('/api/page?saved=1')).page, null);
  const flow = await get('/api/dataflow?fn=sensor.c::Sensor_Update&dir=out');
  assert.ok(flow.vars.some((v) => v.version === 'before' && v.peers.some((p) => p.name === 'Monitor_Read')));
  assert.ok(flow.vars.some((v) => v.version === 'after' && v.peers.some((p) => p.name === 'Monitor_Read')));
  assert.equal((await post('/api/compare/exit', {})).ok, true);
  assert.equal((await get('/api/project')).comparison, null);
  assert.equal((await get('/api/project')).path, projectPath);
  assert.equal((await get('/api/node?id=var::g_limit')).overlay.change, 'existing');
  assert.deepEqual((await get('/api/page?saved=1')).page.roots, ['main.c::main']);
  assert.equal((await get('/api/node?id=control.c::Legacy_Log')).error, 'not found');
});

test('比较失败保留原工程：不存在的 after 不发布部分结果', async (t) => {
  const srv = await launchServer(); t.after(() => srv.close());
  const { get, post } = requests(srv);
  const original = await get('/api/project');
  const failed = await post('/api/compare', { beforePath, afterPath: path.join(afterPath, '不存在的目录') });
  assert.equal(failed.ok, false);
  assert.equal((await get('/api/project')).path, original.path);
  assert.equal((await get('/api/project')).comparison, null);
  assert.ok((await get('/api/view')).nodes.some((n) => n.name === 'main'));
});
