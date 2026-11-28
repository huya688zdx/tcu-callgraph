import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { parseDot } from '../src/core/dot.js';
import { buildIndex, loadModel, stats, subgraph } from '../src/core/index.js';
import { detectTasks } from '../src/core/detect-tasks.js';

const SAMPLE = path.join(import.meta.dirname, '..', 'samples', 'tcu');

let cached = null;
function tcu() {
  if (!cached) cached = loadModel(SAMPLE);
  return cached;
}

// 2026-10-22 实测金标：functions 21 / edges 32 / files 8。
//
// 为什么 functions/edges 用「下限 + 关键符号存在」而不是严格相等：
// 解析层正在被并行修改（__attribute__ / __declspec 支持、K&R 支持、宏表按文件
// 快照、函数 id 去重）。前两项只会让函数和边变多；后两项会让「跨文件泄漏的宏边」
// 与「重复 id 的函数」变少。用严格相等等于把别人正在修的行为钉死，合法修复会
// 把测试打红，所以这里给 2 个余量，真正的强度由下面的「关键函数 + 关键边」承担。
const GOLDEN = { functions: 21, edges: 32, files: 8 };

test('loadModel(samples/tcu)：函数/边/文件数量在金标区间内', () => {
  const model = tcu();

  assert.ok(
    model.functions.length >= GOLDEN.functions,
    `functions 不应少于金标 ${GOLDEN.functions}，实际 ${model.functions.length}`
  );
  assert.ok(model.functions.length <= 40, `functions 异常膨胀: ${model.functions.length}`);

  // 金标 32 条调用记录 = 31 组节点对 + 1 条同对重复调用（Adc_GetFiltered 里调了两次 Adc_Read）。
  // 留 2 条余量：在途的 kind:'var' 边可能被回退，重复调用也可能被合并。
  assert.ok(
    model.edges.length >= GOLDEN.edges - 2,
    `edges 不应少于 ${GOLDEN.edges - 2}，实际 ${model.edges.length}`
  );
  assert.ok(model.edges.length <= 80, `edges 异常膨胀: ${model.edges.length}`);

  // files 只取决于目录扫描，与解析改动无关，可以严格断言
  assert.equal(model.files.length, GOLDEN.files);
  assert.deepEqual(
    model.files.map((f) => f.rel).sort(),
    ['adc.c', 'adc.h', 'can.c', 'can.h', 'config.h', 'gear.c', 'gear.h', 'main.c']
  );
});

test('loadModel(samples/tcu)：关键函数存在且 id 唯一', () => {
  const model = tcu();
  const ids = new Set(model.functions.map((fn) => fn.id));

  for (const id of [
    'main.c::main',
    'main.c::SysTick_Handler',
    'main.c::Task_10ms',
    'main.c::Task_100ms',
    'main.c::Task_Shift',
    'can.c::Can_Init',
    'can.c::Can_GetRpm',
    'adc.c::Adc_Read',
    'gear.c::Gear_Init',
    'gear.c::Gear_Apply',
    'gear.c::Gear_Retry',
    'gear.c::Gear_ShiftUp',
    'gear.c::Gear_ShiftDown',
  ]) {
    assert.ok(ids.has(id), `缺少函数 ${id}`);
  }

  // 同一函数被 #if/#else 各定义一次时会产生重复 id，导致前端按 id 建索引时丢节点
  assert.equal(ids.size, model.functions.length, 'functions 里存在重复的 id');
});

test('loadModel(samples/tcu)：关键调用边存在（含 macro / fnptr / 回边）', () => {
  const model = tcu();
  const has = (from, to, kind) =>
    model.edges.some((e) => e.from === from && e.to === to && (!kind || e.kind === kind));

  assert.ok(has('main.c::main', 'main.c::Task_100ms', 'direct'));
  assert.ok(has('main.c::main', 'main.c::Task_10ms', 'direct'));
  assert.ok(has('main.c::main', 'can.c::Can_Init', 'direct'));
  assert.ok(has('main.c::Task_10ms', 'main.c::Task_Shift', 'direct'));

  // 宏展开出来的真实调用：READ_ADC(ch) -> Adc_Read
  const macroEdge = model.edges.find(
    (e) => e.from === 'gear.c::Gear_CheckSpeed' && e.to === 'adc.c::Adc_Read' && e.kind === 'macro'
  );
  assert.ok(macroEdge, '缺少 READ_ADC 宏展开出的 macro 边');
  assert.equal(macroEdge.via, 'READ_ADC');

  // 函数指针表间接调用：INVOKE(&g_ops_4at, shift_up) -> Gear_ShiftUp
  const fnptrEdge = model.edges.find(
    (e) => e.from === 'main.c::Task_Shift' && e.to === 'gear.c::Gear_ShiftUp' && e.kind === 'fnptr'
  );
  assert.ok(fnptrEdge, '缺少经 g_ops_4at 的函数指针边');

  // 调用环：Gear_Apply <-> Gear_Retry
  assert.ok(has('gear.c::Gear_Apply', 'gear.c::Gear_Retry'));
  assert.ok(has('gear.c::Gear_Retry', 'gear.c::Gear_Apply'));

  assert.ok(model.edges.some((e) => e.kind === 'macro'), '至少应有 1 条 macro 边');
  assert.ok(model.edges.some((e) => e.kind === 'fnptr'), '至少应有 1 条 fnptr 边');
});

test('loadModel(samples/tcu)：直接/宏/函数指针边的两端都能在索引里解析', () => {
  const model = tcu();
  const byId = model._index.byId;
  // 只校验文档化的三种 kind；在途的 kind:'var' 边（数据流实验）不在本用例范围内
  for (const e of model.edges) {
    if (!['direct', 'macro', 'fnptr'].includes(e.kind)) continue;
    assert.ok(byId.has(e.from), `边 ${e.from}->${e.to} 的源端不在索引里`);
    assert.ok(byId.has(e.to), `边 ${e.from}->${e.to} 的目标端不在索引里`);
  }
});

test('stats(samples/tcu)：计数口径自洽，cycleGroups 稳定', () => {
  const model = tcu();
  const st = stats(model);

  assert.equal(st.functions, model.functions.length);
  assert.equal(st.files, model.files.length);
  assert.equal(st.calls, model.edges.length, 'calls 应等于原始调用记录数');
  const uniquePairs = new Set(model.edges.map((e) => `${e.from}|${e.to}`)).size;
  assert.equal(st.edges, uniquePairs, 'edges 应按节点对去重');
  assert.ok(st.edges <= st.calls);
  assert.equal(st.macroEdges, model.edges.filter((e) => e.kind === 'macro').length);
  assert.equal(st.fnptrEdges, model.edges.filter((e) => e.kind === 'fnptr').length);
  assert.ok(st.macroEdges >= 1 && st.fnptrEdges >= 1);

  // 金标：唯一的强连通分量是 gear.c 里的 Gear_Apply <-> Gear_Retry 双人环。
  // 排序后再比，避免 tarjan 遍历顺序变化造成的假失败。
  assert.deepEqual(
    st.cycleGroups.map((g) => [...g].sort()),
    [['gear.c::Gear_Apply', 'gear.c::Gear_Retry']]
  );
  assert.equal(st.cycles, 1);
});


test('恒假分支不修改宏，跨文件 static 不解析为调用目标', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.c'), 'static void helper(void) {} void real_target(void) {}');
  fs.writeFileSync(path.join(dir, 'b.c'), 'static void helper(void) {}');
  fs.writeFileSync(path.join(dir, 'c.c'), '#define CALL real_target\n#if 0\n#undef CALL\n#define CALL wrong_target\n#endif\nvoid entry(void) { CALL(); helper(); }');
  const edges = loadModel(dir).edges.filter((e) => e.from === 'c.c::entry');
  assert.ok(edges.some((e) => e.to === 'a.c::real_target'));
  assert.ok(edges.some((e) => e.to === 'ext::helper'));
});

test('同名平台实现按调用方选择硬件、主机或测试版本', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-platform-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = {
    'app/main.c': 'void main(void) { plat_mb_poll_init(); printf("init"); }',
    'platform/sh7254r/plat_sh7254r.c': 'void plat_mb_poll_init(void) { init_rx(); init_tx(); }',
    'platform/host/plat_host.c': 'void plat_mb_poll_init(void) {}',
    'platform/host/entry.c': 'void host_main(void) { plat_mb_poll_init(); }',
    'tests/unit/stub_plat.c': 'void plat_mb_poll_init(void) {}',
    'tests/unit/test_main.c': 'void test_main(void) { plat_mb_poll_init(); }',
  };
  for (const [rel, source] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  const model = loadModel(dir);
  const targets = (id) => model._index.outAdj.get(id).map(({ to }) => to);
  assert.deepEqual(targets('app/main.c::main'), ['platform/sh7254r/plat_sh7254r.c::plat_mb_poll_init', 'ext::printf']);
  assert.deepEqual(targets('platform/host/entry.c::host_main'), ['platform/host/plat_host.c::plat_mb_poll_init']);
  assert.deepEqual(targets('tests/unit/test_main.c::test_main'), ['tests/unit/stub_plat.c::plat_mb_poll_init']);
  assert.ok(!model._index.byId.has('ext::plat_mb_poll_init'));
});

test('子图将头文件 static inline 解析为工程内节点，外部调用按需展示', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-externals-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'cal_inplace.h'), 'static inline int cal_u8(void) { return 0; }');
  fs.writeFileSync(path.join(dir, 'main.c'), '#include "cal_inplace.h"\nvoid main(void) { printf("init"); cal_u8(); }');
  const model = loadModel(dir);
  const root = 'main.c::main', inline = 'cal_inplace.h::cal_u8', external = 'ext::printf';
  assert.equal(model._index.byId.get(inline).isStatic, true);

  const hidden = subgraph(model, root, { maxNodes: 2 });
  assert.deepEqual(hidden.nodes.map(({ id }) => id), [root, inline]);
  assert.deepEqual(hidden.edges.map(({ to }) => to), [inline]);
  assert.equal(hidden.truncated, false);
  const visible = subgraph(model, root, { includeExternals: true });
  assert.deepEqual(visible.edges.map(({ to }) => to), [external, inline]);
  assert.ok(visible.nodes.some(({ id }) => id === external));
  const externalRoot = subgraph(model, external, { up: 1 });
  assert.deepEqual(externalRoot.nodes.map(({ id }) => id), [external, root]);
  assert.deepEqual(externalRoot.edges.map(({ from, to }) => [from, to]), [[root, external]]);
});

test('头文件静态函数只对直接或间接包含该头文件的调用方可见', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-header-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'include', 'driver'), { recursive: true });
  const files = {
    'include/driver/private.h': 'static inline int helper(void) { return 1; }\nstatic inline int scoped(void) { return 2; }',
    'include/public.h': '#include "driver/private.h"\n',
    'uses.c': '#include "private.h"\nint uses(void) { return helper(); }',
    'transitive.c': '#include "include/public.h"\nint transitive(void) { return helper(); }',
    'inactive.c': '#if 0\n#include "private.h"\n#endif\nint inactive(void) { return helper(); }',
    'noinc.c': 'extern int helper(void);\nint noinc(void) { return helper(); }',
    'linked.c': 'int scoped(void) { return 3; }',
    'app.c': '#include "private.h"\nint app(void) { return scoped(); }',
  };
  for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), source);
  const model = loadModel(dir);
  const target = (name) => model._index.outAdj.get(`${name}.c::${name}`)[0].to;
  assert.equal(target('uses'), 'include/driver/private.h::helper');
  assert.equal(target('transitive'), 'include/driver/private.h::helper');
  assert.equal(target('inactive'), 'ext::helper');
  assert.equal(target('noinc'), 'ext::helper');
  assert.equal(target('app'), 'include/driver/private.h::scoped');
});

test('DOT 端口不产生节点，引号内冒号保留', () => {
  const graph = parseDot('digraph { a:ne -> "b:c":port:sw; }');
  assert.deepEqual([...graph.nodes.keys()], ['a', 'b:c']);
  assert.deepEqual(graph.edges.map(({ from, to }) => [from, to]), [['a', 'b:c']]);
});

test('紧凑索引保留头文件宏的生效顺序、文件内 undef 和嵌套调用判断', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-scopes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = new Map([
    ['a.h', '#define CALL first\nstatic void early(void) { CALL(); }\n'],
    ['b.h', '#undef CALL\n#define CALL second\nstatic void late(void) { CALL(); }\n'],
    ['a.c', '#undef CALL\nvoid isolated(void) { CALL(); }\n'],
    ['b.c', 'void first(void) {}\nvoid second(void) {}\n' +
      'int inner(void) { return 0; }\nvoid outer(int n) {}\n' +
      'void inherited(void) { CALL(); outer(inner()); }\n'],
  ]);
  const sources = new Map();
  for (const [name, source] of files) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    sources.set(name, file);
  }
  const model = buildIndex(dir, sources);
  const target = (from) => model._index.outAdj.get(from)[0].to;
  assert.equal(target('a.h::early'), 'b.c::first');
  assert.equal(target('b.h::late'), 'b.c::second');
  assert.equal(target('a.c::isolated'), 'ext::CALL');
  assert.equal(target('b.c::inherited'), 'b.c::second');
  assert.ok(model.functions.every((fn) => !Object.hasOwn(fn, 'bodyTokens')));
  assert.deepEqual(detectTasks(model, 'b.c::inherited').skipped.map(({ from }) => from), ['b.c::inherited']);
});

test('单次词法分析后绑定在后续文件中定义的函数指针和全局变量', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-deferred-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'caller.c'), `
static int local_count = 0;
void entry(void) {
  later = 3;
  local_count += later;
  outer(ops.tick());
}
void unknown_member(void) { outer(unknown.tick()); entry(); }
void unknown_field(void) { ops.toString(); }
`);
  fs.writeFileSync(path.join(dir, 'table.c'), `
int later = 0;
int local_count = 0;
void outer(int value) {}
int tick(void) { return 1; }
const Ops ops = { .tick = tick };
`);
  const model = loadModel(dir);
  const entry = model._index.byId.get('caller.c::entry');
  const edges = model._index.outAdj.get(entry.id);
  assert.ok(edges.some((e) => e.kind === 'fnptr' && e.to === 'table.c::tick' && e.via === 'ops.tick'));
  assert.equal(entry.hasNestedCalls, true);
  assert.equal(model._index.byId.get('caller.c::unknown_member').hasNestedCalls, undefined);
  assert.ok(!model._index.outAdj.get('caller.c::unknown_field')?.some((e) => e.kind === 'fnptr'));
  assert.deepEqual(entry.varAccess.map(({ id, read, write }) => [id, read, write]),
    [['var::later', true, true], ['var::caller.c::local_count', true, true]]);
});

test('宏复合表达式 #define x (a()+b())、同文件重定义、变参宏、外层括号调用与假边过滤', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-macro-edge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'macro.c'), `
int a(void) { return 1; }
int b(void) { return 2; }
void one(void) {}
void two(void) {}
int never_called(void) { return 0; }
#define X (a() + b())
#define WRAP(...) (__VA_ARGS__)
#define ID(fn) fn
#define M one
int use_x(void) {
  void local_proto(void);
  int sz = (int)sizeof(never_called());
  M();
  WRAP(two());
  ID(one)();
  (a)();
  return X + sz;
}
#undef M
#define M two
void use_m_after(void) {
  M();
}
`);
  const model = loadModel(dir);
  const out = (name) => (model._index.outAdj.get(`macro.c::${name}`) || []).filter((e) => e.kind !== 'var');
  const useX = out('use_x');
  assert.ok(useX.some((e) => e.to === 'macro.c::a' && e.kind === 'macro'), '#define X (a()+b()) 应提取到 a()');
  assert.ok(useX.some((e) => e.to === 'macro.c::b' && e.kind === 'macro'), '#define X (a()+b()) 应提取到 b()');
  assert.ok(useX.some((e) => e.to === 'macro.c::one' && e.kind === 'macro'), 'M() 在重定义前应指向 one');
  assert.ok(useX.some((e) => e.to === 'macro.c::two' && e.kind === 'macro'), '变参宏 WRAP(two()) 应提取到 two');
  assert.ok(useX.some((e) => e.to === 'macro.c::a' && e.kind === 'direct'), '(a)() 应识别为直接调用');
  assert.ok(!useX.some((e) => e.to === 'macro.c::never_called'), 'sizeof(never_called()) 不求值不应建边');
  assert.ok(!useX.some((e) => e.callee === 'local_proto'), '块内局部函数原型不应被当成调用');
  const after = out('use_m_after');
  assert.deepEqual(after.map((e) => e.to), ['macro.c::two'], '#undef 重定义后应指向 two');
});

test('1D/2D 常量函数指针数组与结构体表：常量下标直连、动态下标保留候选且 static 表按文件隔离', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-fnptr-2d-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.c'), `
typedef void (*fn_t)(void);
typedef struct { fn_t step; } Ops;
void fnA(void) {}
void vvv(void) {}
void ggg(void) {}
void jjj(void) {}
void ghh(void) {}
void jkk(void) {}
void kkk(void) {}
static const Ops ops = { .step = fnA };
static const Ops wrapped = { .step = ((fnA)) };
static const fn_t addresses[] = { &(vvv), ((void (*)(void))(&ghh)), (fn_t)jjj };
void call_wrapped(void) { wrapped.step(); addresses[0](); addresses[1](); addresses[2](); }
const fn_t z[] = { vvv, ghh };
const fn_t e[2][3] = { { vvv, ggg, jjj }, { ghh, jkk, kkk } };
const Ops tbl[] = { { .step = vvv }, { .step = ghh } };
void call_const(void) {
  ops.step();
  z[1]();
  e[1][0]();
  tbl[0].step();
}
void call_dyn(int r, int c) {
  z[r]();
  e[r][c]();
  tbl[r].step();
}
`);
  fs.writeFileSync(path.join(dir, 'b.c'), `
typedef void (*fn_t)(void);
typedef struct { fn_t step; } Ops;
void fnB(void) {}
static const Ops ops = { .step = fnB };
void call_b(void) {
  ops.step();
}
`);
  const model = loadModel(dir);
  const out = (id) => (model._index.outAdj.get(id) || []).filter((e) => e.kind !== 'var');
  const constTargets = out('a.c::call_const').map((e) => e.to);
  assert.ok(constTargets.includes('a.c::fnA'), 'a.c static ops.step() 不应被 b.c 同名 static 表污染');
  assert.ok(constTargets.includes('a.c::ghh'), '常量下标 z[1]() 与 e[1][0]() 应直接连到 ghh');
  assert.ok(constTargets.includes('a.c::vvv'), '结构体数组常量下标 tbl[0].step() 应直接连到 vvv');
  assert.deepEqual(out('b.c::call_b').map((e) => e.to), ['b.c::fnB'], 'b.c static ops 应独立指向 fnB');
  assert.deepEqual(model.fnptrTables.find(table => table.name === 'wrapped').map, { step: 'fnA' });
  assert.deepEqual(out('a.c::call_wrapped').map(e => [e.kind, e.to]), [
    ['fnptr', 'a.c::fnA'], ['fnptr', 'a.c::vvv'], ['fnptr', 'a.c::ghh'], ['fnptr', 'a.c::jjj'],
  ]);

  // expand 模式默认把动态下标与结构体表全部候选展开成虚线 fnptr 边，并在 indirectCalls 保留元数据
  const expandDyn = out('a.c::call_dyn').filter((e) => e.kind === 'fnptr');
  assert.ok(expandDyn.every((e) => e.resolution === 'possible' && e.dynamicDispatch));
  assert.deepEqual(new Set(expandDyn.map((e) => e.callee)), new Set(['vvv', 'ggg', 'jjj', 'ghh', 'jkk', 'kkk']));
  const strictModel = loadModel(dir, { parserOptions: { dispatchPolicy: 'strict' } });
  const strictOut = (id) => (strictModel._index.outAdj.get(id) || []).filter((e) => e.kind !== 'var');
  assert.equal(strictOut('a.c::call_dyn').length, 0);
  const dynSites = (model.indirectCalls || []).filter((ic) => ic.caller === 'a.c::call_dyn');
  assert.equal(dynSites.length, 3);
  const site2d = dynSites.find((ic) => ic.table?.name === 'e');
  assert.ok(site2d);
  assert.deepEqual(site2d.candidates.map((c) => c.name).sort(), ['ggg', 'ghh', 'jjj', 'jkk', 'kkk', 'vvv']);
  assert.ok(site2d.candidates.some((c) => c.slot === '[1][0]' && c.name === 'ghh'));
});

test('保留初始化式调用，解析函数内分派表作用域和八进制下标', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-local-tables-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'app.c'), `
typedef void (*fn_t)(void);
typedef struct { fn_t run; } Ops;
void global_target(void) {}
void first_local(void) {}
void second_local(void) {}
void inner_local(void) {}
int number(void) { return 1; }
int *pointer(void) { return 0; }
static const Ops ops = { .run = global_target };
static const fn_t table[11] = { [010u] = first_local, [10] = second_local };
void first(void) {
  ops.run();
  static const Ops ops = { .run = first_local };
  ops.run();
  { static const Ops ops = { .run = inner_local }; ops.run(); }
  ops.run();
}
void second(void) { static const Ops ops = { .run = second_local }; ops.run(); }
void global_only(void) { ops.run(); }
void octal(void) { table[010](); table[8](); table[10](); }
int initialize(void) {
  typedef int Value;
  extern int *prototype(void);
  extern Value *typedef_prototype(void);
  int x = 2 * number();
  int y = *pointer();
  return x + y;
}
`);
  const model = loadModel(dir);
  const calls = name => (model._index.outAdj.get(`app.c::${name}`) || [])
    .filter(edge => edge.kind !== 'var').map(edge => edge.callee);
  assert.deepEqual(calls('first'), ['global_target', 'first_local', 'inner_local', 'first_local']);
  assert.deepEqual(calls('second'), ['second_local']);
  assert.deepEqual(calls('global_only'), ['global_target']);
  assert.deepEqual(calls('octal'), ['first_local', 'first_local', 'second_local']);
  assert.deepEqual(calls('initialize'), ['number', 'pointer']);
});

test('区分 typedef 转换和括号调用，并保留解引用分派表下标里的调用', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-casts-and-indices-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'types.h'), 'typedef unsigned short Reading, *ReadingPtr;\n');
  fs.writeFileSync(path.join(dir, 'api.h'), '#include "types.h"\n#define READ_CAST() (Reading)(read_value())\n');
  fs.writeFileSync(path.join(dir, 'app.c'), `
#include "api.h"
#include <stdint.h>
typedef void (*Handler)(void);
static unsigned short read_value(void) { return 5; }
static void first(void) {}
static void second(void) {}
static int next(void) { return 0; }
static int column(void) { return 1; }
static int handler_t(void) { return 0; }
static const Handler arr[2][2] = { { first, second }, { second, first } };
unsigned int cast_values(void) {
  typedef unsigned int LocalCount;
  return (uint16_t)(read_value()) + (LocalCount)(read_value()) + READ_CAST() + (handler_t)();
}
Handler cast_handler(void) { return (Handler)(0); }
void dispatch(void) { (*arr[next()][column()])(); }
`);
  fs.writeFileSync(path.join(dir, 'other.c'), 'int Reading(void) { return 3; }\nint use(void) { return (Reading)(); }\n');
  const model = loadModel(dir);
  const calls = id => (model._index.outAdj.get(id) || []).filter(edge => edge.kind !== 'var').map(edge => edge.callee);
  assert.deepEqual(calls('app.c::cast_values'), ['read_value', 'read_value', 'read_value', 'handler_t']);
  assert.deepEqual(calls('app.c::cast_handler'), []);
  assert.deepEqual(calls('other.c::use'), ['Reading']);
  assert.deepEqual(calls('app.c::dispatch'), ['next', 'column', 'first', 'second']);
  const strict = loadModel(dir, { parserOptions: { dispatchPolicy: 'strict' } });
  const strictCalls = (strict._index.outAdj.get('app.c::dispatch') || []).filter(e => e.kind !== 'var').map(e => e.callee);
  assert.deepEqual(strictCalls, ['next', 'column']);
  const sites = model.indirectCalls.filter(call => call.caller === 'app.c::dispatch');
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0].indices, ['next()', 'column()']);
  assert.deepEqual(new Set(sites[0].candidates.map(candidate => candidate.name)), new Set(['first', 'second']));
  assert.ok(!(model.headerEdges || []).some(edge => edge.to === 'ext::Reading'));
});

test('分派表保留未知指定槽位，已知槽位按初始化文件绑定', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-designators-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.c'), `
typedef void (*Fn)(void);
static void target(void) {}
static void other(void) {}
#define SLOT (2)
const Fn table[4] = { [SLOT] = target, other };
extern const int EXT_SLOT;
static const Fn uncertain[4] = { [EXT_SLOT] = target, other };
enum { ENUM_SLOT = 2 };
static const Fn enum_tbl[4] = { [ENUM_SLOT] = target, other };
void unknown(void) { uncertain[0](); }
void by_enum(void) { enum_tbl[ENUM_SLOT](); enum_tbl[ENUM_SLOT + 1](); }
`);
  fs.writeFileSync(path.join(dir, 'b.c'), `
typedef void (*Fn)(void);
extern const Fn table[4];
static void target(void) {}
#define INDEX 2
void call_sites(void) { table[INDEX](); table[3](); target(); }
`);
  const strictModel = loadModel(dir, { parserOptions: { dispatchPolicy: 'strict' } });
  const calls = id => (strictModel._index.outAdj.get(id) || []).filter(edge => edge.kind !== 'var');
  assert.deepEqual(calls('b.c::call_sites').map(edge => edge.to), ['a.c::target', 'a.c::other', 'b.c::target']);
  assert.deepEqual(calls('a.c::by_enum').map(edge => edge.to), ['a.c::target', 'a.c::other']);
  assert.deepEqual(calls('a.c::unknown'), []);
  const table = strictModel.fnptrTables.find(table => table.name === 'uncertain');
  assert.equal(table.incomplete, true);
  assert.deepEqual(table.map, { '[?EXT_SLOT]': 'target', '[?EXT_SLOT+1]': 'other' });
  const site = strictModel.indirectCalls.find(call => call.caller === 'a.c::unknown');
  assert.deepEqual(site.candidates.map(candidate => candidate.id), ['a.c::target', 'a.c::other']);
});

test('sizeof 只保留变长数组边界调用，连续调用的实参不生成假边', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-vla-chained-calls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'types.h'), 'typedef unsigned short Count;\n');
  fs.writeFileSync(path.join(dir, 'app.c'), `
#include "types.h"
typedef int (*Fn)(int);
static int next(void) { return 2; }
static int second(void) { return 3; }
static int run(int n) { return n; }
static Fn factory(int index) { return run; }
int sizes(const int *values) {
  return sizeof(int[next()]) + sizeof(Count[second()]) + sizeof(values[next()])
    + sizeof(next()) + sizeof(int (*)[next()]);
}
int chain(int index) { return factory(index)(42) + (factory)(index)(42); }
int cast_chain(int index) { typedef int Result; return (Result)(run)(index); }
int conditional(int index) { if (index) (run)(42); return 0; }
`);
  const model = loadModel(dir);
  const calls = name => (model._index.outAdj.get(`app.c::${name}`) || [])
    .filter(edge => edge.kind !== 'var').map(edge => edge.callee);
  assert.deepEqual(calls('sizes'), ['next', 'second']);
  assert.deepEqual(calls('chain'), ['factory', 'factory']);
  assert.deepEqual(calls('cast_chain'), ['run']);
  assert.deepEqual(calls('conditional'), ['run']);
});

test('sizeof 在调用处展开宏，只记录变长数组类型中求值的维度', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-sizeof-macro-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'types.h'), '#define TYPE int[next()]\n#define ALIAS TYPE\n');
  fs.writeFileSync(path.join(dir, 'app.c'), `
#include "types.h"
static int next(void) { return 2; }
static int second(void) { return 3; }
#define MATRIX(n) int[n][second()]
int first(void) { return sizeof(ALIAS); }
int matrix(void) { return sizeof(MATRIX(next())); }
#undef TYPE
#define TYPE values[next()]
int expr(int *values) { return sizeof(ALIAS); }
#undef TYPE
#define TYPE int (*)[next()]
int ptr(void) { return sizeof(ALIAS); }
#define MAKE_MATRIX MATRIX
int matrix_alias(void) { return sizeof(MAKE_MATRIX(next())); }
`);
  const model = loadModel(dir);
  const calls = name => (model._index.outAdj.get(`app.c::${name}`) || [])
    .filter(edge => edge.kind !== 'var');
  assert.deepEqual(calls('first').map(edge => [edge.callee, edge.line, edge.via]), [
    ['next', 6, 'ALIAS > TYPE'],
  ]);
  assert.deepEqual(calls('matrix').map(edge => edge.callee), ['next', 'second']);
  assert.deepEqual(calls('matrix_alias').map(edge => edge.callee), ['next', 'second']);
  assert.deepEqual(calls('expr'), []);
  assert.deepEqual(calls('ptr'), []);
});

test('括号内的函数名按调用处展开对象宏，保留函数式宏的同名函数', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-parenthesized-alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'api.h'), '#define FN ENTRY\n#define ENTRY first\n');
  fs.writeFileSync(path.join(dir, 'app.c'), `
#include "api.h"
typedef int Result;
static int first(int n) { return n; }
static int second(int n) { return n; }
static int actual(int n) { return n; }
#define actual(n) second(n)
#define CAST Result
int before(int n) { return (FN)(n) + (actual)(n); }
#undef ENTRY
#define ENTRY ((second))
int after(int n) { return ((FN))((actual)(n)) + (CAST)(FN)(n); }
`);
  const model = loadModel(dir);
  const calls = name => (model._index.outAdj.get(`app.c::${name}`) || [])
    .filter(edge => edge.kind !== 'var').map(edge => [edge.to, edge.kind, edge.via]);
  assert.deepEqual(calls('before'), [
    ['app.c::first', 'macro', 'FN > ENTRY'], ['app.c::actual', 'direct', undefined],
  ]);
  assert.deepEqual(calls('after'), [
    ['app.c::second', 'macro', 'FN > ENTRY'], ['app.c::actual', 'direct', undefined],
    ['app.c::second', 'macro', 'FN > ENTRY'],
  ]);
});

test('分派表保留可见的外部函数候选，并区分函数指针变量和无关声明', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-external-targets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'lib.h'), 'void api(void), api_only(void);\n');
  fs.writeFileSync(path.join(dir, 'entry.h'), '#include "lib.h"\n');
  fs.writeFileSync(path.join(dir, 'unrelated.h'), 'void numeric(void);\n');
  fs.writeFileSync(path.join(dir, 'other.c'), 'static void external(void) {}\n');
  fs.writeFileSync(path.join(dir, 'app.c'), `
#include "entry.h"
typedef void (*Fn)(void);
extern void external(void);
static void local(void) {}
static const Fn dispatch[] = { local, external, api };
static const Fn library[] = { api, api_only };
enum { numeric = 2 };
static const int data[] = { numeric };
void constant(void) { dispatch[0](); dispatch[1](); dispatch[2](); }
void dynamic(unsigned i) { dispatch[i](); library[i](); }
void partial(unsigned i, Fn api) {
  extern void inside(void);
  const Fn mixed[] = {local, api, inside};
  const Fn single[] = {local, api};
  mixed[0](); mixed[2](); mixed[i](); single[i]();
}
void different(void) { enum { inside = 1 }; const int values[] = { inside }; }
void shadow(Fn runtime) {
  { Fn external = runtime; const Fn dispatch[] = {external}; dispatch[0](); }
  const Fn restored[] = {external}; restored[0]();
}
`);
  const model = loadModel(dir);
  const strict = loadModel(dir, { parserOptions: { dispatchPolicy: 'strict' } });
  const targets = (m, name) => (m._index.outAdj.get('app.c::' + name) || [])
    .filter(edge => edge.kind !== 'var').map(edge => edge.to);
  assert.deepEqual(targets(model, 'constant'), ['app.c::local', 'ext::external', 'ext::api']);
  assert.deepEqual(targets(strict, 'dynamic'), []);
  assert.deepEqual(targets(model, 'dynamic'), ['app.c::local', 'ext::external', 'ext::api', 'ext::api', 'ext::api_only']);
  assert.deepEqual(targets(strict, 'partial'), ['app.c::local', 'ext::inside']);
  assert.deepEqual(targets(model, 'partial'), ['app.c::local', 'ext::inside', 'app.c::local', 'ext::inside', 'app.c::local']);
  assert.deepEqual(targets(model, 'shadow'), ['ext::external']);
  const candidates = table => model.indirectCalls.find(call => call.receiver === table)?.candidates.map(c => c.id);
  assert.deepEqual(candidates('dispatch'), ['app.c::local', 'ext::external', 'ext::api']);
  assert.deepEqual(candidates('library'), ['ext::api', 'ext::api_only']);
  assert.deepEqual(candidates('mixed'), ['app.c::local', 'ext::inside']);
  assert.deepEqual(candidates('single'), ['app.c::local']);
  assert.ok(model.externals.some(node => node.id === 'ext::api_only'));
  assert.ok(!model.fnptrTables.some(table => ['data', 'values'].includes(table.name)));
});

test('形参和块内指针按声明位置遮蔽分派表，离开块后恢复外层绑定', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-shadow-table-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'types.h'), 'typedef void (*Fn)(void);\n');
  fs.writeFileSync(path.join(dir, 'app.c'), `
#include "types.h"
static void file_fn(void) {}
static void local_fn(void) {}
static const Fn table[] = {file_fn};
void param(const Fn *table) { table[0](); }
void array_param(unsigned n, Fn table[n]) { table[0](); }
void pointer(const Fn *other) { const Fn *table = other; table[0](); }
void block(Fn *other) {
  table[0]();
  { Fn *table = other; table[0](); }
  table[0]();
}
void nested(Fn *table) {
  table[0]();
  { const Fn table[] = {local_fn};
    table[0](); { Fn *table = 0; table[0](); } table[0]();
  }
  table[0]();
}
void loop(Fn *other) {
  for (Fn *table = other; table; table = 0) { table[0](); }
  table[0]();
  for (Fn *table = other; table; table = 0) if (other) table[0](); else table[0]();
  for (Fn table[] = {local_fn}; other; other = 0) table[0]();
  table[0]();
}
`);
  const model = loadModel(dir);
  const resolved = name => (model._index.outAdj.get('app.c::' + name) || [])
    .filter(edge => edge.kind === 'fnptr').map(edge => edge.callee);
  for (const name of ['param', 'array_param', 'pointer']) assert.deepEqual(resolved(name), [], name);
  assert.deepEqual(resolved('block'), ['file_fn', 'file_fn']);
  assert.deepEqual(resolved('nested'), ['local_fn', 'local_fn']);
  assert.deepEqual(resolved('loop'), ['file_fn', 'local_fn', 'file_fn']);
  const unresolved = model.indirectCalls.filter(call => call.receiver === 'table');
  assert.equal(unresolved.length, 10);
  assert.ok(unresolved.every(call => !call.table && !call.candidates.length));
});

test('静态分派表仅在直接或间接包含其头文件的调用点可见', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-header-table-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['first', 'second']) {
    fs.writeFileSync(path.join(dir, name + '.h'), `
typedef struct { void (*run)(void); } Ops;
static void target(void) {}
static const Ops ops = {.run = target};
`);
  }
  fs.writeFileSync(path.join(dir, 'wrapper.h'), '#include "second.h"\n');
  fs.writeFileSync(path.join(dir, 'one.c'), '#include "first.h"\nvoid run(void) { ops.run(); }\n');
  fs.writeFileSync(path.join(dir, 'two.c'), '#include "wrapper.h"\nvoid run(void) { ops.run(); }\n');
  fs.writeFileSync(path.join(dir, 'three.c'), 'typedef struct { void (*run)(void); } Ops;\nextern Ops ops;\nvoid run(void) { ops.run(); }\n');
  const model = loadModel(dir);
  const targets = file => (model._index.outAdj.get(file + '::run') || [])
    .filter(edge => edge.kind === 'fnptr').map(edge => edge.to);
  assert.deepEqual(targets('one.c'), ['first.h::target']);
  assert.deepEqual(targets('two.c'), ['second.h::target']);
  assert.deepEqual(targets('three.c'), []);
  assert.deepEqual(model.indirectCalls.find(call => call.caller === 'three.c::run').candidates, []);
});

test('成员数组调用保留所属表达式，同名全局分派表只绑定裸表调用', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-member-receiver-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'app.c'), `
typedef void (*Fn)(void);
typedef struct { Fn table[1]; } Ops;
typedef struct { Fn run; } Entry;
static void a(void) {}
static void b(void) {}
static Fn const table[] = { a };
static const Entry entries[] = {{ .run = b }};
static int index_of(void) { return 0; }
static Ops *choose(Ops *p) { return p; }
void dispatch(Ops *p, Ops s) {
  p->table[0]();
  s.table[0]();
  (*p->table[index_of()])();
  choose(p)->table[0]();
  (p->table)[0]();
  table[0]();
  entries[0].run();
}
`);
  const model = loadModel(dir);
  const calls = model._index.outAdj.get('app.c::dispatch').filter(edge => edge.kind !== 'var');
  assert.deepEqual(calls.map(edge => [edge.kind, edge.callee]), [
    ['direct', 'index_of'], ['direct', 'choose'], ['fnptr', 'a'], ['fnptr', 'b'],
  ]);
  const sites = model.indirectCalls.filter(call => call.caller === 'app.c::dispatch');
  assert.deepEqual(sites.map(call => call.expr), [
    'p->table[0]', 's.table[0]', 'p->table[index_of()]', 'choose(p)->table[0]', '(p->table)[0]',
  ]);
  assert.ok(sites.every(call => !call.table && !call.candidates.length));
});

test('C89 位置初始化按可见字段顺序分派，括号解引用和嵌套下标匹配同一槽位', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-positional-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'types.h'), `
typedef void (*Fn)(void);
typedef struct { int id; Fn handler; } Tbl;
typedef struct { Fn first, run; } Ops;
struct Sub { Fn fn; Fn more[2]; };
typedef struct { struct Sub sub; } Nested;
typedef struct Later Later;
struct Later { Nested entry; };
`);
  fs.writeFileSync(path.join(dir, 'wrapper.h'), '#include "types.h"\n');
  fs.writeFileSync(path.join(dir, 'elsewhere.h'), 'typedef struct { void (*wrong)(void); } Tbl;\n');
  fs.writeFileSync(path.join(dir, 'app.c'), `
#include "wrapper.h"
static void FnA(void) {} static void FnB(void) {}
static const Tbl rows[] = {{1, FnA}, {2, FnB}};
static const Ops s_ops = {FnA, FnB};
static const Nested nested[] = {{{FnA, {FnA, FnB}}}, {{FnB, {FnB, FnA}}}};
static const Nested single = {{FnB, {FnA, FnA}}};
static const struct Sub grid[1][2] = {{{FnA}, {FnB}}};
static const Tbl flat[] = {1, FnA, 2, FnB};
static const Later later = {FnB, FnA, FnB};
static int index_of(void) { return 1; }
void constant(void) {
  rows[0].handler(); (*rows[1].handler)(); s_ops.run(); (*s_ops.first)();
  nested[0].sub.fn(); single.sub.fn(); grid[0][1].fn(); nested[0].sub.more[1]();
  flat[1].handler(); later.entry.sub.fn(); later.entry.sub.more[1]();
}
void dynamic(int i) {
  rows[i].handler(); (*rows[index_of()].handler)(); (*nested[i].sub.fn)(); nested[0].sub.more[i]();
}
void local(int i) {
  typedef struct { Fn handler; int id; } Tbl;
  static const Tbl rows[] = {{FnB, 1}, {FnA, 2}};
  rows[0].handler(); rows[i].handler();
}
`);
  const model = loadModel(dir);
  const edges = name => model.edges.filter(edge => edge.from === 'app.c::' + name && edge.kind !== 'var')
    .map(edge => [edge.kind, edge.callee]);
  const sites = name => model.indirectCalls.filter(site => site.caller === 'app.c::' + name);
  assert.deepEqual(model.fnptrTables.find(table => table.name === 'rows' && !table.functionId).map,
    { '[0].handler': 'FnA', '[1].handler': 'FnB' });
  assert.deepEqual(edges('constant'), [
    'FnA', 'FnB', 'FnB', 'FnA', 'FnA', 'FnB', 'FnB', 'FnB', 'FnB', 'FnB', 'FnB',
  ].map(fn => ['fnptr', fn]));
  assert.deepEqual(edges('local'), [['fnptr', 'FnB'], ['fnptr', 'FnB'], ['fnptr', 'FnA']]);
  assert.deepEqual(edges('dynamic'), [
    ['fnptr', 'FnA'], ['fnptr', 'FnB'], ['direct', 'index_of'],
    ['fnptr', 'FnA'], ['fnptr', 'FnB'], ['fnptr', 'FnA'], ['fnptr', 'FnB'], ['fnptr', 'FnA'], ['fnptr', 'FnB'],
  ]);
  const strict = loadModel(dir, { parserOptions: { dispatchPolicy: 'strict' } });
  const strictEdges = name => strict.edges.filter(edge => edge.from === 'app.c::' + name && edge.kind !== 'var')
    .map(edge => [edge.kind, edge.callee]);
  assert.deepEqual(strictEdges('local'), [['fnptr', 'FnB']]);
  assert.deepEqual(strictEdges('dynamic'), [['direct', 'index_of']]);
  assert.deepEqual(sites('dynamic').map(site => [site.table.name, site.candidates.map(c => c.slot)]), [
    ['rows', ['[0].handler', '[1].handler']], ['rows', ['[0].handler', '[1].handler']],
    ['nested', ['[0].sub.fn', '[1].sub.fn']], ['nested', ['[0].sub.more[0]', '[0].sub.more[1]']],
  ]);
  assert.deepEqual(sites('local')[0].candidates.map(c => c.name), ['FnB', 'FnA']);
});

test('局部指针在初始化处绑定分派表，重赋值、增量与逃逸保留为间接候选', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-table-alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'app.c'), `
typedef struct { void (*run)(void); } Ops;
typedef struct { int id; void (*handler)(void); } Tbl;
static void FnA(void) {} static void FnB(void) {}
static const Ops s_ops = {FnA};
static const Ops other = {FnB};
static const Tbl rows[] = {{0, FnA}, {1, FnB}};
static const Tbl one[] = {{0, FnA}};
void take(const Ops **out);
#define ESCAPE(x) take(&(x))
void constant(void) {
  const Ops *p = &s_ops; p->run(); (*p->run)();
  const Tbl *q = &rows[0]; q->handler();
  { const Ops s_ops = {FnB}; p->run(); }
  { const Ops *p = &other; p->run(); }
  p->run();
}
void dynamic(int i) {
  const Tbl *r = &rows[i]; r->handler();
  const Tbl *s = &one[i]; (*s->handler)();
}
void reassign(int cond) { const Ops *p = &s_ops; if (cond) p = &other; p->run(); }
void move(void) { const Tbl *p = &rows[0]; ++p; p->handler(); }
void escape(void) { const Ops *p = &s_ops; ESCAPE(p); (*p->run)(); }
void shadow(void) { const Ops *p = &s_ops; { const Ops *p = &other; ESCAPE(p); p->run(); } p->run(); }
void conditional(void) {
#ifdef VARIANT
  const Ops *p = &other;
#else
  const Ops *p = &s_ops;
#endif
  p->run();
}
`);
  const model = loadModel(dir);
  const strict = loadModel(dir, { parserOptions: { dispatchPolicy: 'strict' } });
  const edges = (m, name) => m.edges.filter(edge => edge.from === 'app.c::' + name && edge.kind === 'fnptr')
    .map(edge => edge.callee);
  const sites = name => model.indirectCalls.filter(site => site.caller === 'app.c::' + name);
  assert.deepEqual(edges(model, 'constant'), ['FnA', 'FnA', 'FnA', 'FnA', 'FnB', 'FnA']);
  assert.deepEqual(sites('constant'), []);
  for (const name of ['dynamic', 'reassign', 'move', 'escape', 'conditional']) assert.deepEqual(edges(strict, name), [], name);
  assert.deepEqual(edges(model, 'reassign'), ['FnA', 'FnB']);
  assert.deepEqual(edges(model, 'conditional').sort(), ['FnA', 'FnB']);
  assert.deepEqual(sites('dynamic').map(site => [site.receiver, site.table.name, site.indices, site.candidates.map(c => c.slot)]), [
    ['r', 'rows', ['i'], ['[0].handler', '[1].handler']], ['s', 'one', ['i'], ['[0].handler']],
  ]);
  assert.deepEqual(sites('reassign')[0].candidates.map(c => c.name), ['FnA', 'FnB']);
  assert.deepEqual(sites('move')[0].candidates.map(c => c.name), ['FnA', 'FnB']);
  assert.deepEqual(sites('escape')[0].candidates.map(c => c.name), ['FnA']);
  assert.deepEqual(edges(model, 'shadow'), ['FnB', 'FnA']);
  assert.deepEqual(edges(strict, 'shadow'), ['FnA']);
  assert.deepEqual(sites('shadow')[0].candidates.map(c => c.name), ['FnB']);
  assert.deepEqual(sites('conditional')[0].candidates.map(c => c.name).sort(), ['FnA', 'FnB']);
});

test('带尾置嵌入式属性的分派表保留变量名，并在初始化行展开处理函数宏', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-table-attribute-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'app.c'), `
typedef struct { void (*run)(void); } Ops;
static void RealFn(void) {} static void Later(void) {}
#define ALIAS_MACRO HANDLER
#define HANDLER RealFn
static const Ops sectioned[] __attribute__((section(".rodata"))) = {{.run = ALIAS_MACRO}};
static const Ops unused _attribute((unused)) = {.run = &ALIAS_MACRO};
#undef HANDLER
#define HANDLER Later
static const Ops aligned __declspec(align(4)) _attribute((unused)) = {ALIAS_MACRO};
static void (*const raw[])(void) __attribute__((used)) = {ALIAS_MACRO};
void call(void) { sectioned[0].run(); unused.run(); aligned.run(); raw[0](); }
void local(void) { static const Ops block _attribute((unused)) = {ALIAS_MACRO}; block.run(); }
`);
  const model = loadModel(dir);
  assert.deepEqual(model.fnptrTables.filter(table => !table.functionId).map(table => [table.name, table.map]), [
    ['sectioned', { '[0].run': 'RealFn' }], ['unused', { run: 'RealFn' }],
    ['aligned', { run: 'Later' }], ['raw', { '[0]': 'Later' }],
  ]);
  assert.deepEqual(model.edges.filter(edge => edge.from === 'app.c::call' && edge.kind === 'fnptr').map(edge => edge.callee),
    ['RealFn', 'RealFn', 'Later', 'Later']);
  assert.deepEqual(model.edges.filter(edge => edge.from === 'app.c::local' && edge.kind !== 'var').map(edge => edge.callee), ['Later']);
});
