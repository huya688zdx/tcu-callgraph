/**
 * 工程索引：扫描目录 → 解析 → 建立函数表 / 调用边 / 宏表 / 函数指针表
 * 提供搜索、上下游子图查询、统计画像
 */

import fs from 'node:fs';
import path from 'node:path';
import { lex } from './lexer.js';
import { preprocess } from './preproc.js';
import { findFunctions, findFnPtrTables, scanCalls } from './extract.js';
import { parseDot, modelFromDot } from './dot.js';

const SRC_EXT = /\.(c|cc|cpp)$/i;
const HDR_EXT = /\.(h|hh|hpp)$/i;

/**
 * 源码解码：先按 UTF-8 严格解码，失败则回退 CP932(Shift-JIS)。
 * 汽车电子不少 TCU 工程出自日文环境，源码是 CP932 编码，
 * 直接按 UTF-8 读会把注释和字符串里的日文变成乱码。
 * 同时兼容 UTF-8 BOM / UTF-16 BOM。
 */
export function decodeSource(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // 不是合法 UTF-8，继续尝试 CP932
  }
  try {
    return new TextDecoder('shift_jis').decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

// ---------------- 全局 / 静态变量 ----------------

const TYPE_KW = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
  'const', 'volatile', 'static', 'extern', 'register', 'auto', 'struct', 'union',
  'enum', 'inline', 'typedef', '_Bool', 'bool', 'size_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
]);

/** 解析一条文件作用域的声明，判断它是不是变量定义 */
function parseVarDecl(stmt, file) {
  if (!stmt.length) return null;
  if (stmt.some((t) => t.v === '(')) return null; // 函数声明 / 宏
  if (stmt.some((t) => t.v === 'typedef')) return null; // 类型别名

  let nameTok = null;
  let hasType = false;
  for (let i = 0; i < stmt.length; i++) {
    const t = stmt[i];
    if (t.t !== 'id') continue;
    if (TYPE_KW.has(t.v)) {
      hasType = true;
      continue;
    }
    const next = stmt[i + 1];
    if (next && (next.v === ';' || next.v === '=' || next.v === '[' || next.v === ',')) {
      nameTok = t;
      break;
    }
  }
  if (!hasType || !nameTok) return null;

  const words = stmt.filter((t) => t.t === 'id').map((t) => t.v);
  return {
    name: nameTok.v,
    file,
    line: nameTok.line,
    isStatic: words.includes('static'),
    isExtern: words.includes('extern'),
    isConst: words.includes('const'),
    typeText: words.filter((w) => TYPE_KW.has(w) && w !== 'static' && w !== 'extern').join(' '),
  };
}

/** 提取文件作用域（花括号深度 0）的变量声明 */
function findGlobalVars(tokens, file) {
  const out = [];
  let depth = 0;
  let stmt = [];
  const flush = () => {
    const d = parseVarDecl(stmt, file);
    if (d) out.push(d);
    stmt = [];
  };
  for (const tk of tokens) {
    if (tk.t === 'preproc') continue;
    if (tk.v === '{') {
      if (depth === 0) stmt = []; // 进入函数体 / 结构体，丢掉声明头
      depth++;
      continue;
    }
    if (tk.v === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (tk.v === ';') {
      flush();
      continue;
    }
    stmt.push(tk);
  }
  return out;
}

const WRITE_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

/**
 * 判断 tokens[i] 处的变量引用是「纯写」「读写」还是「读」。
 * 需要穿过成员链（a.b.c）和数组下标（a[i][j]），再看紧跟的运算符。
 * 注意 lexer 把 `==` 识别为单独的 token，所以 `=` 一定是赋值。
 */
function writeKind(tokens, i) {
  let j = i + 1;
  while (j < tokens.length) {
    const v = tokens[j].v;
    if (v === '.' || v === '->') {
      j += 2;
      continue;
    }
    if (v === '[') {
      let d = 0;
      for (; j < tokens.length; j++) {
        if (tokens[j].v === '[') d++;
        else if (tokens[j].v === ']') {
          d--;
          if (d === 0) {
            j++;
            break;
          }
        }
      }
      continue;
    }
    break;
  }
  const op = tokens[j];
  if (!op) return null;
  if (op.v === '=') return 'write';
  if (WRITE_OPS.has(op.v)) return 'readwrite'; // += 之类，先读旧值再写
  if (op.v === '++' || op.v === '--') return 'readwrite';
  return null;
}

/** 扫描函数体里对全局变量的读写 */
function scanVarAccess(bodyTokens, lookup) {
  const hits = new Map();
  for (let i = 0; i < bodyTokens.length; i++) {
    const t = bodyTokens[i];
    if (t.t !== 'id') continue;
    const id = lookup(t.v);
    if (!id) continue;
    const prev = bodyTokens[i - 1];
    if (prev && (prev.v === '.' || prev.v === '->')) continue; // 成员名
    const next = bodyTokens[i + 1];
    if (next && next.v === '(') continue; // 函数调用

    let rec = hits.get(id);
    if (!rec) {
      rec = { id, name: t.v, line: t.line, read: false, write: false };
      hits.set(id, rec);
    }
    const kind = writeKind(bodyTokens, i);
    if (kind === 'write') rec.write = true;
    else if (kind === 'readwrite') {
      rec.write = true;
      rec.read = true;
    } else if (prev && (prev.v === '++' || prev.v === '--')) {
      rec.write = true;
      rec.read = true;
    } else if (prev && prev.v === '&') {
      // 取地址交给别的函数写，保守算作写
      rec.write = true;
    } else {
      rec.read = true;
    }
  }
  return [...hits.values()];
}

export function listSourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (SRC_EXT.test(e.name) || HDR_EXT.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * 扫描源码文件清单（带大小与 mtime），供解析缓存算 key。
 * 比 listSourceFiles 多做一次 stat：解析本身要读整个文件，多这一次 stat 可以忽略，
 * 但 mtime 是判断「文件到底变没变」最可靠的低成本信号。
 */
export function scanSources(root) {
  const out = [];
  for (const abs of listSourceFiles(root)) {
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue; // 扫描期间被删 / 无权限，交给 buildIndex 自己记 warning
    }
    out.push({
      abs,
      rel: path.relative(root, abs).replace(/\\/g, '/'),
      bytes: st.size,
      mtimeMs: Math.round(st.mtimeMs),
      isHeader: HDR_EXT.test(abs),
    });
  }
  return out;
}

/**
 * 从纯数据重建 _index。
 * 解析缓存反序列化后必须走这一步：JSON 留不住对象引用，
 * 直接把 _index 存下来会让 byId 里的函数和 functions 数组变成两份互不相干的副本，
 * 之后任何一处改字段，另一处都看不到。
 */
export function rebuildIndex(model) {
  const functions = model.functions || [];
  const externals = model.externals || [];
  const edges = model.edges || [];

  const byId = new Map();
  const byName = new Map();
  for (const fn of functions) {
    byId.set(fn.id, fn);
    if (!byName.has(fn.name)) byName.set(fn.name, []);
    byName.get(fn.name).push(fn);
  }
  for (const ex of externals) byId.set(ex.id, ex);
  for (const v of model.variables || []) byId.set(v.id, v);

  const outAdj = new Map();
  const inAdj = new Map();
  for (const e of edges) {
    if (!outAdj.has(e.from)) outAdj.set(e.from, []);
    outAdj.get(e.from).push(e);
    if (!inAdj.has(e.to)) inAdj.set(e.to, []);
    inAdj.get(e.to).push(e);
  }

  const varWriters = new Map();
  const varReaders = new Map();
  for (const fn of functions) {
    for (const a of fn.varAccess || []) {
      if (a.write) {
        if (!varWriters.has(a.id)) varWriters.set(a.id, []);
        varWriters.get(a.id).push(fn.id);
      }
      if (a.read) {
        if (!varReaders.has(a.id)) varReaders.set(a.id, []);
        varReaders.get(a.id).push(fn.id);
      }
    }
  }

  model._index = { byId, byName, outAdj, inAdj, varWriters, varReaders };
  return model;
}

/**
 * @param {string} root 工程根目录
 * @returns {object} model
 */
export function buildIndex(root, sourceFiles = null) {
  const t0 = Date.now();
  // 比较时仅替换文件来源，符号身份和层级仍相对于总代码目录。
  const files = sourceFiles ? [...sourceFiles] : listSourceFiles(root).map((abs) => [path.relative(root, abs).replace(/\\/g, '/'), abs]);
  const headers = files.filter(([rel]) => HDR_EXT.test(rel));
  const sources = files.filter(([rel]) => !HDR_EXT.test(rel));

  const macros = new Map();
  const parsed = [];
  const includes = [];
  const warnings = [];
  // 宏清单：同名后定义覆盖前定义，与「全局宏表」旧口径一致
  const macroDefs = new Map();
  const MAX_FILE_BYTES = 8 * 1024 * 1024;

  /** 把头文件解析后的宏表并回全局表（含 #undef 带来的删除效果） */
  const mergeMacros = (target, snap) => {
    for (const name of [...target.keys()]) if (!snap.has(name)) target.delete(name);
    for (const [name, def] of snap) target.set(name, def);
  };

  const parseFile = (rel, abs, isHeader) => {
    let buf;
    try {
      const size = fs.statSync(abs).size;
      if (size > MAX_FILE_BYTES) {
        warnings.push({ file: rel, error: `文件过大（${(size / 1048576).toFixed(1)} MB），已跳过` });
        return;
      }
      buf = fs.readFileSync(abs);
    } catch (err) {
      // 单个文件读失败（权限 / 被占用 / 扫描期间被删）不应让整次索引失败
      warnings.push({ file: rel, error: `读取失败：${err.message}` });
      return;
    }
    // UTF-16 源码（带 BOM）里 ASCII 字符后面就是 0x00，不能按二进制跳过
    const isUtf16 =
      buf.length >= 2 &&
      ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
    if (!isUtf16 && buf.includes(0)) {
      warnings.push({ file: rel, error: '疑似二进制文件（含 \\0），已跳过' });
      return;
    }
    const src = decodeSource(buf);
    const toks = lex(src, rel);
    // 每个文件一份宏表快照：本文件的 #define/#undef 只作用于本文件，
    // 避免 a.c 里定义的宏泄漏到 b.c；头文件解析完再并回全局表，
    // 保证「头文件 → 源文件」这一方向的累积仍然成立。
    const fileMacros = new Map(macros);
    const { tokens, includes: inc } = preprocess(toks, fileMacros, rel);
    if (isHeader) mergeMacros(macros, fileMacros);
    // 本文件自己定义的宏进入清单（继承来的头文件宏不算，避免重复）
    for (const def of fileMacros.values()) if (def.file === rel) macroDefs.set(def.name, def);
    includes.push(...inc);
    parsed.push({ abs, rel, tokens, macros: fileMacros, isHeader, bytes: src.length });
  };

  // 先头文件（宏定义先入表），再源文件
  for (const [rel, abs] of headers) parseFile(rel, abs, true);
  for (const [rel, abs] of sources) parseFile(rel, abs, false);

  const functions = [];
  const fnptrTables = new Map();
  const seenFnId = new Set();

  for (const p of parsed) {
    for (const fn of findFunctions(p.tokens, p.rel)) {
      fn.id = `${fn.file}::${fn.name}`;
      // #if/#else 两个分支各定义一次同名函数时 id 相同：只保留首个，避免重复节点
      if (seenFnId.has(fn.id)) continue;
      seenFnId.add(fn.id);
      fn.bodyTokens = p.tokens.slice(fn.bodyStart + 1, fn.bodyEnd);
      functions.push(fn);
    }
    for (const [name, map] of findFnPtrTables(p.tokens)) {
      fnptrTables.set(name, { ...map });
    }
  }

  const byId = new Map();
  const byName = new Map();
  for (const fn of functions) {
    byId.set(fn.id, fn);
    if (!byName.has(fn.name)) byName.set(fn.name, []);
    byName.get(fn.name).push(fn);
  }

  // 全局 / 静态变量：作为独立节点参与绘图，函数读写它们时连虚线
  const variables = [];
  const varById = new Map();
  for (const p of parsed) {
    for (const v of findGlobalVars(p.tokens, p.rel)) {
      // static 变量按文件区分；普通全局变量跨文件同名即同一个
      v.id = v.isStatic ? `var::${p.rel}::${v.name}` : `var::${v.name}`;
      v.kind = 'var';
      v.params = [];
      const prev = varById.get(v.id);
      // extern 只是声明，真实定义优先
      if (!prev || (prev.isExtern && !v.isExtern)) varById.set(v.id, v);
    }
  }
  for (const v of varById.values()) {
    variables.push(v);
    byId.set(v.id, v);
  }

  const resolveCallee = (name, fromFile) => {
    const all = byName.get(name);
    if (!all || !all.length) return `ext::${name}`;
    const local = all.filter((f) => f.file === fromFile);
    if (local.length === 1) return local[0].id;
    if (all.length === 1) return all[0].id;
    const nonStatic = all.filter((f) => !f.isStatic);
    if (nonStatic.length === 1) return nonStatic[0].id;
    return (local[0] || all[0]).id;
  };

  const edges = [];
  // 每个函数用它所属文件的宏快照展开，避免跨文件互相污染
  const macrosByFile = new Map(parsed.map((p) => [p.rel, p.macros]));

  // 变量名 → 节点：优先本文件的 static，其次同名全局
  const varByName = new Map();
  for (const v of variables) {
    if (!varByName.has(v.name)) varByName.set(v.name, []);
    varByName.get(v.name).push(v);
  }
  const lookupVar = (fnFile, name) => {
    const list = varByName.get(name);
    if (!list || !list.length) return null;
    const local = list.find((v) => v.file === fnFile && v.isStatic);
    if (local) return local.id;
    const glob = list.find((v) => !v.isStatic);
    return (glob || list[0]).id;
  };

  for (const fn of functions) {
    const raw = [];
    scanCalls(fn.bodyTokens, { macros: macrosByFile.get(fn.file) || macros, fnptr: fnptrTables }, raw);
    for (const c of raw) {
      if (!c.callee) continue;
      edges.push({
        from: fn.id,
        to: resolveCallee(c.callee, fn.file),
        callee: c.callee,
        kind: c.kind,
        line: c.line,
        cond: c.cond,
        via: c.via,
        macroChain: c.macroChain,
      });
    }
    // 全局变量读写：画成虚线，同时记录方向供数据流分析
    const access = scanVarAccess(fn.bodyTokens, (n) => lookupVar(fn.file, n));
    fn.varAccess = access;
    for (const a of access) {
      edges.push({
        from: fn.id,
        to: a.id,
        callee: a.name,
        kind: 'var',
        line: a.line,
        via: a.write ? (a.read ? '读写' : '写') : '读',
      });
    }
  }

  // 数据流索引：变量 → 写它的函数 / 读它的函数
  const varWriters = new Map();
  const varReaders = new Map();
  for (const fn of functions) {
    for (const a of fn.varAccess || []) {
      if (a.write) {
        if (!varWriters.has(a.id)) varWriters.set(a.id, []);
        varWriters.get(a.id).push(fn.id);
      }
      if (a.read) {
        if (!varReaders.has(a.id)) varReaders.set(a.id, []);
        varReaders.get(a.id).push(fn.id);
      }
    }
  }

  // 外部符号虚拟节点
  const externals = new Map();
  for (const e of edges) {
    if (e.to.startsWith('ext::')) {
      const name = e.to.slice(5);
      if (!externals.has(e.to)) {
        externals.set(e.to, {
          id: e.to,
          name,
          file: '<external>',
          line: 0,
          isStatic: false,
          external: true,
          params: [],
        });
      }
    }
  }

  // 邻接表
  const outAdj = new Map();
  const inAdj = new Map();
  for (const e of edges) {
    if (!outAdj.has(e.from)) outAdj.set(e.from, []);
    outAdj.get(e.from).push(e);
    if (!inAdj.has(e.to)) inAdj.set(e.to, []);
    inAdj.get(e.to).push(e);
  }

  const allNodes = new Map([...byId, ...externals]);

  const model = {
    root,
    ...(sourceFiles ? { _sourceFiles: sourceFiles } : {}),
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    files: parsed.map((p) => ({ rel: p.rel, isHeader: p.isHeader, bytes: p.bytes })),
    functions,
    variables,
    externals: [...externals.values()],
    edges,
    macros: [...macroDefs.values()],
    fnptrTables: [...fnptrTables.entries()].map(([name, map]) => ({ name, map })),
    includes,
    warnings,
    _index: { byId: allNodes, byName, outAdj, inAdj, varWriters, varReaders },
  };

  return model;
}

/** 统一入口：目录走 C 源码解析，.dot/.gv 文件走 DOT 解析，单个 .c 索引所在目录并聚焦该文件 */
export function loadModel(target) {
  const st = fs.statSync(target);
  if (st.isFile()) {
    const ext = path.extname(target).toLowerCase();
    if (ext === '.dot' || ext === '.gv') {
      const src = decodeSource(fs.readFileSync(target));
      return modelFromDot(parseDot(src), path.basename(target));
    }
    if (SRC_EXT.test(ext) || HDR_EXT.test(ext)) {
      const dir = path.dirname(target);
      const model = buildIndex(dir);
      model.focusFile = path.relative(dir, target).replace(/\\/g, '/');
      return model;
    }
    throw new Error(`不支持的文件类型: ${ext}（支持 .c / .h / .dot / .gv 或目录）`);
  }
  return buildIndex(target);
}

/** 统计画像 */
export function stats(model) {
  // 统计口径与画布一致：同一对节点的多次调用只算一条关系边
  const pairs = new Set(model.edges.map((e) => `${e.from}|${e.to}`));
  const outSet = new Map();
  const inSet = new Map();
  for (const e of model.edges) {
    if (!outSet.has(e.from)) outSet.set(e.from, new Set());
    outSet.get(e.from).add(e.to);
    if (!inSet.has(e.to)) inSet.set(e.to, new Set());
    inSet.get(e.to).add(e.from);
  }

  let maxFanOut = 0;
  let maxFanOutFn = '';
  let maxFanIn = 0;
  let maxFanInFn = '';

  for (const [id, set] of outSet) {
    if (set.size > maxFanOut) {
      maxFanOut = set.size;
      maxFanOutFn = id;
    }
  }
  for (const [id, set] of inSet) {
    if (set.size > maxFanIn) {
      maxFanIn = set.size;
      maxFanInFn = id;
    }
  }

  const sccs = tarjan(model);
  // 自递归（函数直接调用自己）在 tarjan 里是单点分量，同样要算作一个环。
  // cycleGroups 保持「id 数组的数组」旧结构（cli/scan.js 直接 join 打印），
  // 自环另外在 selfLoops 里给出，便于界面区分「自递归」与「环组」。
  const outAdj = model._index?.outAdj;
  const cycleGroups = [];
  const selfLoops = [];
  for (const c of sccs) {
    if (c.length > 1) {
      cycleGroups.push(c);
    } else if (c.length === 1 && (outAdj?.get(c[0]) || []).some((e) => e.to === c[0])) {
      cycleGroups.push(c);
      selfLoops.push(c[0]);
    }
  }

  return {
    files: model.files.length,
    // 同名函数在 #if/#else 两分支各定义一次时会有重复 id，按 id 去重后再计数
    functions: new Set(model.functions.map((f) => f.id)).size,
    variables: model.variables?.length ?? 0,
    externals: model.externals?.length ?? 0,
    edges: pairs.size,
    calls: model.edges.length,
    macros: model.macros?.length ?? 0,
    macroEdges: model.edges.filter((e) => e.kind === 'macro').length,
    fnptrEdges: model.edges.filter((e) => e.kind === 'fnptr').length,
    unknownEdges: model.edges.filter((e) => e.kind === 'unknown').length,
    maxFanOut,
    maxFanOutFn,
    maxFanIn,
    maxFanInFn,
    cycles: cycleGroups.length,
    cycleGroups,
    selfLoops,
    elapsedMs: model.elapsedMs,
  };
}

/**
 * 数据流：经由同一个全局变量的「写者 → 读者」关系。
 * A 写 g_x、B 读 g_x，即使两者之间没有调用，也存在 A → B 的数据流。
 * 这种关系数量可能爆炸，所以默认不展开，只在用户对某个函数显式开启时计算。
 */
export function dataflowOf(model, nodeId) {
  const idx = model._index || {};
  const varWriters = idx.varWriters || new Map();
  const varReaders = idx.varReaders || new Map();
  const fn = idx.byId ? idx.byId.get(nodeId) : null;
  if (!fn || !fn.varAccess) return [];

  const out = [];
  const seen = new Set();
  const push = (from, to, a) => {
    if (from === to) return;
    const k = `${from}|${to}|${a.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ from, to, varId: a.id, varName: a.name, kind: 'dataflow' });
  };

  for (const a of fn.varAccess) {
    if (a.write) for (const r of varReaders.get(a.id) || []) push(fn.id, r, a);
    if (a.read) for (const w of varWriters.get(a.id) || []) push(w, fn.id, a);
  }
  return out;
}

/** Tarjan 强连通分量 */
export function tarjan(model) {
  const { outAdj } = model._index;
  const ids = new Set();
  for (const fn of model.functions) ids.add(fn.id);
  for (const e of model.edges) {
    ids.add(e.from);
    ids.add(e.to);
  }

  let idx = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const result = [];

  const strong = (v) => {
    index.set(v, idx);
    low.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);
    for (const e of outAdj.get(v) || []) {
      const w = e.to;
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      result.push(comp);
    }
  };

  for (const v of ids) if (!index.has(v)) strong(v);
  return result;
}

/**
 * 取子图：以 rootId 为中心，向下 down 层、向上 up 层
 */
export function subgraph(model, rootId, { up = 0, down = 2, maxNodes = 400, includeVariables = true } = {}) {
  const { byId, outAdj, inAdj } = model._index;
  if (!byId.has(rootId)) return { nodes: [], edges: [] };

  const nodes = new Map();
  const edges = [];
  const seenCall = new Set();
  // 同一对节点之间的多次调用合并成一条边，调用次数与行号记在 calls 里，
  // 避免画出并排的多条平行边
  const byPair = new Map();

  const addNode = (id) => {
    if (nodes.has(id)) return false;
    const n = byId.get(id);
    if (!n) return false;
    nodes.set(id, n);
    return true;
  };

  addNode(rootId);

  const kindRank = { direct: 3, macro: 2, fnptr: 1, unknown: 0 };

  const addEdge = (e) => {
    const callKey = `${e.from}|${e.to}|${e.line}|${e.kind}`;
    if (seenCall.has(callKey)) return;
    seenCall.add(callKey);
    const pairKey = e.comparison ? `${e.from}|${e.to}|${e.change}|${e.kind === 'var' ? e.via : ''}|${e.cond || ''}` : `${e.from}|${e.to}`;
    let m = byPair.get(pairKey);
    if (!m) {
      m = { ...e, calls: [] };
      byPair.set(pairKey, m);
      edges.push(m);
    } else if ((kindRank[e.kind] ?? 0) > (kindRank[m.kind] ?? 0)) {
      // 同一对节点既有直接调用又有宏/函数指针调用时，以更具体的类型展示
      m.kind = e.kind;
      m.line = e.line;
      m.callee = e.callee;
      m.via = e.via;
      m.cond = e.cond;
    }
    m.calls.push({ line: e.line, kind: e.kind, cond: e.cond, via: e.via });
  };

  const walk = (adj, depth) => {
    let frontier = [rootId];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const id of frontier) {
        for (const e of adj.get(id) || []) {
          // 在遍历时排除变量，避免变量占满节点名额，或沿共享变量拉入无调用关系的函数。
          if (!includeVariables && e.kind === 'var') continue;
          const other = adj === outAdj ? e.to : e.from;
          addEdge(e);
          if (nodes.size >= maxNodes) continue;
          if (addNode(other)) next.push(other);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
  };

  walk(outAdj, down);
  if (up > 0) walk(inAdj, up);

  return {
    root: rootId,
    nodes: [...nodes.values()],
    edges: edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)),
  };
}

/** 按名字模糊搜索 */
export function search(model, q, limit = 30) {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const scored = [];
  for (const fn of model.functions) {
    const name = fn.name.toLowerCase();
    const file = fn.file.toLowerCase();
    let score = 0;
    if (name === query) score = 100;
    else if (name.startsWith(query)) score = 80;
    else if (name.includes(query)) score = 60;
    else if (file.includes(query)) score = 20;
    if (score) scored.push({ fn, score });
  }
  scored.sort((a, b) => b.score - a.score || a.fn.name.length - b.fn.name.length);
  return scored.slice(0, limit).map((s) => s.fn);
}

/** 两点之间的所有路径（用于高亮调用链） */
export function findPaths(model, from, to, maxDepth = 8, maxPaths = 20) {
  const { outAdj } = model._index;
  const results = [];
  const path = [];
  const onPath = new Set();

  const dfs = (v, d) => {
    if (results.length >= maxPaths || d > maxDepth) return;
    path.push(v);
    onPath.add(v);
    if (v === to) {
      results.push(path.slice());
    } else {
      for (const e of outAdj.get(v) || []) {
        if (!onPath.has(e.to)) dfs(e.to, d + 1);
      }
    }
    path.pop();
    onPath.delete(v);
  };

  dfs(from, 0);
  return results;
}
