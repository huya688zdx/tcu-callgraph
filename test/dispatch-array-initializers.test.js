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
