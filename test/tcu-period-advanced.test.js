import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel } from '../src/core/index.js';
import { buildDataflowIndex } from '../src/core/dataflow.js';
import { projectTasks, taskPeriods, withTaskPeriods } from '../src/core/task-periods.js';
import { exportSvg } from '../src/core/export-svg.js';
import { buildSVGFromLayout } from '../src/core/export.js';
import { canvasPeriodBadge, nodePeriodBadge } from '../web/lib/period-text.js';
import { launchServer } from '../scripts/lib/server.mjs';

function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcu-period-advanced-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, data] of Object.entries(files)) {
    const dest = path.join(root, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  return root;
}

const periodsFor = (model, name) => {
  const fn = model.functions.find(f => f.name === name);
  assert.ok(fn, name);
  return taskPeriods(model).get(fn.id) || [];
};

test('取模、有效位掩码和阈值清零按调用位置推导，普通调用保持原周期', t => {
  const root = project(t, { 'rates.c': `
#define MODULO (5U)
#define MASK (0x03u)
void Five(void) {}
void Four(void) {}
void Seven(void) {}
void InvalidMask(void) {}
void Ephemeral(void) {}
void Conditional(void) {}
void Direct(void) {}
void Mixed(void) {}
void ISR_1ms(void) {
  static unsigned cnt;
  static unsigned reset;
  static unsigned maybe;
  unsigned ephemeral = 0;
  cnt += 1; ephemeral++; if (Flag()) maybe++;
  if ((cnt % MODULO) == 2u) { Five(); Mixed(); } else { Direct(); }
  if ((cnt & MASK) == 0u) Four(); Direct();
  if (cnt & MASK == 0u) InvalidMask();
  if ((cnt & 0x05u) == 0u) InvalidMask();
  if (++reset >= 7U) { reset = 0U; Seven(); }
  if (ephemeral % 5u == 0u) Ephemeral();
  if (maybe % 5u == 0u) Conditional();
  if (cnt % 3u == 0u) Direct(); Direct();
}
void App_Task10ms(void) { Mixed(); }
` });
  const model = loadModel(root);
  for (const [name, us, divider] of [['Five', 5000, 5], ['Four', 4000, 4], ['Seven', 7000, 7]]) {
    const [context] = periodsFor(model, name);
    assert.equal(context.us, us, name);
    assert.equal(context.kind, 'isr');
    assert.equal(context.dividers[0].divider, divider);
  }
  for (const name of ['Direct', 'InvalidMask', 'Ephemeral', 'Conditional']) {
    assert.deepEqual(periodsFor(model, name).map(c => c.us), [1000], name);
    assert.equal(periodsFor(model, name)[0].dividers, undefined);
  }
  const [mixed] = withTaskPeriods(model.functions.filter(f => f.name === 'Mixed'), model);
  assert.equal(mixed.multiRate, true);
  assert.equal(mixed.isIsr, true);
  assert.deepEqual(nodePeriodBadge(mixed), { text: 'ISR·5ms·10ms', tier: 'multi', multi: true });
});

test('计数助手只有沿每轮调用一次的路径才能推导分频', t => {
  const counter = name => `void ${name}(void) {}
void bump_${name}(void) { static unsigned count; if (++count >= 10) { count = 0; ${name}(); } }`;
  const source = ['Twice', 'Diamond', 'Loop', 'Conditional', 'Once', 'Nested'].map(counter).join('\n') + `
void left(void) { bump_Diamond(); }
void right(void) { bump_Diamond(); }
void once(void) { bump_Once(); }
int flags;
void Task1ms(void) {
  static unsigned slow;
  if (++slow >= 2) { slow = 0; bump_Nested(); }
  bump_Twice(); bump_Twice();
  left(); right();
  for (int i = 0; i < flags; ++i) bump_Loop();
  if (flags) bump_Conditional();
  once();
}`;
  const model = loadModel(project(t, { 'timer.c': source }));
  for (const name of ['Twice', 'Diamond', 'Loop', 'Conditional']) {
    assert.deepEqual(periodsFor(model, name).map(c => [c.us, c.dividers]), [[1000, undefined]], name);
  }
  assert.deepEqual(periodsFor(model, 'Once').map(c => [c.us, c.dividers[0].divider]), [[10000, 10]]);
  assert.deepEqual(periodsFor(model, 'Nested').map(c => [c.us, c.dividers.map(d => d.divider)]), [[20000, [2, 10]]]);
});

test('全局 tick 按唯一写者推导主循环周期，与调用者周期取 LCM', async t => {
  const demo = loadModel(fileURLToPath(new URL('../samples/demo', import.meta.url)));
  await buildDataflowIndex(demo);
  // App_Init 也会重置 g_tick；只能确认 Nvm_Save 可由 100ms 任务调用。
  assert.deepEqual(periodsFor(demo, 'Nvm_Save').map(c => c.us), [100000]);
  assert.equal(periodsFor(demo, 'Nvm_Save')[0].dividers, undefined);
  assert.deepEqual(periodsFor(demo, 'Diag_Report').map(c => [c.task, c.us]),
    [['main.c::App_Task10ms', 10000], ['main.c::App_Task100ms', 100000]]);

  const root = project(t, { 'rates.c': `
volatile unsigned tick;
void Tick(void) { ++tick; }
void Timed(void) {}
void InTask(void) {}
void FasterPath(void) {}
void App_Task2ms(void) { FasterPath(); }
void App_Task5ms(void) { if ((tick % 4) == 0) { InTask(); FasterPath(); } }
int main(void) { for (;;) if (tick % 3 == 0) Timed(); }
`, 'tcu-schedule.json': JSON.stringify({ tickUs: 2000 }) });
  const model = loadModel(root);
  await buildDataflowIndex(model);
  assert.deepEqual(periodsFor(model, 'Timed').map(c => [c.task, c.us]), [['rates.c::Tick', 6000]]);
  assert.deepEqual(periodsFor(model, 'InTask').map(c => c.us), [40000]);
  assert.deepEqual(periodsFor(model, 'FasterPath').map(c => c.us), [2000]);
});

test('ISR 自增和其他函数读 tick 时均须验证全工程写者，静态和局部同名按作用域区分', async t => {
  const root = project(t, {
    'timer.c': `
unsigned shared;
unsigned escaped;
unsigned clean;
unsigned bounded;
void A(void) {} void B(void) {} void C(void) {} void D(void) {} void E(void) {} void F(void) {}
void ISR_1ms(void) {
  ++shared;
  if (shared % 4 == 0) A();
  ++clean;
  if (clean % 4 == 0) B();
  ++escaped;
  if (escaped % 4 == 0) C();
  if (++bounded >= 7) { bounded = 0; F(); }
}
void App_Task2ms(void) {
  if (shared % 4 == 0) D();
  if (clean % 4 == 0) E();
}
`,
    'reset.c': `
extern unsigned escaped;
static unsigned clean;
void reset(void) { extern unsigned shared; shared = 0; clean = 0; }
void unknown(unsigned *);
void may_reset(void) { unknown(&escaped); }
`,
    'locals.c': 'void shadow(void) { unsigned clean; clean = 0; }',
  });
  const model = loadModel(root);
  const rates = name => periodsFor(model, name).map(c => [c.us, Boolean(c.dividers)]);
  assert.deepEqual(rates('B'), [[1000, false]], '尚未取得 AST 写者证据');
  await buildDataflowIndex(model);
  for (const name of ['A', 'C']) assert.deepEqual(rates(name), [[1000, false]], name);
  assert.deepEqual(rates('D'), [[2000, false]], '跨函数共享 tick 也没有可靠的分频');
  for (const name of ['B', 'E']) assert.deepEqual(rates(name), [[4000, true]], name);
  assert.deepEqual(rates('F'), [[7000, true]], '阈值分支内自己的合法清零');
});

test('缺少变量定义、地址从 ISR 逃逸、或有额外条件写入时仅保留入口周期', async t => {
  const root = project(t, { 'timer.c': `
extern unsigned unresolved;
unsigned escaped = 0;
unsigned conditional = 0;
void unknown(unsigned *);
void Before(void) {} void After(void) {} void Reset(void) {}
void ISR_1ms(void) {
  ++unresolved;
  if (unresolved % 5 == 0) Before();
  ++escaped;
  unknown(&escaped);
  if (escaped % 5 == 0) After();
  ++conditional;
  if ((conditional = Flag())) {}
  if (conditional % 5 == 0) Reset();
}` });
  const model = loadModel(root);
  await buildDataflowIndex(model);
  for (const name of ['Before', 'After', 'Reset']) {
    assert.deepEqual(periodsFor(model, name).map(c => [c.us, c.dividers]), [[1000, undefined]], name);
  }
});

test('静态调度表读取位置宏、指定初始化、微秒字段与独立任务定义', t => {
  const root = project(t, { 'table.c': `
#define FAST (2U)
#define MICROSECONDS (750u)
extern void Fast(void);
extern void Slow(void);
extern void Micro(void);
extern void Disabled(void);
typedef struct { void (*fn)(void); unsigned period_us; unsigned phase; } MicroCfg;
const TaskCfg_t g_schedTbl[] = { { Fast, FAST, 0 }, { Slow, 100, 5 }, { Disabled, 0, 5 } };
const MicroCfg microTable[] = { { Micro, MICROSECONDS, 0 } };
const TaskCfg_t entries[] = { { .fn = Micro, .period_ms = FAST } };
`, 'control.c': `
void Fast(void) {}
void Slow(void) {}
void Micro(void) {}
void Disabled(void) {}
` });
  const model = loadModel(root);
  const tasks = projectTasks(model);
  assert.deepEqual(tasks.map(task => [task.name, task.us]),
    [['Micro', 750], ['Fast', 2000], ['Micro', 2000], ['Slow', 100000]]);
  assert.ok(tasks.every(task => task.source.startsWith('C 调度表 · table.c:')));
  assert.deepEqual(periodsFor(model, 'Micro').map(c => c.us), [750, 2000]);
});

test('工程 JSON、OSEK 和跨文件 AUTOSAR XML 提供权威周期及 ISR 类型', t => {
  const root = project(t, {
    'tasks.c': `
TASK(OsekControl) {}
TASK(OsekDefault) {}
TASK(OsekIdle) {}
void FastControl(void) {}
void Runnable_Shift(void) {}
void App_Task10ms(void) {}
void SysTick_Handler(void) {}
ISR(ExternalVector) {}
__interrupt void TimerVector(void) {}
`,
    'tcu-schedule.json': JSON.stringify({
      tickUs: 1000,
      tasks: [
        { name: 'SysTick_Handler', periodUs: 1000, kind: 'isr' },
        { name: 'Runnable_Shift', periodMs: 10 },
        { name: 'App_Task10ms', periodMs: 20 },
      ],
    }),
    'os/app.oil': `
CPU Tcu {
  COUNTER Clock { SECONDSPERTICK = 0.0005; };
  COUNTER DefaultClock {};
  TASK OsekControl {};
  TASK OsekDefault {};
  TASK OsekIdle {};
  ALARM Control { COUNTER = Clock; ACTION = ACTIVATETASK { TASK = OsekControl; };
    AUTOSTART = TRUE { ALARMTIME = 3; CYCLETIME = 4; }; };
  ALARM Slow { ACTION = ACTIVATETASK { TASK = OsekDefault; }; COUNTER = DefaultClock; CYCLETIME = 5; };
  ALARM Idle { ACTION = ACTIVATETASK { TASK = OsekIdle; }; COUNTER = Clock; CYCLETIME = 0; };
};
`,
    'autosar/runnables.arxml': `
<AUTOSAR><AR-PACKAGE><SHORT-NAME>Shift</SHORT-NAME>
  <RUNNABLE-ENTITY><SHORT-NAME>Control</SHORT-NAME><SYMBOL>FastControl</SYMBOL></RUNNABLE-ENTITY>
</AR-PACKAGE></AUTOSAR>
`,
    'autosar/events.arxml': `
<AUTOSAR xmlns:a="urn:autosar"><a:TIMING-EVENT>
  <a:START-ON-EVENT-REF DEST="RUNNABLE-ENTITY">/Shift/Control</a:START-ON-EVENT-REF><a:PERIOD>0.002</a:PERIOD>
</a:TIMING-EVENT></AUTOSAR>
`,
  });
  const model = loadModel(root);
  const tasks = new Map(projectTasks(model).map(task => [task.name, task]));
  assert.equal(tasks.get('SysTick_Handler').kind, 'isr');
  assert.equal(tasks.get('SysTick_Handler').us, 1000);
  assert.equal(tasks.get('Runnable_Shift').us, 10000);
  assert.equal(tasks.get('App_Task10ms').us, 20000);
  assert.equal(tasks.get('OsekControl').us, 2000);
  assert.equal(tasks.get('OsekControl').source, 'OIL 配置 · os/app.oil');
  assert.equal(tasks.get('OsekDefault').us, 5000);
  assert.equal(tasks.get('OsekIdle').us, null);
  assert.equal(tasks.get('FastControl').us, 2000);
  assert.equal(tasks.get('FastControl').source, 'ARXML TimingEvent · autosar/events.arxml');
  for (const name of ['ExternalVector', 'TimerVector']) {
    assert.equal(tasks.get(name).kind, 'isr');
    const [node] = withTaskPeriods(model.functions.filter(f => f.name === name), model);
    assert.equal(nodePeriodBadge(node).text, 'ISR');
  }
});

test('普通 API 视图和 SVG 显示跨周期读写及实际临界区保护，保留文件行号', async t => {
  const root = project(t, { 'shared.c': `int exposed, guarded, unlocked, interruptValue;
void App_Task2ms(void) {
  exposed = 1;
  SuspendAllInterrupts(); guarded = 1; ResumeAllInterrupts();
  EnterCritical(); ExitCritical(); unlocked = 1;
}
int App_Task10ms(void) {
  taskENTER_CRITICAL();
  int value = guarded;
  taskEXIT_CRITICAL();
  return exposed + value + unlocked + interruptValue;
}
ISR(ExternalVector) { interruptValue = 1; }
` });
  const server = await launchServer({ target: root });
  t.after(() => server.close());
  const query = new URLSearchParams({
    roots: 'shared.c::App_Task2ms,shared.c::App_Task10ms,shared.c::ExternalVector',
    vars: 'var::exposed,var::guarded,var::unlocked,var::interruptValue',
    down: '0', up: '0',
  });
  const response = await fetch(`${server.baseUrl}/api/view?${query}`);
  assert.equal(response.status, 200);
  const view = await response.json();
  const varNode = name => view.nodes.find(node => node.id === `var::${name}`);
  const unguarded = { writerUs: [2000], readerUs: [10000], hasIsr: false, protected: false };
  assert.deepEqual(varNode('exposed').crossPeriod, unguarded);
  assert.deepEqual(varNode('unlocked').crossPeriod, unguarded);
  assert.deepEqual(varNode('guarded').crossPeriod, { ...unguarded, protected: true });
  assert.deepEqual(varNode('interruptValue').crossPeriod,
    { writerUs: [], readerUs: [10000], hasIsr: true, protected: false });
  assert.deepEqual(varNode('exposed').taskPeriods.map(c => c.us), [2000, 10000]);
  assert.deepEqual(nodePeriodBadge(varNode('exposed')), { text: '⚡2↔10ms', tier: 'cross-hazard' });
  assert.deepEqual(nodePeriodBadge(varNode('guarded')), { text: '🔒2↔10ms', tier: 'cross-safe' });
  assert.deepEqual(canvasPeriodBadge(varNode('exposed')), { text: '⚡2↔10ms', tier: 'cross-hazard' });
  assert.equal(canvasPeriodBadge(view.nodes.find(node => node.name === 'App_Task2ms')), null);
  assert.equal(nodePeriodBadge({ taskPeriods: [{ us: null }] }), null);
  const svg = exportSvg(view);
  assert.match(svg, />shared\.c:2<\/text>/);
  assert.doesNotMatch(svg, /data-period-badge="(?:fast|mid|slow|isr|multi)"/);
  assert.match(svg, /data-period-badge="cross-hazard"/);
  assert.match(svg, /data-period-badge="cross-safe"/);
  assert.doesNotMatch(svg, /周期待确认/);
  const cliSvg = buildSVGFromLayout(view);
  assert.match(cliSvg, />shared\.c:2<\/text>/);
  assert.doesNotMatch(cliSvg, /data-period-badge="(?:fast|mid|slow|isr|multi)"/);
  assert.match(cliSvg, /data-period-badge="cross-safe"/);
});
