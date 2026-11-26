/**
 * 工程构建配置发现与 compile_commands.json 生成器：
 * - 多核/单核 Eclipse CDT（支持多个 .cproject，按 configurationName / <configuration> 拆分机种，解析 -I/-D/excluding）
 * - 纯 Make / 多 .mak 工程（支持 !include / include / -include、.mac、$(CDIR) 等变量展开、@rsp / -f 响应文件）
 * - QAC 配置（.prj / .via / prqaproject.xml）
 * - Green Hills RH850 / V850 (ccrh850 / ccv850 / v800) Clang AST 兼容垫片头
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeSource, SRC_EXT } from './source-files.js';
import { scanBuildConfig } from './build-inspect.js';

const MAX_INCLUDE_DEPTH = 12;
const MAX_RSP_DEPTH = 6;
const MAX_CONFIG_FILE_BYTES = 8 * 1024 * 1024;

const toPosix = (p) => String(p || '').replace(/\\/g, '/');
const fileKey = (rel) => (process.platform === 'win32' ? rel.toLowerCase() : rel);

function safeReadText(absPath) {
  const st = fs.statSync(absPath, { throwIfNoEntry: false });
  if (!st?.isFile() || st.size > MAX_CONFIG_FILE_BYTES) return null;
  const buf = fs.readFileSync(absPath);
  const isUtf16 = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
  if (!isUtf16 && buf.includes(0)) return null;
  return decodeSource(buf);
}

function stripQuotes(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/&quot;/gi, '"').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function extractXmlAttr(tag, attr) {
  const m = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : '';
}

function detectArchAndCompiler(text) {
  const s = String(text || '');
  if (/\bccrh850\b|\brh850\b/i.test(s)) return { arch: 'rh850', compiler: 'ccrh850 (GHS)' };
  if (/\bccv850\b|\bcxv850\b|\bv850\b/i.test(s)) return { arch: 'v850', compiler: 'ccv850 (GHS)' };
  if (/\bv800\b/i.test(s)) return { arch: 'rh850', compiler: 'GHS v800' };
  if (/\bccrh\b/i.test(s)) return { arch: 'rh850', compiler: 'ccrh (Renesas)' };
  if (/\bca850\b/i.test(s)) return { arch: 'v850', compiler: 'ca850 (Renesas)' };
  if (/\btricore-gcc\b|\bctc\b|\btasking\b/i.test(s)) return { arch: 'tricore', compiler: 'TriCore' };
  if (/\barm-none-eabi-gcc\b|\bccarm\b/i.test(s)) return { arch: 'arm', compiler: 'ARM' };
  if (/\bgcc\b|\bg\+\+\b/i.test(s)) return { arch: 'generic', compiler: 'GCC' };
  return { arch: 'generic', compiler: 'C' };
}

/** 将 Eclipse CDT 排除模式（如 z115/**|foo/*.c|unused）转为匹配函数（单趟编译避免二次替换串扰）。 */
function compileExclusionMatcher(baseDirRel, rawExcluding) {
  const patterns = String(rawExcluding || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (!patterns.length) return () => false;
  const globToRegex = (glob) => {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
      if (glob.startsWith('**/', i)) {
        out += '(?:.*/)?';
        i += 2;
      } else if (glob.startsWith('**', i)) {
        out += '.*';
        i += 1;
      } else if (glob[i] === '*') {
        out += '[^/]*';
      } else if (glob[i] === '?') {
        out += '[^/]';
      } else {
        out += glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
    }
    return out;
  };
  const regexes = patterns.map((pat) => {
    const clean = toPosix(pat).replace(/^\/+/, '').replace(/\/+$/, '');
    const full = baseDirRel && baseDirRel !== '.' ? `${baseDirRel}/${clean}` : clean;
    return new RegExp(`^${globToRegex(full)}(?:/.*)?$`, process.platform === 'win32' ? 'i' : '');
  });
  return (rel) => regexes.some((re) => re.test(toPosix(rel)));
}

/** 展开 Eclipse ${workspace_loc:...} / ${ProjDirPath} / ${ConfigName} 变量。 */
function resolveEclipsePath(raw, { rootDir, projectDir, configName, projectName }) {
  let s = stripQuotes(raw);
  if (!s) return null;
  s = s.replace(/\$\{workspace_loc:\/([^}]+)\}/gi, (_, inner) => {
    const parts = toPosix(inner).split('/').filter(Boolean);
    if (parts.length && projectName && parts[0].toLowerCase() === projectName.toLowerCase()) {
      return path.resolve(projectDir, parts.slice(1).join('/'));
    }
    const fromRoot = path.resolve(rootDir, parts.join('/'));
    if (fs.existsSync(fromRoot)) return fromRoot;
    const fromProj = path.resolve(projectDir, parts.slice(1).join('/'));
    if (parts.length > 1 && fs.existsSync(fromProj)) return fromProj;
    return fromRoot;
  });
  s = s.replace(/\$\{workspace_loc\}/gi, rootDir);
  s = s.replace(/\$\{ProjDirPath\}/gi, projectDir);
  s = s.replace(/\$\{ProjName\}/gi, projectName || path.basename(projectDir));
  s = s.replace(/\$\{ConfigName\}/gi, configName || '');
  s = s.replace(/\$\{CWD\}/gi, projectDir);
  if (/\$\{[^}]+\}/.test(s)) return null;
  return path.isAbsolute(s) ? path.normalize(s) : path.resolve(projectDir, s);
}

/** 拆分命令行字符串（兼容双引号、单引号与 Windows 路径反斜杠）。 */
function tokenizeArgs(line) {
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && quote !== "'" && line[i + 1] === '"') {
      cur += '"';
      i++;
      continue;
    }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? '' : ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** 从一段编译参数（含 @rsp / -f 响应文件）提取 -I、-D、-U、-include 与 .c 源路径。 */
function extractCompilerFlags(rawTokens, baseDir, rootDir, out, seenRsp = new Set(), depth = 0) {
  if (depth > MAX_RSP_DEPTH) return;
  for (let i = 0; i < rawTokens.length; i++) {
    const tok = stripQuotes(rawTokens[i]);
    if (!tok) continue;

    // 响应文件：@file.rsp / -@file.rsp / -f file.opt
    if (tok.startsWith('@') || tok.startsWith('-@') || (tok === '-f' && rawTokens[i + 1])) {
      const rspRaw = tok === '-f' ? stripQuotes(rawTokens[++i]) : tok.replace(/^-?@/, '');
      if (rspRaw && !rspRaw.startsWith('-')) {
        const candidates = [path.resolve(baseDir, rspRaw), path.resolve(rootDir, rspRaw)];
        const rspPath = candidates.find((p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile());
        if (rspPath && !seenRsp.has(fileKey(rspPath))) {
          seenRsp.add(fileKey(rspPath));
          const rspText = safeReadText(rspPath);
          if (rspText) {
            const cleaned = rspText.replace(/(?:^|\s)#[^\r\n]*/g, ' ');
            extractCompilerFlags(tokenizeArgs(cleaned), baseDir, rootDir, out, seenRsp, depth + 1);
          }
          seenRsp.delete(fileKey(rspPath));
        }
      }
      continue;
    }

    // -I / -I= / -isystem / -i (部分 GHS / QAC 风格)
    if (/^(?:-I|-isystem|-iquote|-i)(?:=|$)/.test(tok) || (/^-[Ii]/.test(tok) && tok.length > 2 && !/^-(?:include|imacros|isystem|iquote|idirafter|inline|ir|iso)/.test(tok))) {
      let val = '';
      if (/^(?:-I|-isystem|-iquote|-i)=?$/.test(tok)) {
        val = stripQuotes(rawTokens[++i] || '');
      } else {
        val = stripQuotes(tok.replace(/^(?:-I|-isystem|-iquote|-i)=?/, ''));
      }
      if (val && !val.startsWith('-') && !/\$\(/.test(val)) {
        const abs = path.isAbsolute(val) ? path.normalize(val) : path.resolve(baseDir, val);
        out.includeDirs.add(abs);
      }
      continue;
    }

    // -D / -D= / -d (QAC)
    if (/^-[Dd](?:=|$)/.test(tok) || (/^-D/.test(tok) && tok.length > 2)) {
      let val = '';
      if (/^-[Dd]=?$/.test(tok)) val = stripQuotes(rawTokens[++i] || '');
      else val = stripQuotes(tok.replace(/^-[Dd]=?/, ''));
      if (val && /^[A-Za-z_][A-Za-z0-9_]*(?:=.*)?$/.test(val)) {
        (out.macroArgs ||= []).push('-D', val);
        for (const old of out.defines) if (old.split('=')[0] === val.split('=')[0]) out.defines.delete(old);
        out.defines.add(val);
      }
      continue;
    }

    if (tok === '-U' || tok.startsWith('-U')) {
      const name = tok === '-U' ? stripQuotes(rawTokens[++i] || '') : tok.slice(2);
      if (/^[A-Za-z_]\w*$/.test(name)) {
        (out.macroArgs ||= []).push('-U', name);
        for (const old of out.defines) if (old.split('=')[0] === name) out.defines.delete(old);
      }
      continue;
    }

    // -include / -preinclude / -fi (QAC forced include)
    if (/^(?:-include|-preinclude|--preinclude|-fi)=?$/.test(tok) || /^(?:-include|-preinclude|--preinclude)=/.test(tok)) {
      let val = '';
      if (tok.includes('=')) val = stripQuotes(tok.slice(tok.indexOf('=') + 1));
      else val = stripQuotes(rawTokens[++i] || '');
      if (val && !val.startsWith('-')) {
        const abs = path.isAbsolute(val) ? path.normalize(val) : path.resolve(baseDir, val);
        out.forcedIncludes.add(fs.existsSync(abs) ? abs : val);
      }
      continue;
    }

    // 源码文件引用
    if (SRC_EXT.test(tok) && !tok.startsWith('-') && !/[*?<>]/.test(tok) && !/\$\(/.test(tok)) {
      const candidates = [path.resolve(baseDir, tok), path.resolve(rootDir, tok)];
      candidates.sort((a, b) => Number(!!fs.statSync(b, { throwIfNoEntry: false })?.isFile()) - Number(!!fs.statSync(a, { throwIfNoEntry: false })?.isFile()));
      for (const abs of candidates) {
        const rel = toPosix(path.relative(rootDir, abs));
        if (rel && !rel.startsWith('../') && !path.isAbsolute(rel)) {
          out.sourceFiles.add(rel);
          break;
        }
      }
    }
  }
}

function expandMakeVars(str, vars, depth = 0) {
  if (!str || depth > 8 || !str.includes('$')) return str;
  return str.replace(/\$\(([\w.-]+)\)|\$\{([\w.-]+)\}/g, (_, a, b) => {
    const variable = vars.get(a || b);
    if (!variable) return '';
    return variable.simple ? variable.value : expandMakeVars(variable.value, vars, depth + 1);
  });
}

/** 递归解析 .mak / .mac / Makefile（支持 !include、include、-include、$(CDIR) 与 @rsp）。 */
export function parseMakefileTree(entryAbs, rootDir) {
  const entryDir = path.dirname(entryAbs);
  const defaults = {
    CC: 'cc',
    CXX: 'g++',
    CDIR: entryDir,
    CURDIR: entryDir,
    TOPDIR: rootDir,
    ROOTDIR: rootDir,
    PROJ_DIR: entryDir,
    PROJECT_DIR: entryDir,
  };
  const vars = new Map(Object.entries(defaults).map(([name, value]) => [name, { value, simple: true }]));
  const recipes = [];
  const rules = new Map();
  let defaultGoal;
  const collected = {
    includeDirs: new Set(),
    defines: new Set(),
    forcedIncludes: new Set(),
    sourceFiles: new Set(),
    includedFiles: [],
  };
  const visited = new Set();

  const processFile = (absPath, depth) => {
    if (depth > MAX_INCLUDE_DEPTH) return;
    const key = fileKey(absPath);
    if (visited.has(key)) return;
    visited.add(key);
    const text = safeReadText(absPath);
    if (!text) return;
    const dir = path.dirname(absPath);
    collected.includedFiles.push(toPosix(path.relative(rootDir, absPath)));

    // 合并反斜杠续行
    const rawLines = text.split(/\r\n|\r|\n/);
    const lines = [];
    let buf = '';
    for (const line of rawLines) {
      if (buf) {
        buf += ' ' + line.trim();
      } else {
        buf = line;
      }
      if (/\\\s*$/.test(buf)) {
        buf = buf.replace(/\\\s*$/, '');
      } else {
        lines.push(buf);
        buf = '';
      }
    }
    if (buf) lines.push(buf);

    const conditions = [];
    const active = () => conditions.every(c => c.active);
    const evaluate = (kind, operand) => {
      if (kind === 'ifdef' || kind === 'ifndef') {
        const value = vars.get(expandMakeVars(operand.trim(), vars))?.value || '';
        return kind === 'ifdef' ? value !== '' : value === '';
      }
      const expanded = expandMakeVars(operand, vars).trim();
      const pair = expanded.startsWith('(') && expanded.endsWith(')')
        ? expanded.slice(1, -1).split(',').map(v => v.trim()) : tokenizeArgs(expanded);
      if (pair.length !== 2) throw new Error(`不支持的 Make 条件: ${kind} ${operand}`);
      return kind === 'ifeq' ? pair[0] === pair[1] : pair[0] !== pair[1];
    };
    let prerequisites = '';
    let targets = [];
    for (const rawLine of lines) {
      const line = rawLine.replace(/^\s*#.*$/, '').trim();
      if (!line) continue;
      if (!rawLine.startsWith('\t')) {
        const conditional = /^(ifeq|ifneq|ifdef|ifndef)\s+(.+)$/.exec(line);
        if (conditional) {
          const parent = active();
          const taken = parent && evaluate(conditional[1], conditional[2]);
          conditions.push({ parent, active: taken, taken });
          continue;
        }
        if (/^else(?:\s|$)/.test(line)) {
          const frame = conditions.at(-1);
          if (!frame) throw new Error('Make else 缺少条件');
          const tail = line.slice(4).trim();
          const chained = /^(ifeq|ifneq|ifdef|ifndef)\s+(.+)$/.exec(tail);
          if (tail && !chained) throw new Error(`不支持的 Make 条件: ${line}`);
          frame.active = frame.parent && !frame.taken && (!chained || evaluate(chained[1], chained[2]));
          frame.taken ||= frame.active;
          continue;
        }
        if (line === 'endif') { if (!conditions.pop()) throw new Error('Make endif 缺少条件'); continue; }
        if (/^!\s*(?:if|else|endif)/i.test(line)) throw new Error(`不支持的 Make 条件: ${line}`);
      }
      if (!active()) continue;
      if (rawLine.startsWith('\t')) {
        recipes.push({ command: line, prerequisites, targets });
        continue;
      }

      // !include / include / -include / sinclude
      const incMatch = /^(?:!|-|s)?include\s+(.+)$/i.exec(line);
      if (incMatch) {
        const expanded = expandMakeVars(incMatch[1], vars);
        for (const token of tokenizeArgs(expanded)) {
          const clean = stripQuotes(token);
          if (!clean || /\$\(/.test(clean)) continue;
          const candidates = [path.resolve(dir, clean), path.resolve(entryDir, clean), path.resolve(rootDir, clean)];
          const found = candidates.find((p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile());
          if (found) processFile(found, depth + 1);
        }
        continue;
      }

      // 变量定义：VAR = / := / ?= / += val
      const assignMatch = /^(?:export\s+)?([\w.-]+)\s*([:+?]?=)\s*(.*)$/.exec(line);
      if (assignMatch) {
        const [, varName, op, rhsRaw] = assignMatch;
        const previous = vars.get(varName);
        if (op === '?=' && previous) continue;
        const simple = op === ':=' || (op === '+=' && Boolean(previous?.simple));
        let value = rhsRaw.replace(/\s+#.*$/, '').trim();
        if (simple) value = expandMakeVars(value, vars);
        if (op === '+=' && previous) value = `${previous.value} ${value}`.trim();
        vars.set(varName, { value, simple });
        continue;
      }

      const rule = /^[^:]+::?\s*([^;]*)(?:;(.*))?$/.exec(line);
      if (rule) {
        // 尚未实例化模式规则的目标，拒绝该候选，避免发布含 %.c 的空配置。
        if (line.slice(0, line.indexOf(':')).includes('%')) throw new Error('暂不支持 Make 模式规则');
        // 普通规则的依赖在读入时展开；命令（包括分号后的内联命令）等所有定义收齐。
        prerequisites = expandMakeVars(rule[1].replace(/\s+#.*$/, '').trim(), vars);
        targets = tokenizeArgs(expandMakeVars(line.slice(0, line.indexOf(':')), vars));
        for (const target of targets) {
          if (!target.startsWith('.')) defaultGoal ??= target;
          if (!rules.has(target)) rules.set(target, []);
          rules.get(target).push(...tokenizeArgs(prerequisites.replace('|', ' ')));
        }
        if (rule[2]?.trim()) recipes.push({ command: rule[2].trim(), prerequisites, targets });
      } else if (/^ +\S/.test(rawLine)) {
        // 一些 NMAKE 工程以空格缩进命令。
        recipes.push({ command: line, prerequisites, targets });
      }
    }
  };

  processFile(entryAbs, 0);
  const compilers = new Set();
  const compilationUnits = {};
  const reachable = new Set();
  const visitTarget = target => {
    if (reachable.has(target)) return;
    reachable.add(target);
    for (const dependency of rules.get(target) || []) visitTarget(dependency);
  };
  const goal = expandMakeVars('$(.DEFAULT_GOAL)', vars).trim() || defaultGoal;
  if (goal) visitTarget(goal);
  for (const { command, prerequisites, targets } of recipes) {
    if (goal && !targets.some(target => reachable.has(target))) continue;
    const deps = prerequisites.split('|')[0];
    const expanded = expandMakeVars(command.replace(/^[@+-]+/, ''), vars)
      .replace(/\$[<^+]/g, ref => ref === '$<' ? `"${tokenizeArgs(deps)[0] || ''}"` : deps);
    const args = tokenizeArgs(expanded);
    const wrapper = /^(?:ccache|sccache|distcc)(?:\.exe)?$/i.test(path.posix.basename(toPosix(args[0])));
    const compiler = path.posix.basename(toPosix(args[wrapper ? 1 : 0])).replace(/\.exe$/i, '');
    // 兼容工程自定义的 CC 名称，同时避免将 echo、清理等命令的参数计入配置。
    const compilerVar = /^[@+-]*(?:\$\((?:CC|CXX|C_COMPILER)\)|\$\{(?:CC|CXX|C_COMPILER)\})(?:\s|$)/i;
    if (!compilerVar.test(command) &&
        !/(?:^|-)(?:gcc|g\+\+|clang(?:\+\+)?|cc|c\+\+|ccrh(?:850)?|ccv850|cxv850|ccarm|ctc|cctc|iccarm|iccrh850|dcc)(?:-\d+(?:\.\d+)*)?$/i.test(compiler)) continue;
    if (args.length) compilers.add(compiler);
    const unit = { includeDirs: new Set(), defines: new Set(), forcedIncludes: new Set(), sourceFiles: new Set() };
    extractCompilerFlags(args, entryDir, rootDir, unit);
    for (const rel of unit.sourceFiles) compilationUnits[rel] = {
      includeDirs: [...unit.includeDirs], defines: [...unit.defines],
      forcedIncludes: [...unit.forcedIncludes], macroArgs: unit.macroArgs || [],
    };
    extractCompilerFlags(args, entryDir, rootDir, collected);
  }
  if (!recipes.length) {
    // 仅含变量的 .mak/.mac 配置片段没有命令，按常用编译变量的最终值恢复。
    compilers.add(expandMakeVars('$(CC) $(CXX)', vars));
    for (const key of ['CPPFLAGS', 'CFLAGS', 'CXXFLAGS', 'INCLUDES', 'DEFINES', 'SRCS', 'C_SRCS', 'SOURCES']) {
      extractCompilerFlags(tokenizeArgs(expandMakeVars(`$(${key})`, vars)), entryDir, rootDir, collected);
    }
  }
  const meta = detectArchAndCompiler([...compilers].join('\n'));
  return {
    ...meta,
    includeDirs: [...collected.includeDirs],
    defines: [...collected.defines],
    macroArgs: collected.macroArgs || [],
    forcedIncludes: [...collected.forcedIncludes],
    sourceFiles: [...collected.sourceFiles],
    includedFiles: collected.includedFiles,
    compilationUnits,
  };
}

/** 解析单个 .cproject，按 <cconfiguration> 拆出每套机种构建配置。 */
function parseCprojectProfiles(rootDir, cprojectRel, cprojectAbs) {
  const text = safeReadText(cprojectAbs);
  if (!text) return [];
  const projectDir = path.dirname(cprojectAbs);
  const projectRelDir = toPosix(path.relative(rootDir, projectDir)) || '.';
  const dotProjectAbs = path.join(projectDir, '.project');
  const dotProjectText = safeReadText(dotProjectAbs) || '';
  const projectName = /<projectDescription>[\s\S]*?<name>\s*([^<]+?)\s*<\/name>/i.exec(dotProjectText)?.[1]?.trim()
    || path.basename(projectDir);

  // 同目录 .mak 仅用于兜底推断编译器/架构，不把多套互斥 .mak 的 -D/-I 无条件混入每个 CDT 机种
  let fallbackArch = 'generic';
  let fallbackCompiler = 'C';
  try {
    const siblingMaks = fs.readdirSync(projectDir, { withFileTypes: true })
      .filter((ent) => ent.isFile() && /\.(?:mak|mk|make)$/i.test(ent.name))
      .map((ent) => path.join(projectDir, ent.name));
    for (const mk of siblingMaks.slice(0, 4)) {
      const sample = safeReadText(mk);
      if (!sample) continue;
      const detected = detectArchAndCompiler(sample.slice(0, 8000));
      if (detected.arch !== 'generic') {
        fallbackArch = detected.arch;
        fallbackCompiler = detected.compiler;
        break;
      }
    }
  } catch { /* ignore */ }

  let sections = [...text.matchAll(/<cconfiguration\b[^>]*>([\s\S]*?)<\/cconfiguration>/gi)].map((m) => m[1]);
  if (!sections.length) {
    sections = [...text.matchAll(/<configuration\b[^>]*>([\s\S]*?)<\/configuration>/gi)].map((m) => m[0]);
  }
  if (!sections.length) sections = [text];
  const profiles = [];
  const seenNames = new Set();

  for (const block of sections) {
    const cfgName =
      /\bconfigurationName\s*=\s*"([^"]+)"/i.exec(block)?.[1] ||
      /<configuration\b[^>]*\bname\s*=\s*"([^"]+)"/i.exec(block)?.[1] ||
      /<storageModule\b[^>]*moduleId="org\.eclipse\.cdt\.core\.settings"[^>]*\bname\s*=\s*"([^"]+)"/i.exec(block)?.[1] ||
      '';
    if (!cfgName || seenNames.has(cfgName)) continue;
    seenNames.add(cfgName);

    const includeDirs = new Set();
    const defines = new Set();
    const forcedIncludes = new Set();
    const exclusions = [];
    const sourceRoots = [];
    const sourceEntries = [];

    for (const m of block.matchAll(/<option\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?<!\/)>([\s\S]*?)<\/option>/gi)) {
      const attrs = m[1];
      const body = m[2];
      const vt = extractXmlAttr(attrs, 'valueType');
      const sc = extractXmlAttr(attrs, 'superClass');
      const values = [...body.matchAll(/<listOptionValue\b[^>]*\bvalue="([^"]*)"/gi)].map((x) => x[1]);
      if (!values.length) continue;
      if (/includePath/i.test(vt) || /include\.?paths?/i.test(sc)) {
        for (const raw of values) {
          const abs = resolveEclipsePath(raw, { rootDir, projectDir, configName: cfgName, projectName });
          if (abs) includeDirs.add(abs);
        }
      } else if (/definedSymbols/i.test(vt) || /symbols?|macros?|def/i.test(sc)) {
        for (const raw of values) {
          const clean = stripQuotes(raw).replace(/^-D/, '');
          if (clean && /^[A-Za-z_][A-Za-z0-9_]*(?:=.*)?$/.test(clean)) defines.add(clean);
        }
      } else if (/includeFiles/i.test(vt) || /include\.?files?/i.test(sc)) {
        for (const raw of values) {
          const abs = resolveEclipsePath(raw, { rootDir, projectDir, configName: cfgName, projectName });
          if (abs) forcedIncludes.add(abs);
        }
      }
    }

    // 兜底：部分厂商 CDT 插件把额外参数写在 valueType="string" 的 misc/flags 选项里
    for (const m of block.matchAll(/<option\b((?:[^>"']|"[^"]*"|'[^']*')*?\bvalue="([^"]+)"(?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/gi)) {
      const attrs = m[1];
      const val = stripQuotes(m[2]);
      const sc = extractXmlAttr(attrs, 'superClass');
      if (/(?:flag|misc|other|option|cmd)/i.test(sc) && /(?:^|\s)(?:-[ID]|@|-f\s)/.test(val)) {
        const tmp = { includeDirs, defines, forcedIncludes, sourceFiles: new Set() };
        extractCompilerFlags(tokenizeArgs(val), projectDir, rootDir, tmp);
      }
    }

    for (const m of block.matchAll(/<entry\b[^>]*\bkind="sourcePath"[^>]*>/gi)) {
      const entryName = toPosix(extractXmlAttr(m[0], 'name')).replace(/^\/+|\/+$/g, '');
      const excluding = extractXmlAttr(m[0], 'excluding');
      const relRoot = entryName
        ? (projectRelDir === '.' ? entryName : `${projectRelDir}/${entryName}`)
        : projectRelDir;
      sourceRoots.push(relRoot);
      sourceEntries.push({ root: relRoot, excluding: excluding || '' });
      if (excluding) exclusions.push({ base: relRoot, pattern: excluding });
    }

    const meta = detectArchAndCompiler(block + '\n' + text.slice(0, 2000));
    const arch = meta.arch !== 'generic' ? meta.arch : fallbackArch;
    const compiler = meta.compiler !== 'C' ? meta.compiler : fallbackCompiler;
    const scopePrefix = projectRelDir === '.' ? '' : `[${projectRelDir}] `;
    const id = `cproject::${cprojectRel}::${cfgName}`;
    profiles.push({
      id,
      label: `${scopePrefix}${cfgName}`,
      source: 'cproject',
      configFile: cprojectRel,
      configName: cfgName,
      dir: projectRelDir,
      arch,
      compiler,
      includeDirs: [...includeDirs],
      defines: [...defines],
      forcedIncludes: [...forcedIncludes],
      sourceRoots,
      sourceEntries,
      exclusions,
      sourceFiles: [],
    });
  }
  return profiles;
}

/** 解析 QAC .prj / .via 配置文件。 */
function parseQacProfile(rootDir, rel, abs) {
  const text = safeReadText(abs);
  if (!text) return null;
  const dir = path.dirname(abs);
  const collected = { includeDirs: new Set(), defines: new Set(), forcedIncludes: new Set(), sourceFiles: new Set() };
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    extractCompilerFlags(tokenizeArgs(line), dir, rootDir, collected);
  }
  if (!collected.includeDirs.size && !collected.defines.size && !collected.sourceFiles.size) return null;
  const meta = detectArchAndCompiler(text);
  return {
    id: `qac::${rel}`,
    label: `QAC · ${rel}`,
    source: 'qac',
    configFile: rel,
    dir: toPosix(path.relative(rootDir, dir)) || '.',
    ...meta,
    includeDirs: [...collected.includeDirs],
    defines: [...collected.defines],
    macroArgs: collected.macroArgs || [],
    forcedIncludes: [...collected.forcedIncludes],
    sourceRoots: [],
    exclusions: [],
    sourceFiles: [...collected.sourceFiles],
  };
}

/** 扫描并列出当前工程所有可用的构建配置（多 .cproject 机种 / .mak / QAC）。 */
export function discoverBuildProfiles(rootDir) {
  const scan = scanBuildConfig(rootDir);
  if (!scan.ok) return { ok: false, error: scan.error, profiles: [] };

  const profiles = [];
  for (const cp of scan.cprojects || []) {
    const abs = path.resolve(rootDir, cp.file);
    profiles.push(...parseCprojectProfiles(rootDir, cp.file, abs));
  }

  // .mak / Makefile 候选（优先顶层和主构建脚本，避免把几十个碎片子 .mak 全摊平）
  const makEntries = (scan.makefiles || []).slice(0, 20);
  const parsedMaks = [];
  for (const mk of makEntries) {
    const abs = path.resolve(rootDir, mk.file);
    let parsed;
    try { parsed = parseMakefileTree(abs, rootDir); }
    catch { continue; }
    const score = parsed.includeDirs.length * 3 + parsed.defines.length * 3 + parsed.sourceFiles.length * 2 + parsed.includedFiles.length * 4;
    if (score > 0 || makEntries.length <= 4) {
      parsedMaks.push({ rel: mk.file, dir: toPosix(path.dirname(mk.file)) || '.', parsed, score });
    }
  }
  parsedMaks.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  for (const item of parsedMaks.slice(0, 8)) {
    profiles.push({
      id: `make::${item.rel}`,
      label: `Make · ${item.rel}`,
      source: 'makefile',
      configFile: item.rel,
      dir: item.dir,
      arch: item.parsed.arch,
      compiler: item.parsed.compiler,
      includeDirs: item.parsed.includeDirs,
      defines: item.parsed.defines,
      macroArgs: item.parsed.macroArgs,
      compilationUnits: item.parsed.compilationUnits,
      forcedIncludes: item.parsed.forcedIncludes,
      sourceRoots: [],
      exclusions: [],
      sourceFiles: item.parsed.sourceFiles,
    });
  }

  for (const rel of (scan.qacFiles || []).filter((f) => /\.(?:prj|via)$/i.test(f)).slice(0, 6)) {
    const q = parseQacProfile(rootDir, rel, path.resolve(rootDir, rel));
    if (q) profiles.push(q);
  }

  return {
    ok: true,
    multiCoreHint: Boolean(scan.multiCoreHint),
    cprojectCount: Number(scan.counts?.cprojects || 0),
    profiles,
  };
}

/** 根据构建配置过滤当前工程中实际参与编译的 .c 文件清单。 */
export function selectProfileSourceFiles(profile, allFiles) {
  const cFiles = (allFiles || []).filter((f) => !f.isHeader && SRC_EXT.test(f.rel));
  if (!profile) return cFiles.map((f) => f.rel);

  if (profile.sourceFiles?.length) {
    const allowed = new Set(profile.sourceFiles.map(fileKey));
    return cFiles.filter((f) => allowed.has(fileKey(f.rel))).map((f) => f.rel);
  }

  // CDT sourceEntries：逐项应用各自的 root 与 excluding，再取并集，避免空源根静默扩大到全工程
  if (Array.isArray(profile.sourceEntries) && profile.sourceEntries.length) {
    const selected = new Set();
    for (const entry of profile.sourceEntries) {
      const root = entry.root && entry.root !== '.' ? entry.root : '';
      const matcher = entry.excluding ? compileExclusionMatcher(entry.root || '.', entry.excluding) : null;
      for (const f of cFiles) {
        const inEntry = !root || fileKey(f.rel) === fileKey(root) || fileKey(f.rel).startsWith(fileKey(root) + '/');
        if (!inEntry) continue;
        if (matcher && matcher(f.rel)) continue;
        selected.add(f.rel);
      }
    }
    return cFiles.filter((f) => selected.has(f.rel)).map((f) => f.rel);
  }

  const scopeDir = profile.dir && profile.dir !== '.' ? profile.dir : '';
  const matchers = (profile.exclusions || []).map((ex) => compileExclusionMatcher(ex.base, ex.pattern));
  const roots = (profile.sourceRoots || []).filter((r) => r && r !== '.');

  let candidates = cFiles;
  if (roots.length) {
    candidates = cFiles.filter((f) => roots.some((r) => fileKey(f.rel) === fileKey(r) || fileKey(f.rel).startsWith(fileKey(r) + '/')));
  } else if (scopeDir && profile.source === 'cproject') {
    candidates = cFiles.filter((f) => fileKey(f.rel).startsWith(fileKey(scopeDir) + '/'));
  }

  if (matchers.length) {
    candidates = candidates.filter((f) => !matchers.some((fn) => fn(f.rel)));
  }
  return candidates.map((f) => f.rel);
}

/** 生成 Green Hills RH850 / V850 兼容垫片头，使 Clang -fsyntax-only 顺利解析嵌入式扩展关键字。 */
export function buildGhsCompatShim(arch = 'rh850') {
  const isV850 = arch === 'v850';
  return [
    '/* Auto-generated TCU CallGraph compiler compatibility shim for Clang AST */',
    '#ifndef __TCU_CALLGRAPH_COMPAT_SHIM_H__',
    '#define __TCU_CALLGRAPH_COMPAT_SHIM_H__',
    '#ifndef __ghs__',
    '#define __ghs__ 1',
    '#endif',
    '#ifndef __V800__',
    '#define __V800__ 1',
    '#endif',
    isV850 ? '#ifndef __V850__\n#define __V850__ 1\n#endif' : '#ifndef __RH850__\n#define __RH850__ 1\n#endif',
    '#ifndef __interrupt',
    '#define __interrupt',
    '#endif',
    '#ifndef _interrupt',
    '#define _interrupt',
    '#endif',
    '#ifndef __near',
    '#define __near',
    '#endif',
    '#ifndef __far',
    '#define __far',
    '#endif',
    '#ifndef __sreg',
    '#define __sreg',
    '#endif',
    '#ifndef __tiny',
    '#define __tiny',
    '#endif',
    '#ifndef __huge',
    '#define __huge',
    '#endif',
    '#ifndef __noinit',
    '#define __noinit',
    '#endif',
    '#ifndef __packed',
    '#define __packed __attribute__((packed))',
    '#endif',
    '#ifndef __far_call',
    '#define __far_call',
    '#endif',
    '#ifndef __near_call',
    '#define __near_call',
    '#endif',
    '#ifndef __callt',
    '#define __callt',
    '#endif',
    '#ifndef __syscall',
    '#define __syscall',
    '#endif',
    '#ifndef _attribute',
    '#define _attribute(x)',
    '#endif',
    '#ifndef __DI',
    '#define __DI() ((void)0)',
    '#endif',
    '#ifndef __EI',
    '#define __EI() ((void)0)',
    '#endif',
    '#ifndef __NOP',
    '#define __NOP() ((void)0)',
    '#endif',
    '#ifndef __HALT',
    '#define __HALT() ((void)0)',
    '#endif',
    '#endif /* __TCU_CALLGRAPH_COMPAT_SHIM_H__ */',
    '',
  ].join('\n');
}

function writeFileIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const prev = fs.readFileSync(filePath, 'utf8');
    if (prev === content) return false;
  } catch { /* file does not exist yet */ }
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

/** 写入任何导出文件前，核对其目录实际位置和最终文件类型。 */
function validateExportFile(root, target) {
  const relative = path.relative(root, target);
  const outside = rel => rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
  if (!relative || outside(relative)) throw new Error('导出路径必须位于工程目录内');
  const realRoot = fs.realpathSync(root);
  let directory = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    directory = path.join(directory, part);
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })) break;
    const real = fs.realpathSync(directory);
    if (outside(path.relative(realRoot, real))) throw new Error('导出目标真实路径超出工程目录范围');
    if (!fs.statSync(real).isDirectory()) throw new Error('导出目标父路径必须是目录');
  }
  const file = fs.lstatSync(target, { throwIfNoEntry: false });
  if (file && !file.isFile()) throw new Error('导出目标必须是普通文件，不允许覆盖符号链接');
}

/** 为指定构建配置生成标准 compile_commands.json（及配套 GHS 兼容垫片头）。 */
export function materializeCompileCommands(rootDir, profile, { files = [], cacheDir = null, exportPath = null } = {}) {
  if (!profile) throw new Error('未指定构建配置');
  const absRoot = path.resolve(rootDir);
  const hash = crypto.createHash('sha1').update(`${absRoot}\0${profile.id}`).digest('hex').slice(0, 12);
  const compileCommandsPath = exportPath
    ? path.resolve(absRoot, exportPath)
    : path.join(cacheDir || path.join(os.tmpdir(), 'tcu-callgraph-build-configs', hash), 'compile_commands.json');
  const shimDir = exportPath
    ? path.join(path.dirname(compileCommandsPath), '.tcu-callgraph-compat')
    : path.dirname(compileCommandsPath);

  const needsGhsShim = ['rh850', 'v850'].includes(profile.arch) || /ghs|v800|ccrh|ccv850/i.test(profile.compiler || '');
  const shimPath = needsGhsShim ? path.join(shimDir, `compat_${profile.arch || 'v800'}.h`) : null;
  if (exportPath) {
    validateExportFile(absRoot, compileCommandsPath);
    if (shimPath) validateExportFile(absRoot, shimPath);
  }

  const activeRels = selectProfileSourceFiles(profile, files);
  // 补齐头文件目录作为兜底搜索路径（配置自带 -I 在前；若配置限定了子目录则优先同子目录头，避免多核串头）
  const scopeDir = profile.dir && profile.dir !== '.' ? profile.dir : '';
  const scopedHeaderDirs = [...new Set(
    (files || [])
      .filter((f) => f.isHeader && (!scopeDir || fileKey(f.rel).startsWith(fileKey(scopeDir) + '/')))
      .map((f) => path.dirname(f.abs)),
  )];
  const allIncludeDirs = [];
  const seenInc = new Set();
  const fallbackDirs = (profile.includeDirs || []).length ? scopedHeaderDirs : [absRoot, ...scopedHeaderDirs];
  for (const dir of [...(profile.includeDirs || []), ...fallbackDirs]) {
    if (!dir) continue;
    const norm = path.normalize(dir);
    const k = fileKey(norm);
    if (seenInc.has(k)) continue;
    if (fs.statSync(norm, { throwIfNoEntry: false })?.isDirectory()) {
      seenInc.add(k);
      allIncludeDirs.push(norm);
    }
  }

  const baseArgs = ['clang', '-fsyntax-only', '-fms-extensions', '-fgnu-keywords', '-Wno-unknown-pragmas', '-Wno-attributes'];
  const argsFor = config => {
    const args = [...baseArgs];
    for (const dir of config === profile ? allIncludeDirs : config.includeDirs || []) args.push('-I', dir);
    if (config.macroArgs?.length) args.push(...config.macroArgs);
    else for (const def of config.defines || []) args.push('-D', def);
    if (shimPath) args.push('-include', shimPath);
    for (const inc of config.forcedIncludes || []) args.push('-include', inc);
    return args;
  };

  const cwd = profile.dir && profile.dir !== '.' ? path.resolve(absRoot, profile.dir) : absRoot;
  const entries = activeRels.map((rel) => {
    const absFile = path.resolve(absRoot, rel);
    return {
      directory: cwd,
      file: absFile,
      arguments: [...argsFor(profile.compilationUnits?.[rel] || profile), absFile],
    };
  });

  if (shimPath) writeFileIfChanged(shimPath, buildGhsCompatShim(profile.arch));
  writeFileIfChanged(compileCommandsPath, JSON.stringify(entries, null, 2) + '\n');

  return {
    compileCommandsPath,
    shimPath,
    unitCount: entries.length,
    includeCount: allIncludeDirs.length,
    defineCount: (profile.defines || []).length,
    activeFiles: activeRels,
  };
}
