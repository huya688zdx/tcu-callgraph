import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, loadModel } from '../src/core/index.js';
import { buildFlowchart } from '../src/core/flowchart.js';
import { layoutElk } from '../src/core/layout-elk.js';
import { projectTasks, taskPeriods, withTaskPeriods } from '../src/core/task-periods.js';
import { scheduleConfig } from '../src/core/tcu-schedule.js';
import { readCompileCommands } from '../src/core/parsers/clang-config.js';
import { launchServer } from '../scripts/lib/server.mjs';

function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rw-fixes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source);
  return root;
}

test('中断状态在一次执行的循环与条件汇合后保守合并，嵌套 API 保留深度', t => {
  const model = buildIndex(project(t, { 'irq.c': `
int opened, direct, mixed, nested, joined, sch, bypassed, looping;
void App_Task10ms(int x) {
  __disable_irq();
  do { __enable_irq(); } while (0);
  opened = 1;
  __disable_irq(); __disable_irq(); __enable_irq();
  direct = 1;
  DisableAllInterrupts();
  if (x) { EnableAllInterrupts(); }
  mixed = 1;
  SuspendAllInterrupts(); SuspendAllInterrupts(); ResumeAllInterrupts();
  nested = 1;
  ResumeAllInterrupts();
  if (x) __disable_irq(); else DisableAllInterrupts();
  joined = 1;
  __enable_irq();
  SchM_Enter_Control(); SchM_Enter_Control(); SchM_Exit_Control();
  sch = 1;
  SchM_Exit_Control();
  do { if (x) break; __disable_irq(); } while (0);
  bypassed = 1;
  __disable_irq();
  while (x) { looping++; }
  __enable_irq();
}
` }));
  const fn = model._index.byId.get('irq.c::App_Task10ms');
  const guarded = new Map(fn.criticalAccess);
  for (const id of ['opened', 'direct', 'mixed', 'bypassed']) assert.ok(!guarded.has(id), id);
  for (const id of ['nested', 'joined', 'sch', 'looping']) assert.ok(guarded.has(id), id);
});

test('同一计数器的嵌套取模和掩码条件先检查可达性', t => {
  const model = buildIndex(project(t, { 'rates.c': `
void Odd(void) {}
void Inconsistent(void) {}
void Reachable(void) {}
void Updated(void) {}
void Task10ms(void) {
  static unsigned c;
  c++;
  if (c % 2 == 0) {
    if (c % 2 == 1) Odd();
    if ((c & 3) == 1) Inconsistent();
    if (c % 6 == 2) Reachable();
  }
}
void Task20ms(void) {
  static unsigned c;
  if (c % 2 == 0) { c++; if (c % 2 == 1) Updated(); }
}
` }));
  const rates = name => taskPeriods(model).get('rates.c::' + name)?.map(c => c.us);
  assert.equal(rates('Odd'), undefined);
  assert.equal(rates('Inconsistent'), undefined);
  assert.deepEqual(rates('Reachable'), [60000]);
  assert.deepEqual(rates('Updated'), [20000]);
});

test('Clang 保留调度表、注册、延时、同一行调用的列与保护证据', async t => {
  const source = [
    'int shared;',
    'void Step(void) {}',
    'void Runner(void) { for (;;) { vTaskDelay(pdMS_TO_TICKS(4)); } }',
    'void Register(void) { osThreadNew(Runner, 0, 0); }',
    'void Writer(void) {',
    '  static unsigned c; ++c;',
    '  __disable_irq(); shared = 1; __enable_irq();',
    '  if (c % 3 == 0) Step(); Step();',
    '}',
    'void App_Task20ms(void) {',
    '  __disable_irq(); shared; __enable_irq();',
    '}',
    'const TaskCfg g_sched[] = { { Writer, 10 } };',
  ].join('\n');
  const root = project(t, { 'task.c': source });
  const loc = (needle, from = 0) => {
    const offset = source.indexOf(needle, from);
    assert.ok(offset >= 0, needle);
    return { offset, line: source.slice(0, offset).split('\n').length, tokLen: needle.length };
  };
  const range = (begin, end = begin) => ({ begin, end });
  const fn = (name, inner = []) => {
    const head = loc('void ' + name);
    const open = loc('{', head.offset), close = loc(name === 'Runner' ? '} }' : '}', open.offset);
    const end = name === 'Runner' ? { ...close, offset: close.offset + 2, tokLen: 1 } : close;
    return { kind: 'FunctionDecl', id: name, name, loc: loc(name, head.offset), range: range(head, end),
      inner: [{ kind: 'CompoundStmt', range: range(open, end), inner }] };
  };
  const ref = (id, kind, pos) => ({ kind: 'DeclRefExpr', range: range(pos), referencedDecl: { kind, id, name: id } });
  const step = loc('Step();', loc('if (').offset);
  const call = pos => ({ kind: 'CallExpr', range: range({ ...pos, tokLen: 4 }),
    inner: [ref('Step', 'FunctionDecl', { ...pos, tokLen: 4 })] });
  const write = loc('shared ='), read = loc('shared; __');
  const ast = { kind: 'TranslationUnitDecl', inner: [
    { kind: 'VarDecl', name: 'shared', id: 'shared', loc: loc('shared') },
    fn('Step'), fn('Runner'), fn('Register'),
    fn('Writer', [{ kind: 'BinaryOperator', opcode: '=', range: range(write),
      inner: [ref('shared', 'VarDecl', write), { kind: 'IntegerLiteral' }] },
    call(step), call(loc('Step();', step.offset + step.tokLen))]),
    fn('App_Task20ms', [ref('shared', 'VarDecl', read)]),
    { kind: 'VarDecl', name: 'g_sched', id: 'g_sched', loc: loc('g_sched'),
      range: range(loc('const TaskCfg'), loc(';', loc('g_sched').offset)) },
  ] };
  const model = await loadModel(root, { parserId: 'clang-ast', parserOptions: { execClang: () => ast } });
  const tasks = projectTasks(model);
  assert.deepEqual(tasks.map(task => [task.name, task.us]), [['Runner', 4000], ['Writer', 10000], ['App_Task20ms', 20000]]);
  assert.match(tasks[0].source, /osThreadNew/);
  assert.match(tasks[1].source, /C 调度表/);
  const writer = model._index.byId.get('task.c::Writer');
  const calls = model._index.outAdj.get(writer.id).filter(edge => edge.to === 'task.c::Step');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].col, source.split('\n')[7].indexOf('Step') + 1);
  assert.notEqual(calls[0].col, calls[1].col);
  assert.deepEqual(writer.callDividers.map(site => [site.col, site.gates[0].divider]), [[calls[0].col, 3]]);
  const [state] = withTaskPeriods(model.variables.filter(n => n.name === 'shared'), model);
  assert.deepEqual(state.crossPeriod, { writerUs: [10000], readerUs: [20000], hasIsr: false, protected: true });
});

test('Clang 合并无函数编译单元初始化的全局指针，并隔离同名局部指针', async t => {
  const root = project(t, {
    'a.c': 'int g; int *p = &g;',
    'b.c': 'extern int *p; void f(void) { *p = 1; } void shadow(void) { int *p; *p = 1; }',
  });
  const ref = id => ({ kind: 'DeclRefExpr', referencedDecl: { kind: 'VarDecl', name: id, id } });
  const pointer = { kind: 'VarDecl', name: 'p', id: 'p', type: { qualType: 'int *' }, loc: { line: 1 } };
  const write = id => ({ kind: 'BinaryOperator', opcode: '=', inner: [
    { kind: 'UnaryOperator', opcode: '*', inner: [ref(id)] }, { kind: 'IntegerLiteral' },
  ] });
  const fn = (name, inner) => ({ kind: 'FunctionDecl', id: name, name, loc: { line: 1 },
    inner: [{ kind: 'CompoundStmt', inner }] });
  const ast = file => ({ kind: 'TranslationUnitDecl', inner: path.basename(file) === 'a.c' ? [
    { kind: 'VarDecl', id: 'g', name: 'g', loc: { line: 1 } },
    { ...pointer, init: 'c', inner: [{ kind: 'UnaryOperator', opcode: '&', inner: [ref('g')] }] },
  ] : [{ ...pointer, storageClass: 'extern' }, fn('f', [write('p')]),
    fn('shadow', [{ ...pointer, id: 'local' }, write('local')])] });
  const model = await loadModel(root, { parserId: 'clang-ast', parserOptions: { execClang: ast } });
  assert.deepEqual([...model._df.writers.get('var::g')], ['b.c::f']);
  assert.equal(model._df.fnAccess.get('b.c::f').writes.get('var::g').indirect, true);
});

test('调度配置的文件类型、单文件体积、累计体积和 XML 深度受限，结果按模型缓存', t => {
  const root = project(t, { 'a.arxml': '<X>'.repeat(150) + '</X>'.repeat(150), 'big.oil': '',
    'good.oil': '', 'compile_commands.json': '', 'tcu-schedule.json': '{"tickUs":1000}' });
  fs.mkdirSync(path.join(root, 'dir.arxml'));
  fs.truncateSync(path.join(root, 'big.oil'), 8 * 1024 * 1024 + 1);
  for (let i = 0; i < 5; i++) {
    const file = path.join(root, 'volume' + i + '.oil');
    fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024, 32));
  }
  const model = { root };
  const config = scheduleConfig(model);
  assert.equal(config.tickUs, 1000);
  assert.ok(config.warnings.some(w => /嵌套/.test(w.error) && w.file === 'a.arxml'));
  assert.ok(config.warnings.some(w => /8 MiB/.test(w.error) && w.file === 'big.oil'));
  assert.ok(config.warnings.some(w => /32 MiB/.test(w.error)));
  assert.ok(config.warnings.some(w => /普通文件/.test(w.error) && w.file === 'dir.arxml'));
  fs.writeFileSync(path.join(root, 'tcu-schedule.json'), '{"tickUs":2000}');
  assert.equal(scheduleConfig(model), config);
  const database = path.join(root, 'compile_commands.json');
  fs.truncateSync(database, 64 * 1024 * 1024 + 1);
  assert.throws(() => readCompileCommands(root, database), /64 MiB/);
  assert.throws(() => readCompileCommands(root, path.join(root, 'dir.arxml')), /普通文件/);
});

test('Flowchart 区分编译分支、运行期单条语句体以及条件 default 的未匹配出口', async t => {
  const model = buildIndex(project(t, { 'flow.c': `
void if_body(int x) {
  if (x)
#if CONFIG
    yes();
#else
    no();
#endif
  done();
}
void switch_body(int x) {
  switch (x) {
    case 1: yes(); break;
#if CONFIG
    default: no(); break;
#endif
  }
  done();
}
void partial(int x) {
#if CONFIG
  if (x) {
#endif
  yes();
#if CONFIG
  }
#endif
}
` }));
  const chart = name => buildFlowchart(model, model._index.byId.get('flow.c::' + name));
  const condition = await chart('if_body');
  const byText = (g, text) => g.nodes.find(n => n.text === text)?.id;
  const exit = (g, text, branch) => g.edges.find(e => e.from === byText(g, text) && e.branch === branch)?.to;
  assert.equal(exit(condition, 'if (x)', 'ON'), byText(condition, '#if CONFIG'));
  assert.equal(exit(condition, 'if (x)', 'OFF'), byText(condition, 'done();'));
  assert.equal(exit(condition, '#if CONFIG', 'ON'), byText(condition, 'yes();'));
  assert.equal(exit(condition, '#if CONFIG', 'OFF'), byText(condition, 'no();'));
  const sw = await chart('switch_body');
  const edges = sw.edges.filter(e => e.from === byText(sw, 'switch (x)'));
  const guard = [{ condition: '#if CONFIG', branch: 'ON' }];
  assert.deepEqual(edges.find(e => e.to === byText(sw, 'default:')).guards, guard);
  assert.deepEqual(edges.find(e => e.to === byText(sw, 'done();')).unless, [guard]);
  await assert.rejects(chart('partial'), /条件编译/);
});

test('Flowchart 不为恒真循环生成 OFF，保留 break，恒假循环仅走 OFF', async t => {
  const model = buildIndex(project(t, { 'loops.c': `
void forever(void) { while (1) tick(); dead(); }
void for_loop(int x) { for (;;) { if (x) break; tick(); } done(); }
void truth(void) { while (true) { return; } dead(); }
void never(void) { while (0) dead(); for (; 0; ) dead(); done(); }
` }));
  const chart = name => buildFlowchart(model, model._index.byId.get('loops.c::' + name));
  for (const name of ['forever', 'truth']) {
    const graph = await chart(name);
    assert.ok(!graph.edges.some(e => e.branch === 'OFF'));
    assert.ok(!graph.nodes.some(n => n.text.includes('dead')));
  }
  const loop = await chart('for_loop');
  const id = text => loop.nodes.find(n => n.text === text)?.id;
  assert.ok(loop.edges.some(e => e.from === id('break;') && e.to === id('done();')));
  assert.ok(!loop.edges.some(e => e.from === id('for (; ; )') && e.branch === 'OFF'));
  const never = await chart('never');
  assert.equal(never.edges.filter(e => e.branch === 'OFF').length, 2);
  assert.ok(!never.nodes.some(n => n.text.includes('dead')));
});

test('周期泳道增量排版保留同组相对坐标，分组改变时重新定位', async () => {
  const task = (id, us) => ({ id, name: id, file: 'a.c', taskPeriods: [{ us }] });
  const [a, b, c] = [task('a', 1000), task('b', 1000), task('c', 1000)];
  const original = await layoutElk([a, b], [], { groupMode: 'period' });
  const before = original.nodes.find(n => n.id === a.id);
  before.x += 26;
  before.y += 86;
  const box = original.groups.find(g => g.id === before.group);
  const next = await layoutElk([a, b, c], [], { groupMode: 'period', previous: original });
  const after = next.nodes.find(n => n.id === a.id);
  const newBox = next.groups.find(g => g.id === after.group);
  assert.deepEqual([after.x - newBox.x, after.y - newBox.y], [before.x - box.x, before.y - box.y]);
  const moved = await layoutElk([task(a.id, 2000), b, c], [], { groupMode: 'period', previous: next });
  assert.match(moved.nodes.find(n => n.id === a.id).group, /period-2000/);
});

test('周期模式贯通页面、书签、回放、空画布和 SVG 导出', async t => {
  const srv = await launchServer();
  t.after(srv.close);
  const get = url => fetch(srv.baseUrl + url).then(res => res.json());
  const post = (url, body) => fetch(srv.baseUrl + url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(res => res.json());
  const id = 'main.c::SysTick_Handler';
  const page = { roots: [id], up: 0, down: 0, group: true, groupMode: 'period' };
  assert.ok((await post('/api/page', page)).ok);
  assert.equal((await get('/api/page?saved=1')).page.groupMode, 'period');
  assert.ok((await post('/api/bookmarks', { ...page, name: '周期' })).ok);
  assert.ok((await post('/api/bookmarks', { ...page, groupMode: undefined, group: false, name: '旧版' })).ok);
  const bookmarks = (await get('/api/bookmarks')).list;
  assert.equal(bookmarks.find(b => b.name === '周期').groupMode, 'period');
  assert.equal(bookmarks.find(b => b.name === '旧版').groupMode, 'flat');
  const file = await post('/api/view-event', { op: 'view.snapshot', view: { ...page, groupMode: 'file' } });
  const period = await post('/api/view-event', { op: 'view.snapshot', view: page });
  assert.ok(period.eventId > file.eventId);
  assert.ok((await post('/api/view-event', { op: 'view.snapshot', view: page })).deduplicated);
  const review = await get('/api/view?groupMode=file&useSnapshot=1&at=' + period.eventId);
  assert.equal(review.reviewSnapshot.groupMode, 'period');
  assert.ok(review.containers.some(box => box.kind === 'period-lane'));
  const live = await get('/api/view?groupMode=period&root=' + encodeURIComponent(id));
  const empty = await post('/api/view?groupMode=period', { empty: true, roots: [], previous: live });
  assert.deepEqual([empty.width, empty.height, empty.empty, empty.groupMode], [480, 260, true, 'period']);
  const exported = await post('/api/export/svg', { root: id, groupMode: 'period' });
  assert.ok(exported.ok, exported.error);
  try {
    assert.match(fs.readFileSync(exported.path, 'utf8'), /周期|ISR/);
  } finally {
    fs.unlinkSync(exported.path);
  }
});
