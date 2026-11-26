import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { compareProjects, fingerprint } from './compare.js';
import { selectedBuildProfile } from './build-profile-options.js';
import { decodeSource, listSourceFiles } from './index.js';
import { addScheduleBytes, isScheduleFile, listScheduleFiles } from './tcu-schedule.js';

const run = promisify(execFile);
const sourceExtension = /\.(c|h)$/i;
const worktreeRef = 'WORKTREE';
const indexRef = 'INDEX';
const regularBlob = /^100(?:644|755)$/;
const oid = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const maxSourceBytes = 8 * 1024 * 1024;
const snapshotCacheBytes = 24 * 1024 * 1024;
const defaultGitTimeoutMs = 120_000;
const ioConcurrency = 16;
const analyzedComparisons = new Map();
const analyzedComparisonLimit = 1;

// 只让 Git 扫描关心的 C/H 源码与调度配置，避免在大仓库里遍历海量非源码文件或构建产物。
const sourcePathspecs = [
  ':(icase)*.c',
  ':(icase)*.h',
  ':(icase)*.oil',
  ':(icase)*.arxml',
  ':(literal)tcu-schedule.json',
];

async function git(directory, args, { binary = false, input, timeout = defaultGitTimeoutMs } = {}) {
  const command = run('git', ['-c', 'core.quotePath=false', '-c', 'diff.relative=false', '-C', directory, ...args], {
    encoding: binary ? 'buffer' : 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 72 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });
  if (input) {
    command.child.stdin.on('error', () => {}); // 错误由子进程退出结果报告
    command.child.stdin.end(input);
  }
  try {
    return (await command).stdout;
  } catch (error) {
    if (error?.killed && error?.signal) {
      const sub = args[0] || 'command';
      const timeoutError = new Error(`Git 命令超时（git ${sub}，超过 ${Math.round(timeout / 1000)} 秒），请检查仓库规模或文件锁状态`);
      timeoutError.gitTimeout = true;
      throw timeoutError;
    }
    throw error;
  }
}

/** 受限并发执行：任一任务失败后停止派发新任务，并等待所有已启动任务完全结束再抛错，防止清理目录后仍有残留写入。 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let firstError = null;
  const worker = async () => {
    while (!firstError && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        if (!firstError) firstError = err;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (firstError) throw firstError;
  return results;
}

const singleLine = value => value.replace(/\r?\n$/, '');
const records = value => value.split('\0').slice(0, -1);
const emptySummary = () => Object.fromEntries(['functions', 'variables'].map(key =>
  [key, { existing: 0, modified: 0, added: 0, deleted: 0 }]));

/**
 * 按需读取未落临时盘的快照内容：
 * - 文件的大小、修改时间和状态变更时间均匹配快照记录时，直接读取普通文件；
 * - 若后续被编辑、删除或替换，则回退到 git cat-file blob 读取精确历史快照。
 */
export class SnapshotBuffers {
  constructor(repoRoot, entries) {
    this._repoRoot = repoRoot;
    this._entries = entries;
    this._cache = new Map();
    this._cachedBytes = 0;
  }
  get size() { return this._entries.size; }
  has(key) { return this._entries.has(key); }
  keys() { return this._entries.keys(); }
  toSnapshot() { return { repoRoot: this._repoRoot, entries: this._entries }; }
  async getAsync(key) {
    const entry = this._entries.get(key);
    if (!entry) return undefined;
    if (entry.buffer) return entry.buffer;
    if (entry.diskPath && entry.size !== undefined) {
      try {
        const info = await lstat(entry.diskPath);
        if (info.isFile() && info.size === entry.size && info.mtimeMs === entry.mtimeMs && info.ctimeMs === entry.ctimeMs) {
          const buf = await readFile(entry.diskPath);
          if (buf.length === entry.size) return buf;
        }
      } catch {
        // 文件改变时改读 Git 对象。
      }
    }
    return entry.oid ? git(this._repoRoot, ['cat-file', 'blob', entry.oid], { binary: true, timeout: 30_000 })
      : entry.diskPath ? readFile(entry.diskPath) : undefined;
  }
  get(key) {
    const entry = this._entries.get(key);
    if (!entry) return undefined;
    if (entry.buffer) return entry.buffer;
    const cached = this._cache.get(key);
    if (cached) {
      this._cache.delete(key);
      this._cache.set(key, cached);
      return cached;
    }
    if (entry.diskPath && entry.size !== undefined && entry.mtimeMs !== undefined) {
      try {
        const info = fs.lstatSync(entry.diskPath);
        if (info.isFile() && !info.isSymbolicLink() && info.size === entry.size && info.mtimeMs === entry.mtimeMs &&
            info.ctimeMs === entry.ctimeMs && info.size <= maxSourceBytes) {
          const buf = fs.readFileSync(entry.diskPath);
          if (buf.length === entry.size) return buf;
        }
      } catch {
        // 文件被删或无法访问时回退到 Git 对象库
      }
    }
    if (!entry.oid && !entry.diskPath) return undefined;
    const buf = entry.oid
      ? execFileSync('git', ['-c', 'core.quotePath=false', '-C', this._repoRoot, 'cat-file', 'blob', entry.oid], {
        encoding: 'buffer',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        maxBuffer: maxSourceBytes + 4096,
        timeout: 30_000,
        windowsHide: true,
      })
      : fs.readFileSync(entry.diskPath);
    if (buf.length > snapshotCacheBytes) return buf;
    while (this._cachedBytes + buf.length > snapshotCacheBytes) {
      const oldest = this._cache.keys().next().value;
      this._cachedBytes -= this._cache.get(oldest).length;
      this._cache.delete(oldest);
    }
    this._cache.set(key, buf);
    this._cachedBytes += buf.length;
    return buf;
  }
  [Symbol.iterator]() {
    const self = this;
    return (function* () {
      for (const key of self._entries.keys()) yield [key, self.get(key)];
    })();
  }
  entries() { return this[Symbol.iterator](); }
  values() {
    const self = this;
    return (function* () {
      for (const key of self._entries.keys()) yield self.get(key);
    })();
  }
}

async function locateRepo(projectPath) {
  let root;
  try {
    root = await realpath(projectPath);
    if (!(await stat(root)).isDirectory()) return { ok: true, isRepo: false, reason: 'projectNotDirectory' };
  } catch {
    return { ok: true, isRepo: false, reason: 'projectNotDirectory' };
  }
  try {
    const output = await git(root, ['rev-parse', '--show-toplevel', '--show-prefix']);
    const separator = output.indexOf('\n');
    const repoRoot = singleLine(output.slice(0, separator + 1));
    const projectPrefix = singleLine(output.slice(separator + 1));
    return { ok: true, isRepo: true, root, repoRoot, projectPrefix };
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

export async function quickGitDirtySummary(projectPath) {
  try {
    const repo = await locateRepo(projectPath);
    if (repo.isRepo) {
      const porcelain = await git(repo.root, [
        'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=normal', '--', ...sourcePathspecs,
      ]);
      return { isRepo: true, dirtyFiles: workingStatus(repo, porcelain).files.map(({ file }) => file) };
    }
  } catch {
    // 快速查询失败时采用和非仓库相同的结果。
  }
  return { isRepo: false, dirtyFiles: [] };
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
      git(repo.root, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', ...sourcePathspecs]),
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
  } catch (error) {
    return { ok: true, isRepo: false, reason: error?.gitTimeout ? 'statusTimeout' : 'statusUnavailable' };
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
  // ls-tree 不支持 :(icase) 魔法路径，仅读树对象元数据本身很快，在内存中按 projectSource 过滤。
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
  const output = await git(repo.root, ['ls-files', '--stage', '--full-name', '-z', '--', ...sourcePathspecs]);
  for (const record of records(output)) {
    const tab = record.indexOf('\t');
    const [mode, object, stage] = record.slice(0, tab).split(' ');
    const file = projectSource(repo, record.slice(tab + 1));
    if (!file || !regularBlob.test(mode) || !oid.test(object)) continue;
    if (!worktree && stage !== '0') throw new Error('请先解决 Git 暂存区中的源码合并冲突：' + file);
    files.set(file, object);
  }
  if (!worktree) {
    const intentOnly = await git(repo.root, [
      'diff', '--name-only', '-z', '--diff-filter=A', '--ita-invisible-in-index', '--no-ext-diff', '--', ...sourcePathspecs,
    ]);
    for (const relative of records(intentOnly)) files.delete(projectSource(repo, relative));
  }
  return files;
}

async function untrackedFiles(repo) {
  const output = await git(repo.root, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ...sourcePathspecs]);
  return records(output).map(file => projectSource(repo, file)).filter(Boolean);
}

/** 找出带 --assume-unchanged（首字母小写）或 --skip-worktree（大写 S）标记的跟踪源码，避免绕过 git diff 脏检查。 */
async function assumeUnchangedFiles(repo) {
  const output = await git(repo.root, ['ls-files', '-v', '--full-name', '-z', '--', ...sourcePathspecs]);
  const flagged = [];
  for (const record of records(output)) {
    if (record.length < 3) continue;
    const tag = record[0];
    if ((tag >= 'a' && tag <= 'z') || tag === 'S') {
      const file = projectSource(repo, record.slice(2));
      if (file) flagged.push(file);
    }
  }
  return flagged;
}

function gitBlobOid(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
}

async function diffNameStatus(repo, refArgs) {
  const diff = await git(repo.root, [
    'diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv',
    ...refArgs, '--', ...sourcePathspecs,
  ]);
  const entries = records(diff);
  const parsed = [];
  for (let i = 0; i < entries.length;) {
    const code = entries[i++];
    const oldFile = projectSource(repo, entries[i++]);
    const renamed = code.startsWith('R');
    const file = renamed || code.startsWith('C') ? projectSource(repo, entries[i++]) : oldFile;
    parsed.push({ code, oldFile, file, renamed });
  }
  return parsed;
}

async function diskSource(repo, relative, configBytes) {
  const expected = path.join(repo.root, relative);
  try {
    const actual = await realpath(expected);
    const info = await lstat(expected);
    if (path.relative(expected, actual) || !info.isFile()) return null;
    if (info.size > maxSourceBytes) throw new Error('Git 源码文件超过 8 MB：' + relative);
    if (configBytes === undefined) {
      const buffer = await readFile(actual);
      if (buffer.length > maxSourceBytes) throw new Error('Git 源码文件超过 8 MB：' + relative);
      return buffer;
    }
    const file = await open(actual, 'r');
    try {
      const current = await file.stat();
      if (!current.isFile()) return null;
      addScheduleBytes(configBytes, current.size);
      const buffer = Buffer.allocUnsafe(current.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) return Buffer.from(buffer.subarray(0, offset));
        offset += bytesRead;
      }
      // fstat 后增长的文件最多再读一字节，避免重新越过预算。
      const { bytesRead } = await file.read(Buffer.allocUnsafe(1), 0, 1, offset);
      if (bytesRead) throw new Error('读取时调度配置已更改，请重试：' + relative);
      return buffer;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** 校验工作区上的未改文件确实存在、非符号链接、父目录无 junction/符号链接且不超过 8 MB。 */
async function verifyCleanDisk(repo, relative, dirRealCache, { throwOversize = false } = {}) {
  const abs = path.join(repo.root, relative);
  let info;
  try {
    info = await lstat(abs);
  } catch {
    return null;
  }
  if (!info.isFile() || info.isSymbolicLink()) return null;
  // 先校验父目录无 junction/符号链接，再判文件大小，避免工程外文件触发超限报错。
  const dir = path.dirname(abs);
  if (!dirRealCache.has(dir)) {
    dirRealCache.set(dir, realpath(dir).then(real => path.relative(dir, real) === '', () => false));
  }
  if (!await dirRealCache.get(dir)) return null;
  if (info.size > maxSourceBytes) {
    if (throwOversize) throw new Error('Git 源码文件超过 8 MB：' + relative);
    return null;
  }
  return { diskPath: abs, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}

/**
 * 增量构建工作区文件集合：仅从磁盘读取 Git 报告有变动或未跟踪的文件，
 * 其余确实存在于工作区的未改文件沿用 baseSha 的 blob OID，避免在几千文件的大仓库里全量读盘。
 */
async function worktreeSnapshot(repo, baseSha, before, includeUntracked) {
  const files = new Map();
  const dirty = new Set();
  let diffEntries = [];
  const toRead = new Set();
  const dirRealCache = new Map();
  let configBytes = 0;

  if (!baseSha) {
    const [tracked, untracked] = await Promise.all([
      indexFiles(repo, true),
      includeUntracked ? untrackedFiles(repo) : [],
    ]);
    for (const file of tracked.keys()) toRead.add(file);
    for (const file of untracked) toRead.add(file);
  } else {
    const [entries, untracked, assumed] = await Promise.all([
      diffNameStatus(repo, [baseSha]),
      includeUntracked ? untrackedFiles(repo) : [],
      assumeUnchangedFiles(repo),
    ]);
    diffEntries = entries;
    for (const { code, oldFile, file, renamed } of entries) {
      if (renamed) {
        if (oldFile) dirty.add(oldFile);
        if (file) { toRead.add(file); dirty.add(file); }
      } else if (code === 'D') {
        if (oldFile) dirty.add(oldFile);
      } else if (file) {
        toRead.add(file);
        dirty.add(file);
      }
    }
    for (const file of untracked) {
      toRead.add(file);
      dirty.add(file);
    }
    for (const file of assumed) {
      toRead.add(file);
      dirty.add(file);
    }
    // 稀疏检出等场景下未落盘文件不在工作区，仅保留真实存在的常规文件；超 8 MB 直接报错不误判删除。
    const unchanged = [...before].filter(([file]) => !dirty.has(file));
    const verified = await mapLimit(unchanged, ioConcurrency, ([file]) =>
      verifyCleanDisk(repo, file, dirRealCache, { throwOversize: true }));
    for (const [i, [file, object]] of unchanged.entries()) {
      const info = verified[i];
      if (!info) continue;
      if (isScheduleFile(file)) configBytes = addScheduleBytes(configBytes, info.size);
      files.set(file, object);
    }
  }

  const readList = [...toRead].sort();
  const scheduleFiles = readList.filter(isScheduleFile);
  let preflightBytes = configBytes;
  for (const file of scheduleFiles) {
    const info = await verifyCleanDisk(repo, file, dirRealCache, { throwOversize: true });
    if (info) preflightBytes = addScheduleBytes(preflightBytes, info.size);
  }

  const diffSet = new Set(diffEntries.flatMap(e => [e.file, e.oldFile]).filter(Boolean));
  const record = (file, data) => {
    if (data === null) files.delete(file);
    else if (!diffSet.has(file) && before.has(file) && gitBlobOid(data) === before.get(file)) {
      // assume-unchanged / skip-worktree 文件经核对内容与基准 blob 完全一致，避免误报修改。
      files.set(file, before.get(file));
    } else files.set(file, data);
  };
  // 依次按已保留的实际字节分配配置缓冲区，避免多个并发读取越过预算。
  for (const file of scheduleFiles) {
    const data = await diskSource(repo, file, configBytes);
    if (data) configBytes = addScheduleBytes(configBytes, data.length);
    record(file, data);
  }
  await mapLimit(readList.filter(file => !isScheduleFile(file)), ioConcurrency, async file =>
    record(file, await diskSource(repo, file)));

  // 基于未改文件的 OID 与改动文件的字节计算工作区指纹。
  const hash = createHash('sha256');
  const sortedNames = [...files.keys()].sort();
  for (const file of sortedNames) {
    const entry = files.get(file);
    if (Buffer.isBuffer(entry)) {
      hash.update(JSON.stringify([file, 'buf', entry.length])).update(entry);
    } else {
      hash.update(JSON.stringify([file, 'oid', entry]));
    }
  }

  return { files, fingerprint: hash.digest('hex'), diffEntries, dirty };
}

async function changedFiles(repo, before, after, baseSha, targetRef, targetSha, precomputedDiff = null) {
  const result = new Map();
  const add = (file, status, oldFile = null) => result.set(file, { file, status, oldFile });
  for (const file of before.keys()) if (!after.has(file)) add(file, 'deleted');
  for (const [file, object] of after) {
    if (!before.has(file)) add(file, 'added');
    else if (Buffer.isBuffer(object) || object !== before.get(file)) add(file, 'modified');
  }
  if (!baseSha || (!targetSha && targetRef === 'HEAD')) return [...result.values()].sort((a, b) => a.file.localeCompare(b.file));
  const entries = precomputedDiff ?? await diffNameStatus(repo, [
    ...(targetRef === indexRef ? ['--cached'] : []),
    baseSha,
    ...(targetSha ? [targetSha] : []),
  ]);
  for (const { oldFile, file, renamed } of entries) {
    if (renamed && oldFile && file && result.get(oldFile)?.status === 'deleted' && result.get(file)?.status === 'added') {
      result.delete(oldFile);
      add(file, 'renamed', oldFile);
    } else if (targetRef === worktreeRef && file && before.has(file) && after.has(file)) {
      add(file, 'modified');
    }
  }
  return [...result.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * 仅对「before 与 after 指向同一 OID（未改动）」且在工作区干净无替换的文件复用磁盘路径：
 * - 两边发生改动的文件一律从 Git 对象库取 blob，避免 ident / autocrlf 检出转换造成 blob 与磁盘字节错配；
 * - 使用 --no-renames 防止暂存重命名后重建旧路径绕过脏检查；
 * - 用 verifyCleanDisk 排除符号链接、父目录 junction 与超过 8 MB 的大文件。
 */
async function cleanDiskInfo(repo, before, after, hint = null) {
  const clean = new Map();
  const dirRealCache = new Map();
  const unchangedOids = new Map();
  for (const [file, object] of before) {
    if (!isScheduleFile(file) && typeof object === 'string' && after.get(file) === object) unchangedOids.set(file, object);
  }
  if (!unchangedOids.size) return clean;

  let dirty = hint?.baseClean ? hint.dirty : null;
  let headFiles = before;
  if (!dirty) {
    const head = hint?.headSha ? { sha: hint.headSha } : await headOf(repo.repoRoot);
    if (!head.sha) return clean;
    const [headEntries, dirtyOutput, assumed] = await Promise.all([
      hint?.headFiles ?? commitFiles(repo, head.sha),
      git(repo.root, [
        'diff', '--name-only', '--no-renames', '-z', '--no-ext-diff', '--no-textconv', head.sha, '--', ...sourcePathspecs,
      ]),
      assumeUnchangedFiles(repo),
    ]);
    headFiles = headEntries;
    dirty = new Set([...records(dirtyOutput).map(file => projectSource(repo, file)).filter(Boolean), ...assumed]);
  }
  await mapLimit([...unchangedOids].filter(([file, object]) => !dirty.has(file) && headFiles.get(file) === object),
    ioConcurrency, async ([file, object]) => {
    const disk = await verifyCleanDisk(repo, file, dirRealCache);
    if (disk) clean.set(file, { oid: object, ...disk });
  });
  return clean;
}

async function fetchBlobs(repo, before, after, cleanDisk) {
  const blobs = new Map();
  const ids = [...new Set([...before.entries(), ...after.entries()]
    .filter(([file, entry]) => typeof entry === 'string' && cleanDisk.get(file)?.oid !== entry)
    .map(([, entry]) => entry))];
  const sizes = new Map();
  let entries = [];
  if (ids.length) {
    const check = await git(repo.repoRoot, ['cat-file', '--batch-check'], { input: ids.join('\n') + '\n' });
    entries = singleLine(check).split('\n').map((line, i) => {
      const [id, type, length] = line.split(' ');
      const size = Number(length);
      if (id !== ids[i] || type !== 'blob' || !Number.isSafeInteger(size) || size < 0 || size > maxSourceBytes) {
        throw new Error('Git 源码对象无法读取或超过 8 MB：' + ids[i]);
      }
      sizes.set(id, size);
      return { id, size };
    });
    if (entries.length !== ids.length) throw new Error('Git 返回的源码对象不完整');
  }
  for (const files of [before, after]) {
    let configBytes = 0;
    for (const [file, object] of files) {
      if (!isScheduleFile(file)) continue;
      const size = typeof object === 'string' ? sizes.get(object) : object.length;
      configBytes = addScheduleBytes(configBytes, size);
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

async function materialize(repo, directory, entries, blobs, cleanDisk) {
  const files = new Map();
  const bufferEntries = new Map();
  const toWrite = [];
  const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b));
  for (const [relative, entry] of sorted) {
    const clean = typeof entry === 'string' ? cleanDisk.get(relative) : null;
    if (clean && clean.oid === entry) {
      files.set(relative, clean.diskPath);
      if (!isScheduleFile(relative)) {
        bufferEntries.set(relative, clean);
      }
      continue;
    }
    const bytes = typeof entry === 'string' ? blobs.get(entry) : entry;
    const target = path.join(directory, relative);
    files.set(relative, target);
    if (!isScheduleFile(relative)) {
      // Git blob 可按 OID 重读，未提交的工作区内容需要保留比较当时的字节。
      bufferEntries.set(relative, typeof entry === 'string' ? { oid: entry } : { buffer: bytes });
    }
    toWrite.push({ target, bytes });
  }
  const dirPromises = new Map();
  await mapLimit(toWrite, ioConcurrency, async ({ target, bytes }) => {
    const dir = path.dirname(target);
    let ready = dirPromises.get(dir);
    if (!ready) {
      ready = mkdir(dir, { recursive: true });
      dirPromises.set(dir, ready);
    }
    await ready;
    await writeFile(target, bytes, { flag: 'wx' });
  });
  return { files, bufferEntries, buffers: new SnapshotBuffers(repo.repoRoot, bufferEntries) };
}

function hasSameSources(before, after, blobs) {
  const beforeSrc = [...before].filter(([file]) => !isScheduleFile(file));
  const afterSrc = [...after].filter(([file]) => !isScheduleFile(file));
  if (beforeSrc.length !== afterSrc.length) return false;
  for (const [file, a] of beforeSrc) {
    if (!after.has(file)) return false;
    const b = after.get(file);
    if (a === b) continue;
    const bufA = typeof a === 'string' ? blobs.get(a) : a;
    const bufB = typeof b === 'string' ? blobs.get(b) : b;
    if (!bufA || !bufB || !bufA.equals(bufB)) return false;
  }
  return true;
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
  const buildProfile = selectedBuildProfile(repo.root, compareOptions.parserOptions);
  compareOptions = { ...compareOptions, buildProfile };
  const base = await resolveCommit(repo, baseRef);
  const target = targetRef === worktreeRef || targetRef === indexRef ? null : await resolveCommit(repo, targetRef);
  const before = await commitFiles(repo, base.sha);
  let worktree = null;
  let targetFiles = null;
  if (targetRef === worktreeRef) worktree = await worktreeSnapshot(repo, base.sha, before, includeUntracked);
  else if (targetRef === indexRef) targetFiles = await indexFiles(repo);
  else if (target) targetFiles = await commitFiles(repo, target.sha);

  const after = worktree?.files ?? targetFiles;
  const changes = await changedFiles(repo, before, after, base.sha, targetRef, target?.sha, worktree?.diffEntries ?? null);
  const metadata = {
    mode: 'git', baseRef, baseLabel: base.shortSha ? baseRef + ' (' + base.shortSha + ')' : baseRef, baseSha: base.sha,
    targetRef, targetLabel: target?.shortSha ? targetRef + ' (' + target.shortSha + ')' : targetRef, targetSha: target?.sha ?? null,
    includeUntracked, changedFiles: changes, worktreeFingerprint: worktree?.fingerprint ?? null,
    noSourceChanges: !changes.length, importFacts: emptyFacts(), commentOnlyFiles: [],
  };
  const immediateHint = targetRef === worktreeRef && base.sha
    ? { baseClean: true, dirty: worktree.dirty }
    : baseRef === 'HEAD' && base.sha
    ? { headSha: base.sha, headFiles: before }
    : targetRef === 'HEAD' && target?.sha
    ? { headSha: target.sha, headFiles: after }
    : null;
  // 延迟分析时工作区可能已继续编辑，不再沿用首次的 cleanDisk 提示，改为重新核对。
  const analyze = async (hint = null) => {
    const parserId = compareOptions.parserId || 'builtin';
    if (parserId !== 'builtin') {
      return analyzeGitSnapshot(repo, before, after, metadata, compareOptions, hint);
    }
    const key = JSON.stringify([repo.repoRoot, repo.projectPrefix, baseRef, base.sha, targetRef, target?.sha,
      worktree?.fingerprint, includeUntracked, parserId, compareOptions.parserOptions || null, buildProfile]);
    // INDEX 没有提交 SHA，需核对暂存对象。重命名结果也可能随 Git 配置变化。
    const validation = JSON.stringify([targetRef === indexRef ? [...after].sort() : null, changes,
      metadata.baseLabel, metadata.targetLabel]);
    const entry = analyzedComparisons.get(key);
    let cached;
    if (entry?.validation === validation) {
      cached = entry.result;
    } else {
      cached = await analyzeGitSnapshot(repo, before, after, metadata, compareOptions, hint);
    }
    analyzedComparisons.delete(key);
    analyzedComparisons.set(key, { validation, result: cached });
    if (analyzedComparisons.size > analyzedComparisonLimit) {
      analyzedComparisons.delete(analyzedComparisons.keys().next().value);
    }
    return { ...cached, git: { ...cached.git } };
  };
  if (!changes.length && !compareOptions.allowEmptyRefresh) {
    return { projectPath: repo.root, git: metadata, summary: emptySummary(), roots: [], candidates: [],
      changePoints: [], impactIds: [], macroChanges: [], macroDetails: [], warnings: [], mappings: [], totalNodes: 0,
      ...(compareOptions.deferUnchangedAnalysis ? { analyze: () => analyze(null) } : {}) };
  }
  return analyze(immediateHint);
}

/** 固定两侧的源码及调度配置，批量提取的 blob 在写完临时文件后即可释放。 */
async function materializeSnapshots(repo, before, after, beforePath, afterPath, cleanHint) {
  const cleanDisk = await cleanDiskInfo(repo, before, after, cleanHint);
  const blobs = await fetchBlobs(repo, before, after, cleanDisk);
  await mkdir(beforePath);
  await mkdir(afterPath);
  const settled = await Promise.allSettled([
    materialize(repo, beforePath, before, blobs, cleanDisk),
    materialize(repo, afterPath, after, blobs, cleanDisk),
  ]);
  const failed = settled.find(item => item.status === 'rejected');
  if (failed) throw failed.reason;
  const [beforeSnapshot, afterSnapshot] = settled.map(item => item.value);
  return { beforeSnapshot, afterSnapshot, sameSources: hasSameSources(before, after, blobs) };
}

async function analyzeGitSnapshot(repo, before, after, metadata, compareOptions, cleanHint = null) {
  const changes = metadata.changedFiles;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'callgraph-git-'));
  try {
    const beforePath = path.join(temporary, 'before'), afterPath = path.join(temporary, 'after');
    const { beforeSnapshot, afterSnapshot, sameSources } = await materializeSnapshots(
      repo, before, after, beforePath, afterPath, cleanHint,
    );
    const { runComparison = compareProjects, ...options } = compareOptions;
    const comparison = await runComparison(repo.root, beforePath, afterPath, {
      ...options,
      snapshots: { beforeFiles: beforeSnapshot.files, afterFiles: afterSnapshot.files, mappings: [], sameSources },
    });
    metadata.importFacts = importFacts(comparison);
    const semanticFiles = new Set(comparison.changePoints.map(point => point.file));
    const snapshotFingerprint = async (snapshot, file) => {
      const entry = snapshot.bufferEntries.get(file);
      const bytes = entry.diskPath ? await snapshot.buffers.getAsync(file)
        : entry.buffer ?? await readFile(snapshot.files.get(file));
      return fingerprint(decodeSource(bytes));
    };
    const candidates = changes.filter(({ file, status }) => status === 'modified' && sourceExtension.test(file) && !semanticFiles.has(file));
    metadata.commentOnlyFiles = (await mapLimit(candidates, ioConcurrency, async ({ file }) => {
      const [before, after] = await Promise.all([snapshotFingerprint(beforeSnapshot, file), snapshotFingerprint(afterSnapshot, file)]);
      return before === after ? file : null;
    })).filter(Boolean);
    retainSnapshot(comparison.beforeModel, beforeSnapshot.buffers);
    retainSnapshot(comparison.afterModel, afterSnapshot.buffers);
    retainSnapshot(comparison.model, new SnapshotBuffers(repo.repoRoot,
      new Map([...beforeSnapshot.bufferEntries, ...afterSnapshot.bufferEntries])));
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
