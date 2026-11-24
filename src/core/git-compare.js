import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { compareProjects, fingerprint } from './compare.js';
import { decodeSource, listSourceFiles } from './index.js';
import { addScheduleBytes, isScheduleFile, listScheduleFiles } from './tcu-schedule.js';

const run = promisify(execFile);
const sourceExtension = /\.(c|h)$/i;
const worktreeRef = 'WORKTREE';
const indexRef = 'INDEX';
const regularBlob = /^100(?:644|755)$/;
const oid = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const maxSourceBytes = 8 * 1024 * 1024;

async function git(directory, args, { binary = false, input } = {}) {
  const command = run('git', ['-c', 'core.quotePath=false', '-C', directory, ...args], {
    encoding: binary ? 'buffer' : 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 72 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  if (input) {
    command.child.stdin.on('error', () => {}); // 错误由子进程退出结果报告
    command.child.stdin.end(input);
  }
  return (await command).stdout;
}

const singleLine = value => value.replace(/\r?\n$/, '');
const records = value => value.split('\0').slice(0, -1);
const emptySummary = () => Object.fromEntries(['functions', 'variables'].map(key =>
  [key, { existing: 0, modified: 0, added: 0, deleted: 0 }]));

async function locateRepo(projectPath) {
  let root;
  try {
    root = await realpath(projectPath);
    if (!(await stat(root)).isDirectory()) return { ok: true, isRepo: false, reason: 'projectNotDirectory' };
  } catch {
    return { ok: true, isRepo: false, reason: 'projectNotDirectory' };
  }
  try {
    const [top, prefix] = await Promise.all([
      git(root, ['rev-parse', '--show-toplevel']),
      git(root, ['rev-parse', '--show-prefix']),
    ]);
    return { ok: true, isRepo: true, root, repoRoot: singleLine(top), projectPrefix: singleLine(prefix) };
  } catch (error) {
    return { ok: true, isRepo: false, reason: error.code === 'ENOENT' ? 'gitUnavailable' : 'notRepository' };
  }
}

function projectSource(repo, file) {
  if (!file?.startsWith(repo.projectPrefix)) return null;
  const relative = file.slice(repo.projectPrefix.length);
  if ((!sourceExtension.test(relative) && !isScheduleFile(relative)) || relative.includes('\\')) return null;
  const parts = relative.split('/');
  if (parts.some(part => !part || part.startsWith('.') || part === 'node_modules')) return null;
  // Git 历史可能来自其他平台，避免 Windows 别名和设备路径进入临时目录。
  if (process.platform === 'win32' && parts.some(part =>
    /[<>:"|?*\x00-\x1f]|[ .]$|^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) return null;
  return relative;
}

async function headOf(repoRoot) {
  const optional = async (args) => {
    try { return singleLine(await git(repoRoot, args)); }
    catch (error) { if (error.code === 1) return null; throw error; }
  };
  const [branch, commit] = await Promise.all([
    optional(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    optional(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
  ]);
  const [sha, shortSha, subject] = commit
    ? singleLine(await git(repoRoot, ['log', '-1', '--format=%H%x00%h%x00%s', commit, '--'])).split('\0')
    : [null, null, ''];
  return { ref: branch || 'HEAD', sha, shortSha, subject, hasCommits: Boolean(sha) };
}

function workingStatus(repo, output) {
  const files = [];
  const summary = { dirty: false, modified: 0, added: 0, deleted: 0, untracked: 0, files };
  for (const entry of records(output)) {
    const xy = entry.slice(0, 2);
    const file = projectSource(repo, entry.slice(3));
    if (!file) continue;
    const status = xy === '??' ? 'untracked' : xy.includes('U') || xy === 'AA' || xy === 'DD' ? 'modified'
      : xy[1] === 'D' || xy[0] === 'D' ? 'deleted' : xy.includes('A') ? 'added' : 'modified';
    files.push({ file, status, staged: status !== 'untracked' && xy[0] !== ' ',
      unstaged: status === 'untracked' || xy[1] !== ' ' });
    summary[status]++;
  }
  summary.dirty = files.length > 0;
  return summary;
}

export async function inspectGitRepo(projectPath) {
  const repo = await locateRepo(projectPath);
  if (!repo.isRepo) return repo;
  const { repoRoot, projectPrefix } = repo;
  try {
    const head = await headOf(repoRoot);
    const [branchOutput, tagOutput, history, porcelain] = await Promise.all([
      git(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      git(repoRoot, ['for-each-ref', '--sort=-creatordate', '--count=30', '--format=%(refname:short)', 'refs/tags']),
      head.hasCommits ? git(repoRoot, ['log', '-30', '-z', '--format=%H%x00%h%x00%s%x00%aI', head.sha, '--']) : '',
      git(repoRoot, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', ...scopeOf(repo)]),
    ]);
    const branches = branchOutput.split(/\r?\n/).filter(Boolean);
    if (branches.includes(head.ref)) {
      branches.splice(branches.indexOf(head.ref), 1);
      branches.unshift(head.ref);
    }
    const historyFields = records(history);
    const recentCommits = [];
    for (let i = 0; i < historyFields.length; i += 4) {
      const [sha, shortSha, subject, date] = historyFields.slice(i, i + 4);
      recentCommits.push({ sha, shortSha, subject, date });
    }
    return {
      ok: true, isRepo: true, repoRoot, projectPrefix, head, branches,
      tags: tagOutput.split(/\r?\n/).filter(Boolean), recentCommits, workingTree: workingStatus(repo, porcelain),
    };
  } catch {
    return { ok: true, isRepo: false, reason: 'statusUnavailable' };
  }
}

const scopeOf = repo => repo.projectPrefix ? [':(literal)' + repo.projectPrefix] : [];

function validatedRef(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value || value.startsWith('-') || /[\0\r\n]/.test(value)) {
    throw new Error('Git 基准或目标引用无效');
  }
  return value;
}

async function resolveCommit(repo, ref) {
  if (ref === 'HEAD') return headOf(repo.repoRoot);
  let sha;
  try {
    sha = singleLine(await git(repo.repoRoot, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']));
  } catch {
    throw new Error('Git 提交引用无效或不存在：' + ref);
  }
  if (!oid.test(sha)) throw new Error('Git 提交引用无效：' + ref);
  const shortSha = singleLine(await git(repo.repoRoot, ['rev-parse', '--short', sha]));
  return { sha, shortSha };
}

async function commitFiles(repo, sha) {
  const files = new Map();
  if (!sha) return files;
  const output = await git(repo.repoRoot, ['ls-tree', '-rz', '--full-tree', sha, '--', ...scopeOf(repo)]);
  for (const record of records(output)) {
    const tab = record.indexOf('\t');
    const [mode, type, object] = record.slice(0, tab).split(' ');
    const file = projectSource(repo, record.slice(tab + 1));
    if (file && regularBlob.test(mode) && type === 'blob' && oid.test(object)) files.set(file, object);
  }
  return files;
}

async function indexFiles(repo, worktree = false) {
  const files = new Map();
  const output = await git(repo.repoRoot, ['ls-files', '--stage', '-z', '--', ...scopeOf(repo)]);
  for (const record of records(output)) {
    const tab = record.indexOf('\t');
    const [mode, object, stage] = record.slice(0, tab).split(' ');
    const file = projectSource(repo, record.slice(tab + 1));
    if (!file || !regularBlob.test(mode) || !oid.test(object)) continue;
    if (!worktree && stage !== '0') throw new Error('请先解决 Git 暂存区中的源码合并冲突：' + file);
    files.set(file, object);
  }
  if (!worktree) {
    const intentOnly = await git(repo.repoRoot, [
      'diff', '--name-only', '-z', '--diff-filter=A', '--ita-invisible-in-index', '--no-ext-diff', '--', ...scopeOf(repo),
    ]);
    for (const relative of records(intentOnly)) files.delete(projectSource(repo, relative));
  }
  return files;
}

async function diskSource(repo, relative) {
  const expected = path.join(repo.root, relative);
  try {
    const actual = await realpath(expected);
    const info = await lstat(expected);
    if (path.relative(expected, actual) || !info.isFile()) return null;
    if (info.size > maxSourceBytes) throw new Error('Git 源码文件超过 8 MB：' + relative);
    const buffer = await readFile(actual);
    if (buffer.length > maxSourceBytes) throw new Error('Git 源码文件超过 8 MB：' + relative);
    return buffer;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function workingFiles(repo, includeUntracked) {
  const files = new Map();
  const tracked = await indexFiles(repo, true);
  const untracked = includeUntracked
    ? records(await git(repo.repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...scopeOf(repo)]))
    : [];
  const names = [...new Set([...tracked.keys(), ...untracked.map(file => projectSource(repo, file)).filter(Boolean)])].sort();
  const hash = createHash('sha256');
  let configBytes = 0;
  for (const file of names) {
    const data = await diskSource(repo, file);
    if (data === null) continue;
    if (isScheduleFile(file)) configBytes = addScheduleBytes(configBytes, data.length);
    files.set(file, data);
    hash.update(JSON.stringify([file, data.length])).update(data);
  }
  return { files, fingerprint: hash.digest('hex') };
}

async function changedFiles(repo, before, after, baseSha, targetRef, targetSha) {
  const result = new Map();
  const add = (file, status, oldFile = null) => result.set(file, { file, status, oldFile });
  for (const file of before.keys()) if (!after.has(file)) add(file, 'deleted');
  for (const [file, object] of after) {
    if (!before.has(file)) add(file, 'added');
    else if (targetRef !== worktreeRef && object !== before.get(file)) add(file, 'modified');
  }
  if (!baseSha || (!targetSha && targetRef === 'HEAD')) return [...result.values()];
  const diff = await git(repo.repoRoot, [
    'diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv',
    ...(targetRef === indexRef ? ['--cached'] : []), baseSha, ...(targetSha ? [targetSha] : []), '--', ...scopeOf(repo),
  ]);
  const entries = records(diff);
  for (let i = 0; i < entries.length;) {
    const code = entries[i++];
    const old = projectSource(repo, entries[i++]);
    const renamed = code.startsWith('R');
    const file = renamed || code.startsWith('C') ? projectSource(repo, entries[i++]) : old;
    if (renamed && old && file && result.get(old)?.status === 'deleted' && result.get(file)?.status === 'added') {
      result.delete(old);
      add(file, 'renamed', old);
    } else if (targetRef === worktreeRef && file && before.has(file) && after.has(file)) add(file, 'modified');
  }
  return [...result.values()].sort((a, b) => a.file.localeCompare(b.file));
}

async function fetchBlobs(repo, before, after) {
  const blobs = new Map();
  const ids = [...new Set([...before.values(), ...after.values()])].filter(id => typeof id === 'string');
  if (!ids.length) return blobs;
  const check = await git(repo.repoRoot, ['cat-file', '--batch-check'], { input: ids.join('\n') + '\n' });
  const entries = singleLine(check).split('\n').map((line, i) => {
    const [id, type, length] = line.split(' ');
    const size = Number(length);
    if (id !== ids[i] || type !== 'blob' || !Number.isSafeInteger(size) || size < 0 || size > maxSourceBytes) {
      throw new Error('Git 源码对象无法读取或超过 8 MB：' + ids[i]);
    }
    return { id, size };
  });
  if (entries.length !== ids.length) throw new Error('Git 返回的源码对象不完整');
  const sizes = new Map(entries.map(({ id, size }) => [id, size]));
  for (const files of [before, after]) {
    let configBytes = 0;
    for (const [file, object] of files) {
      if (isScheduleFile(file)) configBytes = addScheduleBytes(configBytes, typeof object === 'string' ? sizes.get(object) : object.length);
    }
  }
  for (let i = 0; i < entries.length;) {
    const batch = [];
    let totalBytes = 0;
    while (i < entries.length && totalBytes + entries[i].size + 100 <= 32 * 1024 * 1024) {
      const entry = entries[i++];
      totalBytes += entry.size + 100;
      batch.push(entry);
    }
    const response = await git(repo.repoRoot, ['cat-file', '--batch'], {
      binary: true, input: batch.map(({ id }) => id).join('\n') + '\n',
    });
    let offset = 0;
    for (const { id, size } of batch) {
      const newline = response.indexOf(10, offset);
      const [actual, type, bytes] = response.toString('ascii', offset, newline).split(' ');
      if (newline === -1 || actual !== id || type !== 'blob' || Number(bytes) !== size || response[newline + 1 + size] !== 10) {
        throw new Error('Git 源码对象内容不完整：' + id);
      }
      offset = newline + 1 + size + 1;
      blobs.set(id, response.subarray(newline + 1, offset - 1));
    }
  }
  return blobs;
}

async function materialize(directory, entries, blobs) {
  const files = new Map(), buffers = new Map();
  for (const [relative, entry] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    const bytes = typeof entry === 'string' ? blobs.get(entry) : entry;
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    files.set(relative, target);
    if (!isScheduleFile(relative)) buffers.set(relative, bytes);
  }
  return { files, buffers };
}

const emptyFacts = () => ({ directIds: [], implicitImpactIds: [], chainImpactIds: [] });

function importFacts(comparison) {
  const facts = emptyFacts();
  for (const n of [...comparison.model.functions, ...comparison.model.variables]) {
    if (n.change !== 'existing') facts.directIds.push(n.id);
    else if (n.macroImpact || n.periodImpact) facts.implicitImpactIds.push(n.id);
    else if (n.impact || n.context) facts.chainImpactIds.push(n.id);
  }
  return facts;
}

function retainSnapshot(model, buffers) {
  delete model._sourceFiles;
  model._sourceBuffers = buffers;
  model.files = model.files.map(file => ({ ...file, abs: path.join(model.root, file.rel) }));
}

export async function compareGitProject(projectPath, gitOptions = {}, compareOptions = {}) {
  const baseRef = validatedRef(gitOptions.baseRef, 'HEAD');
  const targetRef = validatedRef(gitOptions.targetRef, worktreeRef);
  const includeUntracked = gitOptions.includeUntracked !== false;
  const repo = await locateRepo(projectPath);
  if (!repo.isRepo) throw new Error(repo.reason === 'gitUnavailable' ? '未找到 Git 可执行程序' : '当前工程不在 Git 工作区中');
  const base = await resolveCommit(repo, baseRef);
  const target = targetRef === worktreeRef || targetRef === indexRef ? null : await resolveCommit(repo, targetRef);
  const [before, worktree, targetFiles] = await Promise.all([
    commitFiles(repo, base.sha),
    targetRef === worktreeRef ? workingFiles(repo, includeUntracked) : null,
    targetRef === indexRef ? indexFiles(repo) : target ? commitFiles(repo, target.sha) : null,
  ]);
  const after = worktree?.files ?? targetFiles;
  const changes = await changedFiles(repo, before, after, base.sha, targetRef, target?.sha);
  const metadata = {
    mode: 'git', baseRef, baseLabel: base.shortSha ? baseRef + ' (' + base.shortSha + ')' : baseRef, baseSha: base.sha,
    targetRef, targetLabel: target?.shortSha ? targetRef + ' (' + target.shortSha + ')' : targetRef, targetSha: target?.sha ?? null,
    includeUntracked, changedFiles: changes, worktreeFingerprint: worktree?.fingerprint ?? null,
    noSourceChanges: !changes.length, importFacts: emptyFacts(), commentOnlyFiles: [],
  };
  const analyze = () => analyzeGitSnapshot(repo, before, after, metadata, compareOptions);
  if (!changes.length && !compareOptions.allowEmptyRefresh) {
    return { projectPath: repo.root, git: metadata, summary: emptySummary(), roots: [], candidates: [],
      changePoints: [], impactIds: [], macroChanges: [], macroDetails: [], warnings: [], mappings: [], totalNodes: 0,
      ...(compareOptions.deferUnchangedAnalysis ? { analyze } : {}) };
  }
  return analyze();
}

/** 两个版本各自固定源码及调度配置，延迟分析也使用首次读取的工作区缓冲与 Git 对象。 */
async function analyzeGitSnapshot(repo, before, after, metadata, compareOptions) {
  const changes = metadata.changedFiles;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'callgraph-git-'));
  try {
    const beforePath = path.join(temporary, 'before'), afterPath = path.join(temporary, 'after');
    const blobs = await fetchBlobs(repo, before, after);
    await Promise.all([mkdir(beforePath), mkdir(afterPath)]);
    const beforeSnapshot = await materialize(beforePath, before, blobs);
    const afterSnapshot = await materialize(afterPath, after, blobs);
    const sameSources = beforeSnapshot.buffers.size === afterSnapshot.buffers.size &&
      [...beforeSnapshot.buffers].every(([name, bytes]) => afterSnapshot.buffers.get(name)?.equals(bytes));
    const comparison = await compareProjects(repo.root, beforePath, afterPath, {
      ...compareOptions,
      snapshots: { beforeFiles: beforeSnapshot.files, afterFiles: afterSnapshot.files, mappings: [], sameSources },
    });
    metadata.importFacts = importFacts(comparison);
    const semanticFiles = new Set(comparison.changePoints.map(point => point.file));
    metadata.commentOnlyFiles = changes.filter(({ file, status }) => status === 'modified' && sourceExtension.test(file) && !semanticFiles.has(file) &&
      fingerprint(decodeSource(beforeSnapshot.buffers.get(file))) === fingerprint(decodeSource(afterSnapshot.buffers.get(file))))
      .map(({ file }) => file);
    retainSnapshot(comparison.beforeModel, beforeSnapshot.buffers);
    retainSnapshot(comparison.afterModel, afterSnapshot.buffers);
    retainSnapshot(comparison.model, new Map([...beforeSnapshot.buffers, ...afterSnapshot.buffers]));
    delete comparison.beforePath;
    delete comparison.afterPath;
    if (!changes.length) comparison.summary = emptySummary();
    return { ...comparison, git: metadata };
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function watchGitProject(projectPath, signal, onChange) {
  const repo = await locateRepo(projectPath);
  if (!repo.isRepo || signal.aborted) return;
  let watcher, poll, debounce;
  function changed() {
    clearTimeout(debounce);
    debounce = setTimeout(onChange, 500);
    debounce.unref();
  }
  function usePolling() {
    watcher?.close();
    let previous = scan();
    poll = setInterval(() => {
      const next = scan();
      if (next !== previous) changed();
      previous = next;
    }, 1000);
    poll.unref();
  }
  function scan() {
    const files = [...listSourceFiles(repo.root).filter(file => sourceExtension.test(file)), ...listScheduleFiles(repo.root).values()];
    return JSON.stringify(files.sort().flatMap(file => {
      try {
        const s = fs.lstatSync(file, { bigint: true });
        return s.isFile() ? [[file, String(s.mtimeNs), String(s.ctimeNs), String(s.size)]] : [];
      } catch { return []; }
    }));
  }
  try {
    watcher = fs.watch(repo.root, { recursive: true, persistent: false }, (_event, name) => {
      if (!name || projectSource(repo, repo.projectPrefix + name.replace(/\\/g, '/'))) changed();
    });
    watcher.once('error', usePolling);
  } catch { usePolling(); }
  signal.addEventListener('abort', () => {
    watcher?.close();
    clearTimeout(debounce);
    clearInterval(poll);
  }, { once: true });
}
