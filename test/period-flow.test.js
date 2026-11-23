import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModel, subgraph } from '../src/core/index.js';
import { parseDot, modelFromDot } from '../src/core/dot.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { callSequence, callNumbers } from '../src/core/call-sequence.js';
import { projectTasks, withTaskPeriods } from '../src/core/task-periods.js';
import { detectTasks } from '../src/core/detect-tasks.js';
import { exportSvg } from '../src/core/export-svg.js';
import { edgeCaption, svgMarkers } from '../web/lib/edge-flow.js';
import { traceVisiblePaths } from '../web/lib/visible-paths.js';
import { launchServer } from '../scripts/lib/server.mjs';

const dot = contents => modelFromDot(parseDot(`digraph G { ${contents} }`));

test('局部视图保留完整工程中的多个任务，且不沿变量访问或数据流传递周期', () => {
  const model = loadModel(fileURLToPath(new URL('../samples/demo', import.meta.url)));
  const node = model.functions.find(f => f.name === 'Diag_Report');
  const [report] = withTaskPeriods([node], model);
  assert.deepEqual(report.taskPeriods.map(c => c.task), ['main.c::App_Task10ms', 'main.c::App_Task100ms']);
  assert.deepEqual(report.taskPeriods.map(c => c.us), [10000, 100000]);
  const m = dot('Task_1s -> a; a -> b; b -> a; a -> reader [style=dashed]; Delay_5ms -> reader;');
  const nodes = withTaskPeriods(m.functions, m);
  assert.deepEqual(nodes.find(n => n.name === 'b').taskPeriods.map(c => c.us), [1000000]);
  assert.deepEqual(nodes.find(n => n.name === 'reader').taskPeriods, []);
});

test('修改前后独立分析周期，保留并列的调用边与数据流边', () => {
  const before = dot('Runnable_250us -> f; f -> g;');
  const after = dot('App_Task10ms -> f; f -> g [style=dashed]; f -> g [label="via CALL",style=dashed];');
  const edges = subgraph(after, 'dot::f').edges;
  assert.deepEqual(edges.map(e => e.kind).sort(), ['dataflow', 'macro']);
  const [g] = withTaskPeriods([{ id: 'dot::g', versions: ['before', 'after'] }], after,
    { beforeModel: before, afterModel: after });
  assert.deepEqual(g.previousTaskPeriods.map(c => c.us), [250]);
  assert.deepEqual(g.taskPeriods.map(c => c.us), [10000]);
});

test('读写数据的箭头、两点路径与 SVG 标记一致，标注仍使用原始端点', () => {
  const edges = [
    { from: 'write', to: 'v', kind: 'var', via: '写' },
    { from: 'read', to: 'v', kind: 'var', via: '读' },
    { from: 'both', to: 'v', kind: 'var', via: '读写' },
    { from: 'unknown', to: 'v', kind: 'var' },
  ].map(e => ({ ...e, points: [[10,10],[10,20]] }));
  const view = { width: 100, height: 100, nodes: ['write','read','v','both','unknown'].map(id => ({
    id, name: id, kind: id === 'v' ? 'var' : 'fn', file: 'test.c', x: 0, y: 0, w: 10, h: 10,
  })), edges };
  assert.deepEqual(edges.map(e => edgeCaption(e, id => id)), ['write → v','read ← v','both ↔ v','unknown — v']);
  assert.deepEqual(traceVisiblePaths(view, 'write', 'read').flowEdgeIndices, [0,1]);
  assert.deepEqual(traceVisiblePaths(view, 'both', 'read').flowEdgeIndices, [2,1]);
  assert.deepEqual(traceVisiblePaths(view, 'read', 'write').paths[0].steps.map(s => s.forward), [false,false]);
  const paths = exportSvg(view).split('\n').filter(line => line.includes('data-from='));
  for (const [i, line] of paths.entries()) {
    assert.ok(line.includes('stroke-dasharray="7 4"'));
    assert.ok(line.includes(svgMarkers(edges[i], 'mk-var')));
  }
  assert.doesNotMatch(paths[1], /marker-end/);
  assert.match(paths[2], /marker-start=.*marker-end=/);
  assert.doesNotMatch(paths[3], /marker-(?:start|end)=/, '未声明读写方向时不推测箭头');
  assert.deepEqual(traceVisiblePaths(view, 'write', 'read').paths[0].nodes, ['write', 'v', 'read']);
});

test('SVG 显示图中多条调用边的首次调用顺序，保存的手工调用标签优先，不展示自动周期副标题', () => {
  const svg = exportSvg({
    root: 'outer', nodes: [
      { id: 'A', name: 'A', file: 'main.c', line: 10, x: 0, y: 0, w: 100, h: 48, taskEntry: true, taskPeriods: [{ us: 10000 }] },
      { id: 'B', name: 'B', file: 'main.c', line: 20, x: 260, y: 0, w: 100, h: 48 },
      { id: 'C', name: 'C', file: 'main.c', line: 30, x: 260, y: 80, w: 100, h: 48 },
    ],
    edges: [
      { from: 'A', to: 'B', kind: 'direct', callNumbers: ['1'], points: [[10, 30], [250, 30]] },
      { from: 'A', to: 'C', kind: 'direct', callNumbers: ['2'], points: [[10, 110], [250, 110]],
        labels: [{ preset: 'call', text: 'コール順7' }, { preset: 'task', text: 'TASK:2ms' }] },
    ],
  });
  assert.doesNotMatch(svg, /周期待确认/);
  assert.match(svg, /main\.c:10/);
  assert.match(svg, /コール順1</);
  assert.doesNotMatch(svg, /コール順2</);
  assert.match(svg, /コール順7/);
  assert.match(svg, /TASK:2ms/);
});

test('添加预览提供最短任务链、同级调用顺序和跨周期变量关系', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcu-period-preview-'));
  fs.writeFileSync(path.join(root, 'flow.c'), [
    'int shared;',
    'void early(void) {} void late(void) {}',
    'void first(void) {} void second(void) {}',
    'void work(void) { shared = 1; first(); second(); }',
    'void step(void) { early(); work(); late(); }',
    'void App_Task10ms(void) { step(); }',
    'int sample(void) { return shared; }',
    'void App_Task2ms(void) { sample(); }',
  ].join('\n'));
  const srv = await launchServer({ target: root });
  t.after(async () => { await srv.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const get = async url => (await fetch(srv.baseUrl + url)).json();
  const id = name => `flow.c::${name}`;
  const { tasks } = await get('/api/stats?summary=1&tasks=1');
  assert.deepEqual(tasks.map(task => task.us), [2000, 10000]);
  const viewUrl = `/api/view?root=${id('work')}&up=0&down=0`;
  const preview = await get(viewUrl + '&preview=1');
  assert.deepEqual(preview.nodes.map(n => n.id), [id('work')]);
  const { target, taskChains, callSequence } = preview.recommendations;
  assert.deepEqual(target.taskPeriods.map(c => c.us), [10000]);
  assert.deepEqual(taskChains.map(c => c.path), [[id('App_Task10ms'), id('step'), id('work')]]);
  assert.deepEqual(callSequence.callees.map(c => [c.name, c.callNumbers]), [['first', ['1']], ['second', ['2']]]);
  assert.deepEqual(callSequence.siblings.map(c => [c.name, c.position, c.callNumbers]),
    [['early', 'before', ['1']], ['late', 'after', ['3']]]);
  assert.equal((await fetch(srv.baseUrl + '/api/node?id=var::shared')).status, 404);

  const flow = await get(`/api/dataflow?fn=${id('work')}&dir=both`);
  assert.deepEqual(flow.fn.taskPeriods.map(c => c.us), [10000]);
  const shared = flow.vars.find(v => v.name === 'shared' && v.mode === 'write');
  assert.deepEqual(shared.peers.map(p => [p.id, p.taskPeriods.map(c => c.us)]), [[id('sample'), [2000]]]);
  const response = await fetch(srv.baseUrl + viewUrl + '&vars=' + encodeURIComponent(shared.id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expansions: [{ root: id('sample'), up: 0, down: 0 }] }),
  });
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.deepEqual(traceVisiblePaths(view, id('work'), id('sample')).paths[0].nodes,
    [id('work'), shared.id, id('sample')]);
});

test('OSEK TASK 定义自动入表，无调用者也显示，保留真实函数、周期与源码行', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcu-tasks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = ['int A(void) {return 0;}', 'int B(void) {return 1;}', 'void C(int x) {}',
    '#define TASK(x) void x(void)', 'TASK(Control_10ms) { A(); B(); A(); C(B()); C(A() + B()); }',
    'TASK(Background) { A(); }', 'void Ordinary(void) {}'].join('\n');
  fs.writeFileSync(path.join(root, 'tasks.c'), source);
  const model = loadModel(root);
  const tasks = projectTasks(model);
  assert.deepEqual(tasks.map(t => [t.name,t.us,t.line]), [['Control_10ms',10000,5],['Background',null,6]]);
  assert.ok(!model.functions.some(f => f.name === 'TASK'));
  const [leaf] = withTaskPeriods([model.functions.find(f => f.name === 'A')], model);
  assert.deepEqual(leaf.taskPeriods.map(c => c.us), [10000, null]);
  const caller = tasks[0].id;
  const groups = callSequence(model, caller);
  assert.deepEqual(groups.map(g => g.map(c => c.name)), [['A'],['B'],['A'],['B'],['C'],['C','A','B']]);
  const numbers = callNumbers(groups);
  assert.deepEqual(numbers.get('tasks.c::A'), ['1']);
  assert.deepEqual(numbers.get('tasks.c::B'), ['2']);
  assert.deepEqual(numbers.get('tasks.c::C'), ['3']);
  const partial = callNumbers(groups, new Set(['tasks.c::B', 'tasks.c::C']));
  assert.deepEqual(partial.get('tasks.c::B'), ['1']);
  assert.deepEqual(partial.get('tasks.c::C'), ['2']);
  assert.equal(partial.has('tasks.c::A'), false);
});

test('注册的 RTOS 任务按显式毫秒间隔显示，原始 tick 保留待确认', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcu-rtos-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'os.c'), [
    'void work(void) { vTaskDelayUntil(&last, pdMS_TO_TICKS(25U)); }',
    'void sensor(void) { vTaskDelayUntil(&last, 2); }',
    'int main(void) { xTaskCreate(work, "worker", 0, 0, 0, 0); xTaskCreate(sensor, "sensor", 0, 0, 0, 0); }',
  ].join('\n'));
  const tasks = projectTasks(loadModel(root));
  assert.deepEqual(tasks.map(t => [t.name, t.us]), [['work',25000], ['sensor',null]]);
  assert.match(tasks[0].source, /xTaskCreate.*vTaskDelayUntil/);
});

test('单次扫描保留跨文件任务注册、间隔和后绑定成员调用的连续顺序', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcu-merged-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a_start.c'),
    'void start(void) { xTaskCreate(worker, "worker", 0, 0, 0, 0); ops.run(); missing.run(); end(); }');
  fs.writeFileSync(path.join(root, 'z_runtime.c'),
    'Ops ops = { .run = worker }; void worker(void) { vTaskDelayUntil(&last, pdMS_TO_TICKS(10)); } void end(void) {}');
  const model = loadModel(root);
  assert.deepEqual(projectTasks(model).map(t => [t.id, t.us]), [['z_runtime.c::worker', 10000]]);
  assert.deepEqual(callSequence(model, 'a_start.c::start').map(group => group.map(call => call.name)),
    [['xTaskCreate'], ['worker'], ['end']]);
  assert.ok(model.functions.every(fn => !fn.bodyTokens), '不因恢复任务证据而长期保留函数 token');
});

test('纯 C 周期识别支持 RTOS 注册、循环工作函数、毫秒宏和调度表', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcu-period-c-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'schedule.h'), '#define STEP_TIME (20U)\n#define STEP_ALIAS STEP_TIME\n');
  fs.writeFileSync(path.join(root, 'firmware.c'), `
#include "schedule.h"
#include "cmsis_os2.h"
void controller_loop(void) { while (1) { vTaskDelay(pdMS_TO_TICKS(STEP_ALIAS)); } }
static void controller_entry(void *arg) { controller_loop(); }
static void read_pressure(void) { while (true) { vTaskDelay(7 / portTICK_PERIOD_MS); } }
static void service_can(void) { for (;;) vTaskDelayUntil(&last, STEP_TIME / portTICK_PERIOD_MS); }
void monitor(void) { for (;;) { xTaskDelayUntil(&last, pdMS_TO_TICKS(3)); } }
void budgeted(void) {
  while (1) {
    if (stopped) { vTaskDelay(50); continue; }
    if (elapsed < STEP_TIME) vTaskDelay((STEP_TIME - elapsed) / portTICK_PERIOD_MS);
  }
}
void wait_cmsis(void) { while (1) osDelay(5); }
void timeout(void) {}
void Task_10ms(void) {}
void main_10ms(void) {}
void Runnable_5ms(void) {}
void retry(void) { for (int i = 0; i < 3; i++) vTaskDelay(pdMS_TO_TICKS(2)); }
void setup_delay(void) { vTaskDelay(pdMS_TO_TICKS(2)); while (1) {} }
Schedule schedule = { .fast = Runnable_5ms };
int main(void) {
  xTaskCreatePinnedToCore(controller_entry, "control", 0, 0, 0, 0, 1);
  xTaskCreateStatic(&read_pressure, "pressure", 0, 0, 0, 0, 0);
  xTaskCreateStaticPinnedToCore(service_can, "can", 0, 0, 0, 0, 0, 1);
  osThreadNew(wait_cmsis, 0, 0);
  osTimerNew(timeout, osTimerPeriodic, 0, 0);
  schedule.fast();
}
`);
  fs.writeFileSync(path.join(root, 'legacy.c'), `
#include "cmsis_os.h"
void legacy_loop(void) { while (1) osDelay(6); }
`);
  const model = loadModel(root);
  const tasks = projectTasks(model);
  assert.deepEqual(Object.fromEntries(tasks.map(task => [task.name, task.us])), {
    controller_loop: 20000, controller_entry: null, read_pressure: 7000, service_can: 20000,
    monitor: 3000, budgeted: 20000, wait_cmsis: null, timeout: null,
    Task_10ms: 10000, main_10ms: 10000, Runnable_5ms: 5000, legacy_loop: 6000,
  });
  assert.match(tasks.find(task => task.name === 'timeout').source, /osTimerNew/);
  assert.match(tasks.find(task => task.name === 'read_pressure').source, /xTaskCreateStatic.*vTaskDelay/);
  assert.match(tasks.find(task => task.name === 'controller_entry').source, /xTaskCreatePinnedToCore/);
  const wrapper = detectTasks(model, 'firmware.c::controller_entry');
  assert.ok(wrapper.suggestions.some(s => s.to === 'firmware.c::controller_loop' && s.text === 'TASK:20ms'));
  const scheduler = detectTasks(model, 'firmware.c::main');
  assert.ok(scheduler.suggestions.some(s => s.to === 'firmware.c::Runnable_5ms' && s.text === 'TASK:5ms'));
});
