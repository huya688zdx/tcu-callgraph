import fs from 'node:fs';
import path from 'node:path';
import { collectTaskEvidence, applyTaskEvidence } from '../task-periods.js';
import { applyStaticSchedule, staticSchedule } from '../tcu-schedule.js';
import { assignCallGroups } from '../call-sequence.js';
import { taskDeclarations } from '../task-declarations.js';
import { lex } from '../lexer.js';
import { fileMacroScope, preprocess } from '../preproc.js';
import { findFunctions, findFnPtrTables, scanCalls } from '../extract.js';
import { headerSymbols } from '../header-symbols.js';
import { callNestingTokens, hasNestedCall } from '../detect-tasks.js';

import { HDR_EXT, listSourceFiles, decodeSource } from '../source-files.js';
import { buildBuiltinDataflow } from './builtin-dataflow.js';
import { definitionsOf, fingerprint, macroDiff } from './builtin-comparison.js';

const isTestFile = (file) => /(^|\/)(tests?|unit|stubs?|mocks?)(\/|_|-)/i.test(file);
const isHostSimFile = (file) => /(^|\/)(host|sim|simulator|pc|posix|win32)(\/|_|-)/i.test(file);

function sharedDirectoryDepth(directory, file) {
  const parts = file.split('/');
  let depth = 0;
  while (depth < directory.length && depth < parts.length - 1 && directory[depth] === parts[depth]) depth++;
  return depth;
}

function includedHeaders(headers, includes) {
  const paths = new Set(headers.map(({ rel }) => rel));
  const suffixes = new Map();
  for (const rel of paths) {
    for (let slash = rel.indexOf('/'); slash !== -1; slash = rel.indexOf('/', slash + 1)) {
      const suffix = rel.slice(slash + 1);
      suffixes.set(suffix, suffixes.has(suffix) ? null : rel);
    }
  }
  const direct = new Map();
  for (const { file, target } of includes) {
    const normalized = path.posix.normalize(target.replace(/\\/g, '/'));
    const relative = path.posix.join(path.posix.dirname(file), normalized);
    const header = paths.has(relative) ? relative : paths.has(normalized) ? normalized : suffixes.get(normalized);
    if (!header) continue;
    if (!direct.has(file)) direct.set(file, new Set());
    direct.get(file).add(header);
  }
  const closure = new Map();
  const byIncludes = new Map();
  return (file, header) => {
    if (!direct.has(file)) return false;
    if (!closure.has(file)) {
      const entries = direct.get(file);
      const key = JSON.stringify([...entries].sort());
      if (!byIncludes.has(key)) {
        const reachable = new Set(entries);
        for (const included of reachable) {
          for (const nested of direct.get(included) || []) reachable.add(nested);
        }
        byIncludes.set(key, reachable);
      }
      closure.set(file, byIncludes.get(key));
    }
    return closure.get(file).has(header);
  };
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
    if (!next || [';', '=', '[', ','].includes(next.v)) {
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
    tentative: nameTok === stmt.at(-1),
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

/** 先按名字归并引用与首次出现的行号，等全局定义收齐后再解析变量身份。 */
function variableMentions(bodyTokens) {
  const hits = new Map();
  for (let i = 0; i < bodyTokens.length; i++) {
    const t = bodyTokens[i];
    if (t.t !== 'id') continue;
    const name = t.v;
    let rec = hits.get(name);
    if (rec?.read && rec.write) continue;
    const prev = bodyTokens[i - 1];
    if (prev && (prev.v === '.' || prev.v === '->')) continue; // 成员名
    const next = bodyTokens[i + 1];
    if (next && next.v === '(') continue; // 函数调用

    if (!rec) {
      rec = { name, line: t.line, read: false, write: false };
      hits.set(name, rec);
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

/**
 * @param {string} root 工程根目录
 * @returns {object} model
 */
function buildBuiltinIndex(root, sourceFiles = null, scan = null) {
  const t0 = Date.now();
  // 比较时仅替换文件来源，符号身份和层级仍相对于总代码目录。
  const files = scan?.files ?? (sourceFiles
    ? [...sourceFiles].map(([rel, abs]) => ({ rel, abs, isHeader: HDR_EXT.test(rel) }))
    : listSourceFiles(root).map((abs) => ({ rel: path.relative(root, abs).replace(/\\/g, '/'), abs, isHeader: HDR_EXT.test(abs) })));
  const headers = files.filter((file) => file.isHeader);
  const sources = files.filter((file) => !file.isHeader);

  const parsed = [];
  const includes = [];
  const warnings = [...(scan?.warnings ?? [])];
  const macros = new Map();
  // 宏清单：同名后定义覆盖前定义，与「全局宏表」旧口径一致
  const macroDefs = new Map();
  const MAX_FILE_BYTES = 8 * 1024 * 1024;

  const functions = [];
  const functionRecords = [];
  const fnptrTablesList = [];
  const scheduleRows = [];
  const tentativeCounters = new Set();
  const seenFnId = new Set();
  const varById = new Map();

  const parseFile = ({ rel, abs, isHeader, bytes }) => {
    let buf;
    try {
      const size = bytes ?? fs.statSync(abs).size;
      if (size > MAX_FILE_BYTES) {
        warnings.push({ file: rel, error: `文件过大（${(size / 1048576).toFixed(1)} MB），已跳过` });
        return;
      }
      buf = fs.readFileSync(abs);
      if (buf.length > MAX_FILE_BYTES) {
        warnings.push({ file: rel, error: `文件过大（${(buf.length / 1048576).toFixed(1)} MB），已跳过` });
        return;
      }
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
    const original = lex(src, rel);
    const taskDefs = taskDeclarations(src, original);
    const input = taskDefs.names.size ? lex(taskDefs.source, rel) : original;
    const fileMacros = fileMacroScope(macros, new Map(), { trackPositions: true });
    const { tokens, includes: inc } = preprocess(input, fileMacros, rel);
    scheduleRows.push(...staticSchedule(tokens, rel, fileMacros));
    for (const def of fileMacros.changes.values()) if (def) macroDefs.set(def.name, def);
    includes.push(...inc);
    for (const fn of findFunctions(tokens, rel)) {
      if (taskDefs.isrs.has(fn.name)) fn.isrDeclaration = true;
      else if (taskDefs.names.has(fn.name)) fn.taskDeclaration = true;
      for (let k = fn.bodyStart - 1; k >= 0 && ![';', '{', '}'].includes(tokens[k].v); k--) {
        if (tokens[k].v === '__interrupt') fn.isrDeclaration = true;
      }
      fn.id = `${fn.file}::${fn.name}`;
      // #if/#else 两个分支各定义一次同名函数时 id 相同：只保留首个，避免重复节点
      if (seenFnId.has(fn.id)) continue;
      seenFnId.add(fn.id);
      const body = tokens.slice(fn.bodyStart + 1, fn.bodyEnd);
      for (const table of findFnPtrTables(body, rel, fn.id).values()) fnptrTablesList.push(table);
      const calls = [];
      scanCalls(body, { macros: fileMacros }, calls);
      for (const call of calls) {
        call.macroDefinitions = (call.macroChain || []).map((name) => {
          const def = fileMacros.get(name, call.line);
          return def ? `header::${def.file}::${name}` : null;
        }).filter(Boolean);
      }
      const deferred = calls.length > 1 && calls.some((c) => ['unknown', 'fnptr_indexed', 'fnptr_ptr'].includes(c.kind));
      if (!deferred && calls.length > 1 && hasNestedCall(body, calls)) fn.hasNestedCalls = true;
      const nesting = deferred ? callNestingTokens(body) : null;
      assignCallGroups(body, calls);
      functionRecords.push({ fn, calls, nesting, mentions: variableMentions(body),
        taskEvidence: collectTaskEvidence(fn, body, fileMacros, calls) });
      functions.push(fn);
    }
    for (const table of findFnPtrTables(tokens, rel).values()) {
      fnptrTablesList.push(table);
    }
    for (const v of findGlobalVars(tokens, rel)) {
      // static 变量按文件区分；普通全局变量跨文件同名即同一个
      v.id = v.isStatic ? `var::${rel}::${v.name}` : `var::${v.name}`;
      if (v.tentative) {
        // 无初始化声明可绑定 tick；画布变量依旧等按需数据流索引确认。
        tentativeCounters.add(v.id);
        continue;
      }
      delete v.tentative;
      v.kind = 'var';
      v.params = [];
      const prev = varById.get(v.id);
      // extern 只是声明，真实定义优先
      if (!prev || (prev.isExtern && !v.isExtern)) varById.set(v.id, v);
    }
    if (isHeader) for (const [name, def] of fileMacros.changes) {
      if (def) macros.set(name, def);
      else macros.delete(name);
    }
    parsed.push({ rel, isHeader, bytes: src.length, macroChanges: isHeader ? fileMacros.changes : null });
  };

  // 每个文件只词法分析一次。宏按头文件顺序生效，跨文件符号在定义收齐后绑定。
  for (const file of headers) parseFile(file);
  for (const file of sources) parseFile(file);
  const includesHeader = includedHeaders(headers, includes);

  const byId = new Map();
  const byName = new Map();
  for (const fn of functions) {
    byId.set(fn.id, fn);
    if (!byName.has(fn.name)) byName.set(fn.name, []);
    byName.get(fn.name).push(fn);
  }
  applyStaticSchedule(scheduleRows, byName);
  const variables = [];
  for (const v of varById.values()) {
    variables.push(v);
    byId.set(v.id, v);
  }

  const callCounts = new Map(functionRecords.filter(({ fn }) => byName.get(fn.name).length > 1)
    .map(({ fn, calls }) => [fn.id, calls.length]));
  const resolveCallee = (name, fromFile) => {
    const all = byName.get(name);
    if (!all) return `ext::${name}`;
    const local = all.find((f) => f.file === fromFile);
    if (local) return local.id;
    const visibleStatic = f => f.isStatic && HDR_EXT.test(f.file) && includesHeader(fromFile, f.file);
    if (all.length === 1) return !all[0].isStatic || visibleStatic(all[0]) ? all[0].id : `ext::${name}`;
    const visibleStatics = all.filter(visibleStatic);
    let candidates = visibleStatics.length ? visibleStatics : all.filter(f => !f.isStatic);
    if (!candidates.length) return `ext::${name}`;
    if (candidates.length === 1) return candidates[0].id;

    const prefer = (predicate) => {
      const preferred = candidates.filter(predicate);
      if (preferred.length) candidates = preferred;
    };
    if (isTestFile(fromFile)) {
      const directory = path.posix.dirname(fromFile);
      const siblings = candidates.filter((f) => path.posix.dirname(f.file) === directory);
      if (siblings.length) candidates = siblings;
      else prefer((f) => isTestFile(f.file));
    } else {
      prefer((f) => !isTestFile(f.file));
      if (candidates.length > 1 && !isHostSimFile(fromFile)) prefer((f) => !isHostSimFile(f.file));
    }

    const directory = fromFile.split('/').slice(0, -1);
    return [...candidates].sort((a, b) => sharedDirectoryDepth(directory, b.file) - sharedDirectoryDepth(directory, a.file) ||
      callCounts.get(b.id) - callCounts.get(a.id) || (b.bodyEnd - b.bodyStart) - (a.bodyEnd - a.bodyStart) ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))[0].id;
  };

  const edges = [];

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

  // 过滤并按文件/作用域索引函数指针分派表：
  // - 单结构体 `.field = fn` 保持原有兼容；
  // - 数组/嵌套表只保留指向真实已定义函数的槽位，避免把普通常量数据表误认成函数指针表；
  // - 同名 static 表严格按文件隔离，杜绝跨文件污染。
  const cleanedTables = [];
  const staticTablesByFile = new Map();
  const globalTablesByName = new Map();
  const localTablesByFunction = new Map();
  for (const raw of fnptrTablesList) {
    const filteredMap = {};
    for (const [slot, target] of Object.entries(raw.map)) {
      const isStructField = !slot.startsWith('[');
      if (byName.has(target) || isStructField) {
        filteredMap[slot] = target;
      }
    }
    if (!Object.keys(filteredMap).length) continue;
    const entry = {
      name: raw.name,
      file: raw.file,
      line: raw.line,
      isStatic: raw.isStatic,
      isConst: raw.isConst,
      dims: raw.dims,
      map: filteredMap,
      ...(raw.functionId && { functionId: raw.functionId }),
    };
    cleanedTables.push(entry);
    if (entry.functionId) {
      if (!localTablesByFunction.has(entry.functionId)) localTablesByFunction.set(entry.functionId, new Map());
      const byName = localTablesByFunction.get(entry.functionId);
      if (!byName.has(entry.name)) byName.set(entry.name, []);
      byName.get(entry.name).push({ entry, declaration: raw.declaration, end: raw.scope.end });
    } else if (entry.isStatic) {
      if (!staticTablesByFile.has(entry.file)) staticTablesByFile.set(entry.file, new Map());
      staticTablesByFile.get(entry.file).set(entry.name, entry);
    } else {
      globalTablesByName.set(entry.name, entry);
    }
  }
  const compareLocation = (a, b) => a.line - b.line || a.col - b.col;
  const lookupTable = (fn, call) => {
    const name = call.receiver;
    if (!name) return null;
    const local = localTablesByFunction.get(fn.id)?.get(name)?.findLast(table =>
      compareLocation(call, table.declaration) >= 0 && (!table.end || compareLocation(call, table.end) < 0));
    return local?.entry || staticTablesByFile.get(fn.file)?.get(name) || globalTablesByName.get(name) || null;
  };
  const matchTableSlots = (table, indices = [], member = null) => {
    const matched = [];
    for (const [slot, target] of Object.entries(table.map)) {
      if (!indices.length) {
        if (member && slot === member) matched.push({ slot, target });
        continue;
      }
      // 解析槽位路径，例如 "[1][0]" / "[0].fn" / "[1][2].handler"
      const m = /^((?:\[\d+\])+)(?:\.([A-Za-z_]\w*))?$/.exec(slot);
      if (!m) continue;
      const slotIndices = [...m[1].matchAll(/\[(\d+)\]/g)].map((x) => Number.parseInt(x[1], 10));
      const slotField = m[2] || null;
      if (member) {
        if (slotField !== member) continue;
      } else if (slotField) {
        // 结构体数组元素中无成员名调用时（例如 e[r][c]() 对应的非结构体表）不匹配带字段名的槽；
        // 但若是一维位置初始化结构体数组（无指定字段名），slotField 本身为 null。
        continue;
      }
      if (slotIndices.length < indices.length) continue;
      let ok = true;
      for (let d = 0; d < indices.length; d++) {
        if (indices[d] !== null && slotIndices[d] !== indices[d]) {
          ok = false;
          break;
        }
      }
      if (ok) matched.push({ slot, target });
    }
    return matched;
  };

  const indirectCalls = [];
  for (const { fn, calls, nesting, mentions, taskEvidence } of functionRecords) {
    const edgeStart = edges.length;
    for (const call of calls) {
      if (call.callee) {
        edges.push({
          from: fn.id,
          to: resolveCallee(call.callee, fn.file),
          callee: call.callee,
          kind: call.kind,
          line: call.line, col: call.col, orderGroup: call.orderGroup,
          ...(call.onceWhenGatesMatch && { onceWhenGatesMatch: true }),
          cond: call.cond,
          via: call.via,
          macroChain: call.macroChain,
          macroDefinitions: call.macroDefinitions,
        });
        continue;
      }
      const table = lookupTable(fn, call);
      const matched = table ? matchTableSlots(table, call.indices || [], call.member || null) : [];
      const uniqueTargets = [...new Set(matched.map((s) => s.target))];
      const allConstIndices = (call.indices || []).every((idx) => idx !== null);
      if (uniqueTargets.length === 1 && (allConstIndices || !call.indices?.length || matched.length === 1)) {
        const callee = uniqueTargets[0];
        edges.push({
          from: fn.id,
          to: resolveCallee(callee, fn.file),
          callee,
          kind: 'fnptr',
          line: call.line, col: call.col, orderGroup: call.orderGroup,
          ...(call.onceWhenGatesMatch && { onceWhenGatesMatch: true }),
          cond: call.cond,
          via: call.via,
          macroChain: call.macroChain,
          macroDefinitions: call.macroDefinitions,
        });
      } else {
        // 多候选动态分派表（如 z[idx]()、e[r][c]()）或未解析函数指针：
        // 不盲目画死所有候选，而是保留调用点与候选槽位供 LLM 结合源码精准判断后补边。
        indirectCalls.push({
          caller: fn.id,
          callerName: fn.name,
          file: fn.file,
          line: call.line,
          expr: call.via || '',
          receiver: call.receiver || null,
          member: call.member || null,
          indices: call.indexExprs || [],
          table: table ? { name: table.name, file: table.file, line: table.line, isStatic: table.isStatic } : null,
          candidates: matched.map((s) => ({
            slot: s.slot,
            name: s.target,
            id: resolveCallee(s.target, table?.file || fn.file),
          })),
        });
      }
    }
    const resolvedCalls = edges.slice(edgeStart);
    if (nesting && resolvedCalls.length > 1 && hasNestedCall(nesting, resolvedCalls)) fn.hasNestedCalls = true;
    // 未绑定的成员调用不会形成边，清除其占用的序号，同时保留嵌套实参的先后次序。
    const groups = [...new Set(resolvedCalls.map(e => e.orderGroup))].sort((a, b) => a - b);
    const ordinal = new Map(groups.map((group, index) => [group, index + 1]));
    for (const edge of resolvedCalls) edge.orderGroup = ordinal.get(edge.orderGroup);
    applyTaskEvidence(fn, taskEvidence, byName);
    for (const counter of [...(fn.counterIncrements || []), ...(fn.callDividers || []).flatMap(site => site.gates)]) {
      if (counter.local) continue;
      const local = `var::${fn.file}::${counter.counter}`;
      const global = `var::${counter.counter}`;
      if (varById.has(local) || tentativeCounters.has(local)) counter.variable = local;
      else if (varById.has(global) || tentativeCounters.has(global)) counter.variable = global;
    }
    fn.varAccess = [];
    for (const mention of mentions) {
      const id = lookupVar(fn.file, mention.name);
      if (!id) continue;
      const { name, line, read, write } = mention;
      fn.varAccess.push({ id, name, line, read, write });
      edges.push({
        from: fn.id,
        to: id,
        callee: name,
        kind: 'var',
        line,
        via: write ? (read ? '读写' : '写') : '读',
      });
    }
  }
  functionRecords.length = 0;

  // 数据流索引：变量 → 写它的函数 / 读它的函数
  for (const fn of functions) {
    for (const a of fn.varAccess || []) {
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
  const allNodes = new Map([...byId, ...externals]);
  const callsByMacro = new Map();
  for (const e of edges.filter((edge) => edge.kind !== 'var')) for (const id of e.macroDefinitions || []) {
    if (!callsByMacro.has(id)) callsByMacro.set(id, []);
    callsByMacro.get(id).push(e);
  }
  const symbols = headerSymbols(parsed, resolveCallee, new Set([...byName.keys(), ...edges.filter((e) => e.kind !== 'var').map((e) => e.callee)]), macros, callsByMacro);
  for (const symbol of symbols) for (let i = 0; i < symbol.targetIds.length; i++) {
    const id = symbol.targetIds[i];
    if (!allNodes.has(id) && id.startsWith('ext::')) {
      const node = { id, name: id.slice(5), file: '<external>', line: 0, external: true, params: [] };
      externals.set(id, node);
      allNodes.set(id, node);
    }
  }
  for (const symbol of symbols) allNodes.set(symbol.id, symbol);
  const headerEdges = symbols.flatMap((symbol) => [
    ...symbol.targetIds.map((to) => ({ from: symbol.id, to, callee: allNodes.get(to)?.name || to,
      kind: 'macro', line: symbol.line, via: symbol.name, headerReference: true })),
    ...(callsByMacro.get(symbol.id) || []).map((e) => ({ ...e, to: symbol.id, callee: symbol.name, headerReference: true })),
  ]);

  const model = {
    root,
    ...(sourceFiles ? { _sourceFiles: sourceFiles } : {}),
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    files: parsed.map((p) => ({ rel: p.rel, isHeader: p.isHeader, bytes: p.bytes })),
    functions,
    headerSymbols: symbols,
    headerEdges,
    variables,
    externals: [...externals.values()],
    edges,
    macros: [...macroDefs.values()],
    fnptrTables: cleanedTables,
    indirectCalls,
    includes,
    warnings,
  };

  return model;
}

export const builtinParser = {
  id: 'builtin',
  name: '内置快速解析 (Lexer + Tree-sitter)',
  available: () => ({ ok: true }),
  parse: (root, { sourceFiles, scan }) => buildBuiltinIndex(root, sourceFiles, scan),
  buildDataflow: buildBuiltinDataflow,
  compareDefinitions: definitionsOf,
  compareMacros: macroDiff,
  fingerprint,
};
