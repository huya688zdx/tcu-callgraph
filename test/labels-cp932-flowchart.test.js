import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeLabel, displayEdgeLabels } from '../src/core/labels.js';
import { decodeSource } from '../src/core/source-files.js';
import { readScheduleFiles } from '../src/core/tcu-schedule.js';
import { diffFlowchartNodes } from '../src/core/flowchart.js';

test('コール順（call）标签严禁携带任何注释（手写与自动生成均剥离 note）', () => {
  const manual = normalizeLabel({ preset: 'call', text: 'コール順1', note: '不应出现的注释' });
  assert.equal(manual.text, 'コール順1');
  assert.equal(manual.note, undefined, 'call 标签不应保留 note');

  const task = normalizeLabel({ preset: 'task', text: 'TASK:10ms', note: 'main.c:10' });
  assert.equal(task.note, 'main.c:10', 'task 标签仍允许保留简短依据');

  const auto = displayEdgeLabels(
    { from: 'a.c::A', to: 'a.c::B', kind: 'direct', line: 10, callNumbers: ['1'], versions: ['after'] },
    [],
    'a.c::A',
  );
  assert.equal(auto.length, 1);
  assert.equal(auto[0].text, 'コール順1');
  assert.equal(auto[0].note, undefined, '自动生成的 コール順 标签不得附加 修改前/修改后 注释');
});

test('CP932 源码与 OIL 调度文件解码不出现替换乱码', () => {
  // CP932 字节：「/* テスト */」
  const cp932Bytes = Buffer.from([
    0x2f, 0x2a, 0x20, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x20, 0x2a, 0x2f, 0x0a,
    ...Buffer.from('TASK Task_10ms { CYCLETIME = 10; };\n', 'ascii'),
  ]);
  const decoded = decodeSource(cp932Bytes);
  assert.ok(decoded.includes('テスト'), `CP932 日文注释应正确解码，实际=${decoded}`);
  assert.ok(!decoded.includes('\uFFFD'), '不得包含替换乱码字符');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cp932-oil-'));
  try {
    const oilPath = path.join(tmp, 'app.oil');
    fs.writeFileSync(oilPath, cp932Bytes);
    const res = readScheduleFiles(new Map([['app.oil', oilPath]]));
    assert.equal(res.warnings.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('diffFlowchartNodes 按调用关系图分类准确区分 existing / modified / added', () => {
  const before = [
    { kind: 'start', code: 'start' },
    { kind: 'process', code: 'x = 1;' },
    { kind: 'decision', code: 'a > 0' },
    { kind: 'end', code: 'end' },
  ];
  const after = [
    { kind: 'start', code: 'start' },
    { kind: 'process', code: 'x = 2;' },
    { kind: 'call', code: 'log_change();' },
    { kind: 'decision', code: 'a > 0' },
    { kind: 'end', code: 'end' },
  ];
  const statuses = diffFlowchartNodes(after, before, 'after');
  assert.deepEqual(statuses, ['existing', 'modified', 'added', 'existing', 'existing']);
});
