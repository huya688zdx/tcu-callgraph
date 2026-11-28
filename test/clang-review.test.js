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
      sparse: [['alpha']], chain_assign: [['alpha'], ['beta']], loop: [['alpha','beta']], branches: [['alpha'], ['beta']], jump: [['alpha']],
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

test('Clang 按调用点和子对象保留传址写入的回调候选', requiresClang, async t => {
  const dir = project(t, `typedef void (*Fn)(void);
typedef struct { Fn run; Fn slots[2]; } Ops;
typedef struct { Ops rows[2]; } Group;
void first(void) {} void second(void) {} void noise(void) {}
void init(Ops *p) { p->run = second; p->slots[0] = second; }
void set_slot(Fn *p) { *p = second; }
void via_index(Ops *p) { p[0].run = second; }
void next_index(Ops *p) { p[1].run = second; }
void any_index(Ops *p, int i) { p[i].run = second; }
void cast_write(const Ops *p) { ((Ops *)p)->run = second; }
void forward(Ops *p) { p->slots[0] = first; init(p); }
void noop(Ops *p) { (void)p->run; }
void opaque(Ops *);
void inspect(const Ops *p) { (void)p->run; }
void calls(void) {
  Ops local = {first, {first,first}}, sibling = {noise, {noise,noise}};
  local.run(); init(&local); local.run(); sibling.run(); local.slots[0](); local.slots[1]();
}
void nested(void) {
  Group g = {{{first,{first,first}}, {noise,{noise,noise}}}};
  init(&g.rows[0]); g.rows[0].run(); g.rows[1].run();
}
void address(void) {
  Ops local = {first}; inspect(&local); (void)sizeof((init(&local), 0));
  (void)(&local != 0); local.run(); set_slot(&local.run); local.run();
}
void alias(void) { Ops s = {first}; Ops *p = &s; init(p); s.run(); }
void alias_later(void) { Ops s = {first}; Ops *p = &s; s.run = first; init(p); s.run(); }
void boundaries(void) { Ops s = {first}; noop(&s); s.run(); opaque(&s); s.run(); }
void forwarding(void) { Ops s = {first}; forward(&s); s.run(); }
void indexed(void) { Ops rows[2] = {{first}, {noise}}; via_index(&rows[0]); rows[0].run(); rows[1].run(); }
void decay(void) { Ops rows[2] = {{first}, {noise}}; init(rows); rows[0].run(); rows[1].run();
  next_index(rows); rows[1].run(); }
void offset(int i) { Ops rows[2] = {{first}, {noise}}; next_index(&rows[0]); rows[0].run(); rows[1].run();
  any_index(&rows[0], i); rows[0].run(); }
void mutable(void) { Ops s = {first}; cast_write(&s); s.run(); }
void snapshots(void) { Ops s = {first}; Ops before = s; init(&s); Ops after = s; before.run(); after.run(); }
void branches(int n) { Ops s = {first}; if (n) init(&s); else s.run(); s.run(); }
void loop(int n) { Ops s = {first}; while (n--) { s.run(); init(&s); } }
void readonly(void) { const Ops s = {first}; inspect(&s); s.run(); }`);
  const changed = ['first', 'second'];
  for (const policy of ['expand', 'strict']) {
    const model = await buildIndex(dir, { ...options, parserOptions: { dispatchPolicy: policy } });
    for (const [name, expected] of Object.entries({
      calls: [['first'], changed, ['noise'], changed, ['first']],
      nested: [changed, ['noise']], address: [['first'], changed], alias: [changed], alias_later: [changed],
      boundaries: [['first'], changed], forwarding: [changed], indexed: [changed, ['noise']],
      offset: [['first'], ['noise','second'], changed], decay: [changed, ['noise'], ['noise','second']], mutable: [changed],
      snapshots: [['first'], changed], branches: [['first'], changed], loop: [changed],
    })) await t.test(policy + ' ' + name, () => {
      const id = 'main.c::' + name;
      const sites = model.indirectCalls.filter(s => s.caller === id).sort((a,b) => a.line - b.line || a.col - b.col);
      assert.deepEqual(sites.map(s => s.candidates.map(c => c.name).sort()), expected);
      assert.ok(sites.every(s => s.resolution === (policy === 'strict' ? 'unresolved' : 'possible')));
      const edges = (model._index.outAdj.get(id) || []).filter(e => e.kind === 'fnptr' && !e.to.startsWith('ext::'));
      assert.deepEqual(sites.map(s => edges.filter(e => e.siteId === s.siteId).map(e => e.callee).sort()),
        policy === 'strict' ? expected.map(() => []) : expected);
      assert.ok(edges.every(e => e.resolution === 'possible'));
    });
    await t.test(policy + ' readonly', () => {
      const edges = model._index.outAdj.get('main.c::readonly').filter(e => e.kind === 'fnptr');
      assert.deepEqual(edges.map(e => [e.callee, e.resolution]), [['first', 'exact']]);
    });
  }
});

test('Clang 在调用点读取标量和数组的回调值，按赋值时刻保留来源', requiresClang, async t => {
  const dir = project(t, `typedef void (*Fn)(void);
typedef struct { Fn run; Fn slots[2]; } Ops;
typedef struct { Ops rows[2]; } Group;
void first(void) {} void second(void) {} void third(void) {} void unrelated(void) {}
int different(int x) { return x; }
static int (*used)(int) = different;
static Fn const global_slots[] = {second, third};
static Fn empty;
static Fn shared = first;
Fn unknown(void); void opaque(Fn *);
void set(Fn *p) { *p = second; } void next(Fn *p) { p[1] = third; }
void supply(Fn *p, Fn src) { Fn tmp = src; *p = tmp; }
void from_local(Fn *p) { Fn f = second; *p = f; f = unrelated; }
void from_table(Fn *p) { *p = global_slots[1]; }
void assign_shared(void) { Fn f = second; shared = f; f = unrelated; }
void read_shared(void) { shared(); }
void scalar(void) { Fn other = second, cb = first; cb(); cb = other; other = third; cb(); other(); }
void spelling(void) { Fn f = first, src = second; f = src; (*f)(); }
void declaration(void) { Fn src = second, cb = src; src = unrelated; cb(); }
void chain(void) { Fn a = third, b = first, c = second; a = b = c; c = unrelated; a(); b(); }
void branches(int n) { Fn src = second, cb = first; if (n) cb = src; else cb(); cb(); }
void conditional(int n) { Fn src = second, cb = n ? src : third; src = unrelated; cb(); }
void nested(void) { Group g = {{{first,{first,second}}, {third,{third,unrelated}}}};
  Fn cb = g.rows[0].slots[1]; g.rows[0].slots[1] = unrelated;
  g.rows[1].run = cb; cb = first; g.rows[1].run(); g.rows[0].slots[1](); g.rows[0].run(); }
void subscripts(int i) { Fn slots[] = {first,second}; slots[0] = 0; Fn cb = slots[i];
  slots[1] = unrelated; cb(); slots[i](); }
void sparse(int i) { Fn slots[640] = {first}; slots[0] = 0; if (slots[i]) slots[i]();
  slots[639] = third; slots[i](); }
void lifecycle(void) { Fn f = first; f = 0; if (f) f(); Fn e = empty; if (e) e(); }
void slot_address(void) { Fn cb = first, sibling = unrelated; cb(); set(&cb); cb(); sibling(); }
void array_address(void) { Fn slots[] = {first,unrelated,first}; set(slots); next(&slots[1]);
  slots[0](); slots[1](); slots[2](); }
void nested_address(void) { Ops s = {unrelated,{first,third}}; set(s.slots); s.run(); s.slots[0](); s.slots[1](); }
void caller_offset(int i) { Fn a[] = {first,first,unrelated}; set(1 + a); a[0](); a[1](); a[2]();
  set(a + i); a[2](); }
void local_pointer(void) { Fn a[] = {first,unrelated,third}; Fn *p = &a[2] - 1;
  *p = a[2]; (*p)(); a[1](); set(p); a[0](); a[1](); }
void bound_parameter(void) { Fn f = first, src[] = {third,second}; supply(&f, src[0]); src[0] = unrelated; f(); Fn g = unrelated; supply(&g, second); g(); }
void invalidated(void) { Fn f = first; opaque(&f); f = 0; if (f) f(); }
void recurring(void) { static Fn f = first; Fn src = second; f(); f = src; }
void setter_copy(void) { Fn a = first, b = first; from_local(&a); from_table(&b); a(); b(); }
void loop(int n) { Fn cb = first, other = second; while (n--) { cb(); cb = other; } }
void shadows(void) { Fn f = first; { Fn f = unrelated, other = second; f = other; f(); } f(); }
void snapshot(void) { Fn a = first; set(&a); Fn b = a; a = 0; b(); if (a) a(); }
void generic(Fn arg, int n) { Fn f = arg; f(); f = first; f = unknown(); f(); f = n ? second : arg; f(); }
void escaping(void) { Fn f = first, untouched = third; opaque(&f); f(); untouched(); }
void static_empty(void) { if (empty) empty(); }
void exact(void) { global_slots[1](); }`);
  const both = ['first','second'], three = ['first','third'];
  const compatible = ['first','second','third','unrelated'];
  for (const policy of ['expand','strict']) {
    const model = await buildIndex(dir, { ...options, parserOptions: { dispatchPolicy: policy } });
    const expand = policy === 'expand';
    const expected = {
      scalar: [['first'], ['second'], ['third']], spelling: [['second']], declaration: [['second']], chain: [['second'], ['second']],
      branches: [['first'], both], conditional: [['second','third']], nested: [['second'], ['unrelated'], ['first']],
      subscripts: [['second'], ['unrelated']], sparse: [[], ['third']], lifecycle: [[], []], slot_address: [['first'], both, ['unrelated']],
      array_address: [both, ['unrelated'], three], nested_address: [['unrelated'], both, ['third']],
      caller_offset: [['first'], both, ['unrelated'], ['second','unrelated']], bound_parameter: [three, ['second','unrelated']],
      local_pointer: [['third'], ['third'], ['first'], ['second','third']], invalidated: [[]], recurring: [both], setter_copy: [both, three], read_shared: [both], loop: [both], shadows: [['second'], ['first']],
      snapshot: [both, []], generic: expand ? [compatible, compatible, compatible] : [[], [], ['second']],
      escaping: [expand ? compatible : ['first'], ['third']], static_empty: [[]],
    };
    for (const [name, targets] of Object.entries(expected)) await t.test(policy + ' ' + name, () => {
      const caller = 'main.c::' + name;
      const sites = model.indirectCalls.filter(s => s.caller === caller).sort((a,b) => a.line - b.line || a.col - b.col);
      assert.deepEqual(sites.map(s => s.candidates.map(c => c.name).sort()), targets);
      assert.deepEqual(sites.map(s => s.resolution), targets.map(ids => expand && ids.length ? 'possible' : 'unresolved'));
      const edges = model.edges.filter(e => e.from === caller && e.kind === 'fnptr' && !e.to.startsWith('ext::'));
      assert.deepEqual(sites.map(s => edges.filter(e => e.siteId === s.siteId).map(e => e.callee).sort()),
        expand ? targets : targets.map(() => []));
    });
    await t.test(policy + ' exact', () => {
      assert.deepEqual(model.edges.filter(e => e.from === 'main.c::exact' && e.kind === 'fnptr').map(e => [e.callee, e.resolution]), [['third', 'exact']]);
    });
  }
});

test('Clang 全局回调保留两次访问之间的被调函数写入', requiresClang, async t => {
  const root = project(t, `typedef void (*Fn)(void);
void first(void) {} void second(void) {} void third(void) {} void other(void) {}
Fn cb = third, elsewhere = other, slots[2] = {first, third};
extern void unknown_code(void);
void init(void) { cb = second; }
void recursion(int n) { if (n) recursion(n - 1); else init(); }
void assign(Fn value) { cb = value; }
void setter(Fn *p) { *p = second; }
static Fn private_cb = first;
void public_setter(void) { setter(&private_cb); }
void private_unknown(void) { private_cb = first; unknown_code(); private_cb(); }
void through_address(void) { setter(&cb); }
void inspect_address(Fn const *p) { (void)p; }
void inspect_global(void) { inspect_address(&cb); }
void type_only(void) { (void)sizeof((init(), 0)); (void)sizeof(cb = second); }
void wrapper(void) { init(); }
void harmless(void) { elsewhere = other; }
void nested_noop(void) { harmless(); }
void change_slot(void) { slots[1] = second; }
void direct(void) { cb = first; init(); cb(); }
void via_wrapper(void) { cb = first; wrapper(); cb(); }
void optional(int n) { cb = first; if (n) init(); cb(); }
void noop(void) { cb = first; nested_noop(); cb(); }
void shadow(void) { cb = first; init(); cb = third; cb(); }
void prior(void) { cb = first; cb(); init(); }
void disjoint(int n) { cb = first; if (n) { init(); } else { cb(); } }
void copy(void) { cb = first; wrapper(); Fn saved = cb; cb = other; saved(); }
void local(void) { Fn cb = first; init(); cb(); }
void sibling(void) { slots[0] = first; change_slot(); slots[0](); }
void same_slot(void) { slots[1] = first; change_slot(); slots[1](); }
void uncertain(void) { cb = first; unknown_code(); cb(); }
void reentrant(void) { cb = first; recursion(1); cb(); }
void via_arg(void) { cb = first; assign(third); cb(); }
void via_address(void) { cb = first; through_address(); cb(); }
void readonly(void) { cb = first; inspect_global(); cb(); }
void unevaluated(void) { cb = first; type_only(); cb(); }
void recovered(void) { unknown_code(); cb = first; cb(); }`);
  for (const policy of ['strict','expand']) {
    const model = await buildIndex(root, { ...options, parserOptions: { dispatchPolicy: policy } });
    const changed = ['first','second'];
    const expects = { direct: changed, via_wrapper: changed, optional: changed, noop: ['first'],
      shadow: ['third'], prior: ['first'], disjoint: ['first'], copy: changed, local: ['first'],
      sibling: ['first'], same_slot: changed, reentrant: changed, via_arg: ['first','third'],
      via_address: changed, readonly: ['first'], unevaluated: ['first'], recovered: ['first'] };
    for (const [name, targets] of Object.entries(expects)) await t.test(policy + ' ' + name, () => {
      const caller = 'main.c::' + name;
      const site = model.indirectCalls.find(s => s.caller === caller);
      assert.deepEqual(site?.candidates.map(c => c.name).sort(), targets);
      assert.equal(site.resolution, policy === 'expand' ? 'possible' : 'unresolved');
      assert.deepEqual(model.edges.filter(e => e.from === caller && e.kind === 'fnptr').map(e => e.callee).sort(),
        policy === 'expand' ? targets : []);
    });
    await t.test(policy + ' unknown', () => {
      const site = model.indirectCalls.find(s => s.caller === 'main.c::uncertain');
      assert.ok(site.candidates.some(c => c.name === 'second'), '不透明调用仍可能间接运行 init');
      assert.notEqual(site.resolution, 'exact');
      const privateSite = model.indirectCalls.find(s => s.caller === 'main.c::private_unknown');
      assert.notEqual(privateSite.resolution, 'exact');
      if (policy === 'expand') assert.ok(privateSite.candidates.some(c => c.name === 'second'),
        '不透明调用可经过对外部可见的 public_setter 间接修改内部变量');
    });
  }
});

test('Clang 保留 switch 内可达的回调赋值', requiresClang, async t => {
  const root = project(t, `typedef void (*Fn)(void);
void first(void) {} void second(void) {} void third(void) {}
void same(int n) { Fn cb=first; switch(n) { case 0: cb=second; cb(); break; default: break; } }
void separate(int n) { Fn cb=first; switch(n) { case 0: cb=second; break; case 1: cb(); break; } }
void falls(int n) { Fn cb=first; switch(n) { case 0: cb=second; default: cb(); break; } }
void defaults(int n) { Fn cb=first; switch(n) { default: {cb=third; break;} case 1: cb(); break; } }
void stacked(int n) { Fn cb=first; switch(n) { case 0: case 1: { cb=second; cb(); } break; } }
void optional(int n,int flag) { Fn cb=first; switch(n) { case 0: if(flag) cb=second; cb(); break; } }
void post(int n) { Fn cb=first; switch(n) { case 0: cb=second; break; case 1: cb=third; break; } cb(); }
void reset(int n) { Fn cb=first; switch(n) { case 0: cb=second; break; } cb=third; cb(); }
void nested(int a,int b) { Fn cb=first; switch(a) { case 0: cb=second; switch(b) {case 1: cb=third; break;}
  cb(); break; default: cb(); } }
void loop(int n,int *m) { Fn cb=first; while(n--) { switch(m[n]) { case 0: cb=second; break; case 1: cb(); } } }
void repeated_branch(int n,int *m) { Fn cb=first; while(n--) { switch(0) {case 0: if(m[n]) cb=second; else cb();} } }
void unusual(int n,int flag) { Fn cb=first; switch(n) { if(flag) { case 0: cb=second; } case 1: cb(); } }`);
  for (const policy of ['strict','expand']) {
    const model = await buildIndex(root, { ...options, parserOptions: { dispatchPolicy: policy } });
    const expected = { same: [['second']], separate: [['first']], falls: [['first','second']],
      defaults: [['first']], stacked: [['second']], optional: [['first','second']],
      post: [['first','second','third']], reset: [['third']], nested: [['second','third'], ['first']],
      loop: [['first','second']], repeated_branch: [['first','second']], unusual: [['first','second']] };
    for (const [name, targets] of Object.entries(expected)) await t.test(policy + ' ' + name, () => {
      const caller = 'main.c::' + name;
      const sites = model.indirectCalls.filter(s => s.caller === caller);
      assert.deepEqual(sites.map(s => s.candidates.map(c => c.name).sort()), targets);
      assert.ok(sites.every(s => s.resolution === (policy === 'expand' ? 'possible' : 'unresolved')));
      const edges = model.edges.filter(e => e.from === caller && e.kind === 'fnptr');
      assert.deepEqual(sites.map(s => edges.filter(e => e.siteId === s.siteId).map(e => e.callee).sort()),
        policy === 'expand' ? targets : targets.map(() => []));
    });
  }
});

async function checkCallbackFlow(t, root, cases) {
  for (const policy of ['strict', 'expand']) {
    const model = await buildIndex(root, { ...options, parserOptions: { dispatchPolicy: policy } });
    for (const [name, expected] of Object.entries(cases(policy))) await t.test(policy + ' ' + name, () => {
      const caller = 'main.c::' + name;
      const sites = model.indirectCalls.filter(s => s.caller === caller).sort((a,b) => a.line - b.line || a.col - b.col);
      assert.equal(sites.length, expected.length);
      const edges = model.edges.filter(e => e.from === caller && e.kind === 'fnptr' && !e.to.startsWith('ext::'));
      for (const [i, site] of sites.entries()) {
        const names = site.candidates.map(c => c.name).sort();
        if (Array.isArray(expected[i])) assert.deepEqual(names, expected[i]);
        else {
          for (const target of expected[i].required) assert.ok(names.includes(target), '缺少实际调用目标 ' + target);
          assert.ok(names.every(target => expected[i].allowed.includes(target)));
        }
        const emitted = edges.filter(e => e.siteId === site.siteId);
        assert.deepEqual(emitted.map(e => e.callee).sort(), policy === 'expand' ? names : []);
        assert.ok(emitted.every(e => e.resolution === 'possible'));
        assert.equal(site.resolution, policy === 'expand' && names.length ? 'possible' : 'unresolved');
      }
    });
  }
}

test('Clang 回调跟随 for 的初始化、条件、循环体和步进顺序', requiresClang, async t => {
  const root = project(t, `typedef void (*Fn)(void);
typedef struct { Fn run; } Ops;
void first(void) {} void second(void) {} void last(void) {}
void once(void) { Fn cb=first; for(int i=0; i<1; cb=second, ++i) { cb(); } }
void twice(void) { Fn cb=first; for(int i=0; i<2; cb=second, ++i) { cb(); } }
void slots(int n) { Ops ops={first}; for(; n--; ops.run=second) ops.run(); }
void in_init(int n) { Fn cb=first; for(cb(); n--; cb=second) cb(); }
void in_condition(int n) { Fn cb=first; for(; cb(), n--; cb=second) {} }
void in_step(int n) { Fn cb=first; for(; n--; cb()) { cb=second; } }
void reset_body(int n) { Fn cb=first; for(; n--; cb=last) { cb=second; cb(); } }
void initialized(int n) { Fn cb=last; for(cb=first; n--; cb=second) {} cb(); }
void nested(int n,int m) { while(n--) { Fn cb=first; for(int j=0; j<m; cb=second, ++j) cb(); } }
void skipped(int n,int flag) { Fn cb=first; for(; n--; cb()) { if(flag) continue; cb=second; } }
void missing(int n) { Fn cb=first; for(;;) { cb(); cb=second; if(!n--) break; } }
void after(int n) { Fn cb=first; for(; n--; cb=second) {} cb=last; cb(); }`);
  const both = ['first', 'second'];
  await checkCallbackFlow(t, root, () => ({
    once: [{ required: ['first'], allowed: both }], twice: [both], slots: [both],
    in_init: [['first'], both], in_condition: [both], in_step: [['second']], reset_body: [['second']],
    initialized: [both], nested: [both], skipped: [both], missing: [both], after: [['last']],
  }));
});

test('Clang 跳转控制流保留来自对应对象和槽位的可能回调', requiresClang, async t => {
  const root = project(t, `typedef void (*Fn)(void); typedef struct { Fn run; Fn slots[2]; } Ops;
void first(void) {} void second(void) {} void noise(void) {} int wrong(int n) { return n; }
static const Ops initial={first,{first,noise}}; static int (*other_signature)(int)=wrong;
extern Fn unknown(void);
void straight(void) { Ops o={first}; o.run=second; goto invoke; invoke: o.run(); }
void forward(void) { Ops o=initial; goto done; o.run=noise; done: o.run(); }
void conditional(int n) { Ops o={first,{first,noise}}; if(n) goto invoke; o.run=second; invoke: o.run(); }
void backwards(int n) { Ops o={first}; invoke: o.run(); o.run=second; if(--n) goto invoke; }
void computed(int n) { Ops o=initial; void *next=n ? &&invoke : &&change; goto *next;
  change: o.slots[0]=second; invoke: o.slots[0](); o.slots[1](); }
void copied(int n) { Ops o=initial; Fn src=second; if(n) goto done; o.run=src; done: o.run(); }
void via_case(int n) { Ops o={first}; switch(n) {
  case 0: o.run=second; goto invoke; case 1: o.run=first; invoke: o.run(); } }
static Ops global;
void set(Fn *p) { *p=second; } void change_global(void) { set(&global.run); }
void via_callee(int n) { global.run=first; if(n) goto done; change_global(); done: global.run(); }
void clear_only(int n) { Ops o={0}; if(n) goto done; o.run=0; done: if(o.run) o.run(); }
void opaque(int n) { Ops o={0}; if(n) goto done; o.run=unknown(); done: o.run(); }`);
  const both = ['first', 'second'];
  await checkCallbackFlow(t, root, policy => ({
    straight: [['second']], forward: [['first']], conditional: [both], backwards: [both],
    computed: [both, ['noise']], copied: [both], via_case: [both], via_callee: [both], clear_only: [[]],
    opaque: [policy === 'expand' ? ['first', 'noise', 'second'] : []],
  }));
});
