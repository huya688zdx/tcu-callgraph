import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeLabel, displayEdgeLabels } from '../src/core/labels.js';
import { decodeSource } from '../src/core/source-files.js';
import { readScheduleFiles } from '../src/core/tcu-schedule.js';
import { buildIndex } from '../src/core/index.js';
import { buildFlowchart, diffFlowchartNodes, flowchartCacheHash } from '../src/core/flowchart.js';

function flowchartProject(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flowchart-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  return buildIndex(root);
}

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

test('单文件源码对照逐块标记变更，保留未变条件、调用和首尾节点', async t => {
  const helpers = 'int auditCode;\nvoid keep(int x) {}\nvoid obsolete(int x) {}\n';
  const before = `${helpers}

void run(int x) {
  keep(x);
  obsolete(x);
  x = 1;
  if (x == 0) keep(0);
}
`;
  const after = `${helpers}void run(unsigned x) {
  keep(x);
  if (x > 3) auditCode = 7;
  x = 2;
  if (x == 0) keep(0);
}
`;

  for (const [version, source, otherSourceText] of [['after', after, before], ['before', before, after]]) {
    const model = flowchartProject(t, { 'app.c': source });
    const fn = model._index.byId.get('app.c::run');
    const opts = { version, fnChange: 'modified', otherSourceText };
    assert.notEqual(flowchartCacheHash(model, fn, opts),
      flowchartCacheHash(model, fn, { ...opts, otherSourceText: otherSourceText.replace('keep(0)', 'keep(1)') }));

    const graph = await buildFlowchart(model, fn, opts);
    const byText = new Map(graph.nodes.map(node => [node.text, node.change]));
    assert.deepEqual(graph.nodes.filter(node => ['start', 'end'].includes(node.kind)).map(node => node.change),
      ['existing', 'existing']);
    for (const text of ['keep(x);', 'if (x == 0)', 'keep(0);']) assert.equal(byText.get(text), 'existing', text);
    if (version === 'after') {
      assert.equal(byText.get('x = 2;'), 'modified');
      assert.equal(byText.get('if (x > 3)'), 'added');
      assert.equal(byText.get('auditCode = 7;'), 'added');
    } else {
      assert.equal(byText.get('x = 1;'), 'modified');
      assert.equal(byText.get('obsolete(x);'), 'deleted');
    }
    for (const node of graph.nodes.filter(node => node.change !== 'modified')) {
      assert.equal(Object.hasOwn(node, 'diffLines'), false, node.text);
    }
  }
});

test('修改的判断节点在两个版本中都按修改前后顺序标记追加和替换', async t => {
  const source = (first, second) => `
void run(int a, int b, int old_flag, int new_flag) {
  if (${first}) a++;
  if (${second}) b++;
}
`;
  const before = source('a > 0', 'a > 0 && old_flag');
  const after = source('a > 0 && b == 1', 'a > 0 && new_flag');
  for (const [version, current, otherSourceText] of [['after', after, before], ['before', before, after]]) {
    const model = flowchartProject(t, { 'app.c': current });
    const fn = model._index.byId.get('app.c::run');
    const graph = await buildFlowchart(model, fn, { version, fnChange: 'modified', otherSourceText });
    const [extension, replacement] = graph.nodes.filter(node => node.kind === 'decision');
    assert.equal(extension.change, 'modified');
    assert.deepEqual(extension.diffLines, [[
      { text: 'if (a > 0', op: 'same' },
      { text: ' && b == 1', op: 'add' },
      { text: ')', op: 'same' },
    ]]);
    assert.equal(replacement.change, 'modified');
    assert.deepEqual(replacement.diffLines, [[
      { text: 'if (a > 0 && ', op: 'same' },
      { text: 'old_flag', op: 'del' },
      { text: 'new_flag', op: 'add' },
      { text: ')', op: 'same' },
    ]]);
  }
});

test('修改的长条件折行后保留标记，并按新尺寸布置节点和连线', async t => {
  const oldFlag = 'old_' + 'condition_'.repeat(5) + 'flag';
  const newFlag = oldFlag.replace('old_', 'new_');
  const condition = flag => `if (a > 0 && ${flag})`;
  const source = flag => `void run(int a, int ${flag}) { ${condition(flag)} a++; }`;
  const model = flowchartProject(t, { 'app.c': source(newFlag) });
  const fn = model._index.byId.get('app.c::run');
  const baseline = await buildFlowchart(model, fn);
  const graph = await buildFlowchart(model, fn, { fnChange: 'modified', otherSourceText: source(oldFlag) });
  const node = graph.nodes.find(node => node.kind === 'decision');
  assert.equal(node.change, 'modified');
  assert.ok(node.diffLines.length > node.lines.length);
  assert.ok(node.h > baseline.nodes.find(node => node.kind === 'decision').h);
  for (const line of node.diffLines) assert.ok(line.map(({ text }) => text).join('').length <= 46);
  const segments = node.diffLines.flat();
  const textWithout = excluded => segments.filter(({ op }) => op !== excluded).map(({ text }) => text).join('');
  assert.equal(textWithout('add'), condition(oldFlag));
  assert.equal(textWithout('del'), condition(newFlag));
  const outgoing = branch => graph.edges.find(edge => edge.from === node.id && edge.branch === branch);
  assert.deepEqual(outgoing('ON').points[0], [node.x + node.w / 2, node.y + node.h]);
  assert.deepEqual(outgoing('OFF').points[0], [node.x + node.w, node.y + node.h / 2]);
});

test('宏定义变化时，显示文字相同的修改节点没有行内标记', async t => {
  const source = value => `#define VALUE ${value}\nint run(void) { return VALUE; }\n`;
  const model = flowchartProject(t, { 'app.c': source(2) });
  const fn = model._index.byId.get('app.c::run');
  const graph = await buildFlowchart(model, fn, { fnChange: 'modified', otherSourceText: source(1) });
  const node = graph.nodes.find(node => node.text === 'return VALUE;');
  assert.equal(node.change, 'modified');
  assert.equal(Object.hasOwn(node, 'diffLines'), false);
});

test('已缓存的头文件宏等长改写后会更新缓存键和宏展开', async t => {
  const model = flowchartProject(t, {
    'app.c': '#include "config.h"\nint run(void) { return VALUE; }\n',
    'config.h': '#define VALUE 10\n',
  });
  const fn = model._index.byId.get('app.c::run');
  const header = path.join(model.root, 'config.h');
  const time = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(header, time, time);
  const opts = { expandMacros: true };
  const beforeHash = flowchartCacheHash(model, fn, opts);
  const before = await buildFlowchart(model, fn, opts);
  assert.ok(before.nodes.some(node => node.text === 'return 10;'));

  fs.writeFileSync(header, '#define VALUE 20\n');
  fs.utimesSync(header, time, time);
  assert.notEqual(flowchartCacheHash(model, fn, opts), beforeHash);
  const after = await buildFlowchart(model, fn, opts);
  assert.ok(after.nodes.some(node => node.text === 'return 20;'));
  assert.deepEqual(after.macrosUsed.map(macro => [macro.file, macro.name, macro.raw]), [['config.h', 'VALUE', '20']]);
});

test('缓存键和流程图共享可达头文件，跳过其他源文件包含的头文件', async t => {
  const files = {
    'src/app.c': '#include "../inc/main.h"\nint run(void) { return VALUE; }\n',
    'inc/main.h': '#include "nested/value.h"\n',
    'inc/nested/value.h': '#include "../main.h"\n#define VALUE 17\n',
    'other.c': '#include "unused.h"\n',
    'unused.h': '#define VALUE 99\n',
    'isolated.c': 'int isolated(void) { return 0; }\n',
  };
  const model = flowchartProject(t, files);
  const fn = model._index.byId.get('src/app.c::run');
  const reads = [];
  const readFile = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (typeof file === 'string') {
      const rel = path.relative(model.root, file).replace(/\\/g, '/');
      if (Object.hasOwn(files, rel)) reads.push(rel);
    }
    return readFile(file, ...args);
  });

  const opts = { expandMacros: true, otherModel: model, otherFn: fn };
  const hash = flowchartCacheHash(model, fn, opts);
  fs.writeFileSync(path.join(model.root, 'unused.h'), '#define VALUE 100\n');
  assert.equal(flowchartCacheHash(model, fn, opts), hash);
  const graph = await buildFlowchart(model, fn, opts);
  assert.equal(graph.nodes.find(node => node.text === 'return 17;')?.change, 'existing');
  assert.deepEqual(reads.sort(), ['inc/main.h', 'inc/nested/value.h', 'src/app.c']);

  const isolated = model._index.byId.get('isolated.c::isolated');
  const isolatedGraph = await buildFlowchart(model, isolated, { expandMacros: true });
  assert.deepEqual(isolatedGraph.macrosUsed, []);
  assert.equal(reads.at(-1), 'isolated.c');
  assert.equal(reads.length, 4);
});
