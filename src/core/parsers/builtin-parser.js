import { dependencyStamp } from './clang-config.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { preprocessProfile } from './builtin-includes.js';
import { collectTaskEvidence, applyTaskEvidence } from '../task-periods.js';
import { applyStaticSchedule, staticSchedule } from '../tcu-schedule.js';
import { assignCallGroups } from '../call-sequence.js';
import { taskDeclarations } from '../task-declarations.js';
import { lex } from '../lexer.js';
import { expandSeq, fileMacroScope, preprocess } from '../preproc.js';
import { collectDispatchDeclarations, collectEnumValues, findDispatchWrites, findFunctions, findFnPtrTables, findTypedefs, scanCalls, statementEnd } from '../extract.js';
import { headerSymbols } from '../header-symbols.js';
import { callNestingTokens, hasNestedCall } from '../detect-tasks.js';

import { HDR_EXT, listSourceFiles, decodeSource } from '../source-files.js';
import { buildBuiltinDataflow } from './builtin-dataflow.js';
import { definitionsOf, fingerprint, macroDiff } from './builtin-comparison.js';

const isTestFile = (file) => /(^|\/)(tests?|unit|stubs?|mocks?)(\/|_|-)/i.test(file);
const isHostSimFile = (file) => /(^|\/)(host|sim|simulator|pc|posix|win32)(\/|_|-)/i.test(file);

function outerLoopRanges(tokens) {
  const ranges = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!['for', 'while', 'do'].includes(tokens[i].v)) continue;
    const start = tokens[i];
    i = statementEnd(tokens, i) - 1;
    ranges.push({ start, end: tokens[i] });
  }
  return ranges;
}

function sharedDirectoryDepth(directory, file) {
  const parts = file.split('/');
  let depth = 0;
  while (depth < directory.length && depth < parts.length - 1 && directory[depth] === parts[depth]) depth++;
  return depth;
}

function includedHeaders(paths, includes) {
  const suffixes = new Map();
  for (const rel of paths) {
    for (let slash = rel.indexOf('/'); slash !== -1; slash = rel.indexOf('/', slash + 1)) {
      const suffix = rel.slice(slash + 1);
      suffixes.set(suffix, suffixes.has(suffix) ? null : rel);
    }
  }
  const direct = new Map();
  for (const { file, target, resolved } of includes) {
    const normalized = path.posix.normalize(target.replace(/\\/g, '/'));
    const relative = path.posix.join(path.posix.dirname(file), normalized);
    const header = resolved !== undefined ? resolved : paths.has(relative) ? relative : paths.has(normalized) ? normalized : suffixes.get(normalized);
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
function buildBuiltinIndex(root, sourceFiles = null, scan = null, parserOptions = {}) {
  const t0 = Date.now();
  // 比较时仅替换文件来源，符号身份和层级仍相对于总代码目录。
  const rawFiles = scan?.files ?? (sourceFiles
    ? [...sourceFiles].map(([rel, abs]) => ({ rel, abs, isHeader: HDR_EXT.test(rel) }))
    : listSourceFiles(root).map((abs) => ({ rel: path.relative(root, abs).replace(/\\/g, '/'), abs, isHeader: HDR_EXT.test(abs) })));
  const activeSet = Array.isArray(parserOptions?.activeFiles)
    ? new Set(parserOptions.activeFiles.map((rel) => (process.platform === 'win32' ? rel.toLowerCase() : rel)))
    : null;
  const files = activeSet
    ? rawFiles.filter((file) => file.isHeader || activeSet.has(process.platform === 'win32' ? file.rel.toLowerCase() : file.rel))
    : rawFiles;
  const headers = files.filter((file) => file.isHeader);
  const sources = files.filter((file) => !file.isHeader);
  const pruneInactive = Boolean(
    parserOptions?.buildProfileId ||
    (Array.isArray(parserOptions?.defines) && parserOptions.defines.length > 0),
  );

  const parsed = [];
  const includes = [];
  const warnings = [...(scan?.warnings ?? [])];
  const externalDeps = new Map();
  const externalHeaders = new Map();
  const missingIncludes = new Set();
  const macros = new Map();
  // 宏清单：同名后定义覆盖前定义，与「全局宏表」旧口径一致
  const macroDefs = new Map();
  const MAX_FILE_BYTES = 8 * 1024 * 1024;

  const functions = [];
  const functionRecords = [];
  const deferredTypedefCalls = [];
  const headerVariants = new Map();
  const typedefsByFile = new Map();
  const typedefHeadersByName = new Map();
  const fnptrTablesList = [];
  const pendingFieldInitializers = [];
  const dispatchDeclarations = new Map();
  const aliasUsesByFile = new Map();
  const enumsByFile = new Map();
  const scheduleRows = [];
  const tentativeCounters = new Set();
  const seenFnId = new Set();
  const varById = new Map();
  const dispatchPolicy = parserOptions?.dispatchPolicy === 'strict' ? 'strict' : 'expand';

  const visibleEnumsFor = (rel) => {
    const merged = new Map();
    for (const [hdrRel, map] of enumsByFile) {
      if (hdrRel === rel || HDR_EXT.test(hdrRel)) {
        for (const [k, v] of map) merged.set(k, v);
      }
    }
    return merged;
  };

  const recordFunctionCalls = (record, body, fileMacros) => {
    const { fn, calls } = record;
    for (const call of calls) {
      call.macroDefinitions = (call.macroChain || []).map((name) => {
        const def = fileMacros.get(name, call.line);
        return def ? `header::${def.file}::${name}` : null;
      }).filter(Boolean);
    }
    const deferred = calls.length > 1 && calls.some((c) => ['unknown', 'fnptr_indexed', 'fnptr_ptr'].includes(c.kind));
    if (!deferred && calls.length > 1 && hasNestedCall(body, calls)) fn.hasNestedCalls = true;
    record.nesting = deferred ? callNestingTokens(body) : null;
    assignCallGroups(body, calls);
    record.taskEvidence = collectTaskEvidence(fn, body, fileMacros, calls);
  };

  const recordHeaderContext = (file, input, tokens, macros, source) => {
    // 大多数头文件只声明符号；只有包含函数定义的头才需要比对宏展开后的调用。
    input.hasHeaderFunctions ??= findFunctions(input.tokens.filter(token => token.t !== 'preproc'), file.rel).length > 0;
    if (!input.hasHeaderFunctions) return;
    const expanded = expandSeq(tokens, macros);
    const key = createHash('sha256')
      .update(JSON.stringify(expanded.map(token => [token.v, token.line, token.col]))).digest('hex');
    if (!headerVariants.has(file.rel)) headerVariants.set(file.rel, new Map());
    const variants = headerVariants.get(file.rel);
    let variant = variants.get(key);
    if (!variant) {
      variant = { callsByName: new Map(), sources: new Set() };
      variants.set(key, variant);
      for (const fn of findFunctions(tokens, file.rel)) {
        const body = tokens.slice(fn.bodyStart + 1, fn.bodyEnd);
        const calls = [];
        scanCalls(body, { macros }, calls);
        recordFunctionCalls({ fn, calls }, body, macros);
        if (!variant.callsByName.has(fn.name)) variant.callsByName.set(fn.name, calls.filter(call => call.callee));
      }
    }
    variant.sources.add(source);
  };

  const loadInput = ({ rel, abs, bytes, isHeader }) => {
    let buf;
    let externalHeader;
    try {
      const size = bytes ?? fs.statSync(abs).size;
      if (size > MAX_FILE_BYTES) {
        warnings.push({ file: rel, error: `文件过大（${(size / 1048576).toFixed(1)} MB），已跳过` });
        return;
      }
      const stamp = dependencyStamp(abs);
      if (isHeader && (rel.startsWith('../') || path.isAbsolute(rel))) externalHeader = fs.realpathSync(abs);
      buf = fs.readFileSync(externalHeader || abs);
      if (stamp) externalDeps.set(abs, stamp);
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
    if (externalHeader) externalHeaders.set(rel, externalHeader);
    const src = decodeSource(buf);
    const original = lex(src, rel);
    const taskDefs = taskDeclarations(src, original);
    const input = taskDefs.names.size ? lex(taskDefs.source, rel) : original;
    return { tokens: input, taskDefs, bytes: src.length };
  };
  const recordFile = ({ rel, isHeader }, { taskDefs, bytes }, { tokens, includes: inc }, fileMacros) => {
    const typedefs = findTypedefs(tokens, fileMacros);
    if (typedefs.size) typedefsByFile.set(rel, typedefs);
    if (isHeader) for (const [name, entries] of typedefs) {
      if (!entries.some(entry => entry.fileScope)) continue;
      if (!typedefHeadersByName.has(name)) typedefHeadersByName.set(name, []);
      typedefHeadersByName.get(name).push(rel);
    }
    const { enumValues: fileEnums } = collectEnumValues(tokens, fileMacros);
    if (fileEnums.size) enumsByFile.set(rel, fileEnums);
    const visibleEnums = visibleEnumsFor(rel, inc);
    const dispatchScopes = new Set();
    const aliasUses = [];
    scheduleRows.push(...staticSchedule(tokens, rel, fileMacros));
    for (const def of fileMacros.changes.values()) if (def) macroDefs.set(def.name, def);
    includes.push(...inc);
    for (const fn of findFunctions(tokens, rel)) {
      if (taskDefs.isrs.has(fn.name)) fn.isrDeclaration = true;
      else if (taskDefs.names.has(fn.name)) fn.taskDeclaration = true;
      for (let k = fn.bodyStart - 1; k >= 0 && ![';', '{', '}'].includes(tokens[k].v); k--) {
        if (tokens[k].v === '__interrupt' || tokens[k].v === '_interrupt') fn.isrDeclaration = true;
      }
      fn.id = `${fn.file}::${fn.name}`;
      // #if/#else 两个分支各定义一次同名函数时 id 相同：只保留首个，避免重复节点
      if (seenFnId.has(fn.id)) continue;
      seenFnId.add(fn.id);
      const body = tokens.slice(fn.bodyStart + 1, fn.bodyEnd);
      const localTables = findFnPtrTables(body, rel, { functionId: fn.id, macros: fileMacros, pendingFields: pendingFieldInitializers, enumValues: visibleEnums });
      for (const table of localTables.values()) fnptrTablesList.push(table);
      const calls = [];
      scanCalls(body, { macros: fileMacros, enumValues: visibleEnums }, calls);
      const writes = findDispatchWrites(body, fileMacros, aliasUses, visibleEnums);
      if (localTables.size || writes.length || calls.length || fn.params.length) dispatchScopes.add(tokens[fn.bodyStart]);
      const record = { fn, calls, writes, mentions: variableMentions(body) };
      if (dispatchPolicy === 'expand' && writes.some(w => !w.path.length && w.rhsTargets?.length)) {
        record.loops = outerLoopRanges(body);
      }
      functionRecords.push(record);
      // 只延后有歧义的调用，等待头文件类型别名和包含关系收齐。
      if (calls.some(call => call.parenthesized || call.requiresTypes)) deferredTypedefCalls.push({ record, body, fileMacros });
      else recordFunctionCalls(record, body, fileMacros);
      functions.push(fn);
    }
    for (const table of findFnPtrTables(tokens, rel, { macros: fileMacros, pendingFields: pendingFieldInitializers, enumValues: visibleEnums }).values()) {
      fnptrTablesList.push(table);
    }
    collectDispatchDeclarations(tokens, dispatchScopes, binding => {
      const { declaration } = binding;
      if (!dispatchDeclarations.has(declaration.v)) dispatchDeclarations.set(declaration.v, []);
      const declarations = dispatchDeclarations.get(declaration.v);
      if (!pruneInactive && binding.alias && declaration.cond) {
        const previous = declarations.findLast(d => d.scope === binding.scope);
        if (previous?.alias) {
          binding.uncertain = true;
          binding.alternatives = [previous.alias, ...(previous.alternatives || [])];
        }
      }
      declarations.push({ ...binding, file: rel, isHeader });
    }, fileMacros, visibleEnums);
    if (aliasUses.length) aliasUsesByFile.set(rel, aliasUses);
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
    if (isHeader && !pruneInactive) for (const [name, def] of fileMacros.changes) {
      if (def) macros.set(name, def);
      else macros.delete(name);
    }
    parsed.push({ rel, isHeader, bytes, macroChanges: isHeader ? fileMacros.changes : null, profileScope: isHeader && pruneInactive ? fileMacros : null });
  };

  // 构建配置按翻译单元处理 include，普通扫描沿用先头文件后源文件的顺序。
  if (pruneInactive) {
    preprocessProfile(root, files, {
      ...parserOptions, availableFiles: rawFiles, allowLocalIncludes: !sourceFiles,
      onMissingInclude: file => missingIncludes.add(file),
      onHeaderContext: recordHeaderContext,
    }, loadInput, recordFile);
  } else {
    for (const file of [...headers, ...sources]) {
      const input = loadInput(file);
      if (!input) continue;
      const scope = fileMacroScope(macros, new Map(), { trackPositions: true });
      recordFile(file, input, preprocess(input.tokens, scope, file.rel), scope);
    }
  }
  const headerPaths = new Set(parsed.filter(file => file.isHeader).map(file => file.rel));
  for (const { resolved } of includes) if (resolved) headerPaths.add(resolved);
  const includesHeader = includedHeaders(headerPaths, includes);
  const lookupInitializerType = (file, name, at) => {
    const local = typedefsByFile.get(file)?.get(name)?.findLast(e => e.declaration.s <= at.s && (!e.scope.end || e.scope.end.s > at.s));
    if (local) return { file, shape: local.shape };
    const visible = typedefHeadersByName.get(name)?.filter(header => header !== file && includesHeader(file, header));
    if (visible?.length === 1) {
      const shape = typedefsByFile.get(visible[0]).get(name).findLast(e => e.fileScope).shape;
      return { file: visible[0], shape };
    }
  };
  const compareLocation = (a, b) => a.line - b.line || (a.col ?? 0) - (b.col ?? 0);
  const isTypedefAt = (file, name, location) =>
    typedefsByFile.get(file)?.get(name)?.some(({ declaration, scope }) =>
      compareLocation(location, declaration) > 0 && (!scope.end || compareLocation(location, scope.end) < 0)) ||
    typedefHeadersByName.get(name)?.some(header => header !== file && includesHeader(file, header));
  const skipTypeDependentCall = (file, call, params = []) => {
    if (call.parenthesized && !params.includes(call.callee) && isTypedefAt(file, call.callee, call)) return true;
    return call.requiresTypes?.some(type => params.includes(type.v) || !isTypedefAt(file, type.v, type));
  };
  for (const { record, body, fileMacros } of deferredTypedefCalls) {
    const { fn } = record;
    record.calls = record.calls.filter(call => !skipTypeDependentCall(fn.file, call, fn.params));
    recordFunctionCalls(record, body, fileMacros);
  }
  deferredTypedefCalls.length = 0;

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
  const resolveCallee = (name, fromFile, sourceFile) => {
    const all = byName.get(name);
    if (!all) return `ext::${name}`;
    const local = all.find((f) => f.file === fromFile);
    if (local) return local.id;
    if (sourceFile && sourceFile !== fromFile) {
      const inSource = all.find(f => f.file === sourceFile);
      if (inSource) return inSource.id;
    }
    const visibleStatic = f => f.isStatic && headerPaths.has(f.file) && includesHeader(fromFile, f.file);
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
  // - 数组/嵌套表只保留可见的函数定义或原型，避免把普通常量数据表误认成函数指针表；
  // - static 表只在本文件和包含其定义的翻译单元可见。
  const cleanedTables = [];
  const staticTablesByFile = new Map();
  const headerTablesByName = new Map();
  const globalTablesByName = new Map();
  const localTablesByFunction = new Map();
  const tablesWithFilteredTargets = new Set();
  const parsedSlots = new WeakMap();
  const declarationAt = (name, file, location) => dispatchDeclarations.get(name)?.findLast(p =>
    p.file === file && compareLocation(location, p.declaration) > 0 && (!p.scope.end || compareLocation(location, p.scope.end) < 0) &&
    (!p.typeToCheck || isTypedefAt(file, p.typeToCheck.v, p.typeToCheck)));
  const targetKind = (name, file, location, functionId) => {
    const local = declarationAt(name, file, location);
    if (local && !local.isFunction) return 'object';
    if ((!local || local.fileScope) && byId.get(functionId)?.params.includes(name)) return 'object';
    if (local || (byName.has(name) && !resolveCallee(name, file).startsWith('ext::'))) return 'function';
    const declared = dispatchDeclarations.get(name)?.some(p => p.isFunction && p.isHeader && p.fileScope &&
      p.file !== file && includesHeader(file, p.file));
    return declared ? 'function' : 'unknown';
  };
  for (const fill of pendingFieldInitializers) {
    fill(lookupInitializerType, (token, file, functionId) => targetKind(token.v, file, token, functionId) === 'function');
  }
  pendingFieldInitializers.length = 0;
  for (const [file, uses] of aliasUsesByFile) {
    for (const use of uses) {
      const binding = declarationAt(use.name, file, { line: use.line, col: use.col + 1 });
      if (!binding || compareLocation(use, binding.declaration) === 0) continue;
      if (!binding.alias) {
        if (use.alternative) {
          binding.alias = use.alternative;
          if (!use.alternative || uses.filter(u => u.name === use.name).length > 1) binding.uncertain = true;
        }
        continue;
      }
      binding.uncertain = true;
      if (use.alternative) (binding.alternatives ??= []).push(use.alternative);
    }
  }
  const byFileFunctions = new Map();
  for (const fn of functions) {
    if (!byFileFunctions.has(fn.file)) byFileFunctions.set(fn.file, []);
    byFileFunctions.get(fn.file).push(fn);
  }
  const realTableLocations = new Set(fnptrTablesList.map(t => `${t.file}:${t.line}:${t.name}`));
  if (dispatchPolicy === 'expand') {
    for (const bindings of dispatchDeclarations.values()) {
      for (const binding of bindings) {
        if (binding.isFunction || binding.hasBraceInit || binding.isExtern || binding.isParam) continue;
        const declKey = `${binding.file}:${binding.declaration.line}:${binding.declaration.v}`;
        if (realTableLocations.has(declKey)) continue;
        const enclosingFn = !binding.fileScope
          ? byFileFunctions.get(binding.file)?.find(f => f.line <= binding.declaration.line && binding.declaration.line <= f.endLine)
          : null;
        if (!binding.fileScope && !enclosingFn) continue;
        if (binding.pointer && !binding.isFnPtr && !binding.extents?.length) {
          const fnRhs = (binding.rhsTargets || []).some(t =>
            targetKind(t, binding.file, binding.declaration, enclosingFn?.id) === 'function');
          if (!fnRhs) continue;
        }
        fnptrTablesList.push({
          name: binding.declaration.v,
          file: binding.file,
          line: binding.declaration.line,
          isStatic: !!binding.isStatic,
          isConst: !!binding.isConst,
          recordType: binding.recordType || null,
          dims: binding.extents?.length || 0,
          map: {},
          ...(binding.rhsTargets?.length ? { candidateMap: { '': binding.rhsTargets } } : {}),
          slotLines: {},
          slots: new Map(),
          synthetic: true,
          ...(enclosingFn ? { functionId: enclosingFn.id, declaration: binding.declaration, scope: binding.scope } : {}),
        });
      }
    }
  }
  for (const raw of fnptrTablesList) {
    const filteredMap = {};
    const filteredCandidates = {};
    const location = raw.declaration ?? { line: raw.line, col: Infinity };
    for (const [slot, target] of Object.entries(raw.map)) {
      const kind = targetKind(target, raw.file, location, raw.functionId);
      const isStructField = !slot.startsWith('[') && raw.slots.get(slot)?.designated;
      if (kind === 'function' || (kind === 'unknown' && isStructField)) {
        filteredMap[slot] = target;
      }
    }
    if (raw.candidateMap) {
      for (const [slot, cands] of Object.entries(raw.candidateMap)) {
        const valid = cands.filter(t => targetKind(t, raw.file, location, raw.functionId) === 'function');
        if (valid.length) filteredCandidates[slot] = valid;
      }
    }
    const matchedSlots = Object.keys(filteredMap).length;
    const candidateSlots = Object.keys(filteredCandidates).length;
    if (!raw.synthetic && !matchedSlots && !candidateSlots && !raw.functionId && !raw.unresolvedSlots) continue;
    const entry = {
      name: raw.name,
      file: raw.file,
      line: raw.line,
      isStatic: raw.isStatic,
      isConst: raw.isConst,
      ...(raw.recordType ? { recordType: raw.recordType } : {}),
      dims: raw.dims,
      map: filteredMap,
      ...(candidateSlots ? { candidateMap: filteredCandidates } : {}),
      ...(raw.synthetic ? { synthetic: true } : {}),
      ...(raw.incomplete && { incomplete: true }),
      ...(raw.unresolvedSlots && { unresolvedSlots: raw.unresolvedSlots }),
      ...(raw.functionId && { functionId: raw.functionId }),
    };
    const slotSet = new Map();
    for (const [slot, target] of Object.entries(filteredMap)) slotSet.set(slot, { slot, target, ...raw.slots.get(slot) });
    for (const slot of (raw.unresolvedSlots || [])) if (!slotSet.has(slot)) slotSet.set(slot, { slot, target: null, ...raw.slots.get(slot) });
    for (const [slot] of Object.entries(filteredCandidates)) {
      if (!slotSet.has(slot)) slotSet.set(slot, { slot, target: null, ...(raw.slots.get(slot) || { parts: slot ? [slot] : [] }) });
    }
    parsedSlots.set(entry, [...slotSet.values()]);
    if (matchedSlots < Object.keys(raw.map).length) tablesWithFilteredTargets.add(entry);
    if (matchedSlots) cleanedTables.push(entry);
    if (entry.functionId) {
      if (!localTablesByFunction.has(entry.functionId)) localTablesByFunction.set(entry.functionId, new Map());
      const byFnName = localTablesByFunction.get(entry.functionId);
      if (!byFnName.has(entry.name)) byFnName.set(entry.name, []);
      // 同名局部数组即便全由运行时回调初始化，也会遮蔽外层表。
      const binding = dispatchDeclarations.get(entry.name)?.find(p => p.declaration === raw.declaration);
      byFnName.get(entry.name).push({ entry: (matchedSlots || candidateSlots || entry.synthetic) ? entry : null, declaration: raw.declaration, end: (binding?.scope || raw.scope).end });
    } else if (entry.isStatic) {
      if (!staticTablesByFile.has(entry.file)) staticTablesByFile.set(entry.file, new Map());
      staticTablesByFile.get(entry.file).set(entry.name, entry);
      if (headerPaths.has(entry.file)) {
        if (!headerTablesByName.has(entry.name)) headerTablesByName.set(entry.name, []);
        headerTablesByName.get(entry.name).push(entry);
      }
    } else {
      globalTablesByName.set(entry.name, entry);
    }
  }
  const lookupTable = (fn, call) => {
    const name = call.receiver;
    if (!name) return null;
    const local = localTablesByFunction.get(fn.id)?.get(name)?.findLast(table =>
      compareLocation(call, table.declaration) >= 0 && (!table.end || compareLocation(call, table.end) < 0));
    const binding = declarationAt(name, fn.file, call);
    if (binding && !binding.fileScope && (!local || compareLocation(binding.declaration, local.declaration) > 0)) {
      if (!binding.isExtern) return null;
    } else {
      if (local) return local.entry;
      if (fn.params.includes(name)) return null;
    }
    const own = staticTablesByFile.get(fn.file)?.get(name);
    if (own) return own;
    const visible = headerTablesByName.get(name)?.filter(table => includesHeader(fn.file, table.file));
    if (visible?.length) return visible.length === 1 ? visible[0] : null;
    return globalTablesByName.get(name) || null;
  };
  // null 仅匹配数组下标。成员与下标交错时，每个分量仍在原来的位置。
  const compatiblePaths = (a, b) => a.slice(0, b.length).every((part, i) =>
    part === b[i] || (typeof part !== 'string' && typeof b[i] !== 'string' && (part === null || b[i] === null)));
  const writtenSlots = new Map();
  const tableNames = new Set([
    ...cleanedTables.map(table => table.name),
    ...globalTablesByName.keys(),
    ...[...staticTablesByFile.values()].flatMap(m => [...m.keys()]),
    ...[...localTablesByFunction.values()].flatMap(m => [...m.keys()]),
  ]);
  for (const { fn, writes } of functionRecords) {
    for (const write of writes) {
      if (!tableNames.has(write.receiver)) continue;
      // 声明名本身已进入其局部作用域，不能把局部指针的初始化算到外层同名表。
      const table = lookupTable(fn, { ...write, col: write.col + 1 });
      if (!table || (write.escape && table.isConst)) continue;
      if (write.escape === 'array' && !parsedSlots.get(table).some(({ parts }) =>
        parts.length > write.path.length && typeof parts[write.path.length] !== 'string' &&
        compatiblePaths(parts, write.path))) continue;
      if (!writtenSlots.has(table)) writtenSlots.set(table, []);
      writtenSlots.get(table).push({ ...write, file: fn.file, fnId: fn.id });
    }
  }
  // 索引 typedef / struct tag 同名别名，支持 `const Ops *p; p->step()` 按结构体类型+字段解析。
  const recordTypeKeys = (rawType, file, at) => {
    if (!rawType) return [];
    const keys = new Set([rawType]);
    const bare = rawType.replace(/^(?:struct|union)\s+/, '');
    if (bare) keys.add(bare);
    const resolved = lookupInitializerType(file, rawType, at || { line: Infinity, col: Infinity, s: Infinity });
    if (resolved?.shape?.type) {
      keys.add(resolved.shape.type);
      const b2 = resolved.shape.type.replace(/^(?:struct|union)\s+/, '');
      if (b2) keys.add(b2);
    }
    return [...keys];
  };
  const byRecordField = new Map();
  const indexRecordFieldTarget = (table, fieldName, slotLabel, targetName, targetFile) => {
    const tKeys = recordTypeKeys(table.recordType, table.file, table.declaration || { line: table.line, col: 0, s: Infinity });
    if (!tKeys.length || !fieldName || !targetName) return;
    if (targetKind(targetName, targetFile, { line: Infinity, col: Infinity }, table.functionId) !== 'function') return;
    const id = resolveCallee(targetName, targetFile);
    for (const key of tKeys) {
      const k = `${key}::${fieldName}`;
      if (!byRecordField.has(k)) byRecordField.set(k, new Map());
      byRecordField.get(k).set(id + '\0' + table.file + ':' + slotLabel, {
        slot: `${key}.${fieldName}`, name: targetName, id,
        sourceFile: table.file, isStatic: table.isStatic,
      });
    }
  };
  if (dispatchPolicy === 'expand') {
    const allTables = new Set([
      ...cleanedTables,
      ...globalTablesByName.values(),
      ...[...staticTablesByFile.values()].flatMap(m => [...m.values()]),
      ...[...headerTablesByName.values()].flat(),
      ...[...localTablesByFunction.values()].flatMap(m => [...m.values()].flat().map(v => v.entry).filter(Boolean)),
    ]);
    for (const table of allTables) {
      for (const slot of (parsedSlots.get(table) || [])) {
        const lastStr = [...(slot.parts || [])].reverse().find(p => typeof p === 'string');
        if (!lastStr) continue;
        if (slot.target) indexRecordFieldTarget(table, lastStr, slot.slot, slot.target, table.file);
        for (const cand of (table.candidateMap?.[slot.slot] || [])) {
          indexRecordFieldTarget(table, lastStr, slot.slot, cand, table.file);
        }
      }
      for (const w of (writtenSlots.get(table) || [])) {
        const lastStr = w.member ? [...w.path].reverse().find(p => typeof p === 'string') : null;
        if (!lastStr || !w.rhsTargets?.length) continue;
        for (const cand of w.rhsTargets) {
          indexRecordFieldTarget(table, lastStr, `write:${w.line}.${lastStr}`, cand, w.file);
        }
      }
    }
  }
  const resolveRecordFieldCandidates = (binding, call, fn) => {
    // 只对指针或 -> 访问尝试按结构体类型+字段回查（具体全局变量 extern Ops ops; 用命名查表即可）
    if (!binding?.recordType || !call.member || (call.firstOp !== '->' && !binding.pointer)) return [];
    if (binding.typeToCheck && !isTypedefAt(fn.file, binding.typeToCheck.v, binding.typeToCheck)) return [];
    let currentType = binding.recordType;
    const memberParts = call.path.filter(p => typeof p === 'string');
    for (let i = 0; i < memberParts.length - 1; i++) {
      const found = lookupInitializerType(fn.file, currentType, call);
      const nextShape = found?.shape?.fields?.get(memberParts[i]);
      if (nextShape?.type) currentType = nextShape.type;
    }
    const leaf = memberParts.at(-1);
    const out = new Map();
    for (const key of recordTypeKeys(currentType, fn.file, call)) {
      const m = byRecordField.get(`${key}::${leaf}`);
      if (!m) continue;
      for (const [ck, cv] of m) {
        if (cv.isStatic && HDR_EXT.test(cv.sourceFile) && cv.sourceFile !== fn.file && !includesHeader(fn.file, cv.sourceFile)) continue;
        out.set(cv.id + '\0' + cv.slot, { slot: cv.slot, name: cv.name, id: cv.id });
      }
    }
    return [...out.values()];
  };
  // null 仅匹配数组下标。成员与下标交错时，每个分量仍在原来的位置。
  const possiblyWritten = (writes, path, unions = []) => writes?.some(w =>
    w.escape === 'address' || compatiblePaths(w.path, path) || unions.some(depth =>
      typeof w.path[depth] === 'string' && w.path[depth] !== path[depth] &&
      compatiblePaths(w.path.slice(0, depth), path.slice(0, depth))));
  const matchTableSlots = (table, path, writes) => {
    const matched = [];
    for (const { slot, target, parts, unknownPosition, unions } of parsedSlots.get(table)) {
      // 整个聚合值未知时，其后续成员也未知。省略括号且维度未知时可能跨行。
      const prefix = parts.length < path.length && (target === null || unknownPosition);
      if ((parts.length === path.length || prefix) && compatiblePaths(parts, path)) {
        const candidateTargets = table.candidateMap?.[slot] || [];
        matched.push({
          slot,
          rawTarget: target,
          candidateTargets,
          target: possiblyWritten(writes, parts, unions) ? null : target,
        });
      }
    }
    return matched;
  };

  const dispatchSources = (fn, call, binding) => {
    if (!binding?.alias) return [{ table: lookupTable(fn, call), path: call.path, indexExprs: call.indexExprs }];
    const sources = [];
    for (const ref of [binding.alias, ...(binding.alternatives || [])]) {
      // 捕获声明位置可见的表，调用位置可能已被另一个同名局部表遮蔽。
      const table = lookupTable(fn, ref);
      if (!table || (!ref.address && !table.dims)) continue;
      let prefix = ref.address ? ref.path : [0];
      if (binding.uncertain) prefix = prefix.map(part => typeof part === 'string' ? part : null);
      sources.push({ table, path: [...prefix, ...call.path],
        indexExprs: [...(ref.address ? ref.indexExprs : ['0']), ...call.indexExprs] });
    }
    return sources;
  };

  const MAX_FNPTR_EDGES_PER_SITE = 32;
  const MAX_FNPTR_EDGES_PER_MODEL = 50000;
  let totalExpandedFnptrEdges = 0;
  const headerCalls = (fn, calls) => {
    const variants = headerVariants.get(fn.file);
    if (!variants) return calls;
    const direct = new Map();
    let found = false;
    for (const { callsByName, sources } of variants.values()) {
      const fromVariant = callsByName.get(fn.name);
      if (!fromVariant) continue;
      found = true;
      for (const call of fromVariant) {
        if (skipTypeDependentCall(fn.file, call, fn.params)) continue;
        for (const source of sources) {
          const resolvedTarget = resolveCallee(call.callee, fn.file, source);
          const key = JSON.stringify([call.line, call.col, call.kind, resolvedTarget]);
          if (!direct.has(key)) direct.set(key, { ...call, resolvedTarget });
        }
      }
    }
    return found ? [...calls.filter(call => !call.callee), ...direct.values()] : calls;
  };

  const indirectCalls = [];
  for (const { fn, calls, nesting, mentions, taskEvidence, loops } of functionRecords) {
    const edgeStart = edges.length;
    for (const call of headerCalls(fn, calls)) {
      if (call.callee) {
        if (dispatchPolicy === 'expand' && !byName.has(call.callee)) {
          const scalarRef = { callee: null, receiver: call.callee, path: [], indexExprs: [], member: null, firstOp: null, via: call.callee, line: call.line, col: call.col };
          const tbl = lookupTable(fn, scalarRef);
          const binding = declarationAt(call.callee, fn.file, call);
          if (tbl || (binding && !binding.isFunction)) {
            const cands = new Map();
            if (tbl) {
              for (const slot of matchTableSlots(tbl, [], null)) {
                if (slot.rawTarget) {
                  const id = resolveCallee(slot.rawTarget, tbl.file);
                  cands.set(id + '\0' + slot.slot, { slot: slot.slot || call.callee, name: slot.rawTarget, id });
                }
                for (const ct of slot.candidateTargets || []) {
                  const id = resolveCallee(ct, tbl.file);
                  cands.set(id + '\0' + slot.slot, { slot: slot.slot || call.callee, name: ct, id });
                }
              }
              const loop = loops?.find(({ start, end }) => compareLocation(start, call) <= 0 && compareLocation(call, end) <= 0);
              for (const w of (writtenSlots.get(tbl) || [])) {
                if (w.path.length) continue;
                // 同一循环内靠后的写入可能经回边到达下一轮调用。
                if (w.fnId === fn.id && compareLocation(w, call) >= 0 && (!loop || compareLocation(w, loop.end) > 0)) continue;
                for (const rhsT of (w.rhsTargets || [])) {
                  if (targetKind(rhsT, w.file, { line: w.line, col: w.col }, w.fnId) !== 'function') continue;
                  const id = resolveCallee(rhsT, w.file);
                  cands.set(id + '\0write:' + w.line, { slot: `write:${w.line}`, name: rhsT, id });
                }
              }
            }
            for (const rhsT of (binding?.rhsTargets || [])) {
              if (targetKind(rhsT, binding.file, binding.declaration, tbl?.functionId) !== 'function') continue;
              const id = resolveCallee(rhsT, binding.file);
              cands.set(id + '\0decl:' + binding.declaration.line, { slot: 'decl', name: rhsT, id });
            }
            if (cands.size > 0) {
              const siteId = `${fn.id}@${call.line}:${call.col ?? 0}`;
              const candList = [...cands.values()];
              const uniqueByCallee = new Map();
              for (const c of candList) if (!uniqueByCallee.has(c.id)) uniqueByCallee.set(c.id, c);
              const emittedList = [...uniqueByCallee.values()].slice(0, MAX_FNPTR_EDGES_PER_SITE);
              const res = candList.length === 1 ? 'possible' : 'possible';
              for (const c of emittedList) {
                if (totalExpandedFnptrEdges >= MAX_FNPTR_EDGES_PER_MODEL) break;
                totalExpandedFnptrEdges++;
                edges.push({
                  from: fn.id, to: c.id, callee: c.name, kind: 'fnptr',
                  line: call.line, col: call.col, orderGroup: call.orderGroup,
                  ...(call.onceWhenGatesMatch && { onceWhenGatesMatch: true }),
                  cond: call.cond, via: call.via || call.callee,
                  siteId, resolution: res, dynamicDispatch: true,
                  macroChain: call.macroChain, macroDefinitions: call.macroDefinitions,
                });
              }
              indirectCalls.push({
                caller: fn.id, callerName: fn.name, file: fn.file, line: call.line, col: call.col,
                siteId, expr: call.via || call.callee, receiver: call.callee, member: null, indices: [],
                resolution: res, truncated: uniqueByCallee.size > MAX_FNPTR_EDGES_PER_SITE,
                matchedSlots: candList.length,
                table: tbl ? { name: tbl.name, file: tbl.file, line: tbl.line, isStatic: tbl.isStatic } : null,
                candidates: candList,
              });
              continue;
            }
          }
        }
        edges.push({
          from: fn.id,
          to: call.resolvedTarget ?? resolveCallee(call.callee, fn.file),
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
      const siteId = `${fn.id}@${call.line}:${call.col ?? 0}`;
      const binding = (call.firstOp === '->' || dispatchPolicy === 'expand') ? declarationAt(call.receiver, fn.file, call) : null;
      const aliasBinding = call.firstOp === '->' ? binding : null;
      const sources = dispatchSources(fn, call, aliasBinding);
      const tables = new Set(sources.map(source => source.table).filter(Boolean));
      const table = tables.size === 1 ? [...tables][0] : null;
      const matched = [];
      const expandCandidates = new Map();
      let uncertain = aliasBinding?.uncertain || (aliasBinding?.alias && !pruneInactive &&
        aliasBinding.declaration.cond && aliasBinding.declaration.cond !== call.cond);
      let hasSlotWrite = false;
      for (const source of sources) {
        if (!source.table) continue;
        let writes = writtenSlots.get(source.table);
        if (writes && source.table.isStatic && headerPaths.has(source.table.file) && !headerPaths.has(fn.file)) {
          // 头文件里的 static 对象在每个翻译单元有独立实例。
          writes = writes.filter(write => write.file === fn.file || includesHeader(fn.file, write.file));
        }
        if (possiblyWritten(writes, source.path) || (aliasBinding?.alias && source.path.includes(null))) {
          uncertain = true;
          hasSlotWrite = true;
        }
        for (const slot of matchTableSlots(source.table, source.path, writes)) {
          matched.push({ ...slot, file: source.table.file });
          if (dispatchPolicy === 'expand') {
            if (slot.rawTarget) {
              const id = resolveCallee(slot.rawTarget, source.table.file);
              expandCandidates.set(id + '\0' + slot.slot, { slot: slot.slot, name: slot.rawTarget, id });
            }
            for (const ct of (slot.candidateTargets || [])) {
              const id = resolveCallee(ct, source.table.file);
              expandCandidates.set(id + '\0' + slot.slot, { slot: slot.slot, name: ct, id });
            }
          }
        }
        if (dispatchPolicy === 'expand' && writes) {
          for (const w of writes) {
            if (!w.escape && !compatiblePaths(w.path, source.path) && !compatiblePaths(source.path, w.path)) continue;
            for (const rhsT of (w.rhsTargets || [])) {
              if (targetKind(rhsT, w.file, { line: w.line, col: w.col }, w.fnId) !== 'function') continue;
              const id = resolveCallee(rhsT, w.file);
              const wSlot = w.member ? `.${w.member}` : w.indices.length ? `[${w.indices.map(i => i ?? '?').join('][')}]` : 'write';
              expandCandidates.set(id + '\0' + wSlot + '@' + w.line, { slot: wSlot, name: rhsT, id });
            }
          }
        }
      }
      if (dispatchPolicy === 'expand' && expandCandidates.size === 0 && call.member && binding?.recordType) {
        for (const rc of resolveRecordFieldCandidates(binding, call, fn)) {
          expandCandidates.set(rc.id + '\0' + rc.slot, rc);
        }
      }
      const uniqueTargets = [...new Set(matched.map((s) => s.target))];
      const allConstIndices = sources.every(source => !source.path.includes(null));
      const strictSingle = Boolean(table && !table.synthetic && !table.incomplete && !uncertain &&
        uniqueTargets.length === 1 && uniqueTargets[0] !== null &&
        (allConstIndices || (matched.length === 1 && !tablesWithFilteredTargets.has(table))));
      if (strictSingle) {
        const callee = uniqueTargets[0];
        edges.push({
          from: fn.id,
          to: resolveCallee(callee, table.file),
          callee,
          kind: 'fnptr',
          line: call.line, col: call.col, orderGroup: call.orderGroup,
          ...(call.onceWhenGatesMatch && { onceWhenGatesMatch: true }),
          cond: call.cond,
          via: call.via,
          siteId,
          resolution: 'exact',
          macroChain: call.macroChain,
          macroDefinitions: call.macroDefinitions,
        });
      } else if (dispatchPolicy === 'expand' && expandCandidates.size > 0) {
        const candList = [...expandCandidates.values()];
        const uniqueByCallee = new Map();
        for (const c of candList) if (!uniqueByCallee.has(c.id)) uniqueByCallee.set(c.id, c);
        const emittedList = [...uniqueByCallee.values()].slice(0, MAX_FNPTR_EDGES_PER_SITE);
        const truncated = uniqueByCallee.size > MAX_FNPTR_EDGES_PER_SITE;
        const resolution = 'possible';
        for (const c of emittedList) {
          if (totalExpandedFnptrEdges >= MAX_FNPTR_EDGES_PER_MODEL) break;
          totalExpandedFnptrEdges++;
          edges.push({
            from: fn.id,
            to: c.id,
            callee: c.name,
            kind: 'fnptr',
            line: call.line, col: call.col, orderGroup: call.orderGroup,
            ...(call.onceWhenGatesMatch && { onceWhenGatesMatch: true }),
            cond: call.cond,
            via: call.via,
            siteId,
            resolution,
            dynamicDispatch: true,
            macroChain: call.macroChain,
            macroDefinitions: call.macroDefinitions,
          });
        }
        indirectCalls.push({
          caller: fn.id,
          callerName: fn.name,
          file: fn.file,
          line: call.line,
          col: call.col,
          siteId,
          expr: call.via || '',
          receiver: call.receiver || null,
          member: call.member || null,
          indices: sources.length === 1 ? sources[0].indexExprs : call.indexExprs,
          resolution,
          truncated,
          matchedSlots: candList.length,
          table: table ? { name: table.name, file: table.file, line: table.line, isStatic: table.isStatic } : null,
          candidates: candList,
        });
      } else {
        // strict 模式或静态零候选的未解析函数指针：保留调用点供检查/诊断
        const candidates = new Map();
        for (const { slot, target, file } of matched) {
          if (target === null) continue;
          const id = resolveCallee(target, file);
          candidates.set(id + '\0' + slot, { slot, name: target, id });
        }
        indirectCalls.push({
          caller: fn.id,
          callerName: fn.name,
          file: fn.file,
          line: call.line,
          col: call.col,
          siteId,
          expr: call.via || '',
          receiver: call.receiver || null,
          member: call.member || null,
          indices: sources.length === 1 ? sources[0].indexExprs : call.indexExprs,
          resolution: 'unresolved',
          truncated: false,
          matchedSlots: candidates.size,
          table: table ? { name: table.name, file: table.file, line: table.line, isStatic: table.isStatic } : null,
          candidates: [...candidates.values()],
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
  const noteExternal = id => {
    if (id.startsWith('ext::') && !externals.has(id)) {
      externals.set(id, { id, name: id.slice(5), file: '<external>', line: 0, isStatic: false, external: true, params: [] });
    }
  };
  for (const edge of edges) noteExternal(edge.to);
  for (const call of indirectCalls) for (const candidate of call.candidates) noteExternal(candidate.id);

  // 邻接表
  const allNodes = new Map([...byId, ...externals]);
  const callsByMacro = new Map();
  for (const e of edges.filter((edge) => edge.kind !== 'var')) for (const id of e.macroDefinitions || []) {
    if (!callsByMacro.has(id)) callsByMacro.set(id, []);
    callsByMacro.get(id).push(e);
  }
  const symbols = headerSymbols(parsed, resolveCallee,
    new Set([...byName.keys(), ...edges.filter(e => e.kind !== 'var').map(e => e.callee)]), macros, callsByMacro, skipTypeDependentCall);
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
    externalDeps: [...externalDeps.values()],
    ...(externalHeaders.size ? { externalHeaders } : {}),
    missingIncludes: [...missingIncludes],
    compilationUnits: parserOptions?.compilationUnits || {},
    ...(Array.isArray(parserOptions?.defines) && parserOptions.defines.length ? { buildDefines: [...parserOptions.defines] } : {}),
    ...(pruneInactive ? {
      pruneInactive: true, includeDirs: parserOptions.includeDirs || [], includeOptions: parserOptions.includeOptions,
      forcedIncludes: parserOptions.forcedIncludes || [], macroIncludes: parserOptions.macroIncludes,
      macroArgs: parserOptions.macroArgs, languageStandard: parserOptions.languageStandard,
      workingDirectory: parserOptions.workingDirectory,
    } : {}),
  };

  return model;
}

export const builtinParser = {
  id: 'builtin',
  name: '内置快速解析 (Lexer + Tree-sitter)',
  available: () => ({ ok: true }),
  cacheKey: (root, options = {}) => {
    const policy = options?.dispatchPolicy === 'strict' ? 'strict' : 'expand';
    const hasProfile = Boolean(options?.buildProfileId);
    const hasActive = Array.isArray(options?.activeFiles);
    const hasDefines = Array.isArray(options?.defines) && options.defines.length > 0;
    if (!hasProfile && !hasActive && !hasDefines && policy === 'expand') return 'builtin:26';
    return JSON.stringify([
      'builtin:26',
      policy,
      options?.buildProfileId || null,
      hasActive ? options.activeFiles : null,
      hasDefines ? options.defines : [], options.includeDirs || [], options.forcedIncludes || [], options.compilationUnits || {},
      options.includeOptions, options.macroArgs, options.macroIncludes, options.languageStandard, options.workingDirectory,
    ]);
  },
  parse: (root, { sourceFiles, scan, parserOptions }) => buildBuiltinIndex(root, sourceFiles, scan, parserOptions),
  buildDataflow: buildBuiltinDataflow,
  compareDefinitions: definitionsOf,
  compareMacros: macroDiff,
  fingerprint,
};
