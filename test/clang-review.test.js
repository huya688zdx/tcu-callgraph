import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareProjects } from '../src/core/compare.js';
import { buildIndex } from '../src/core/index.js';
import { detectClang } from '../src/core/parsers/clang-parser.js';
import { taskPeriods } from '../src/core/task-periods.js';

const clang = detectClang();
const requiresClang = { skip: clang.ok ? false : clang.reason };
const options = { parserId: 'clang-ast' };

function project(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-clang-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.c'), source);
  return root;
}

function compare(t, before, after) {
  return compareProjects(project(t, before), project(t, before), project(t, after), options);
}

test('Clang 比较 sizeof 类型操作数的改变，并传播至写入变量和读取者', requiresClang, async t => {
  const before = 'int g; void write(void) { g = sizeof(int); } int read(void) { return g; }';
  const result = await compare(t, before, before.replace('sizeof(int)', 'sizeof(long long)'));
  for (const id of ['var::g', 'main.c::read']) {
    assert.ok(result.model._index.byId.get(id).impactChainIds.includes('main.c::write'), id);
  }
});

test('Clang 将显式、隐式枚举值的变化连接到使用者，保留未使用的变更点', requiresClang, async t => {
  const before = `enum { SCALE = 1, NEXT, UNUSED = 20 };
int g, initial = NEXT;
void write(void) { g = SCALE; }
int read(void) { return g; }
int shadow(void) { enum { SCALE = 7 }; return SCALE; }`;
  const result = await compare(t, before, before.replace('SCALE = 1', 'SCALE = 2').replace('UNUSED = 20', 'UNUSED = 21'));
  const points = result.changePoints.filter(p => p.kind === 'enum');
  const scale = points.find(p => p.name === 'SCALE');
  assert.deepEqual([scale?.beforeValue, scale?.afterValue], ['1', '2']);
  assert.deepEqual(scale.affectedIds.toSorted(), ['main.c::write', 'var::g', 'main.c::read'].sort());
  assert.deepEqual(points.find(p => p.name === 'NEXT')?.affectedIds, ['var::initial']);
  assert.deepEqual(points.find(p => p.name === 'UNUSED')?.affectedIds, []);
  assert.equal(result.model._index.byId.get('main.c::shadow').impact, false);
  assert.equal(result.model._index.byId.get('main.c::write').macroImpact, false);
});

test('Clang 区分同一头文件的枚举值在两个编译单元之间对调', requiresClang, async t => {
  const source = (name, value) => `#define INPUT ${value}\n#include "scale.h"\nint ${name}(void) { return SCALE; }`;
  const base = project(t, source('first', 1)), before = project(t, source('first', 1)), after = project(t, source('first', 2));
  fs.writeFileSync(path.join(base, 'scale.h'), 'enum { SCALE = INPUT };');
  for (const [dir, value] of [[base, 2], [before, 2], [after, 1]]) {
    fs.writeFileSync(path.join(dir, 'second.c'), source('second', value));
  }
  const { changePoints } = await compareProjects(base, before, after, options);
  const scale = changePoints.find(p => p.kind === 'enum' && p.name === 'SCALE');
  assert.deepEqual([scale?.beforeValue, scale?.afterValue], ['main.c=1 / second.c=2', 'main.c=2 / second.c=1']);
  assert.deepEqual(scale.affectedIds.sort(), ['main.c::first', 'second.c::second']);
});

test('Clang 按各自声明符比较全局变量，保留共用类型和存储说明', requiresClang, async t => {
  const before = `static int *a[2] = { 0, 0 }, b __attribute__((aligned(8), used)) = 2, (*c)(int, int);
int read_b(void) { return b; }`;
  const { model, changePoints } = await compare(t, before, before.replace('*a[2] = { 0, 0 }', '*a[3] = { 0, 0, 0 }'));
  assert.deepEqual(changePoints.map(p => p.name), ['a']);
  assert.equal(model._index.byId.get('main.c::read_b').impact, false);
  assert.match(model._index.byId.get('var::main.c::b').sourceText, /^static int\s+b __attribute__\(\(aligned\(8\), used\)\) = 2$/);
  assert.match(model._index.byId.get('var::main.c::c').sourceText, /^static int\s+\(\*c\)\(int, int\)$/);
  const shared = await compare(t, before, before.replace('static int', 'static long'));
  assert.deepEqual(shared.changePoints.filter(p => p.kind === 'variable').map(p => p.name).sort(), ['a', 'b', 'c']);
  const withAttribute = 'int a __attribute__((aligned(8), used)), b = 2;';
  const attr = await compare(t, withAttribute, withAttribute.replace('aligned(8)', 'aligned(16)'));
  assert.equal(attr.model._index.byId.get('var::b').change, 'existing');
});

test('Clang 的同一行两个调用点不构成每轮一次的计数证据', requiresClang, async t => {
  const body = 'void Work(void) {} void bump(void) { static unsigned count; if (++count >= 10) { count = 0; Work(); } }';
  for (const [calls, expected] of [['bump(); bump();', 1000], ['bump();', 10000]]) {
    const model = await buildIndex(project(t, body + ' void Task1ms(void) { ' + calls + ' }'), options);
    const [work] = taskPeriods(model).get('main.c::Work');
    assert.equal(work.us, expected);
    assert.equal(Boolean(work.dividers), expected === 10000);
  }
});

test('Clang 保留指针加减的基对象，并区分整数偏移与指针差', requiresClang, async t => {
  const source = `int a[8], b[8], offset;
void set(int *p) { *p = 4; }
void direct(void) { *(a + offset) = 1; *(offset + b) = 2; }
void pass(void) { set((a + 5) - offset); }
void difference(void) { *(b + (&a[1] - &a[0])) = 3; }
int read(void) { return b[1]; }`;
  const model = await buildIndex(project(t, source), options);
  const writes = name => [...model._df.fnAccess.get('main.c::' + name).writes.keys()].sort();
  assert.deepEqual(writes('direct'), ['var::a', 'var::b']);
  assert.deepEqual(writes('set'), ['var::a']);
  assert.deepEqual(writes('difference'), ['var::b']);
  assert.ok(model._df.fnAccess.get('main.c::direct').reads.has('var::offset'));
  const result = await compare(t, source, source.replace('= 2;', '= 7;'));
  assert.ok(result.model._index.byId.get('main.c::read').impactChainIds.includes('main.c::direct'));
});

test('Clang 通过内层声明字段归集回调，隔离同名字段及外层回调', requiresClang, async t => {
  const dir = project(t, [
    '#include "nested.h"',
    'typedef struct { struct { Fn run; } inside; } Anonymous;',
    'struct Local { Fn run; };',
    'void nested(void) {} void outer(void) {} void different(void) {} void item(void) {}',
    'static Outer holder = { .inner = { .run = nested, .slots = { item, nested } }, .run = outer };',
    'static Other unrelated = { .run = different };',
    'static Anonymous unnamed = { .inside.run = item };',
    'static struct Local local = { outer };',
    'void anon_call(Anonymous *p) { p->inside.run(); }',
    'void local_call(struct Local *p) { p->run(); }',
    'void shadow(void) { struct Local { Fn other; } s; }',
    'void inner_call(Outer *p) { p->inner.run(); }',
    'void outer_call(Outer *p) { p->run(); }',
    'void other_call(Other *p) { p->run(); }',
    'void array_call(Outer *p, int i) { p->inner.slots[i](); }',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'nested.h'), [
    'typedef void (*Fn)(void);', 'typedef struct { Fn run; Fn slots[2]; } Inner;',
    'typedef struct { Inner inner; Fn run; } Outer;', 'typedef struct { Fn run; } Other;',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'other.c'), [
    '#include "nested.h"', 'struct Local { Fn run; }; extern void different(void);',
    'static struct Local local = { different };',
    'void foreign_call(struct Local *p) { p->run(); }',
    'void shared_call(Outer *p) { p->inner.run(); }',
  ].join('\n'));
  for (const policy of ['expand', 'strict']) {
    const model = await buildIndex(dir, { ...options, parserOptions: { dispatchPolicy: policy } });
    for (const [fn, expected] of [['main.c::inner_call', ['nested']], ['main.c::outer_call', ['outer']],
      ['main.c::other_call', ['different']], ['main.c::array_call', ['item', 'nested']], ['main.c::anon_call', ['item']],
      ['main.c::local_call', ['outer']], ['other.c::foreign_call', ['different']], ['other.c::shared_call', ['nested']]]) {
      const site = model.indirectCalls.find(s => s.caller === fn);
      assert.deepEqual(site?.candidates.map(c => c.name).sort(), expected, fn);
      assert.equal(site.resolution, policy === 'strict' ? 'unresolved' : 'possible');
    }
  }
});

test('Clang 下标只采信整个表达式的常量值，保留窄化转换', requiresClang, async t => {
  const dir = project(t, [
    'typedef void (*Fn)(void); void good(void) {} void wrong(void) {}',
    'static Fn const slots[] = { [1] = good, [257] = wrong };',
    'void narrowed(void) { slots[(unsigned char)257](); }',
    'void literal(void) { slots[1](); }',
    'static Fn const small[] = { wrong, wrong, good };',
    'void shifted(void) { small[(0x80000000u >> 31) + 1](); }',
  ].join('\n'));
  for (const parserId of ['builtin', 'clang-ast']) {
    const model = await buildIndex(dir, { parserId, parserOptions: { dispatchPolicy: 'strict' } });
    const exact = name => (model._index.outAdj.get('main.c::' + name) || [])
      .filter(e => e.kind === 'fnptr' && e.resolution === 'exact').map(e => e.to);
    assert.deepEqual(exact('literal'), ['main.c::good']);
    for (const fn of ['narrowed', 'shifted']) {
      const targets = exact(fn);
      if (targets.length) assert.deepEqual(targets, ['main.c::good'], parserId + ' ' + fn);
      else assert.ok(model.indirectCalls.some(s => s.caller === 'main.c::' + fn), parserId + ' ' + fn);
    }
  }
});

test('Clang 下标写入与调用对称匹配，保留不同层级、字段和对象的边界', requiresClang, async t => {
  const dir = project(t, [
    'typedef void (*Fn)(void); typedef struct { Fn fn[2]; Fn spare; } Row;',
    'void a(void) {} void b(void) {} void c(void) {} void d(void) {}',
    'static Row rows[2] = { {{a,b}, d}, {{b,b}, d} };',
    'static Row other[1] = { {{d,d}, d} }; static Fn bare[2];',
    'void change(int i) { rows[i].fn[0] = c; bare[i] = c; }',
    'void constant(void) { rows[0].fn[0](); } void dynamic(int j) { rows[1].fn[j](); }',
    'void apart(void) { rows[0].fn[1](); } void sibling(void) { rows[1].spare(); }',
    'void separate(void) { other[0].fn[0](); } void uninitialized(void) { bare[0](); }',
    'void bare_other(void) { bare[1](); } void parameter(Row *p) { p->fn[1](); }',
  ].join('\n'));
  for (const policy of ['strict', 'expand']) {
    const model = await buildIndex(dir, { ...options, parserOptions: { dispatchPolicy: policy } });
    for (const [name, expected] of [['constant', ['a','c']], ['dynamic', ['b','c']], ['apart', ['b']],
      ['sibling', ['d']], ['separate', ['d']], ['uninitialized', ['c']], ['bare_other', ['c']], ['parameter', ['b','d']]]) {
      const caller = 'main.c::' + name;
      const site = model.indirectCalls.find(s => s.caller === caller);
      assert.deepEqual(site?.candidates.map(c => c.name).sort(), expected, policy + ' ' + name);
      assert.equal((model._index.outAdj.get(caller) || []).some(e => e.kind === 'fnptr' && e.resolution === 'exact'), false);
    }
  }
});

test('Clang 局部回调表采用声明身份和词法作用域，同名对象、类型和函数互不串线', requiresClang, async t => {
  const dir = project(t, [
    'typedef void (*Fn)(void); struct Ops { Fn run; };',
    'void a(void) {} void b(void) {} void c(void) {} void unused(void) {}',
    'static const struct Ops global = { unused };',
    'void one(int i) {',
    '  struct Ops row = {a}; row.run();',
    '  { struct Ops { Fn other; Fn run; }; const struct Ops row = {unused, b}; row.run(); }',
    '  row.run(); const Fn slots[] = {a, b}; slots[1](); slots[i]();',
    '}',
    'void two(void) { struct Ops row = {c}; row.run(); }',
    'void typed(void) { typedef struct { Fn run; } Local; Local local = {b}; Local *p = &local; p->run(); }',
    'void untouched(void) { struct Blank { Fn run; }; struct Blank *p = 0; if (p) p->run(); }',
    'void empty_table(void) { Fn slots[2] = {0}; if (slots[0]) slots[0](); }',
    'void empty_row(void) { struct Ops row = {0}; if (row.run) row.run(); }',
    'void caller_a(struct Ops *p) { struct Ops local = {a}; p->run(); }',
    'void caller_b(struct Ops *p) { struct Ops local = {b}; p->run(); }',
    'void blocks(struct Ops *p) { { struct Ops local = {a}; p->run(); } { struct Ops local = {b}; p->run(); } }',
  ].join('\n'));
  for (const policy of ['strict', 'expand']) {
    const model = await buildIndex(dir, { ...options, parserOptions: { dispatchPolicy: policy } });
    const calls = name => {
      const id = 'main.c::' + name;
      const exact = (model._index.outAdj.get(id) || []).filter(e => e.kind === 'fnptr' && e.resolution === 'exact')
        .map(e => ({ line: e.line, col: e.col, targets: [e.callee], resolution: 'exact' }));
      return [...exact, ...model.indirectCalls.filter(s => s.caller === id)
        .map(s => ({ line: s.line, col: s.col, targets: s.candidates.map(c => c.name).sort(), resolution: s.resolution }))]
        .sort((a,b) => a.line-b.line || a.col-b.col);
    };
    assert.deepEqual(calls('one').map(c => c.targets), [['a'], ['b'], ['a'], ['b'], ['a','b']], policy);
    assert.deepEqual(calls('one').map(c => c.resolution === 'exact'), [false, true, false, true, false]);
    assert.deepEqual(calls('two').map(c => c.targets), [['c']]);
    assert.deepEqual(calls('typed').map(c => c.targets), [['b']]);
    for (const name of ['untouched', 'empty_table', 'empty_row']) {
      assert.deepEqual(calls(name).map(c => c.targets), [[]], name);
    }
    assert.deepEqual(calls('caller_a').map(c => c.targets), [['a','unused']]);
    assert.deepEqual(calls('caller_b').map(c => c.targets), [['b','unused']]);
    assert.deepEqual(calls('blocks').map(c => c.targets), [['a','unused'], ['b','unused']]);
    assert.ok(model.fnptrTables.every(table => table.name !== 'row' && table.name !== 'slots'));
  }
});

test('Clang 聚合复制按复制时的声明和成员解析回调', requiresClang, async t => {
  const dir = project(t, [
    'typedef void (*Fn)(void); typedef struct { Fn run; Fn slots[2]; } Ops;',
    'typedef struct { Ops rows[2]; } Group;',
    'void alpha(void) {} void beta(void) {} void noise(void) {}',
    'static const Ops original = {alpha, {beta, alpha}}, other = {beta, {alpha, beta}}, unrelated = {noise, {noise, noise}};',
    'static const Group group = {{{alpha,{beta,alpha}}, {beta,{alpha,beta}}}};',
    'Ops unknown(void);',
    'void declare(void) { const Ops copy = original; copy.run(); copy.slots[0](); }',
    'void assign(void) { Ops copy = unrelated; copy = original; copy.run(); }',
    'void chain(void) { Group g = group; Ops row = g.rows[1]; Ops next; next = row; next.slots[0](); }',
    'void member(void) { Group g = {0}; g.rows[1] = original; g.rows[1].run(); g.rows[0].run(); }',
    'void designated(void) { Group g = {.rows = {original, other}}; g.rows[1].slots[0](); }',
    'void choose(int n) { const Ops copy = n ? original : other; copy.run(); }',
    'void partial(int n) { const Ops copy = n ? original : unknown(); copy.run(); }',
    'void overwrite(void) { Ops copy = original; copy = unknown(); copy.run(); }',
    'void branch(int n) { Ops copy = original; if(n) copy = other; copy.run(); }',
    'void snapshots(void) { Ops src = original; src.run = beta; Ops dst = src; src.run = noise; dst.run(); dst.run = alpha; src.run(); dst.run(); }',
    'void sparse(void) { Ops c = original; int slots[] = {[3] = (c.run(), 0)}; }',
    'void chain_assign(void) { Ops a,b; a = b = original; b = other; a.run(); b.run(); }',
    'void loop(int n) { Ops x = original; while(n--) { Ops dst = x; dst.run(); x = other; } }',
    'void branches(int n) { Ops c = unrelated; if(n) { c = original; c.run(); } else { c = other; c.run(); } }',
    'void jump(void) { Ops c = original; goto done; c = unrelated; done: c.run(); }',
    'void dynamic(int i) { Group g = group; g.rows[i] = original; g.rows[1].run(); }',
    'void literal(int n) { Ops x = n ? (Ops){beta,{alpha,beta}} : original; x.run(); x = (Ops){alpha,{beta,beta}}; x.slots[1](); }',
    'void unknownptr(Ops *p) { Ops dst = *p; dst.run(); }',
    'void again(void) { Ops dst = original; dst = dst; dst.run(); }',
    'void shadow(void) { Ops src = original; { Ops src = other; Ops copy = src; copy.run(); } Ops copy = src; copy.run(); }',
    'void isolated(void) { Ops src = unrelated; Ops copy = src; copy.run(); }',
  ].join('\n'));
  for (const policy of ['strict', 'expand']) {
    const m = await buildIndex(dir, { ...options, parserOptions: { dispatchPolicy: policy } });
    for (const [caller, expected] of Object.entries({
      declare: [['alpha'], ['beta']], assign: [['alpha']], chain: [['alpha']],
      member: [['alpha'], []], designated: [['alpha']], choose: [['alpha', 'beta']],
      partial: [['alpha']], overwrite: [[]], branch: [['alpha', 'beta']],
      sparse: [['alpha']], chain_assign: [['alpha'], ['beta']], loop: [['alpha','beta']], branches: [['alpha'], ['beta']], jump: [[]],
      dynamic: [['alpha','beta']], literal: [['alpha','beta'], ['beta']], unknownptr: [[]], again: [['alpha']],
      snapshots: [['beta'], ['noise'], ['alpha']], shadow: [['beta'], ['alpha']], isolated: [['noise']],
    })) await t.test(policy + ' ' + caller, () => {
      const id = 'main.c::' + caller;
      const sites = m.indirectCalls.filter(s => s.caller === id).sort((a, b) => a.line - b.line || a.col - b.col);
      assert.deepEqual(sites.map(s => s.candidates.map(c => c.name).sort()), expected);
      assert.deepEqual(sites.map(s => s.resolution), expected.map(c => policy === 'expand' && c.length ? 'possible' : 'unresolved'));
      const edges = (m._index.outAdj.get(id) || []).filter(e => e.kind === 'fnptr' && !e.to.startsWith('ext::'));
      assert.ok(edges.every(e => e.resolution === 'possible'));
      assert.deepEqual([...new Set(edges.map(e => e.callee))].sort(), policy === 'strict' ? [] : [...new Set(expected.flat())].sort());
    });
  }
});
