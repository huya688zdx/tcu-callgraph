import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { compareProjects } from '../src/core/compare.js';
import { compareGitProject, inspectGitRepo } from '../src/core/git-compare.js';
import { projectTasks } from '../src/core/task-periods.js';
import { cacheKey, openStore } from '../src/core/store.js';
import { loadModel, rebuildIndex, scanSources } from '../src/core/index.js';

const rates = m => Object.fromEntries(projectTasks(m).map(t => [t.name, t.us]));
const config = periodMs => JSON.stringify({ tasks: [{ name: 'Fast', periodMs }] });
const oil = n => `TASK Os {}; ALARM A { ACTION = ACTIVATETASK { TASK = Os; }; CYCLETIME = ${n}; };`;
const events = seconds => `<TIMING-EVENT><START-ON-EVENT-REF>/R</START-ON-EVENT-REF><PERIOD>${seconds}</PERIOD></TIMING-EVENT>`;
const runnable = '<RUNNABLE-ENTITY><SHORT-NAME>R</SHORT-NAME><SYMBOL>Run</SYMBOL></RUNNABLE-ENTITY>';
const source = 'void Fast(void) {}\nvoid Os(void) {}\nvoid Run(void) {}';

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-schedule-snapshots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), value);
  };
  return { root, put };
}

test('嵌套的稀疏目录只覆盖各自配置；缺少一侧是删除，共有 ARXML 实体沿用基础工程', async t => {
  const { root, put } = tree(t);
  put('app.c', source);
  put('tcu-schedule.json', config(99));
  put('os/tcu.oil', oil(99));
  put('auto/runnable.arxml', runnable);
  put('auto/events.arxml', events(0.099));
  put('old/tcu-schedule.json', config(10));
  put('new/tcu-schedule.json', config(20));
  put('old/tcu.oil', oil(4));
  put('old/events.arxml', events(0.003));
  put('new/events.arxml', events(0.005));
  const cmp = await compareProjects(root, path.join(root, 'old'), path.join(root, 'new'));
  assert.deepEqual(rates(cmp.beforeModel), { Fast: 10000, Os: 4000, Run: 3000 });
  assert.deepEqual(rates(cmp.afterModel), { Fast: 20000, Run: 5000 });
  assert.deepEqual(cmp.beforeModel.files.map(f => f.rel), ['app.c']);
  assert.equal(cmp.beforeModel._df, cmp.afterModel._df, '相同 C 源码仅做一次数据流解析');
  assert.deepEqual(cmp.model._index.byId.get('app.c::Fast').periods, { before: ['10ms'], after: ['20ms'] });
  assert.equal(cmp.model._index.byId.get('app.c::Fast').change, 'existing');
  assert.deepEqual(cmp.model._index.byId.get('app.c::Os').periods, { before: ['4ms'], after: [] });
});

test('Git 只改调度配置也形成周期差分，提交、INDEX 与 WORKTREE 各自固定全部配置', async t => {
  const { root, put } = tree(t);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true });
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  const commit = () => { git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'schedule'); };
  put('app.c', source);
  put('tcu-schedule.json', config(10));
  put('os/app.oil', oil(4));
  put('auto/runnable.arxml', runnable);
  put('auto/events.arxml', events(0.003));
  commit();
  put('tcu-schedule.json', config(20));
  fs.unlinkSync(path.join(root, 'os/app.oil'));
  put('auto/events.arxml', events(0.005));
  commit();
  put('tcu-schedule.json', config(30));
  git('add', 'tcu-schedule.json');
  put('tcu-schedule.json', config(40));
  const history = await compareGitProject(root, { baseRef: 'HEAD~1', targetRef: 'HEAD' });
  assert.equal(history.git.noSourceChanges, false);
  assert.deepEqual(history.git.changedFiles.map(f => f.file).sort(), ['auto/events.arxml', 'os/app.oil', 'tcu-schedule.json']);
  assert.deepEqual(history.git.commentOnlyFiles, []);
  assert.deepEqual(rates(history.beforeModel), { Fast: 10000, Os: 4000, Run: 3000 });
  assert.deepEqual(rates(history.afterModel), { Fast: 20000, Run: 5000 });
  assert.deepEqual(history.model.files.map(f => f.rel), ['app.c']);
  assert.deepEqual([...history.model._sourceBuffers.keys()], ['app.c']);
  assert.ok(history.git.importFacts.implicitImpactIds.includes('app.c::Os'));
  assert.deepEqual(history.git.importFacts.directIds, []);
  assert.equal(rates((await compareGitProject(root, { targetRef: 'INDEX' })).afterModel).Fast, 30000);
  assert.equal(rates((await compareGitProject(root)).afterModel).Fast, 40000);
  assert.deepEqual((await inspectGitRepo(root)).workingTree.files.map(f => f.file), ['tcu-schedule.json']);
});

test('历史和 INDEX 两侧的调度配置均在 Git 读取任何 blob 前执行总量校验', async t => {
  const { root, put } = tree(t);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true });
  const commit = () => git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'schedule');
  git('init', '--quiet');
  put('app.c', source);
  const bytes = Buffer.alloc(7 * 1024 * 1024, 32);
  const names = Array.from({ length: 5 }, (_, index) => `task-${index}.arxml`);
  for (const name of names) put(name, bytes);
  git('add', '.');
  commit();
  git('rm', '--quiet', ...names);
  commit();
  for (const name of names) put(name, bytes);
  git('add', ...names);

  const trace = path.join(root, 'git-trace.jsonl');
  const originalTrace = process.env.GIT_TRACE2_EVENT;
  t.after(() => {
    if (originalTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = originalTrace;
  });
  process.env.GIT_TRACE2_EVENT = trace;
  for (const refs of [{ baseRef: 'HEAD~1', targetRef: 'HEAD' }, { targetRef: 'INDEX' }]) {
    fs.writeFileSync(trace, '');
    await assert.rejects(compareGitProject(root, refs), /调度配置累计超过 32 MiB/);
    const gitCommands = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.event === 'start').map(row => row.argv);
    assert.ok(gitCommands.some(argv => argv.includes('--batch-check')));
    assert.ok(!gitCommands.some(argv => argv.includes('--batch')), '拒绝之前不得请求 blob 内容');
  }
});

test('WORKTREE 配置超限时不读取内容，并限制预检后增长的文件', async t => {
  const { root, put } = tree(t);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true });
  git('init', '--quiet');
  put('app.c', source);
  git('add', 'app.c');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline');

  const MiB = 1024 * 1024;
  const names = Array.from({ length: 10 }, (_, index) => `task-${index}.arxml`);
  for (const name of names) {
    put(name, '');
    fs.truncateSync(path.join(root, name), 5 * MiB);
  }
  const readFile = promises.readFile;
  const open = promises.open;
  const opened = [];
  let readBytes = 0;
  let growBeforeStat = false;
  let growAfterStat = false;
  promises.readFile = async (file, ...options) => {
    if (typeof file === 'string' && file.endsWith('.arxml')) assert.fail('调度配置不得无界读入');
    return readFile(file, ...options);
  };
  promises.open = async (name, ...options) => {
    if (!name.endsWith('.arxml')) return open(name, ...options);
    opened.push(path.basename(name));
    if (growBeforeStat && name.endsWith('task-5.arxml')) fs.truncateSync(name, 8 * MiB);
    const file = await open(name, ...options);
    const read = file.read.bind(file);
    file.read = async (...args) => {
      if (growAfterStat && name.endsWith('task-5.arxml')) fs.truncateSync(name, 8 * MiB);
      const result = await read(...args);
      readBytes += result.bytesRead;
      return result;
    };
    return file;
  };
  syncBuiltinESMExports();
  t.after(() => {
    promises.readFile = readFile;
    promises.open = open;
    syncBuiltinESMExports();
  });

  await assert.rejects(compareGitProject(root), /调度配置累计超过 32 MiB/);
  assert.deepEqual(opened, [], '50 MiB 的预检必须在打开任何配置文件前失败');

  for (const name of names.slice(6)) fs.unlinkSync(path.join(root, name));
  growBeforeStat = true;
  await assert.rejects(compareGitProject(root), /调度配置累计超过 32 MiB/);
  assert.deepEqual(opened, names.slice(0, 6));
  assert.equal(readBytes, 25 * MiB, '打开后已超过剩余额度的文件不得读取内容');

  fs.truncateSync(path.join(root, names[5]), 5 * MiB);
  growBeforeStat = false;
  growAfterStat = true;
  readBytes = 0;
  await assert.rejects(compareGitProject(root), /读取时调度配置已更改/);
  assert.equal(readBytes, 30 * MiB + 1, '打开后再次增长只能多读一个探测字节');
});

test('同尺寸调度配置改写后重开工程，命中 C 解析缓存并重新读取配置', t => {
  const { root, put } = tree(t);
  put('app.c', source);
  put('tcu-schedule.json', config(10));
  const store = openStore({ dbPath: path.join(root, 'cache.db') });
  try {
    const model = loadModel(root);
    const key = cacheKey(scanSources(root));
    assert.equal(rates(model).Fast, 10000);
    assert.equal(store.putCachedModel(key, model).cached, true);
    put('tcu-schedule.json', config(20));
    assert.equal(cacheKey(scanSources(root)), key);
    const reopened = rebuildIndex(store.getCachedModel(key));
    assert.equal(rates(reopened).Fast, 20000);
    assert.equal(rates(model).Fast, 10000);
  } finally { store.close(); }
});
