import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { decodeSource, SRC_EXT } from '../source-files.js';

export const fileKey = (rel) => process.platform === 'win32' ? rel.toLowerCase() : rel;

const clangDetectCache = new Map();

export function detectClang(customBin, { refresh = false } = {}) {
  const bin = customBin || process.env.CALLGRAPH_CLANG || 'clang';
  if (!refresh && clangDetectCache.has(bin)) return clangDetectCache.get(bin);
  let result;
  try {
    const version = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).split(/\r?\n/)[0];
    if (!/clang version/i.test(version)) throw new Error('未返回 Clang 版本');
    result = { ok: true, bin, version, reason: null };
  } catch (error) {
    result = { ok: false, bin, version: null, reason: `无法运行 Clang（${bin}）：${error.code || error.message}` };
  }
  clangDetectCache.set(bin, result);
  return result;
}

export function relativeFile(root, file) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  return rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) ? null : rel;
}

export function findCompileCommands(root, explicit) {
  if (explicit) return path.resolve(root, explicit);
  return [path.join(root, 'compile_commands.json'), path.join(root, 'build', 'compile_commands.json')]
    .find((file) => fs.statSync(file, { throwIfNoEntry: false })) || null;
}

export function clangCacheKey(root, options, status) {
  const file = findCompileCommands(root, options.compileCommandsPath);
  const st = file && fs.statSync(file, { throwIfNoEntry: false });
  return JSON.stringify([
    'clang-ast', 'v7', root, status.bin, status.version, file, st?.mtimeMs, st?.size,
    Boolean(options.strictCompileCommands), options.buildProfileId || null,
  ]);
}

/** 只拆分参数，不展开变量、重定向或执行编译数据库里的命令。 */
function splitCommand(command) {
  const windows = process.platform === 'win32';
  const args = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && quote !== "'") {
      if (windows) {
        let end = i + 1;
        while (command[end] === '\\') end++;
        const count = end - i;
        if (command[end] === '"') {
          word += '\\'.repeat(Math.floor(count / 2));
          if (count % 2) { word += '"'; i = end; }
          else i = end - 1;
        } else {
          word += '\\'.repeat(count);
          i = end - 1;
        }
      } else if (i + 1 < command.length && (!quote || /["\\$]/.test(command[i + 1]))) {
        word += command[++i];
      } else word += ch;
    } else if ((ch === '"' || (ch === "'" && !windows)) && (!quote || quote === ch)) {
      quote = quote ? '' : ch;
    } else if (!quote && /\s/.test(ch)) {
      if (started) args.push(word);
      word = ''; started = false;
      continue;
    } else word += ch;
    started = true;
  }
  if (quote) throw new Error('compile_commands.json 的 command 含未闭合引号');
  if (started) args.push(word);
  return args;
}

const pathFlags = new Set(['-I', '-isystem', '-iquote', '-idirafter', '-include', '-imacros', '--sysroot', '-isysroot']);
const valueFlags = new Set(['-D', '-U', '-std', '-x', '-target', '--target']);
const flags = [...pathFlags, ...valueFlags].sort((a, b) => b.length - a.length);

function responseDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function expandResponseTokens(args, directory, responseFiles, seen = new Set(), depth = 0) {
  if (depth > 6) return args;
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const isCompilerSlot = depth === 0 && i === 0;
    const prev = i > 0 ? args[i - 1] : null;
    const isOptionOperand = typeof prev === 'string' && (pathFlags.has(prev) || valueFlags.has(prev));
    if (!isCompilerSlot && !isOptionOperand && typeof arg === 'string' && arg.length > 1 &&
        (arg.startsWith('@') || arg.startsWith('-@'))) {
      const rawPath = arg.startsWith('-@') ? arg.slice(2) : arg.slice(1);
      const target = path.resolve(directory, rawPath);
      const key = fileKey(target);
      const exists = fs.statSync(target, { throwIfNoEntry: false })?.isFile();
      if (!exists) responseFiles?.set(target, null);
      if (!seen.has(key) && exists) {
        seen.add(key);
        const bytes = fs.readFileSync(target);
        responseFiles?.set(target, responseDigest(bytes));
        const text = decodeSource(bytes).replace(/^\uFEFF/, '');
        const nested = splitCommand(text.replace(/\r?\n/g, ' '));
        out.push(...expandResponseTokens(nested, directory, responseFiles, seen, depth + 1));
        seen.delete(key);
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}

function clangArguments(rawArgs, directory, remap, responseFiles) {
  const args = expandResponseTokens(rawArgs, directory, responseFiles);
  const result = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const flag = flags.find((f) => arg === f || arg.startsWith(f + '=')
      || (['-I', '-D', '-U', '-isystem', '-iquote', '-idirafter'].includes(f) && arg.startsWith(f)));
    if (!flag) {
      if (/^-f(?:no-)?(?:ms-extensions|ms-compatibility|gnu-keywords|short-enums|short-wchar|signed-char|unsigned-char|freestanding|builtin)$/.test(arg) ||
          /^-Wno-(?:unknown-pragmas|attributes|gnu|incompatible-pointer-types)$/.test(arg)) {
        result.push(arg);
      }
      continue;
    }
    const value = arg === flag ? args[++i] : arg.slice(flag.length).replace(/^=/, '');
    if (!value || value.startsWith('@') || (arg === flag && value.startsWith('-'))) {
      throw new Error(`compile_commands.json 编译选项缺少有效参数：${flag}`);
    }
    const abs = pathFlags.has(flag) ? path.resolve(directory, value) : null;
    // 对强制包含，保留按 -I 搜索的文件名，除非它确实是相对于原工作目录的文件。
    const normalized = abs && (!['-include', '-imacros'].includes(flag) || path.isAbsolute(value)
      || fs.existsSync(abs)) ? remap(abs) : value;
    if (flag === '-std' || flag === '--target' || flag === '--sysroot') result.push(`${flag}=${normalized}`);
    else result.push(flag, normalized);
  }
  return result;
}

export function readCompileCommands(root, file, { files, remap = (p) => p, includeTemplates = false, responseFiles } = {}) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) {
    throw new Error(`compile_commands.json 必须是 64 MiB 以内的普通文件：${file}`);
  }
  const database = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(database)) throw new Error('compile_commands.json 必须是数组');
  const allowed = files && new Map(files.map((f) => [fileKey(f.rel), f.rel]));
  const units = new Map();
  for (const entry of database) {
    if (typeof entry?.file !== 'string' || typeof entry.directory !== 'string') {
      throw new Error('compile_commands.json 条目缺少 file 或 directory');
    }
    const directory = path.resolve(path.dirname(file), entry.directory);
    const abs = path.resolve(directory, entry.file);
    const rel = relativeFile(root, abs);
    if (!rel || !SRC_EXT.test(abs)) continue;
    const id = fileKey(rel);
    if ((allowed && !allowed.has(id) && !includeTemplates) || units.has(id)) continue;
    const args = Array.isArray(entry.arguments) ? entry.arguments
      : typeof entry.command === 'string' ? splitCommand(entry.command) : [];
    if (!args.length || args.some((arg) => typeof arg !== 'string')) {
      throw new Error(`compile_commands.json 条目缺少有效编译参数：${rel}`);
    }
    units.set(id, { rel: allowed?.get(id) || rel, file: remap(abs), cwd: remap(directory), args: clangArguments(args, directory, remap, responseFiles), ...(includeTemplates && { templateOnly: !allowed?.has(id) }) });
  }
  return [...units.values()];
}

export function completeCompileUnits(entries, files, fallbackArgs) {
  const units = entries.filter(entry => !entry.templateOnly);
  const covered = new Set(units.map(entry => fileKey(entry.rel)));
  const templates = entries.filter(entry => /\.c$/i.test(entry.rel));
  const depth = (a, b) => {
    const left = fileKey(a).split('/').slice(0, -1);
    const right = fileKey(b).split('/').slice(0, -1);
    let i = 0;
    while (i < left.length && left[i] === right[i]) i++;
    return i;
  };
  for (const file of files) {
    if (!/\.c$/i.test(file.rel) || covered.has(fileKey(file.rel))) continue;
    let best, score = -1;
    for (const template of templates) {
      const common = path.posix.dirname(fileKey(file.rel)) === path.posix.dirname(fileKey(template.rel))
        ? Infinity : depth(file.rel, template.rel);
      if (common > score) { best = template; score = common; }
    }
    units.push({ rel: file.rel, file: file.abs, cwd: path.dirname(file.abs), args: best?.args ?? fallbackArgs });
  }
  return units;
}

export function dependencyStamp(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? { file, size: stat.size, mtimeMs: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

export function externalDependenciesCurrent(model) {
  for (const file of model.missingIncludes || []) {
    try { if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return false; }
    catch { return false; }
  }
  for (const [file, digest] of model.responseFiles || []) {
    try {
      const current = fs.statSync(file, { throwIfNoEntry: false })?.isFile()
        ? responseDigest(fs.readFileSync(file)) : null;
      if (current !== digest) return false;
    } catch { return false; }
  }
  return (model.externalDeps || []).every(dep => {
    const current = dependencyStamp(dep.file);
    return current && current.size === dep.size && current.mtimeMs === dep.mtimeMs;
  });
}
