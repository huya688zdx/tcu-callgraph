import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModel } from '../src/core/index.js';

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
  const model = loadModel(dir);
  const resolved = name => (model._index.outAdj.get('app.c::' + name) || [])
    .filter(edge => edge.kind === 'fnptr').map(edge => edge.via);
  const unresolved = name => model.indirectCalls.filter(site => site.caller === 'app.c::' + name)
    .map(site => site.expr);
  assert.deepEqual(resolved('dispatch'), ['table[1]']);
  assert.deepEqual(unresolved('dispatch'), ['table[0]']);
  assert.deepEqual(resolved('call'), ['rows[0].stop', 'shared[0]']);
  assert.deepEqual(unresolved('call'), ['rows[0].run', 'shared[1]']);
  assert.deepEqual(resolved('local'), ['table[0]']);
  assert.deepEqual(unresolved('local'), ['table[1]']);
  for (const name of ['alias', 'address']) {
    assert.deepEqual(resolved(name), []);
    assert.deepEqual(unresolved(name), ['slots[0]']);
  }
  const candidates = name => model.indirectCalls.find(site => site.caller === 'app.c::' + name).candidates;
  assert.deepEqual(candidates('dispatch'), []);
  assert.deepEqual(candidates('dynamic').map(candidate => candidate.slot), ['[1]']);
});

test('下标可能命中未解析的初始化值时保留间接调用，已知位置仍能直连', t => {
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
  const model = loadModel(dir);
  const targets = name => (model._index.outAdj.get('dispatch.c::' + name) || [])
    .filter(edge => edge.kind === 'fnptr').map(edge => edge.callee);
  assert.deepEqual(targets('uncertain'), []);
  assert.deepEqual(targets('known'), ['a', 'a', 'b']);
  assert.deepEqual(targets('members'), ['a']);
  assert.deepEqual(model.indirectCalls.find(site => site.receiver === 'entries').candidates.map(c => c.name), ['a']);
  const sites = model.indirectCalls.filter(site => site.caller === 'dispatch.c::uncertain');
  assert.deepEqual(sites.map(site => site.candidates.map(c => c.name)), [['a'], [], ['a'], []]);
  assert.deepEqual(model.fnptrTables.find(t => t.name === 'overrides').map, { '[1]': 'b' });
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
enum { WIDTH = 2 };
static Fn unknown[][WIDTH] = {a, b, c, [2] = {d}};
static Fn rows[][WIDTH] = {{a}, {b, c}};
void call(void) {
  flat[1][0](); mixed[0][0](); mixed[1][1](); mixed[2][0]();
  designated[1][1][0](); designated[2][0][0](); designated[3][0][0]();
  rows[1][1](); unknown[1][0]();
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
  assert.deepEqual(targets.map(edge => edge.callee), ['c', 'a', 'c', 'd', 'b', 'd', 'a', 'c']);
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
  const model = loadModel(dir);
  const edges = model._index.outAdj.get('ops.c::call').filter(edge => edge.kind === 'fnptr');
  assert.deepEqual(edges.map(edge => edge.callee), ['foo', 'keep']);
  assert.equal(model.indirectCalls.filter(call => call.caller === 'ops.c::call').length, 1);
});
