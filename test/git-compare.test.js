import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFlowchart } from '../src/core/flowchart.js';
import { compareGitProject, inspectGitRepo } from '../src/core/git-compare.js';
import { decodeSource } from '../src/core/index.js';

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const put = (file, source) => {
    const abs = path.join(root, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, source);
  };
  const commit = (subject) => {
    git('add', '-A');
    git('commit', '--quiet', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.name', 'Callgraph Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'core.autocrlf', 'false');
  return { root, git, put, commit };
}

const byId = (comparison, id) => comparison.model._index.byId.get(id);

test('工作区读取最新内容，区分暂存区、未跟踪源码、注释与编码', async t => {
  const { root, git, put, commit } = repository(t);
  const file = '制御/変速.c', active = file + '::shift', notes = 'notes.c::stable', fresh = 'new.c::diag';
  const cp932 = Buffer.concat([
    Buffer.from('/* '), Buffer.from('93fa967b', 'hex'), Buffer.from(' */\nint shift(void) { return 1; }\n'),
  ]);
  put(file, cp932);
  put('notes.c', '// 原注释\nint stable(void) { return 0; }\n');
  put('.gitignore', 'generated/\n');
  commit('初回コミット');
  const staged = Buffer.concat([
    Buffer.from([0xff, 0xfe]), Buffer.from('/* 日本 */\nint shift(void) { return 2; }\n', 'utf16le'),
  ]);
  put(file, staged);
  git('add', '.');
  put(file, '/* 日本 */\nint shift(void) { return 3; }\n');
  put('notes.c', '\n// 新注释\nint stable(void) {  return 0; }\n');
  put('new.c', 'int diag(void) { return 4; }\n');
  put('intent.c', 'int intent(void) { return 5; }\n');
  git('add', '-N', 'intent.c');
  put('generated/ignored.c', 'int ignored(void) { return 0; }\n');
  put('README.md', '文档不在源码比较范围内');

  const info = await inspectGitRepo(root);
  assert.equal(info.head.subject, '初回コミット');
  assert.equal(info.workingTree.modified, 2);
  assert.equal(info.workingTree.untracked, 1);
  assert.deepEqual(info.workingTree.files.find(entry => entry.file === file), {
    file, status: 'modified', staged: true, unstaged: true,
  });
  const live = await compareGitProject(root);
  assert.equal(byId(live, active).change, 'modified');
  assert.equal(byId(live, fresh).change, 'added');
  assert.equal(byId(live, notes).change, 'existing');
  assert.equal(byId(live, 'generated/ignored.c::ignored'), undefined);
  assert.deepEqual(live.git.commentOnlyFiles, ['notes.c']);
  assert.ok(live.git.importFacts.directIds.includes(active));
  assert.match(live.git.worktreeFingerprint, /^[0-9a-f]{64}$/);
  assert.match(decodeSource(live.beforeModel._sourceBuffers.get(file)), /日本/);
  assert.equal(live.beforePath, undefined);
  assert.equal(live.afterPath, undefined);

  const index = await compareGitProject(root, { targetRef: 'INDEX' });
  assert.equal(byId(index, active).change, 'modified');
  assert.equal(byId(index, fresh), undefined);
  assert.equal(byId(index, 'intent.c::intent'), undefined);
  assert.deepEqual(index.afterModel._sourceBuffers.get(file), staged);
  assert.match(index.changePoints.find(p => p.id === active).afterValue, /return 2/);
  const trackedOnly = await compareGitProject(root, { includeUntracked: false });
  assert.equal(byId(trackedOnly, fresh), undefined);
  put(file, 'int shift(void) { return 99; }\n');
  assert.match(decodeSource(live.model._sourceBuffers.get(file)), /return 3;/);
  await assert.rejects(compareGitProject(root, { baseRef: '--help' }), /引用无效/);
  await assert.rejects(compareGitProject(root, { targetRef: 'missing-tag' }), /无效或不存在/);
});

test('子目录工程只收录自己的 C/H，头文件变更推导宏与数据流影响', async t => {
  const { root, put, commit } = repository(t);
  const dir = 'packages/計測';
  const header = scale => `#define SCALE ${scale}
typedef union { int a, b; } Shared;
typedef struct { Shared value; } Signal;
`;
  put(dir + '/lsb.h', header(10));
  put(dir + '/control.c', '#include "lsb.h"\nSignal signal;\nvoid update(void) { signal.value.a = SCALE; }\n');
  put(dir + '/observe.c', '#include "lsb.h"\nextern Signal signal;\nint observe(void) { return signal.value.b; }\n');
  put('packages/計測-extra/other.c', 'int other(void) { return 1; }\n');
  commit('base');
  put(dir + '/lsb.h', header(20));
  put('packages/計測-extra/other.c', 'int other(void) { return 9; }\n');
  const project = path.join(root, dir);

  const status = await inspectGitRepo(project);
  assert.equal(status.projectPrefix, dir + '/');
  assert.deepEqual(status.workingTree.files.map(f => f.file), ['lsb.h']);
  const comp = await compareGitProject(project);
  assert.deepEqual(comp.git.changedFiles, [{ file: 'lsb.h', status: 'modified', oldFile: null }]);
  assert.equal(byId(comp, 'control.c::update').impactRole, 'macro_lsb_impact');
  assert.ok(comp.git.importFacts.implicitImpactIds.includes('control.c::update'));
  assert.equal(comp.afterModel._df.byId.get('var::signal').containsUnion, true);
  assert.ok(comp.git.importFacts.chainImpactIds.includes('observe.c::observe'));
  assert.deepEqual(comp.git.importFacts.directIds, []);
  assert.equal(comp.model.functions.some(fn => fn.name === 'other'), false);
});

test('历史比较以两个提交为准，识别删除和重命名，无关工作区内容不进入任一侧', async t => {
  const { root, git, put, commit } = repository(t);
  put('old.c', 'int removed(void) { return 0; }\n');
  put('rename.c', 'int renamed(void) { return 1; }\n');
  put('control.c', '#include "lsb.h"\nint update(void) { return SCALE; }\n');
  put('lsb.h', '#define SCALE 10\n');
  const base = commit('base');
  git('tag', 'release-base');
  git('checkout', '--quiet', '-b', 'feature');
  git('rm', 'old.c');
  git('mv', 'rename.c', 'renamed.c');
  put('control.c', '#include "lsb.h"\nint update(void) { return SCALE + 1; }\n');
  const target = commit('feature');
  put('lsb.h', '#define SCALE 999\n');
  put('rename.c', 'int bogus(void) { return 99; }\n');
  put('unrelated.c', 'int unrelated(void) { return 1; }\n');

  const status = await inspectGitRepo(root);
  assert.deepEqual(status.branches, ['feature', 'main']);
  assert.deepEqual(status.tags, ['release-base']);
  assert.deepEqual(status.recentCommits.map(c => c.sha), [target, base]);
  assert.ok(status.recentCommits.every(c => Number.isFinite(Date.parse(c.date))));
  const comp = await compareGitProject(root, { baseRef: 'release-base', targetRef: 'feature' });
  assert.equal(comp.git.baseSha, base);
  assert.equal(comp.git.targetSha, target);
  assert.ok(comp.git.changedFiles.some(f => f.status === 'renamed' && f.oldFile === 'rename.c' && f.file === 'renamed.c'));
  assert.equal(byId(comp, 'old.c::removed').change, 'deleted');
  assert.equal(byId(comp, 'rename.c::renamed').change, 'deleted');
  assert.equal(byId(comp, 'renamed.c::renamed').change, 'added');
  assert.equal(byId(comp, 'control.c::update').change, 'modified');
  assert.equal(byId(comp, 'rename.c::bogus'), undefined);
  assert.equal(byId(comp, 'unrelated.c::unrelated'), undefined);
  assert.match(decodeSource(comp.afterModel._sourceBuffers.get('lsb.h')), /10/);
});

test('大仓库未改动文件复盘与按需快照隔离：后续磁盘编辑不污染历史 _sourceBuffers', async t => {
  const { root, put, commit } = repository(t);
  const file = 'src/mod/f2.c';
  const diskPath = path.join(root, file);
  const time = new Date('2020-01-01T00:00:00Z');
  for (let i = 0; i < 40; i++) put(`src/mod/f${i}.c`, `int fn_${i}(void) { return ${i}; }\n`);
  fs.utimesSync(diskPath, time, time);
  commit('base');
  put('src/mod/f0.c', 'int fn_0(void) { return 100; }\n');
  put('src/mod/f1.c', 'int fn_1(void) { return 101; }\n');
  commit('second');

  const comp = await compareGitProject(root, { baseRef: 'HEAD~1', targetRef: 'HEAD' });
  assert.deepEqual(comp.git.changedFiles.map(f => f.file), ['src/mod/f0.c', 'src/mod/f1.c']);
  assert.equal(byId(comp, 'src/mod/f0.c::fn_0').change, 'modified');
  assert.equal(byId(comp, 'src/mod/f1.c::fn_1').change, 'modified');
  assert.equal(byId(comp, 'src/mod/f2.c::fn_2').change, 'existing');

  const buffers = comp.model._sourceBuffers;
  const original = buffers.get(file);
  const reread = buffers.get(file);
  assert.notEqual(reread, original);
  assert.deepEqual(reread, original);

  // 等长改写并恢复修改时间后，三份快照仍按原 OID 读取。
  put(file, 'int fn_2(void) { return 9; }\n');
  fs.utimesSync(diskPath, time, time);
  assert.deepEqual(comp.beforeModel._sourceBuffers.get(file), original);
  assert.deepEqual(comp.afterModel._sourceBuffers.get(file), original);
  const recovered = buffers.get(file);
  assert.deepEqual(recovered, original);
  assert.equal(buffers.get(file), recovered);
  const graph = await buildFlowchart(comp.model, byId(comp, file + '::fn_2'));
  assert.ok(graph.nodes.some(node => node.lines.some(line => /return 2/.test(line))));
});

test('边界回归：diff.relative=true、暂存重命名重建旧路径、ident 转换均不污染比较结果', async t => {
  // 1. diff.relative=true 下子目录工程仍正确检测修改与 intent-to-add
  {
    const { root, git, put, commit } = repository(t);
    const sub = 'sub [x] 中';
    put(`${sub}/a.C`, 'int a(void) { return 1; }\n');
    commit('init');
    git('config', 'diff.relative', 'true');
    put(`${sub}/a.C`, 'int a(void) { return 2; }\n');
    put(`${sub}/new.c`, 'int b(void) { return 3; }\n');
    git('add', '-N', `${sub}/new.c`);
    const project = path.join(root, sub);
    const live = await compareGitProject(project);
    assert.equal(live.git.noSourceChanges, false);
    assert.equal(byId(live, 'a.C::a').change, 'modified');
    const idx = await compareGitProject(project, { targetRef: 'INDEX' });
    assert.equal(idx.git.noSourceChanges, true);
  }
  // 2. 暂存重命名后重建同名未跟踪文件，不污染 HEAD~1..HEAD 历史比较
  {
    const { root, git, put, commit } = repository(t);
    put('a.c', 'int keep_a(void) { return 1; }\n');
    put('b.c', 'int b(void) { return 1; }\n');
    commit('c1');
    put('b.c', 'int b(void) { return 2; }\n');
    commit('c2');
    git('mv', 'a.c', 'new.c');
    put('a.c', 'int bogus_untracked(void) { return 99; }\n');
    const hist = await compareGitProject(root, { baseRef: 'HEAD~1', targetRef: 'HEAD' });
    assert.equal(byId(hist, 'a.c::keep_a').change, 'existing');
    assert.equal(byId(hist, 'a.c::bogus_untracked'), undefined);
  }
  // 3. ident 检出转换下纯注释提交仍判定为 commentOnly，不误报函数修改
  {
    const { root, git, put, commit } = repository(t);
    put('.gitattributes', 'a.c ident\n');
    put('a.c', 'const char *id(void) { return "$Id$"; }\n');
    commit('c1');
    put('a.c', '// only comment\nconst char *id(void) { return "$Id$"; }\n');
    commit('c2');
    fs.unlinkSync(path.join(root, 'a.c'));
    git('checkout', '--', 'a.c');
    const hist = await compareGitProject(root, { baseRef: 'HEAD~1', targetRef: 'HEAD' });
    assert.equal(byId(hist, 'a.c::id').change, 'existing');
    assert.deepEqual(hist.git.commentOnlyFiles, ['a.c']);
  }
});

test('未提交仓库以空 HEAD 为基准，识别首批 C/H 与空暂存区', async t => {
  const { root, git, put } = repository(t);
  put('start.c', 'int start(void) { return 1; }\n');
  const status = await inspectGitRepo(root);
  assert.deepEqual(status.head, { ref: 'main', sha: null, shortSha: null, subject: '', hasCommits: false });
  assert.equal(status.workingTree.untracked, 1);
  assert.equal((await compareGitProject(root, { targetRef: 'INDEX' })).git.noSourceChanges, true);
  const live = await compareGitProject(root);
  assert.equal(byId(live, 'start.c::start').change, 'added');
  git('add', 'start.c');
  assert.equal(byId(await compareGitProject(root, { targetRef: 'INDEX' }), 'start.c::start').change, 'added');
  put('graph.dot', 'digraph G { a -> b }');
  assert.deepEqual(await inspectGitRepo(path.join(root, 'graph.dot')), {
    ok: true, isRepo: false, reason: 'projectNotDirectory',
  });
});

test('HTTP Git 预览、出图、节点/数据流、实时推送、保留状态和退出', { timeout: 30_000 }, async t => {
  const { root, put, commit } = repository(t);
  const original = 'int speed;\nvoid update(void) { speed = 1; }\nint read_speed(void) { return speed; }\n';
  put('control.c', original);
  commit('initial');
  const db = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-db-'));
  const argv = process.argv.slice();
  const previousDB = process.env.CALLGRAPH_DB;
  process.argv.splice(2, Infinity, root, '0');
  process.env.CALLGRAPH_DB = path.join(db, 'test.db');
  let server;
  try {
    ({ server } = await import('../src/server.js'));
  } finally {
    process.argv.splice(0, Infinity, ...argv);
    if (previousDB === undefined) delete process.env.CALLGRAPH_DB;
    else process.env.CALLGRAPH_DB = previousDB;
  }
  if (!server.listening) await once(server, 'listening');
  const streamAbort = new AbortController();
  t.after(async () => {
    streamAbort.abort();
    await new Promise((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
      server.closeAllConnections();
    });
    fs.rmSync(db, { recursive: true, force: true, maxRetries: 3 });
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const get = route => fetch(baseUrl + route).then(res => res.json());
  const post = (route, body) => fetch(baseUrl + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(res => res.json());
  const project = await get('/api/project');
  const gitOptions = { mode: 'git', baseRef: 'HEAD', targetRef: 'WORKTREE' };
  assert.equal((await get('/api/git/status')).workingTree.dirty, false);
  put('README.md', '只有文档修改');
  const clean = (await post('/api/compare', gitOptions)).preview;
  assert.equal(clean.git.noSourceChanges, true);
  assert.deepEqual(clean.candidates, []);
  assert.deepEqual(clean.changePoints, []);
  assert.ok(Object.values(clean.summary.functions).every(n => n === 0));

  put('control.c', original.replace('speed = 1', 'speed = 2'));
  const { preview } = await post('/api/compare', gitOptions);
  const id = 'control.c::update';
  assert.ok(preview.git.importFacts.directIds.includes(id));
  const applied = await post('/api/compare/apply', { previewId: preview.id, selectedIds: [id, 'var::speed'] });
  assert.equal(applied.ok, true);
  assert.equal(applied.comparison.git.targetRef, 'WORKTREE');
  assert.equal(applied.comparison.beforePath, undefined);
  const view = await get('/api/view');
  assert.ok(view.nodes.some(n => n.id === id && n.change === 'modified'));
  assert.ok((await get('/api/dataflow?fn=' + id)).vars.some(v => v.name === 'speed'));
  assert.equal((await post('/api/compare/status', { comparisonId: applied.comparison.id, nodeId: id, change: 'existing' })).ok, true);
  const edge = (await get('/api/node?id=' + id)).outEdges.find(e => e.to === 'var::speed');
  assert.equal((await post('/api/compare/status', {
    comparisonId: applied.comparison.id, edgeId: edge.comparisonKey, change: 'modified',
  })).ok, true);

  const stream = await fetch(baseUrl + '/api/stream', {
    signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(8000)]),
  });
  put('control.c', original);
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  let message;
  let pending = '';
  while (!message) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    pending += value;
    const events = pending.split('\n\n');
    pending = events.pop();
    for (const event of events) {
      const data = event.split('\n').find(line => line.startsWith('data: '));
      if (data && JSON.parse(data.slice(6)).op === 'git.changed') message = JSON.parse(data.slice(6));
    }
  }
  assert.equal(message.projectId, project.id);
  assert.equal(message.comparisonId, applied.comparison.id);
  await reader.cancel();

  const refreshed = (await post('/api/compare', { ...gitOptions, refresh: true })).preview;
  assert.equal(refreshed.git.noSourceChanges, true);
  assert.notEqual(refreshed.git.worktreeFingerprint, preview.git.worktreeFingerprint);
  const kept = await post('/api/compare/apply', { previewId: refreshed.id, selectedIds: [], retainIds: [id, 'var::speed'] });
  assert.equal(kept.ok, true);
  assert.deepEqual(kept.roots, [id, 'var::speed']);
  const detail = await get('/api/node?id=' + id);
  assert.equal(detail.node.statusSource, 'manual');
  assert.equal(detail.outEdges.find(e => e.to === 'var::speed').statusSource, 'manual');
  assert.equal((await post('/api/compare/exit', {})).ok, true);
  assert.equal((await get('/api/project')).comparison, null);
  assert.equal((await get('/api/node?id=' + id)).node.change, undefined);
});
