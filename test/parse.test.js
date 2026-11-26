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

  // 动态下标不盲目画死所有候选，而是在 indirectCalls 保留完整候选供 LLM 判断
  assert.equal(out('a.c::call_dyn').length, 0);
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
  assert.deepEqual(calls('app.c::dispatch'), ['next', 'column']);
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
enum { ENUM_SLOT = 2 };
static const Fn uncertain[4] = { [ENUM_SLOT] = target, other };
void unknown(void) { uncertain[0](); }
`);
  fs.writeFileSync(path.join(dir, 'b.c'), `
typedef void (*Fn)(void);
extern const Fn table[4];
static void target(void) {}
#define INDEX 2
void call_sites(void) { table[INDEX](); table[3](); target(); }
`);
  const model = loadModel(dir);
  const calls = id => (model._index.outAdj.get(id) || []).filter(edge => edge.kind !== 'var');
  assert.deepEqual(calls('b.c::call_sites').map(edge => edge.to), ['a.c::target', 'a.c::other', 'b.c::target']);
  assert.deepEqual(calls('a.c::unknown'), []);
  const table = model.fnptrTables.find(table => table.name === 'uncertain');
  assert.equal(table.incomplete, true);
  assert.deepEqual(table.map, { '[?ENUM_SLOT]': 'target', '[?ENUM_SLOT+1]': 'other' });
  const site = model.indirectCalls.find(call => call.caller === 'a.c::unknown');
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
  const targets = name => (model._index.outAdj.get('app.c::' + name) || [])
    .filter(edge => edge.kind !== 'var').map(edge => edge.to);
  assert.deepEqual(targets('constant'), ['app.c::local', 'ext::external', 'ext::api']);
  assert.deepEqual(targets('dynamic'), []);
  assert.deepEqual(targets('partial'), ['app.c::local', 'ext::inside']);
  assert.deepEqual(targets('shadow'), ['ext::external']);
  const candidates = table => model.indirectCalls.find(call => call.receiver === table)?.candidates.map(c => c.id);
  assert.deepEqual(candidates('dispatch'), ['app.c::local', 'ext::external', 'ext::api']);
  assert.deepEqual(candidates('library'), ['ext::api', 'ext::api_only']);
  assert.deepEqual(candidates('mixed'), ['app.c::local', 'ext::inside']);
  assert.deepEqual(candidates('single'), ['app.c::local']);
  assert.ok(model.externals.some(node => node.id === 'ext::api_only'));
  assert.ok(!model.fnptrTables.some(table => ['data', 'values'].includes(table.name)));
});
