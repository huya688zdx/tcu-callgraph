import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SRC_EXT } from '../source-files.js';

export const fileKey = (rel) => process.platform === 'win32' ? rel.toLowerCase() : rel;

export function detectClang(customBin) {
  const bin = customBin || process.env.CALLGRAPH_CLANG || 'clang';
  try {
    const version = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).split(/\r?\n/)[0];
    if (!/clang version/i.test(version)) throw new Error('未返回 Clang 版本');
    return { ok: true, bin, version, reason: null };
  } catch (error) {
    return { ok: false, bin, version: null, reason: `无法运行 Clang（${bin}）：${error.code || error.message}` };
  }
}

export function relativeFile(root, file) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  return rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) ? null : rel;
}

export function findCompileCommands(root, explicit) {
  if (explicit) return path.resolve(root, explicit);
  return [path.join(root, 'compile_commands.json'), path.join(root, 'build', 'compile_commands.json')]
    .find((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile()) || null;
}

export function clangCacheKey(root, options, status) {
  const file = findCompileCommands(root, options.compileCommandsPath);
  const st = file && fs.statSync(file, { throwIfNoEntry: false });
  return JSON.stringify(['clang-ast', 'v1', root, status.bin, status.version, file, st?.mtimeMs, st?.size]);
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

function clangArguments(args, directory, remap) {
  const result = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const flag = flags.find((f) => arg === f || arg.startsWith(f + '=')
      || (['-I', '-D', '-U', '-isystem', '-iquote', '-idirafter'].includes(f) && arg.startsWith(f)));
    if (!flag) {
      if (/^-f(?:no-)?(?:ms-extensions|ms-compatibility|short-enums|short-wchar|signed-char|unsigned-char|freestanding|builtin)$/.test(arg)) result.push(arg);
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

export function readCompileCommands(root, file, { files, remap = (p) => p } = {}) {
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
    if ((allowed && !allowed.has(id)) || units.has(id)) continue;
    const args = Array.isArray(entry.arguments) ? entry.arguments
      : typeof entry.command === 'string' ? splitCommand(entry.command) : [];
    if (!args.length || args.some((arg) => typeof arg !== 'string')) {
      throw new Error(`compile_commands.json 条目缺少有效编译参数：${rel}`);
    }
    units.set(id, { rel: allowed?.get(id) || rel, file: remap(abs), cwd: remap(directory), args: clangArguments(args, directory, remap) });
  }
  return [...units.values()];
}
