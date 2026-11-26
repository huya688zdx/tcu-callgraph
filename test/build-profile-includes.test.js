import { analysisSources } from '../src/core/parsers/builtin-dataflow.js';
import { readCompileCommands } from '../src/core/parsers/clang-config.js';
import { externalDependenciesCurrent } from '../src/core/parsers/clang-config.js';
import { discoverBuildProfiles, materializeCompileCommands } from '../src/core/build-config.js';
import { resolveBuildProfileOptions } from '../src/core/build-profile-options.js';
import { buildIndex, scanSources } from '../src/core/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModel } from '../src/core/index.js';
import { buildDataflowIndex } from '../src/core/dataflow.js';

test('活动编译单元按包含位置与搜索路径绑定头文件宏，调用图与数据流使用同一配置', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-includes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    const dest = path.join(root, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  };
  write('inc/start.h', '#define FORCED 1\n');
  write('inc/branch.h', `#ifndef BRANCH_H
#define BRANCH_H
#if FEATURE && BUILD && FORCED
#define RUN choose_on
#define STATE state_on
#else
#define RUN choose_off
#define STATE state_off
#endif
#endif
`);
  for (const [dir, value] of [['core0', 1], ['core1', 0]]) {
    write(dir + '/config.h', '#define FEATURE ' + value + '\n#include <branch.h>\n');
    write(dir + '/main.c', `#if FEATURE
void leaked(void) {}
#endif
#include "config.h"
int state_on, state_off;
static void choose_on(void) {}
static void choose_off(void) {}
void dispatch(void) { RUN(); STATE = 1; }
`);
  }
  write('unused/config.h', '#define FEATURE 0\nvoid unused_header(void) {}\n');
  const parse = activeFiles => loadModel(root, { parserId: 'builtin', parserOptions: {
    buildProfileId: 'test', defines: ['BUILD=1'], includeDirs: [path.join(root, 'inc')],
    forcedIncludes: ['start.h'], activeFiles,
  } });
  for (const active of [['core0/main.c'], ['core0/main.c', 'core1/main.c']]) {
    const model = parse(active);
    assert.ok(!model.functions.some(fn => ['leaked', 'unused_header'].includes(fn.name)));
    assert.ok(!model.files.some(file => file.rel === 'unused/config.h'));
    if (active.length === 1) assert.ok(!model.files.some(file => file.rel.startsWith('core1/')));
    const flow = await buildDataflowIndex(model);
    for (const file of active) {
      const suffix = file.startsWith('core0/') ? 'on' : 'off';
      const id = file + '::dispatch';
      assert.deepEqual(model.edges.filter(e => e.from === id && e.kind === 'macro').map(e => e.to), [file + '::choose_' + suffix]);
      assert.deepEqual([...flow.fnAccess.get(id).writes.keys()], ['var::state_' + suffix]);
    }
  }
});

test('配置路径加载工程外的 SDK 头文件及嵌套包含', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sdk-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'), sdk = path.join(base, 'sdk');
  fs.mkdirSync(root); fs.mkdirSync(sdk);
  fs.writeFileSync(path.join(sdk, 'config.h'), '#include "nested.h"');
  fs.writeFileSync(path.join(sdk, 'nested.h'), '#define FEATURE 1');
  fs.writeFileSync(path.join(root, 'main.c'), '#include <config.h>\n#if FEATURE\nvoid yes(void) {}\n#else\nvoid no(void) {}\n#endif');
  const model = loadModel(root, { parserId: 'builtin', parserOptions: { buildProfileId: 'sdk', includeDirs: [sdk] } });
  assert.ok(model.functions.some(f => f.name === 'yes'));
  assert.ok(!model.functions.some(f => f.name === 'no'));
  assert.equal(externalDependenciesCurrent(model), true);
  assert.ok(model.externalDeps.some(dep => dep.file === path.join(sdk, 'nested.h')));
  fs.writeFileSync(path.join(sdk, 'nested.h'), '#define FEATURE 0\n');
  assert.equal(externalDependenciesCurrent(model), false);
  const refreshed = loadModel(root, { parserId: 'builtin', parserOptions: { buildProfileId: 'sdk', includeDirs: [sdk] } });
  assert.ok(refreshed.functions.some(f => f.name === 'no'));
  fs.unlinkSync(path.join(sdk, 'config.h'));
  assert.equal(externalDependenciesCurrent(refreshed), false);
});

test('union 省略花括号后转到下一个结构体成员', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-union-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.c'), `
void foo(void) {} void bar(void) {}
struct Ops { union { void (*a)(void); void (*b)(void); } u; void (*next)(void); };
struct Ops ops = { foo, bar };
void run(void) { ops.u.a(); ops.next(); }
`);
  const model = loadModel(root, { parserId: 'builtin' });
  const edges = model.edges.filter(e => e.from === 'main.c::run');
  assert.ok(edges.some(e => e.to === 'main.c::foo'));
  assert.ok(edges.some(e => e.to === 'main.c::bar'));
});

test('Make 不同编译单元保持各自宏环境并分别导出', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unit-flags-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n\tcc -DMODE=1 a.c\n\tcc -DMODE=2 b.c');
  for (const [name, mode] of [['a', 1], ['b', 2]]) fs.writeFileSync(path.join(root, name + '.c'),
    `#if MODE == ${mode}\nvoid ${name}_yes(void) {}\n#else\nvoid ${name}_no(void) {}\n#endif`);
  const profile = discoverBuildProfiles(root).profiles.find(p => p.source === 'makefile');
  const files = scanSources(root);
  const options = resolveBuildProfileOptions(root, 'builtin', { buildProfileId: profile.id }, files, profile);
  const model = loadModel(root, { parserId: 'builtin', parserOptions: options });
  assert.deepEqual(model.functions.map(f => f.name).sort(), ['a_yes', 'b_yes']);
  const exported = materializeCompileCommands(root, profile, { files, exportPath: 'compile_commands.json' });
  const entries = JSON.parse(fs.readFileSync(exported.compileCommandsPath, 'utf8'));
  for (const entry of entries) {
    const args = entry.arguments;
    assert.equal(args.filter(v => v === '-D').length, 1);
    assert.equal(args[args.indexOf('-D') + 1], path.basename(entry.file) === 'a.c' ? 'MODE=1' : 'MODE=2');
  }
});

test('更早的外部 include 候选出现时缓存失效', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-search-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'), a = path.join(base, 'a'), b = path.join(base, 'b');
  for (const dir of [root, a, b]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root, 'main.c'), '#include <config.h>\n#if FEATURE\nvoid yes(void) {}\n#else\nvoid no(void) {}\n#endif');
  fs.writeFileSync(path.join(b, 'config.h'), '#define FEATURE 0');
  const parse = () => loadModel(root, { parserId: 'builtin', parserOptions: { buildProfileId: 'sdk', includeDirs: [a, b] } });
  const model = parse();
  assert.equal(externalDependenciesCurrent(model), true);
  fs.writeFileSync(path.join(a, 'config.h'), '#define FEATURE 1');
  assert.equal(externalDependenciesCurrent(model), false);
  assert.ok(parse().functions.some(f => f.name === 'yes'));
});

test('枚举标量在省略括号的结构体中占一个成员', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-enum-init-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.c'), `
enum { MODE = 1 };
typedef void (*Fn)(void);
typedef struct { int mode; Fn fn; } Inner;
typedef struct { Inner inner; Fn next; int tail; } Outer;
void foo(void) {} void bar(void) {}
Outer ops = { MODE, foo, bar };
void first(void) { ops.inner.fn(); }
void second(void) { ops.next(); }
`);
  const model = loadModel(root, { parserId: 'builtin' });
  assert.ok(model.edges.some(e => e.from === 'main.c::first' && e.to === 'main.c::foo'));
  assert.ok(model.edges.some(e => e.from === 'main.c::second' && e.to === 'main.c::bar'));
  assert.ok(!model.edges.some(e => e.from === 'main.c::second' && e.to === 'main.c::foo'));
});

test('Make 响应文件参数使用编译工作目录', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rsp-cwd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'build')); fs.mkdirSync(path.join(root, 'inc'));
  fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n\tgcc @build/flags.rsp -c main.c');
  fs.writeFileSync(path.join(root, 'build/flags.rsp'), '-Iinc -include inc/config.h');
  fs.writeFileSync(path.join(root, 'inc/config.h'), '#define FEATURE 1');
  fs.writeFileSync(path.join(root, 'main.c'), '#if FEATURE\nvoid yes(void) {}\n#endif');
  const profile = discoverBuildProfiles(root).profiles[0];
  assert.deepEqual(profile.includeDirs, [path.join(root, 'inc')]);
  assert.deepEqual(profile.forcedIncludes, [path.join(root, 'inc/config.h')]);
  const files = scanSources(root);
  const model = loadModel(root, { parserId: 'builtin', parserOptions: resolveBuildProfileOptions(root, 'builtin', { buildProfileId: profile.id }, files, profile) });
  assert.ok(model.functions.some(f => f.name === 'yes'));
});

test('快照排除的工程内头文件不从工作区补回', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-excluded-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.h'), '#define FEATURE 1\nvoid leaked(void) {}');
  fs.writeFileSync(path.join(root, 'main.c'), '#include "config.h"\n#if FEATURE\nvoid yes(void) {}\n#else\nvoid no(void) {}\n#endif');
  const model = buildIndex(root, new Map([['main.c', path.join(root, 'main.c')]]), null,
    { parserId: 'builtin', parserOptions: { buildProfileId: 'snapshot' } });
  assert.deepEqual(model.functions.map(f => f.name), ['no']);
  assert.ok(!model.files.some(f => f.rel === 'config.h'));
});

test('字符数组字符串初始化不挤占后续回调', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-string-init-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.c'), `
typedef void (*Fn)(void);
typedef struct { char name[2]; Fn first; Fn second; } Ops;
void foo(void) {} void bar(void) {}
static const Ops ops = { "A", foo, bar };
void first(void) { ops.first(); }
void second(void) { ops.second(); }
`);
  const model = loadModel(root, { parserId: 'builtin' });
  assert.ok(model.edges.some(e => e.from === 'main.c::first' && e.to === 'main.c::foo'));
  assert.ok(model.edges.some(e => e.from === 'main.c::second' && e.to === 'main.c::bar'));
  assert.ok(!model.edges.some(e => e.from === 'main.c::first' && e.to === 'main.c::bar'));
});

test('模式规则候选被隔离，转义引号保留在宏值中', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-quotes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'pattern.mak'), 'all: main.o\n%.o: %.c\n\tgcc -DFEATURE=1 -c $<');
  fs.writeFileSync(path.join(root, 'Makefile'), String.raw`all:
	gcc -DCONFIG_HEADER=\"config.h\" main.c`);
  fs.writeFileSync(path.join(root, 'config.h'), '#define FEATURE 1');
  fs.writeFileSync(path.join(root, 'main.c'), '#include CONFIG_HEADER\n#if FEATURE\nvoid yes(void) {}\n#endif');
  const profiles = discoverBuildProfiles(root).profiles;
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0].defines, ['CONFIG_HEADER="config.h"']);
  const files = scanSources(root);
  const model = loadModel(root, { parserId: 'builtin', parserOptions: resolveBuildProfileOptions(root, 'builtin', { buildProfileId: profiles[0].id }, files, profiles[0]) });
  assert.ok(model.functions.some(f => f.name === 'yes'));
  const exported = materializeCompileCommands(root, profiles[0], { files, exportPath: 'compile_commands.json' });
  assert.ok(JSON.parse(fs.readFileSync(exported.compileCommandsPath, 'utf8'))[0].arguments.includes('CONFIG_HEADER="config.h"'));
});

test('普通加载读取本地 inc，快照仍不补回缺失文件', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-inc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.inc'), '#define FEATURE 1');
  fs.writeFileSync(path.join(root, 'main.c'), '#include "config.inc"\n#if FEATURE\nvoid yes(void) {}\n#else\nvoid no(void) {}\n#endif');
  const options = { parserId: 'builtin', parserOptions: { buildProfileId: 'inc' } };
  assert.ok(loadModel(root, options).functions.some(f => f.name === 'yes'));
  const snapshot = buildIndex(root, new Map([['main.c', path.join(root, 'main.c')]]), null, options);
  assert.deepEqual(snapshot.functions.map(f => f.name), ['no']);
});

test('嵌套响应文件始终相对编译目录解析', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nested-cwd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'build'));
  fs.writeFileSync(path.join(root, 'main.c'), 'int main;');
  fs.writeFileSync(path.join(root, 'build/flags.rsp'), '@nested.rsp');
  fs.writeFileSync(path.join(root, 'nested.rsp'), '-DFEATURE=1');
  const database = path.join(root, 'compile_commands.json');
  fs.writeFileSync(database, JSON.stringify([{ directory: root, file: 'main.c', arguments: ['gcc', '@build/flags.rsp', '-c', 'main.c'] }]));
  const units = readCompileCommands(root, database);
  assert.deepEqual(units[0].args, ['-D', 'FEATURE=1']);
});

test('Make 默认目标仅包含可达的生产编译单元', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-goal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'Makefile'), 'all: active.o\nactive.o: active.c\n\tcc -DPROD active.c\ndebug: debug.c\n\tcc -DDEBUG debug.c');
  for (const file of ['active.c', 'debug.c']) fs.writeFileSync(path.join(root, file), 'int value;');
  const profile = discoverBuildProfiles(root).profiles[0];
  assert.deepEqual(profile.sourceFiles, ['active.c']);
  assert.deepEqual(profile.defines, ['PROD']);
});

test('原始比较定义只包含活动分支并保留宏调用', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-raw-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.c'), '#define VALUE 42\n#if FEATURE\nint run(void) { return 999; }\n#else\nint run(void) { return VALUE; }\n#endif');
  const model = loadModel(root, { parserId: 'builtin', parserOptions: { buildProfileId: 'raw', defines: ['FEATURE=0'] } });
  const file = analysisSources(model).sources.find(f => f.rel === 'main.c');
  assert.ok(!file.src.includes('999'));
  assert.ok(file.src.includes('VALUE'));
  assert.ok(file.expanded.includes('42'));
});

test('快照配置允许活动源文件包含非独立编译的 C 文件', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unity-snapshot-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'worktree');
  const snapshot = path.join(base, 'snapshot');
  fs.mkdirSync(root);
  fs.mkdirSync(snapshot);
  fs.writeFileSync(path.join(root, 'impl.c'), 'static void diskOnly(void) {}');
  const sources = new Map(Object.entries({
    'main.c': '#include "impl.c"\nvoid run(void) { helper(); }',
    'impl.c': 'static void helper(void) {}',
    'unused.c': 'void unused(void) {}',
  }).map(([rel, text]) => {
    const file = path.join(snapshot, rel);
    fs.writeFileSync(file, text);
    return [rel, file];
  }));
  for (const activeFiles of [['main.c'], ['main.c', 'impl.c']]) {
    const model = buildIndex(root, sources, null, { parserId: 'builtin',
      parserOptions: { buildProfileId: 'unity', activeFiles } });
    assert.deepEqual(model.functions.map(fn => fn.name).sort(), ['helper', 'run']);
    assert.deepEqual(model.edges.filter(edge => edge.from === 'main.c::run').map(edge => edge.to), ['impl.c::helper']);
    assert.deepEqual(model.files.map(file => file.rel).sort(), ['impl.c', 'main.c']);
    assert.ok(analysisSources(model).sources.find(file => file.rel === 'impl.c').src.includes('helper'));
  }
});

test('共用头文件按各翻译单元保留不同的宏调用目标', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-header-invocations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'common.h'), 'static inline void invoke(void) { TARGET(); }\n');
  fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n\tcc -DTARGET=foo -c a.c\n\tcc -DTARGET=bar -c b.c\n');
  for (const [file, callee] of [['a', 'foo'], ['b', 'bar']]) {
    fs.writeFileSync(path.join(root, file + '.c'),
      'static void ' + callee + '(void) {}\n#include "common.h"\nvoid ' + file + '_caller(void) { invoke(); }');
  }
  const files = scanSources(root);
  const profile = discoverBuildProfiles(root).profiles[0];
  const options = resolveBuildProfileOptions(root, 'builtin', { buildProfileId: profile.id }, files, profile);
  const model = loadModel(root, { parserId: 'builtin', parserOptions: options });
  assert.deepEqual(model.edges.filter(edge => edge.from === 'common.h::invoke').map(edge => edge.to).sort(),
    ['a.c::foo', 'b.c::bar']);
  assert.deepEqual(model.edges.filter(edge => edge.to === 'common.h::invoke').map(edge => edge.from).sort(),
    ['a.c::a_caller', 'b.c::b_caller']);
});

test('未解析的系统头使未知宏的分支保持可见，已知构建宏仍能裁剪', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-system-header-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.c'), [
    '#include <limits.h>',
    '#if CHAR_BIT == 8', 'void narrow(void) {}', '#else', 'void wide(void) {}', '#endif',
    '#if defined(OPTIONAL_MACRO)', 'void present(void) {}', '#else', 'void absent(void) {}', '#endif',
    '#if BUILD == 1', 'void enabled(void) {}', '#else', 'void disabled(void) {}', '#endif',
  ].join('\n'));
  const model = loadModel(root, { parserId: 'builtin', parserOptions: { buildProfileId: 'system', defines: ['BUILD=1'] } });
  assert.deepEqual(model.functions.map(fn => fn.name).sort(), ['absent', 'enabled', 'narrow', 'present', 'wide']);
});

test('未知编译器内建宏保留可能分支，显式 -U 仍确定删除该宏', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-compiler-define-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.c'), [
    '#ifdef __GNUC__', 'void gcc_path(void) {}', '#else', 'void fallback_path(void) {}', '#endif',
    '#if LOCAL_DEBUG', 'void disabled(void) {}', '#endif',
  ].join('\n'));
  const parse = macroArgs => loadModel(root, { parserId: 'builtin', parserOptions: {
    buildProfileId: 'compiler', compilationUnits: { 'main.c': { defines: [], macroArgs } },
  } }).functions.map(fn => fn.name).sort();
  assert.deepEqual(parse([]), ['fallback_path', 'gcc_path']);
  assert.deepEqual(parse(['-U', '__GNUC__']), ['fallback_path']);
});
