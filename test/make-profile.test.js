import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMakefileTree } from '../src/core/build-config.js';

test('Make 仅采用编译命令实际引用的标志、工具链和源文件', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-make-recipe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['active.c', 'unused.c', 'old.c']) fs.writeFileSync(path.join(root, name), '');
  fs.writeFileSync(path.join(root, 'overrides.mk'), 'CC = gcc\nMODE = RELEASE\nSOURCES = active.c\n');
  const entry = path.join(root, 'Makefile');
  fs.writeFileSync(entry, [
    'CC = ccrh850',
    'MODE = INITIAL',
    'SNAPSHOT := -D$(MODE)',
    'CFLAGS = -DOLD',
    'CFLAGS = -D$(MODE)',
    'CFLAGS += $(SNAPSHOT)',
    'CFLAGS ?= -DIGNORED',
    'DEBUG_FLAGS = -DDEBUG',
    'UNUSED_SOURCES = unused.c',
    'SOURCES = old.c',
    'app:',
    '\t@echo $(DEBUG_FLAGS) $(UNUSED_SOURCES)',
    '\t$(CC) $(CFLAGS) -c $(SOURCES)',
    'include overrides.mk',
  ].join('\n'));
  const profile = parseMakefileTree(entry, root);
  assert.deepEqual(profile.defines, ['RELEASE', 'INITIAL']);
  assert.deepEqual(profile.sourceFiles, ['active.c']);
  assert.equal(profile.compiler, 'GCC');
});

test('Make 在读取规则时固定依赖，编译时展开标志和自动变量', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-make-prereqs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['active.c', 'other.c']) fs.writeFileSync(path.join(root, name), '');
  const entry = path.join(root, 'Makefile');
  fs.writeFileSync(entry, [
    'SOURCE := active.c',
    'app.o: $(SOURCE) ; gcc -c $< $(FLAGS)',
    'SOURCE := other.c',
    'FLAGS = -DFINAL',
  ].join('\n'));
  const profile = parseMakefileTree(entry, root);
  assert.deepEqual(profile.sourceFiles, ['active.c']);
  assert.deepEqual(profile.defines, ['FINAL']);
});
