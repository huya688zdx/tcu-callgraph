import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModel } from '../src/core/index.js';
import { parseConstIndex } from '../src/core/extract.js';
import { lex } from '../src/core/lexer.js';

test('分派表写入后保留间接调用，未受影响的下标、字段和同名表仍可解析', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-table-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'api.h'), 'typedef void (*Fn)(void);\nextern Fn shared[2];\nvoid b(void);\n');
  fs.writeFileSync(path.join(dir, 'app.c'), `
#include "api.h"
static void a(void) {}
void b(void) {}
static Fn table[] = {a, a};
Fn shared[2] = {a, a};
typedef struct { Fn run, stop; } Ops;
static Ops rows[2] = {{.run=a,.stop=a}, {.run=a,.stop=a}};
#define UPDATE(slot, value) ((slot) = (value))
void dispatch(void) { table[0] = b; table[0](); table[1](); }
void edit(int i) { UPDATE(rows[i].run, b); }
void call(void) { rows[0].run(); rows[0].stop(); shared[0](); shared[1](); }
void shadow(Fn *table) { table[1] = b; }
void local(void) { Fn table[] = {a, a}; (table[1]) = b; table[0](); table[1](); }
void alias(void) { Fn slots[] = {a}; Fn *p = slots; *p = b; slots[0](); }
void address(void) { Fn slots[] = {a}; Fn *p = &slots[0]; *p = b; slots[0](); }
void dynamic(int i) { table[i](); }
`);
  fs.writeFileSync(path.join(dir, 'writer.c'), '#include "api.h"\nvoid edit_shared(void) { shared[1] = b; }\n');
  const strictModel = loadModel(dir, { parserOptions: { dispatchPolicy: 'strict' } });
  const strictResolved = name => (strictModel._index.outAdj.get('app.c::' + name) || [])
    .filter(edge => edge.kind === 'fnptr').map(edge => edge.via);
  const strictUnresolved = name => strictModel.indirectCalls.filter(site => site.caller === 'app.c::' + name)
    .map(site => site.expr);
  assert.deepEqual(strictResolved('dispatch'), ['table[1]']);
  assert.deepEqual(strictUnresolved('dispatch'), ['table[0]']);
  assert.deepEqual(strictResolved('call'), ['rows[0].stop', 'shared[0]']);
  assert.deepEqual(strictUnresolved('call'), ['rows[0].run', 'shared[1]']);
  assert.deepEqual(strictResolved('local'), ['table[0]']);
  assert.deepEqual(strictUnresolved('local'), ['table[1]']);
  for (const name of ['alias', 'address']) {
    assert.deepEqual(strictResolved(name), []);
    assert.deepEqual(strictUnresolved(name), ['slots[0]']);
  }
  const strictCandidates = name => strictModel.indirectCalls.find(site => site.caller === 'app.c::' + name).candidates;
  assert.deepEqual(strictCandidates('dispatch'), []);
  assert.deepEqual(strictCandidates('dynamic').map(candidate => candidate.slot), ['[1]']);

  // 默认 expand 模式：运行时赋值写入 `table[0] = b`、`table[1] = b` 等也连出候选边
  const expandModel = loadModel(dir);
  const expandTargets = name => (expandModel._index.outAdj.get('app.c::' + name) || [])
    .filter(edge => edge.kind === 'fnptr').map(edge => `${edge.via}->${edge.callee}`);
  assert.ok(expandTargets('dispatch').includes('table[0]->b'));
  assert.ok(expandTargets('call').includes('rows[0].run->b'));
  assert.ok(expandTargets('call').includes('shared[1]->b'));
  assert.ok(expandTargets('local').includes('table[1]->b'));
  assert.ok(expandTargets('dynamic').some(x => x.endsWith('->a')) && expandTargets('dynamic').some(x => x.endsWith('->b')));
});

test('下标可能命中未解析的初始化值时保留间接调用，已知位置仍能直连；expand 展开三元候选', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-unknown-target-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'dispatch.c'), `
typedef void (*Fn)(void);
static void a(void) {}
static void b(void) {}
static Fn const table[] = {a, 1 ? b : a};
static Fn const rows[2][2] = {{a, (Fn)0}, {a, 1 ? b : a}};
static Fn const overrides[] = {[0] = a, [0] = 1 ? b : a, [1] = 1 ? a : b, [1] = b};
void known(int i) { table[0](); rows[0][i](); overrides[1](); }
void uncertain(int i) { table[i](); table[1](); rows[1][i](); overrides[0](); }
typedef struct { Fn run; } Ops;
void members(int i, Ops left, Ops right) {
  Ops entries[] = {{.run = a}, i ? left : right};
  entries[i].run(); entries[0].run();
}
`);
  const model = loadModel(dir, { parserOptions: { dispatchPolicy: 'strict' } });
  const targets = name => (model._index.outAdj.get('dispatch.c::' + name) || [])
    .filter(edge => edge.kind === 'fnptr').map(edge => edge.callee);
  assert.deepEqual(targets('uncertain'), []);
  assert.deepEqual(targets('known'), ['a', 'a', 'b']);
  assert.deepEqual(targets('members'), ['a']);
  assert.deepEqual(model.indirectCalls.find(site => site.receiver === 'entries').candidates.map(c => c.name), ['a']);
  const sites = model.indirectCalls.filter(site => site.caller === 'dispatch.c::uncertain');
  assert.deepEqual(sites.map(site => site.candidates.map(c => c.name)), [['a'], [], ['a'], []]);
  assert.deepEqual(model.fnptrTables.find(t => t.name === 'overrides').map, { '[1]': 'b' });

  const expanded = loadModel(dir);
  const expTargets = name => (expanded._index.outAdj.get('dispatch.c::' + name) || [])
    .filter(edge => edge.kind === 'fnptr').map(edge => edge.callee);
  assert.ok(expTargets('uncertain').includes('a') && expTargets('uncertain').includes('b'));
});

test('用字段声明区分标量花括号和单元素数组，包括没有调用点的头文件类型', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-braced-fields-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'types.h'), `
typedef void (*Fn)(void);
typedef Fn Single[1];
typedef struct { Fn run, unused; Fn slots[1]; Single extra; void (*raw)(void); } Ops;
`);
  fs.writeFileSync(path.join(dir, 'table.c'), `
#include "types.h"
static void target(void) {}
static const Ops ops = {
  .run = {target}, .unused = {target}, .slots = {target}, .extra = {target}, .raw = {target}
};
static const Ops rows[] = {{ .run = {target} }};
struct Tagged { Ops inner; };
static const struct Tagged nested = { .inner = { .raw = {target} } };
static const struct { Fn run; Fn slots[1]; } inlined = { .run = {target}, .slots = {target} };
void call(void) { ops.run(); rows[0].run(); }
`);
  const model = loadModel(dir);
  assert.deepEqual(model.fnptrTables.find(t => t.name === 'ops').map, {
    run: 'target', unused: 'target', 'slots[0]': 'target', 'extra[0]': 'target', raw: 'target',
  });
  assert.deepEqual(model.fnptrTables.find(t => t.name === 'rows').map, { '[0].run': 'target' });
  assert.deepEqual(model.fnptrTables.find(t => t.name === 'nested').map, { 'inner.raw': 'target' });
  assert.deepEqual(model.fnptrTables.find(t => t.name === 'inlined').map, { run: 'target', 'slots[0]': 'target' });
  const calls = model._index.outAdj.get('table.c::call').filter(edge => edge.kind === 'fnptr');
  assert.deepEqual(calls.map(edge => edge.to), ['table.c::target', 'table.c::target']);
});

test('按声明的数组形状填充省略花括号的初始值和指定槽位', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-array-shape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'table.c'), `
typedef void (*Fn)(void);
void a(void) {} void b(void) {} void c(void) {} void d(void) {}
#define COLS (2)
static Fn flat[][COLS] = {a, b, c, d};
static void (*const mixed[][2])(void) = {{a}, b, {c}, {d}};
static Fn designated[4][2][2] = {[1][0][1] = a, b, c, [2] = {d}, a};
extern const int EXT_WIDTH;
static Fn unknown[][EXT_WIDTH] = {a, b, c, [2] = {d}};
enum { WIDTH = 2 };
static Fn rows[][WIDTH] = {{a}, {b, c}};
void call(void) {
  flat[1][0](); mixed[0][0](); mixed[1][1](); mixed[2][0]();
  designated[1][1][0](); designated[2][0][0](); designated[3][0][0]();
  rows[WIDTH - 1][1](); unknown[1][0]();
}
`);
  const model = loadModel(dir);
  const table = name => model.fnptrTables.find(entry => entry.name === name);
  assert.deepEqual(table('flat').map, { '[0][0]': 'a', '[0][1]': 'b', '[1][0]': 'c', '[1][1]': 'd' });
  assert.deepEqual(table('mixed').map, { '[0][0]': 'a', '[1][0]': 'b', '[1][1]': 'c', '[2][0]': 'd' });
  assert.deepEqual(table('designated').map, {
    '[1][0][1]': 'a', '[1][1][0]': 'b', '[1][1][1]': 'c', '[2][0][0]': 'd', '[3][0][0]': 'a',
  });
  assert.deepEqual(table('rows').map, { '[0][0]': 'a', '[1][0]': 'b', '[1][1]': 'c' });
  assert.equal(table('unknown').incomplete, true);
  assert.equal(table('unknown').map['[0][0]'], 'a');
  assert.equal(table('unknown').map['[2][0]'], 'd');
  const site = model.indirectCalls.find(call => call.receiver === 'unknown');
  assert.deepEqual(site.candidates.map(candidate => candidate.name), ['b', 'c']);
  const targets = model._index.outAdj.get('table.c::call').filter(edge => edge.kind === 'fnptr');
  assert.deepEqual(targets.map(edge => edge.callee), ['c', 'a', 'c', 'd', 'b', 'd', 'a', 'c', 'b', 'c']);
});

test('Problem 6：未初始化结构体/数组运行时赋值、结构体指针参数与枚举偏移分派', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-problem6-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ops.h'), `
typedef void (*Fn)(void);
typedef struct { Fn step; Fn reset; } Ops;
enum { BASE = 1, STEP = 1 };
`);
  fs.writeFileSync(path.join(dir, 'driver.c'), `
#include "ops.h"
static void fnB(void) {}
static void fnR(void) {}
static void fnD(void) {}
static void fnE(void) {}
static void fnUnused(void) {}
void (*g_other_cb)(void) = fnUnused;
static const Ops c_ops = { .step = fnE, .reset = fnR };
Ops mach;
Fn blank[4];
static const Fn enum_tbl[4] = { [BASE] = fnD, [BASE + STEP] = fnB };
void init(void) {
  mach.step = fnB;
  blank[0] = fnD;
}
void run_mach(int i) {
  mach.step();
  blank[0]();
  blank[i]();
  enum_tbl[BASE + STEP]();
}
`);
  fs.writeFileSync(path.join(dir, 'framework.c'), `
#include "ops.h"
void exec(const Ops *p) {
  p->step();
}
`);
  const model = loadModel(dir);
  const fnptrNames = id => new Set((model._index.outAdj.get(id) || [])
    .filter(e => e.kind === 'fnptr').map(e => e.callee));
  assert.deepEqual(fnptrNames('driver.c::run_mach'), new Set(['fnB', 'fnD']));
  // Typed struct pointer `p->step()` matches Ops.step without leaking fnUnused/fnR
  assert.deepEqual(fnptrNames('framework.c::exec'), new Set(['fnB', 'fnE']));
  assert.ok(!fnptrNames('framework.c::exec').has('fnUnused'));
  assert.ok(!fnptrNames('framework.c::exec').has('fnR'));

  const strict = loadModel(dir, { parserOptions: { dispatchPolicy: 'strict' } });
  const strictNames = id => (strict._index.outAdj.get(id) || [])
    .filter(e => e.kind === 'fnptr').map(e => e.callee);
  // strict 模式只保留枚举算术确定常量槽位 enum_tbl[BASE + STEP] -> fnB
  assert.deepEqual(strictNames('driver.c::run_mach'), ['fnB']);
  assert.deepEqual(strictNames('framework.c::exec'), []);
});

test('expand 模式保留同函数内调用点之后的赋值候选（覆盖循环第二轮调用）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-loop-fnptr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'loop.c'), `
typedef void (*Fn)(void);
static void first_fn(void) {}
static void second_fn(void) {}
static Fn cb_slot[1] = { first_fn };
void loop_step(void) {
  for (int i = 0; i < 2; i++) {
    cb_slot[0]();
    cb_slot[0] = second_fn;
  }
}
`);
  const expandModel = loadModel(dir);
  const targets = (expandModel._index.outAdj.get('loop.c::loop_step') || [])
    .filter(e => e.kind === 'fnptr').map(e => e.callee);
  assert.ok(targets.includes('first_fn'), 'expand 模式应保留初始目标 first_fn');
  assert.ok(targets.includes('second_fn'), 'expand 模式应包含同函数内调用之后写入的 second_fn');
});

test('标量回调在同一循环的后续迭代采用新目标，直线代码和 strict 保留原行为', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-scalar-loop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'loop.c'), [
    'typedef void (*Fn)(void);',
    'static void first(void) {} static void second(void) {} static void later(void) {}',
    'static Fn cb = first;',
    'void run(void) { cb = first; for (int i = 0; i < 2; ++i) { cb(); cb = second; } cb = later; }',
    'void once(void) { Fn local = first; local(); local = later; }',
  ].join('\n'));
  const targets = (model, name) => (model._index.outAdj.get('loop.c::' + name) || [])
    .filter(e => e.kind === 'fnptr').map(e => e.callee).sort();
  const expanded = loadModel(dir);
  assert.deepEqual(targets(expanded, 'run'), ['first', 'second']);
  assert.deepEqual(targets(expanded, 'once'), ['first']);
  const strict = loadModel(dir, { parserOptions: { dispatchPolicy: 'strict' } });
  assert.deepEqual(targets(strict, 'run'), []);
  assert.deepEqual(targets(strict, 'once'), []);
});

test('结构体成员数组在声明位置展开头文件宏，省略花括号时保留后续回调', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-member-width-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ops.h'), [
    'typedef void (*Fn)(void);',
    '#define WIDTH(n) (n)',
    'typedef struct { Fn slots[WIDTH(2)]; Fn next; } Ops;',
    '#undef WIDTH',
    '#define WIDTH(n) (1)',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'ops.c'), [
    '#include "ops.h"',
    'static void first(void) {} static void second(void) {} static void next(void) {}',
    'static const Ops ops = {first, second, next};',
    'void call(void) { ops.slots[0](); ops.slots[1](); ops.next(); }',
  ].join('\n'));
  for (const parserOptions of [{}, { buildProfileId: 'test' }]) {
    const model = loadModel(dir, { parserId: 'builtin', parserOptions });
    const edges = model._index.outAdj.get('ops.c::call').filter(edge => edge.kind === 'fnptr');
    assert.deepEqual(edges.map(edge => edge.callee), ['first', 'second', 'next']);
  }
});

test('覆盖整个结构体成员的初始化会清除被省略的旧回调', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-member-override-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ops.c'), [
    'typedef void (*Fn)(void);',
    'typedef struct { Fn a; Fn b; } Inner;',
    'typedef struct { Inner inner; Inner other; } Ops;',
    'static void foo(void) {} static void bar(void) {} static void baz(void) {}',
    'static const Ops ops = { .inner = { .a = foo, .b = bar }, .other = { .b = bar }, .inner = { .a = baz } };',
    'void call(void) { ops.inner.a(); ops.inner.b(); ops.other.b(); }',
  ].join('\n'));
  const model = loadModel(dir);
  const table = model.fnptrTables.find(entry => entry.name === 'ops');
  assert.deepEqual(table.map, { 'other.b': 'bar', 'inner.a': 'baz' });
  const edges = model._index.outAdj.get('ops.c::call').filter(edge => edge.kind === 'fnptr');
  assert.deepEqual(edges.map(edge => edge.callee), ['baz', 'bar']);
});

test('切换联合体成员会作废重叠的回调槽，保留同一成员的其他字段', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-union-override-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ops.c'), [
    'typedef void (*Fn)(void);',
    'typedef struct { union { struct { Fn x; Fn y; } pair; Fn single; } u; } Ops;',
    'static void foo(void) {} static void bar(void) {} static void baz(void) {}',
    'static const Ops switched = { .u.pair.x = foo, .u.pair.y = bar, .u.single = baz };',
    'static const Ops unchanged = { .u.pair.x = foo, .u.pair.y = bar };',
    'void call(void) { switched.u.pair.x(); switched.u.single(); unchanged.u.pair.x(); unchanged.u.pair.y(); }',
  ].join('\n'));
  const model = loadModel(dir);
  const table = name => model.fnptrTables.find(entry => entry.name === name);
  assert.deepEqual(table('switched').map, { 'u.single': 'baz' });
  assert.deepEqual(table('unchanged').map, { 'u.pair.x': 'foo', 'u.pair.y': 'bar' });
  const edges = model._index.outAdj.get('ops.c::call').filter(edge => edge.kind === 'fnptr');
  assert.deepEqual(edges.map(edge => edge.callee), ['baz', 'foo', 'bar']);
});

test('匿名聚合的初始化保持不确定，不将回调错分给后续字段', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-anonymous-member-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ops.c'), [
    'typedef void (*Fn)(void);',
    'typedef struct { union { Fn first; Fn alternate; }; Fn next; } Ops;',
    'static void foo(void) {} static void bar(void) {}',
    'static const Ops implicit = { foo };',
    'static const Ops explicit = { .alternate = foo, .next = bar };',
    'void call(void) { if (implicit.next) implicit.next(); explicit.next(); }',
  ].join('\n'));
  const model = loadModel(dir);
  const table = name => model.fnptrTables.find(entry => entry.name === name);
  assert.equal(table('implicit').incomplete, true);
  assert.equal(table('implicit').map.next, undefined);
  assert.equal(table('explicit').map.next, 'bar');
  assert.ok(!model.edges.some(edge => edge.from === 'ops.c::call' && edge.to === 'ops.c::foo'));
  const explicitCall = model.indirectCalls.find(call => call.receiver === 'explicit');
  assert.deepEqual(explicitCall.candidates.map(candidate => candidate.name), ['bar']);
});

test('运行时写入联合体其他成员会作废重叠槽，独立实例和字段不受影响', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-overlapping-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ops.c'), [
    'typedef void (*Fn)(void);',
    'typedef struct { union { Fn a; Fn b; } u; Fn next; } Ops;',
    'static void foo(void) {} static void bar(void) {} static void keep(void) {}',
    'static Ops rows[2] = { { .u = { .a = foo }, .next = keep }, { .u = { .a = foo } } };',
    'void call(void) { rows[0].u.b = bar; rows[0].u.a(); rows[1].u.a(); rows[0].next(); }',
  ].join('\n'));
  const model = loadModel(dir, { parserOptions: { dispatchPolicy: 'strict' } });
  const edges = model._index.outAdj.get('ops.c::call').filter(edge => edge.kind === 'fnptr');
  assert.deepEqual(edges.map(edge => edge.callee), ['foo', 'keep']);
  assert.equal(model.indirectCalls.filter(call => call.caller === 'ops.c::call').length, 1);
});

test('宽字符串及其拼接占用整个字符数组，后续回调保持原位置', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-wide-string-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ops.c'), [
    'typedef int wchar_t;',
    'typedef void (*Fn)(void);',
    'typedef struct { wchar_t label[2]; Fn run; Fn next; } Ops;',
    'static void foo(void) {} static void bar(void) {}',
    'static const Ops ops = { L"x" L"", foo, bar };',
    'void call(void) { ops.run(); ops.next(); }',
  ].join('\n'));
  const model = loadModel(dir);
  assert.deepEqual(model.fnptrTables.find(table => table.name === 'ops').map, { run: 'foo', next: 'bar' });
  const edges = model._index.outAdj.get('ops.c::call').filter(edge => edge.kind === 'fnptr');
  assert.deepEqual(edges.map(edge => edge.callee), ['foo', 'bar']);
});

test('无名位域不消耗初始化位置，命名位域仍消耗一个位置', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-bit-field-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ops.c'), [
    'typedef unsigned U;',
    'typedef void (*Fn)(void);',
    '#define BITS 3',
    'typedef struct { U : 0; Fn run; Fn next; } Ops;',
    'typedef struct { U : 0; U flag : BITS; Fn run; Fn next; } FlagOps;',
    'static void foo(void) {} static void bar(void) {}',
    'static const Ops ops = { foo, bar };',
    'static const FlagOps flags = { 1, foo, bar };',
    'void call(void) { ops.run(); ops.next(); flags.run(); flags.next(); }',
  ].join('\n'));
  const model = loadModel(dir);
  for (const name of ['ops', 'flags']) {
    assert.deepEqual(model.fnptrTables.find(table => table.name === name).map, { run: 'foo', next: 'bar' });
  }
  const edges = model._index.outAdj.get('ops.c::call').filter(edge => edge.kind === 'fnptr');
  assert.deepEqual(edges.map(edge => edge.callee), ['foo', 'bar', 'foo', 'bar']);
});

test('回调数组成员退化为指针传出时，只作废该数组的初始目标', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-nested-array-escape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ops.c'), [
    'typedef void (*Fn)(void);',
    'typedef struct { Fn handlers[1]; Fn intact; } Ops;',
    'static void foo(void) {} static void bar(void) {} static void keep(void) {}',
    'static Ops ops = { { foo }, keep };',
    'static void mutate(Fn *p) { p[0] = bar; }',
    'void call(void) { mutate(ops.handlers); ops.handlers[0](); ops.intact(); }',
  ].join('\n'));
  const model = loadModel(dir, { parserOptions: { dispatchPolicy: 'strict' } });
  const edges = model._index.outAdj.get('ops.c::call').filter(edge => edge.kind === 'fnptr');
  assert.deepEqual(edges.map(edge => edge.callee), ['keep']);
  const escapedCall = model.indirectCalls.find(call => call.caller === 'ops.c::call' && call.member === 'handlers');
  assert.ok(escapedCall);
  assert.deepEqual(escapedCall.candidates, []);
});

test('枚举分派按使用位置解析文件、函数与嵌套块作用域', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-enum-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a-shared.h'), '#include "z-base.h"\nenum { HEADER_SLOT = BASE };\n');
  fs.writeFileSync(path.join(dir, 'z-base.h'), 'enum { BASE = 1 };\n');
  fs.writeFileSync(path.join(dir, 'local.h'), 'enum { SLOT = 1 };\n');
  fs.writeFileSync(path.join(dir, 'scope.c'), [
    'typedef void (*Fn)(void); enum { SLOT = 0 };',
    'void first(void) {} void second(void) {}',
    'static const Fn table[] = { first, second };',
    '#define PICK SLOT', '#include "a-shared.h"',
    'void outside(void) { table[PICK](); }',
    'void shadow(void) { table[SLOT]();', '{ enum { SLOT = 1, NEXT = SLOT }; table[NEXT](); }', 'table[SLOT](); }',
    'void other(void) { enum { SLOT = 1 }; table[PICK](); }',
    'void arg(int SLOT) { table[SLOT](); }',
    'void variable(int i) { int SLOT = i; table[SLOT](); }',
    'struct Holder { enum { FIELD_SLOT = 1 } member; }; void member(void) { table[FIELD_SLOT](); }',
    'void loop(void) { for (enum { SLOT = 1 } i = 0; i < 1; ++i) table[SLOT]();', 'table[SLOT](); }',
    'void included(void) { table[HEADER_SLOT](); {', '#include "local.h"', 'table[SLOT](); }', 'table[SLOT](); }',
  ].join('\n'));
  for (const dispatchPolicy of ['strict', 'expand']) {
    for (const defines of [[], ['CONFIGURED=1']]) {
      const model = loadModel(dir, { parserOptions: { dispatchPolicy, defines } });
      const targets = name => (model._index.outAdj.get('scope.c::' + name) || [])
        .filter(e => e.kind === 'fnptr').map(e => e.callee);
      assert.deepEqual(targets('outside'), ['first']);
      assert.deepEqual(targets('shadow'), ['first', 'second', 'first']);
      assert.deepEqual(targets('other'), ['second']);
      for (const name of ['arg', 'variable']) {
        assert.equal((model._index.outAdj.get('scope.c::' + name) || []).some(e => e.kind === 'fnptr' && e.resolution === 'exact'), false);
      }
      assert.deepEqual(targets('member'), ['second']);
      assert.deepEqual(targets('loop'), ['second', 'first']);
      assert.deepEqual(targets('included'), ['second', 'second', 'first']);
    }
  }
});

test('C 整数下标按值选择槽位，宽度或符号不确定时保留间接调用', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-integer-slots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'index.c'), [
    'typedef void (*Fn)(void); void first(void) {} void second(void) {} void third(void) {}',
    'static Fn const table[] = { first, second, third };',
    '#define HIGH (0x80000000u >> 31)',
    'enum { HIGH_SLOT = HIGH + 1 };',
    'void shifted(void) { table[(0x80000000u >> 31) + 1](); }',
    'void enumerated(void) { table[HIGH_SLOT](); }',
    'void wide(void) { table[(0x100000001ULL & 0x100000000ULL) != 0](); }',
    'void signedness(void) { table[(-1 < 1u) + 1](); }',
    'void wrap(void) { table[((0u - 1u) > 1u) + 1](); }',
    'void plain(void) { table[(7 / 2) - 1](); }',
    'void uncertain(void) { table[(1u >> 32) + 1](); }',
  ].join('\n'));
  for (const policy of ['strict', 'expand']) {
    const model = loadModel(dir, { parserOptions: { dispatchPolicy: policy } });
    const exact = fn => (model._index.outAdj.get('index.c::' + fn) || [])
      .filter(e => e.kind === 'fnptr' && e.resolution === 'exact').map(e => e.callee);
    for (const [fn, target] of [['shifted', 'third'], ['enumerated', 'third'], ['wide', 'second'], ['plain', 'third']]) {
      assert.deepEqual(exact(fn), [target], fn);
    }
    for (const [fn, target] of [['signedness', 'second'], ['wrap', 'third'], ['uncertain', null]]) {
      const resolved = exact(fn);
      if (resolved.length) assert.deepEqual(resolved, target ? [target] : [], fn);
      else assert.ok(model.indirectCalls.some(site => site.caller === 'index.c::' + fn), fn);
    }
  }
});

test('C 整数下标保留可移植运算，遇到转换、溢出或不支持的字面量返回未知', () => {
  for (const [expr, value] of [['3u - 1u', 2], ['(-7 / 3) + 4', 2], ['0x100000000ULL >> 32', 1],
    ['(0x100000003ULL ^ 0x100000001ULL) | 1', 3], ["'\\02'", 2]]) {
    assert.equal(parseConstIndex(lex(expr)), value, expr);
  }
  for (const expr of ['-1u < 1', '(0xffffffffu + 1u) == 0', '(1 << 31) > 0', '1 >> 32',
    '(-2 >> 1) + 1', '(~0u) > 0', '(1 ? -1 : 1u) < 0', '9007199254740993ULL == 9007199254740992ULL',
    '1UU + 1', '1 / 0', "'A' == 65"]) {
    assert.equal(parseConstIndex(lex(expr)), null, expr);
  }
});
