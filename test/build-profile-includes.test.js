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
