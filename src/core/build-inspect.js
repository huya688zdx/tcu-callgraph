/**
 * 只读工程构建配置诊断工具：
 * 面向多核 Eclipse CDT（多个 .cproject / .project）、.mak / Makefile、QAC 目录及 .pl 映射脚本，
 * 供内置 AI 助手做构建结构摸底与自然语言诊断，不修改任何工程文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { sourceDecoder } from './source-files.js';

const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.vs', '.idea', '.metadata',
]);

const MAX_SCAN_ENTRIES = 25_000;
const MAX_SCAN_DEPTH = 12;
const MAX_FILE_READ_BYTES = 8 * 1024 * 1024;

const ALLOWED_BUILD_BASENAMES = new Set([
  '.cproject', '.project', 'makefile', 'gnumakefile', 'compile_commands.json',
  'compile_flags.txt', '.clangd', 'cmakelists.txt', 'prqaproject.xml',
]);

const ALLOWED_BUILD_EXTS = new Set([
  '.mak', '.mk', '.make', '.d', '.rsp', '.opt', '.args', '.via', '.prj', '.cip',
  '.cct', '.acf', '.rcf', '.p_a', '.p_c', '.p_s', '.cfg', '.xml', '.json', '.pl',
  '.pm', '.bat', '.cmd', '.sh', '.py', '.txt', '.ini', '.conf', '.cproject', '.project',
  '.h', '.hh', '.hpp', '.inc', '.def', '.lcf', '.ld', '.dir', '.gpj', '.met',
]);

const TOOLCHAIN_PATTERNS = [
  ['v800', /\bv800\b/i],
  ['rh850', /\brh850\b/i],
  ['v850', /\bv850\b/i],
  ['ghs', /\b(?:ccv850|ccrh850|cxv850|ccarm|ghs|green\s*hills|multi|\.gpj)\b/i],
  ['renesas-ccrh', /\b(?:ccrh|ca850|ccrx|cs\+|e2studio|renesas)\b/i],
  ['tasking', /\b(?:ctc|cctc|tasking|tricore)\b/i],
  ['gcc', /\b(?:v850-elf-gcc|arm-none-eabi-gcc|tricore-gcc|gcc|g\+\+)\b/i],
  ['diab', /\b(?:dcc|dplus|windriver|diab)\b/i],
  ['iar', /\b(?:iccarm|iccrh850|iar)\b/i],
  ['clang', /\b(?:clang|clang\+\+)\b/i],
];

function isAllowedBuildFile(rel) {
  const base = path.posix.basename(rel).toLowerCase();
  if (ALLOWED_BUILD_BASENAMES.has(base)) return true;
  const ext = path.posix.extname(base);
  return ALLOWED_BUILD_EXTS.has(ext);
}

/** 严格校验目标文件在工程真实根路径内，防止路径穿越或软链逃逸。 */
export function resolveBuildFile(rootDir, relFile) {
  const clean = String(relFile || '').replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!clean || clean.length > 512 || /[\x00-\x1f]/.test(clean)) return null;
  if (clean.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return null;
  let realRoot;
  try { realRoot = fs.realpathSync(rootDir); } catch { return null; }
  const candidate = path.resolve(realRoot, clean);
  let realTarget;
  try { realTarget = fs.realpathSync(candidate); } catch { return null; }
  const rel = path.relative(realRoot, realTarget).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return null;
  const st = fs.statSync(realTarget, { throwIfNoEntry: false });
  if (!st?.isFile()) return null;
  return { abs: realTarget, rel, size: st.size };
}

function readTextSafe(absPath, encoding = 'auto') {
  const st = fs.statSync(absPath, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new Error('目标不是普通文件');
  if (st.size > MAX_FILE_READ_BYTES) throw new Error(`文件过大（${(st.size / 1048576).toFixed(1)} MB），超出只读上限`);
  const buf = fs.readFileSync(absPath);
  const isUtf16 = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
  if (!isUtf16 && buf.includes(0)) throw new Error('疑似二进制文件，已拒绝读取');
  const decoder = sourceDecoder(buf, encoding);
  return decoder.decode(buf.subarray(decoder.bomLength));
}

function detectToolchains(text) {
  const hits = [];
  for (const [name, re] of TOOLCHAIN_PATTERNS) {
    if (re.test(text)) hits.push(name);
  }
  return hits;
}

function extractXmlAttr(tag, attr) {
  const m = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : '';
}

/** 轻量结构化解析 .project（提取工程名与 linkedResources 映射特征）。 */
export function summarizeDotProject(text) {
  const name = /<projectDescription>[\s\S]*?<name>\s*([^<]+?)\s*<\/name>/i.exec(text)?.[1]?.trim() || '';
  const links = [];
  for (const m of text.matchAll(/<link\b[^>]*>([\s\S]*?)<\/link>/gi)) {
    const block = m[1];
    const linkName = /<name>\s*([^<]+?)\s*<\/name>/i.exec(block)?.[1]?.trim() || '';
    const type = /<type>\s*([^<]+?)\s*<\/type>/i.exec(block)?.[1]?.trim() || '';
    const location = /<location>\s*([^<]+?)\s*<\/location>/i.exec(block)?.[1]?.trim() || '';
    const locationURI = /<locationURI>\s*([^<]+?)\s*<\/locationURI>/i.exec(block)?.[1]?.trim() || '';
    links.push({ name: linkName, type, ...(location ? { location } : {}), ...(locationURI ? { locationURI } : {}) });
  }
  const uriVars = [...new Set(links.map((l) => l.locationURI).filter(Boolean)
    .map((u) => u.split('/')[0]).filter(Boolean))];
  return {
    name,
    linkedResourceCount: links.length,
    uriVariables: uriVars.slice(0, 12),
    sampleLinks: links.slice(0, 8),
  };
}

/** 轻量结构化解析 .cproject（支持多核/多机种 configurationName、路径映射、宏与排除规则）。 */
export function summarizeCproject(text) {
  const configNames = new Set();
  for (const m of text.matchAll(/\bconfigurationName\s*=\s*"([^"]+)"/gi)) configNames.add(m[1]);
  for (const m of text.matchAll(/<configuration\b[^>]*>/gi)) {
    const n = extractXmlAttr(m[0], 'name');
    if (n) configNames.add(n);
  }
  for (const m of text.matchAll(/<storageModule\b[^>]*moduleId="org\.eclipse\.cdt\.core\.settings"[^>]*>/gi)) {
    const n = extractXmlAttr(m[0], 'name');
    if (n) configNames.add(n);
  }

  const toolchains = detectToolchains(text);
  const eclipseVars = [...new Set([...text.matchAll(/\$\{([^}]+)\}/g)].map((m) => '${' + m[1].split(':')[0] + '}'))].slice(0, 20);
  const optionTypes = {};
  const optionSuperClasses = new Set();
  for (const m of text.matchAll(/<option\b[^>]*>/gi)) {
    const vt = extractXmlAttr(m[0], 'valueType') || 'unknown';
    optionTypes[vt] = (optionTypes[vt] || 0) + 1;
    const sc = extractXmlAttr(m[0], 'superClass');
    if (sc && /(?:include|path|symbol|define|macro|flag|misc|option|compiler|preproc)/i.test(sc)) {
      optionSuperClasses.add(sc);
    }
  }

  const includePathSamples = [];
  const symbolSamples = [];
  const optionBlockRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let includePathCount = 0;
  let symbolCount = 0;
  for (const m of text.matchAll(optionBlockRe)) {
    const attrs = m[1];
    const body = m[2];
    const vt = extractXmlAttr(attrs, 'valueType');
    const sc = extractXmlAttr(attrs, 'superClass');
    const values = [...body.matchAll(/<listOptionValue\b[^>]*\bvalue="([^"]*)"/gi)].map((x) => x[1]);
    if (!values.length) continue;
    if (/includePath/i.test(vt) || /include\.?paths?/i.test(sc)) {
      includePathCount += values.length;
      for (const v of values) if (includePathSamples.length < 10 && !includePathSamples.includes(v)) includePathSamples.push(v);
    } else if (/definedSymbols/i.test(vt) || /symbols?|macros?|def/i.test(sc)) {
      symbolCount += values.length;
      for (const v of values) if (symbolSamples.length < 12 && !symbolSamples.includes(v)) symbolSamples.push(v);
    }
  }

  const exclusions = [];
  for (const m of text.matchAll(/<entry\b[^>]*\bexcluding="([^"]+)"[^>]*>/gi)) {
    const name = extractXmlAttr(m[0], 'name');
    const excluding = m[1];
    exclusions.push({ entry: name, excluding: excluding.slice(0, 200) });
  }

  const languageSettingTags = new Set();
  for (const m of text.matchAll(/<(entry|resource|language|toolchain|tool|builder)\b[^>]*>/gi)) {
    const tag = m[1].toLowerCase();
    const id = extractXmlAttr(m[0], 'id') || extractXmlAttr(m[0], 'superClass') || extractXmlAttr(m[0], 'command');
    if (id && /(?:v800|ccrh|ghs|gcc|make|cdt|compiler|include|macro|source)/i.test(id)) {
      languageSettingTags.add(`${tag}:${id.slice(0, 80)}`);
    }
  }

  return {
    configurations: [...configNames].slice(0, 40),
    configurationCount: configNames.size,
    toolchains,
    eclipseVariables: eclipseVars,
    optionValueTypes: optionTypes,
    relevantOptionSuperClasses: [...optionSuperClasses].slice(0, 20),
    includePathCount,
    includePathSamples,
    definedSymbolCount: symbolCount,
    definedSymbolSamples: symbolSamples,
    exclusionCount: exclusions.length,
    sampleExclusions: exclusions.slice(0, 8),
    toolHints: [...languageSettingTags].slice(0, 16),
  };
}

function fingerprintMakefile(text) {
  const lines = text.split(/\r\n|\r|\n/).slice(0, 300);
  const sample = lines.join('\n');
  const toolchains = detectToolchains(sample);
  const hasRsp = /(?:^|\s)(?:@|-f\s+|-@)[^\s]+/m.test(sample);
  const hasDashI = /(?:^|\s)-I\s*=?\s*[^\s]+/m.test(sample);
  const hasLowerI = /(?:^|\s)-i\s*=?\s*[^\s]+/m.test(sample);
  const hasDashD = /(?:^|\s)-D\s*=?\s*[A-Za-z_]/m.test(sample);
  const includeLines = lines.filter((l) => /^\s*-?include\s+/i.test(l)).slice(0, 6).map((l) => l.trim().slice(0, 120));
  const compilerAssigns = lines
    .filter((l) => /^\s*(?:CC|C_COMPILER|COMPILER|TOOLCHAIN|MAKE|AS|LD)\s*[:+?]?=/i.test(l))
    .slice(0, 6)
    .map((l) => l.trim().slice(0, 120));
  return {
    toolchains,
    flags: { hasDashI, hasLowerI, hasDashD, hasResponseFile: hasRsp },
    compilerVars: compilerAssigns,
    includes: includeLines,
  };
}

/** 扫描整个工程目录树，盘点多核 .cproject / .project、.mak / Makefile、QAC 目录及 .pl 脚本。 */
export function scanBuildConfig(rootDir, { maxDepth = MAX_SCAN_DEPTH } = {}) {
  let realRoot;
  try { realRoot = fs.realpathSync(rootDir); } catch {
    return { ok: false, error: '无法访问工程根目录' };
  }

  const cprojects = [];
  const projects = new Map();
  const makefiles = [];
  const qacDirs = new Set();
  const qacFiles = [];
  const perlScripts = [];
  const compileDatabases = [];
  const otherBuildFiles = [];
  let visited = 0;
  let truncated = false;

  const walk = (absDir, relDir, depth) => {
    if (depth > maxDepth || visited >= MAX_SCAN_ENTRIES) {
      truncated = true;
      return;
    }
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (visited >= MAX_SCAN_ENTRIES) { truncated = true; return; }
      visited++;
      const name = ent.name;
      const lower = name.toLowerCase();
      const rel = relDir ? `${relDir}/${name}` : name;
      const abs = path.join(absDir, name);

      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(lower)) continue;
        if (/(?:^|[_-])qac(?:$|[_-])|prqa|helix/i.test(lower)) qacDirs.add(rel);
        walk(abs, rel, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;

      if (lower === '.cproject') {
        cprojects.push({ rel, abs, dir: relDir || '.' });
      } else if (lower === '.project') {
        projects.set(relDir || '.', { rel, abs });
      } else if (lower === 'compile_commands.json' || lower === 'compile_flags.txt' || lower === '.clangd') {
        compileDatabases.push(rel);
      } else if (/\.(?:mak|mk|make)$/i.test(lower) || lower === 'makefile' || lower === 'gnumakefile') {
        makefiles.push({ rel, abs });
      } else if (
        /\.(?:via|prj|cip|cct|acf|rcf|p_a|p_c|p_s|met)$/i.test(lower) ||
        lower === 'prqaproject.xml' ||
        (/(?:qac|prqa)/i.test(rel) && /\.(?:cfg|xml|txt|bat|cmd|sh|h|ini)$/i.test(lower))
      ) {
        qacFiles.push(rel);
      } else if (/\.pl$/i.test(lower)) {
        perlScripts.push(rel);
      } else if (/\.(?:gpj|rsp|opt|args|lcf|ld)$/i.test(lower)) {
        otherBuildFiles.push(rel);
      }
    }
  };

  walk(realRoot, '', 0);

  const cprojectSummaries = cprojects.slice(0, 20).map((cp) => {
    let summary = null;
    try {
      summary = summarizeCproject(readTextSafe(cp.abs));
    } catch (err) {
      summary = { error: String(err.message || err) };
    }
    const sib = projects.get(cp.dir);
    let dotProject = null;
    if (sib) {
      try { dotProject = { file: sib.rel, ...summarizeDotProject(readTextSafe(sib.abs)) }; }
      catch (err) { dotProject = { file: sib.rel, error: String(err.message || err) }; }
    }
    return { file: cp.rel, dir: cp.dir, ...summary, ...(dotProject ? { dotProject } : {}) };
  });

  const makefileSummaries = makefiles.slice(0, 30).map((mk) => {
    try {
      const text = readTextSafe(mk.abs);
      return { file: mk.rel, ...fingerprintMakefile(text) };
    } catch (err) {
      return { file: mk.rel, error: String(err.message || err) };
    }
  });

  return {
    ok: true,
    multiCoreHint: cprojects.length > 1,
    counts: {
      cprojects: cprojects.length,
      dotProjects: projects.size,
      makefiles: makefiles.length,
      qacDirs: qacDirs.size,
      qacFiles: qacFiles.length,
      perlScripts: perlScripts.length,
      compileDatabases: compileDatabases.length,
    },
    cprojects: cprojectSummaries,
    makefiles: makefileSummaries,
    qacDirs: [...qacDirs].slice(0, 20),
    qacFiles: qacFiles.slice(0, 40),
    perlScripts: perlScripts.slice(0, 25),
    compileDatabases: compileDatabases.slice(0, 10),
    otherBuildFiles: otherBuildFiles.slice(0, 30),
    ...(truncated ? { truncated: true } : {}),
  };
}

/** 安全只读查看单个构建/配置文件的指定行范围，或按关键词过滤匹配行。 */
export function readBuildConfigFile(rootDir, { file, startLine = 1, endLine, query = '', encoding = 'auto', limit = 30 } = {}) {
  const resolved = resolveBuildFile(rootDir, file);
  if (!resolved) return { ok: false, error: `工程内未找到或无权访问构建文件：${file}` };
  if (!isAllowedBuildFile(resolved.rel)) {
    return { ok: false, error: `仅允许只读检查构建与配置文件（.cproject/.project/.mak/.mk/Makefile/QAC/.pl/.rsp/.cfg/.xml 等）：${resolved.rel}` };
  }
  let text;
  try { text = readTextSafe(resolved.abs, encoding); } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  const lines = text.split(/\r\n|\r|\n/);
  const needle = String(query || '').trim().toLowerCase();
  if (needle) {
    const cap = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 30)));
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length, i + 2);
      matches.push({
        line: i + 1,
        text: lines[i].slice(0, 260),
        context: lines.slice(from, to).map((l, k) => `${from + k + 1}: ${l.slice(0, 220)}`).join('\n'),
      });
      if (matches.length >= cap) break;
    }
    return { ok: true, file: resolved.rel, totalLines: lines.length, query, matches };
  }
  const start = Math.max(1, Math.min(lines.length || 1, Math.trunc(Number(startLine) || 1)));
  const end = Math.max(start, Math.min(lines.length, start + 199, Math.trunc(Number(endLine) || (start + 119))));
  const content = lines.slice(start - 1, end).map((l, idx) => `${start + idx}: ${l}`).join('\n');
  return {
    ok: true,
    file: resolved.rel,
    startLine: start,
    endLine: end,
    totalLines: lines.length,
    truncated: end < lines.length,
    content: content.slice(0, 12_000),
  };
}
