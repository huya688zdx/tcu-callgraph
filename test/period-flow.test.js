import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModel, subgraph } from '../src/core/index.js';
import { parseDot, modelFromDot } from '../src/core/dot.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { callSequence, callNumbers } from '../src/core/call-sequence.js';
import { projectTasks, withTaskPeriods } from '../src/core/task-periods.js';
import { exportSvg } from '../src/core/export-svg.js';
import { edgeCaption, svgMarkers } from '../web/lib/edge-flow.js';
import { traceVisiblePaths } from '../web/lib/visible-paths.js';

const dot = contents => modelFromDot(parseDot(`digraph G { ${contents} }`));

test('局部视图保留完整工程中的多个任务，且不沿变量访问或数据流传递周期', () => {
  const model = loadModel(new URL('../samples/demo', import.meta.url).pathname);
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

test('SVG 只绘制已保存的连线标签，即使调用边带有解析出的序号', () => {
  const svg = exportSvg({
    root: 'A', nodes: [],
    edges: [
      { from: 'A', to: 'B', kind: 'direct', callNumbers: ['1'], points: [[10, 30], [250, 30]] },
      { from: 'A', to: 'C', kind: 'direct', callNumbers: ['2'], points: [[10, 110], [250, 110]],
        labels: [{ preset: 'call', text: 'コール順7' }, { preset: 'task', text: 'TASK:2ms' }] },
    ],
  });
  assert.doesNotMatch(svg, /コール順[12]/);
  assert.match(svg, /コール順7/);
  assert.match(svg, /TASK:2ms/);
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
  assert.deepEqual(numbers.get('tasks.c::A'), ['1','3','6*']);
  assert.deepEqual(numbers.get('tasks.c::B'), ['2','4','6*']);
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
