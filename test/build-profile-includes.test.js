import { externalDependenciesCurrent } from '../src/core/parsers/clang-config.js';
import { discoverBuildProfiles, materializeCompileCommands } from '../src/core/build-config.js';
import { resolveBuildProfileOptions } from '../src/core/build-profile-options.js';
import { scanSources } from '../src/core/index.js';
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
