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
  const macroReason = '宏/LSB 展开变化: SCALE (10 → 20)';
  assert.ok(fn('Sensor_Update').reasons.includes(macroReason));
  assert.equal(fn('Sensor_Update').macroImpact, true);
  assert.deepEqual(fn('Sensor_Update').macroNames, ['SCALE']);
  assert.equal(fn('Sensor_Update').impactRole, 'macro_lsb_impact');
  assert.deepEqual(result.macroChanges, ['config.h::SCALE']);
  assert.deepEqual(result.macroDetails, [{ id: 'macro::SCALE', name: 'SCALE', file: 'config.h', before: '10', after: '20', isNumeric: true }]);
  const macroPoint = result.changePoints.find(p => p.id === 'macro::SCALE');
  assert.deepEqual([macroPoint.kind, macroPoint.change, macroPoint.beforeValue, macroPoint.afterValue], ['macro_lsb', 'modified', '10', '20']);
  for (const id of ['sensor.c::Sensor_Update', 'var::g_rpm', 'observer.c::Supervisor_Read', 'control.c::Monitor_Read', 'main.c::main']) {
    assert.ok(macroPoint.affectedIds.includes(id), id);
    assert.ok(result.model._index.byId.get(id).impactChainIds.includes(macroPoint.id), id);
  }
  assert.ok(!macroPoint.affectedIds.includes('sensor.c::Normalize'));
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
  assert.deepEqual(prepared.preview.macroDetails, result.macroDetails);
  assert.deepEqual(prepared.preview.changePoints.find(p => p.id === macroPoint.id), macroPoint);
  assert.equal(prepared.preview.candidates.find(n => n.id === 'sensor.c::Sensor_Update').impactRole, 'macro_lsb_impact');
  assert.equal((await get('/api/project')).comparison, null, '解析只生成预览，不切换工程模型');
  assert.equal((await post('/api/compare/apply', { previewId: prepared.preview.id, selectedIds: prepared.preview.candidates.map((n) => n.id) })).ok, true);
  const view = await get('/api/view');
  assert.equal(view.nodes.length, 12);
  assert.deepEqual(view.comparison.macroDetails, result.macroDetails);
  assert.equal(view.nodes.find(n => n.id === 'observer.c::Supervisor_Read').impactRole, 'dataflow_impact');
  const detail = await get('/api/node?id=sensor.c::Sensor_Update');
  assert.ok(detail.node.impactChainIds.includes(macroPoint.id));
  assert.deepEqual(detail.changePoints.find(p => p.id === macroPoint.id), macroPoint);
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

test('比较视图找回两端在图上的手工关系；普通模式仍只认当前视图槽位', async (t) => {
  const srv = await launchServer({ target: projectPath }); t.after(() => srv.close());
  const { get, post } = requests(srv);
  // 手工关系画在 main 视图槽位里；比较模式的 roots 是「保留+选中」合集，键对不上
  await post('/api/layout', { root: 'main.c::main', manual: [
    { from: 'main.c::main', to: 'var::g_fault' },
    { from: 'main.c::main', to: 'control.c::Monitor_Read' },
  ] });
  const normal = await get('/api/view?root=main.c::main&up=0&down=0&group=0&vars=var::g_fault');
  assert.ok(normal.edges.some((e) => e.manual && e.to === 'var::g_fault'));
  assert.ok(!normal.edges.some((e) => e.manual && e.to === 'control.c::Monitor_Read'), '端点不在图上的手工关系不显示');
  // 换个入口的普通视图：手工关系不跨槽位泄漏
  const other = await get('/api/view?root=control.c::Monitor_Read&up=1&down=0&group=0');
  assert.ok(!other.edges.some((e) => e.manual));
  const p = await post('/api/compare', { beforePath, afterPath });
  assert.equal((await post('/api/compare/apply', {
    previewId: p.preview.id, selectedIds: ['var::g_fault'],
    retainIds: ['main.c::main', 'control.c::Monitor_Read'],
  })).ok, true);
  const view = await get('/api/view');
  assert.ok(view.edges.some((e) => e.manual && e.from === 'main.c::main' && e.to === 'var::g_fault'),
    '比较模式槽位键对不上，两端保留的手工关系也要找回显示');
  assert.ok(view.edges.some((e) => e.manual && e.to === 'control.c::Monitor_Read'));
  await post('/api/compare/exit', {});
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

test('比较视图保留头文件宏的调用者和实现映射', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-compare-header-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['project', 'before', 'after']) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'api.h'), '#define Run Real\n');
    fs.writeFileSync(path.join(dir, name, 'main.c'), 'void Real(void) {}\nvoid main(void) { Run(); }\n');
  }
  const srv = await launchServer({ target: path.join(dir, 'project') }); t.after(() => srv.close());
  const { get, post } = requests(srv);
  const preview = await post('/api/compare', { beforePath: path.join(dir, 'before'), afterPath: path.join(dir, 'after') });
  assert.equal((await post('/api/compare/apply', { previewId: preview.preview.id, selectedIds: ['main.c::main'] })).ok, true);
  const id = 'header::api.h::Run';
  const view = await get('/api/view?root=' + encodeURIComponent(id) + '&up=1&down=1');
  assert.ok(view.edges.some((e) => e.from === 'main.c::main' && e.to === id));
  assert.ok(view.edges.some((e) => e.from === id && e.to === 'main.c::Real'));
});

function sourceComparison(t, before, after) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-compare-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = ['project', 'before', 'after'].map(dir => path.join(root, dir));
  for (const [i, source] of [before, before, after].entries()) {
    fs.mkdirSync(dirs[i]);
    fs.writeFileSync(path.join(dirs[i], 'work.c'), source);
  }
  return dirs;
}

test('提前返回条件变化会影响同块后续写入及其读者', async (t) => {
  const before = `
int g_shared;
int g_other;
void update(int x) {
  g_other = 2;
  if (x < 0) return;
  { g_shared = 1; }
}
int read_shared(void) { return g_shared; }
`;
  const result = await compareProjects(...sourceComparison(t, before, before.replace('x < 0', 'x <= 0')));
  const point = result.changePoints.find(({ id }) => id === 'work.c::update');
  assert.ok(point.affectedIds.includes('var::g_shared'));
  assert.ok(point.affectedIds.includes('work.c::read_shared'));
  assert.ok(!point.affectedIds.includes('var::g_other'));
});

test('提前退出条件使用退出点的局部变量，循环内 break 不传播到循环外', async (t) => {
  const before = `
int g_shared;
int g_unrelated;
void update(int x) {
  { int stop = x < 0; if (stop) return; }
  g_shared = 1;
}
void process(int x) {
  while (x) { if (x == 1) break; --x; }
  g_unrelated = 1;
}
`;
  const after = before.replace('x < 0', 'x <= 0').replace('x == 1', 'x == 2');
  const { changePoints } = await compareProjects(...sourceComparison(t, before, after));
  assert.ok(changePoints.find(({ id }) => id === 'work.c::update').affectedIds.includes('var::g_shared'));
  assert.ok(!changePoints.find(({ id }) => id === 'work.c::process').affectedIds.includes('var::g_unrelated'));
});

test('纯 C 工程中 RTOS 延时宏从 20 ms 改为 10 ms，工作函数和下游函数均标记周期影响', async t => {
  const src = `
#include "schedule.h"
int pressure_read(void) { return 1; }
static void controller_loop(void) {
  while (1) {
    pressure_read();
    vTaskDelay(pdMS_TO_TICKS(STEP_TIME));
  }
}
static void controller_entry(void *arg) { controller_loop(); }
void start_controller(void) { xTaskCreatePinnedToCore(controller_entry, "control", 0, 0, 0, 0, 1); }
`;
  const dirs = sourceComparison(t, src, src);
  for (const [index, dir] of dirs.entries()) {
    fs.writeFileSync(path.join(dir, 'schedule.h'), `#define STEP_TIME ${index === 2 ? 10 : 20}\n`);
  }
  const result = await compareProjects(...dirs);
  for (const name of ['controller_loop', 'pressure_read']) {
    const id = `work.c::${name}`;
    const node = result.model._index.byId.get(id);
    assert.equal(node.change, 'existing');
    assert.equal(node.periodImpact, true);
    assert.deepEqual(node.periods, { before: ['20ms'], after: ['10ms'] });
    assert.ok(result.changePoints.some(point => point.kind === 'period' && point.affectedIds.includes(id)));
  }
});

test('未改动的叶函数和变量保留两侧实际周期，周期变化进入影响链和接口', async (t) => {
  const before = `
int g;
int Leaf(void) { return g; }
void Write(void) { g = 1; }
void Unscheduled(void) {}
void Gained(void) {}
void App_Task10ms(void) { Leaf(); Unscheduled(); }
`;
  const after = before.replace('App_Task10ms', 'App_Task20ms').replace('Unscheduled();', 'Gained();');
  const dirs = sourceComparison(t, before, after);
  const result = await compareProjects(...dirs);
  const id = 'work.c::Leaf';
  for (const nodeId of [id, 'var::g']) {
    const n = result.model._index.byId.get(nodeId);
    assert.deepEqual([n.change, n.periodImpact, n.impactRole, n.impact, n.context], ['existing', true, 'period_impact', true, false]);
    assert.deepEqual(n.periods, { before: ['10ms'], after: ['20ms'] });
    assert.equal(n.reasons[0], '周期变化: 10ms → 20ms');
    assert.ok(result.roots.includes(nodeId));
    assert.ok(result.impactIds.includes(nodeId));
    const p = result.changePoints.find(point => point.id === 'period::' + nodeId);
    assert.equal(p.kind, 'period');
    assert.ok(n.impactChainIds.includes(p.id));
    assert.ok(p.affectedIds.includes(nodeId));
  }
  for (const [name, before, after] of [['Unscheduled', ['10ms'], []], ['Gained', [], ['20ms']]]) {
    const n = result.model._index.byId.get('work.c::' + name);
    assert.equal(n.impactRole, 'period_impact');
    assert.deepEqual(n.periods, { before, after });
  }
  const srv = await launchServer({ target: dirs[0] }); t.after(() => srv.close());
  const { get, post } = requests(srv);
  const { preview } = await post('/api/compare', { beforePath: dirs[1], afterPath: dirs[2] });
  assert.equal(preview.candidates.find(n => n.id === id).periodImpact, true);
  assert.equal((await post('/api/compare/apply', { previewId: preview.id, selectedIds: [id, 'var::g'] })).ok, true);
  const { nodes, comparison } = await get('/api/view');
  assert.ok(comparison.changePoints.some(p => p.id === 'period::' + id));
  assert.deepEqual(nodes.find(n => n.id === id).periodBefore, ['10ms']);
  assert.deepEqual((await get('/api/node?id=' + id)).node.periodAfter, ['20ms']);
  const flow = await get('/api/dataflow?fn=work.c::Write&dir=out');
  assert.deepEqual(flow.vars.flatMap(v => v.peers.map(p => [p.version, p.id, p.taskPeriods.map(c => c.us)])),
    [['before', id, [10000]], ['after', id, [20000]]]);
});

test('已存在的调用边记录调用次数从 1 次变为 2 次', async (t) => {
  const before = 'void Callee(void) {} void Caller(void) { Callee(); }';
  const result = await compareProjects(...sourceComparison(t, before, before.replace('Callee();', 'Callee(); Callee();')));
  const caller = result.model._index.byId.get('work.c::Caller');
  const edge = result.model.edges.find(e => e.from === caller.id && e.to === 'work.c::Callee');
  const reason = '调用次数变化: Callee (1 → 2 次)';
  assert.ok(caller.reasons.includes(reason));
  assert.equal(edge.change, 'existing');
  assert.deepEqual([edge.beforeCalls.length, edge.afterCalls.length, edge.reasons], [1, 2, [reason]]);
});

test('只传播变化的成员、写入值及依赖，区分同行的独立语句', async (t) => {
  const before = `
struct Pair { int left; int right; } g;
int g_a, g_b, g_copy, g_fixed;
void Write(void) { int v = 1; g.left = 1; g.right = 2; g_a = 3; g_b = v; }
void Copy(void) { g_copy = g.left; g_fixed = g.right; }
int Left(void) { return g.left; }
int Right(void) { return g.right; }
int A(void) { return g_a; }
int B(void) { return g_b; }
int Copied(void) { return g_copy; }
int Fixed(void) { return g_fixed; }
`;
  const after = before.replace('v = 1; g.left = 1', 'v = 2; g.left = 8');
  const result = await compareProjects(...sourceComparison(t, before, after));
  const point = result.changePoints.find(p => p.id === 'work.c::Write');
  for (const id of ['work.c::Write', 'work.c::Left', 'work.c::Copy', 'work.c::Copied', 'work.c::B', 'var::g', 'var::g_b', 'var::g_copy']) {
    assert.ok(point.affectedIds.includes(id), id);
  }
  for (const id of ['work.c::Right', 'work.c::A', 'work.c::Fixed', 'var::g_a', 'var::g_fixed']) {
    const n = result.model._index.byId.get(id);
    assert.equal(n.impact, false, id);
    assert.equal(n.impactRole, 'unrelated', id);
    assert.ok(!point.affectedIds.includes(id), id);
  }
});

test('局部聚合对象的成员赋值、下标赋值和更新传播到全局写入及读者', async (t) => {
  const before = `
struct S { int v; int values[2]; };
typedef struct S *SPtr;
int g, g_array, g_update, g_fixed;
void Write(void) {
  struct S s;
  s.v = 1;
  s.values[0] = 0;
  g = s.v;
  int a[2];
  (a)[0] = 3;
  a[1] = 0;
  g_array = a[0];
  struct S updated = {0};
  (updated.v)++;
  g_update = updated.v;
  struct S indirect = {0};
  SPtr ptr = &indirect;
  ptr->v = 5;
  g_fixed = ptr != 0;
}
int Read(void) { return g; }
int ReadArray(void) { return g_array; }
int ReadUpdate(void) { return g_update; }
int ReadFixed(void) { return g_fixed; }
`;
  const after = before.replace('s.v = 1', 's.v = 2')
    .replace('(a)[0] = 3', '(a)[0] = 4').replace('(updated.v)++', '(updated.v)--')
    .replace('ptr->v = 5', 'ptr->v = 6');
  const result = await compareProjects(...sourceComparison(t, before, after));
  const point = result.changePoints.find(p => p.id === 'work.c::Write');
  assert.deepEqual(new Set(point.affectedIds), new Set([
    'work.c::Write', 'var::g', 'var::g_array', 'var::g_update',
    'work.c::Read', 'work.c::ReadArray', 'work.c::ReadUpdate',
  ]));
});

test('同一函数使用多个变更宏时，按各自的写入追踪影响链', async (t) => {
  const before = `
#define SCALE 10
#define SCALE_ALIAS SCALE
#define LIMIT 100
int g_rpm, g_limit;
void Update(void) { int rpm = SCALE_ALIAS; g_rpm = rpm; g_limit = LIMIT; }
int ReadRpm(void) { return g_rpm; }
int ReadLimit(void) { return g_limit; }
`;
  const after = before.replace('SCALE 10', 'SCALE 20').replace('LIMIT 100', 'LIMIT 200');
  const result = await compareProjects(...sourceComparison(t, before, after));
  for (const [name, ...affected] of [
    ['SCALE', 'work.c::Update', 'var::g_rpm', 'work.c::ReadRpm'],
    ['LIMIT', 'work.c::Update', 'var::g_limit', 'work.c::ReadLimit'],
  ]) {
    const point = result.changePoints.find(p => p.id === 'macro::' + name);
    assert.deepEqual(new Set(point.affectedIds), new Set(affected));
  }
});

test('同一函数兼有定义修改和宏变化时，写入归到相应变更点', async (t) => {
  const before = `
#define SCALE 10
int g_rpm, g_other;
void Update(void) { g_rpm = SCALE; g_other = 1; }
int ReadRpm(void) { return g_rpm; }
int ReadOther(void) { return g_other; }
`;
  const after = before.replace('SCALE 10', 'SCALE 20').replace('g_other = 1', 'g_other = 2');
  const result = await compareProjects(...sourceComparison(t, before, after));
  const update = result.model._index.byId.get('work.c::Update');
  assert.equal(update.impactRole, 'direct_change');
  assert.equal(update.macroImpact, true);
  for (const [id, ...affected] of [
    ['macro::SCALE', update.id, 'var::g_rpm', 'work.c::ReadRpm'],
    [update.id, update.id, 'var::g_other', 'work.c::ReadOther'],
  ]) {
    assert.deepEqual(new Set(result.changePoints.find(p => p.id === id).affectedIds), new Set(affected));
  }
});
