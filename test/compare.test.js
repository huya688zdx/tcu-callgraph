import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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
  assert.deepEqual(result.summary.functions, { existing: 5, modified: 1, added: 1, deleted: 1 });
  assert.deepEqual(result.summary.variables, { existing: 1, modified: 1, added: 1, deleted: 1 });
  const fn = (name) => result.model.functions.find((f) => f.name === name);
  assert.equal(fn('Sensor_Update').change, 'existing');
  assert.ok(fn('Sensor_Update').impact);
  assert.ok(fn('Sensor_Update').reasons.some((r) => r.includes('宏展开变化')));
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
  const prepared = await post('/api/compare', { beforePath, afterPath });
  assert.equal(prepared.ok, true);
  assert.equal((await get('/api/project')).comparison, null, '解析只生成预览，不切换工程模型');
  assert.equal((await post('/api/compare/apply', { previewId: prepared.preview.id, selectedIds: prepared.preview.candidates.map((n) => n.id) })).ok, true);
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

function nestedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-compare-map-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['src', 'before', 'after']) fs.mkdirSync(path.join(root, dir));
  const old = 'int g_state=1; int work(void){return g_state;}';
  const now = 'int g_state=2; int work(void){return g_state+1;}';
  fs.writeFileSync(path.join(root, 'src/control.c'), old);
  fs.writeFileSync(path.join(root, 'before/control.c'), old);
  fs.writeFileSync(path.join(root, 'after/control.c'), now);
  fs.writeFileSync(path.join(root, 'main.c'), 'void keep(void){} void main(void){work();keep();}');
  return { root, before: path.join(root, 'before'), after: path.join(root, 'after') };
}

test('嵌套对照目录不重复扫描；稀疏文件按唯一后缀对应真实工程路径', async (t) => {
  const f = nestedFixture(t);
  const result = await compareProjects(f.root, f.before, f.after);
  assert.deepEqual(result.model.files.map((n) => n.rel).sort(), ['main.c', 'src/control.c']);
  assert.equal(result.model.functions.length, 3);
  assert.equal(result.model.variables.length, 1);
  assert.equal(result.model._index.byId.get('src/control.c::work').change, 'modified');
  assert.equal(result.model._index.byId.get('var::g_state').change, 'modified');
  assert.ok(result.model.edges.some((e) => e.from === 'main.c::main' && e.to === 'src/control.c::work'));
  assert.ok(result.mappings.every((m) => m.target === 'src/control.c' && m.matched));
  assert.ok(result.warnings.some((w) => w.includes('control.c → src/control.c')));
});

test('文件对应歧义和目录互相包含时明确拒绝，不猜测新增/删除', async (t) => {
  const f = nestedFixture(t);
  fs.mkdirSync(path.join(f.root, 'other'));
  fs.writeFileSync(path.join(f.root, 'other/control.c'), 'void other(void){}');
  await assert.rejects(compareProjects(f.root, f.before, f.after), /对应多个工程文件/);
  await assert.rejects(compareProjects(f.root, f.before, path.join(f.before, 'nested')), /ENOENT/);
  fs.mkdirSync(path.join(f.before, 'nested'));
  await assert.rejects(compareProjects(f.root, f.before, path.join(f.before, 'nested')), /不能互相包含/);
});

test('比较预览可取消；只加入勾选对象并保留原图，退出恢复原标注与模型', async (t) => {
  const srv = await launchServer({ target: projectPath }); t.after(() => srv.close());
  const { get, post } = requests(srv);
  await post('/api/overlay', { nodeId: 'main.c::main', data: { note: '原图备注' } });
  const original = await get('/api/view?root=main.c::main&up=0&down=0');
  const p = await post('/api/compare', { beforePath, afterPath });
  assert.ok(p.preview.candidates.some((n) => n.id === 'var::g_fault' && n.change === 'added'));
  assert.equal((await get('/api/project')).comparison, null);
  assert.deepEqual((await get('/api/view?root=main.c::main&up=0&down=0')).nodes.map((n) => n.id), original.nodes.map((n) => n.id));
  await post('/api/compare/cancel', { previewId: p.preview.id });
  assert.equal((await post('/api/compare/apply', { previewId: p.preview.id, selectedIds: ['var::g_fault'] })).ok, false);
  const next = await post('/api/compare', { beforePath, afterPath });
  assert.equal((await post('/api/compare/apply', { previewId: next.preview.id, selectedIds: ['missing'] })).ok, false);
  assert.equal((await get('/api/project')).comparison, null);
  const applied = await post('/api/compare/apply', { previewId: next.preview.id, selectedIds: ['var::g_fault'], retainIds: ['main.c::main'] });
  assert.equal(applied.ok, true);
  const view = await get('/api/view');
  assert.deepEqual(view.nodes.map((n) => n.id).sort(), ['main.c::main', 'var::g_fault']);
  assert.equal(view.nodes.find((n) => n.id === 'main.c::main').note, '原图备注');
  assert.ok(!view.nodes.some((n) => n.id === 'control.c::Diagnostics'));
  const bodyView = await post('/api/view?up=0&down=0', { roots: ['main.c::main', 'var::g_fault'], vars: ['var::g_fault'] });
  assert.deepEqual(bodyView.nodes.map((n) => n.id).sort(), ['main.c::main', 'var::g_fault']);
  await post('/api/compare/exit', {});
  assert.equal((await get('/api/project')).comparison, null);
  assert.equal((await get('/api/node?id=main.c::main')).overlay.note, '原图备注');
  assert.equal((await get('/api/node?id=var::g_fault')).node.versions, undefined, '退出恢复原工程节点，不残留比较版本数据');
});

test('预览绑定原工程，切换后不能把旧结果加入新工程', async (t) => {
  const srv = await launchServer({ target: projectPath }); t.after(() => srv.close());
  const { get, post } = requests(srv);
  const p = await post('/api/compare', { beforePath, afterPath });
  await post('/api/switch', { path: 'samples/tcu' });
  const applied = await post('/api/compare/apply', { previewId: p.preview.id, selectedIds: ['var::g_fault'] });
  assert.equal(applied.ok, false);
  assert.equal((await get('/api/project')).comparison, null);
});

test('变更颜色只依据实际定义和关系差分；未改动的调用者、变量和连线保持既存', async (t) => {
  const f = nestedFixture(t);
  const old = 'int changed=1; int stable_data=0; int via_macro=RATE; int direct(void){return 1;} int stable(void){return direct()+stable_data+via_macro;}';
  const now = '\n/* 行号变化不是调用关系变更 */\n'+old.replace('changed=1','changed=2').replace('return 1;', 'return 2;');
  for (const [dir, text, rate] of [['before',old,1],['after',now,2]]) {
    fs.writeFileSync(path.join(f.root,dir,'control.c'),text);
    fs.writeFileSync(path.join(f.root,dir,'config.h'),'#define RATE '+rate);
  }
  fs.writeFileSync(path.join(f.root,'src/control.c'),old);
  const result = await compareProjects(f.root,f.before,f.after);
  const node=id=>result.model._index.byId.get(id);
  assert.equal(node('var::changed').change,'modified');
  assert.equal(node('src/control.c::direct').change,'modified');
  for(const id of ['var::stable_data','var::via_macro','src/control.c::stable','main.c::main','main.c::keep']) assert.equal(node(id).change,'existing',id);
  assert.ok(node('var::via_macro').impact);
  assert.ok(result.model.edges.filter(e=>e.from==='src/control.c::stable').every(e=>e.change==='existing'));
  const srv=await launchServer({target:f.root});t.after(()=>srv.close());
  const {post,get}=requests(srv);
  await post('/api/overlay',{nodeId:'src/control.c::stable',data:{color:'#FFFF99',change:'modified'}});
  const prepared=await post('/api/compare',{beforePath:f.before,afterPath:f.after});
  await post('/api/compare/apply',{previewId:prepared.preview.id,selectedIds:['src/control.c::stable','var::stable_data','src/control.c::direct']});
  const view=await get('/api/view');
  assert.equal(view.nodes.find(n=>n.id==='src/control.c::stable').change,'existing');
  assert.equal(view.nodes.find(n=>n.id==='src/control.c::stable').color,undefined,'比较时不能沿用普通工程的人工变更色');
  assert.ok(view.edges.every(e=>e.change==='existing'));
});
