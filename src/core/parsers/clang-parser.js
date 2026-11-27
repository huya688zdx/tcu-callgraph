import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeSource, scanSources } from '../source-files.js';
import { clangCacheKey, completeCompileUnits, dependencyStamp, detectClang, fileKey,
  findCompileCommands, readCompileCommands, relativeFile } from './clang-config.js';
import { children, collectAssignmentWrites, fnRef, functionModel, functionSignature, pointerExpression, pointerSlots,
  readTranslationUnit, transferredValues, typeOf, variableModel, walk } from './clang-ast.js';
import { aggregateCopyReader, matchingSlot } from './clang-copy.js';
import { collectDataflow } from './clang-dataflow.js';
import { applyDataflow } from './ir.js';
import { lex } from '../lexer.js';
import { fingerprint } from '../source-fingerprint.js';
import { fileMacroScope, preprocess } from '../preproc.js';
import { applyTaskEvidence, collectTaskEvidence } from '../task-periods.js';
import { applyStaticSchedule, staticSchedule } from '../tcu-schedule.js';

export { detectClang, findCompileCommands, readCompileCommands };
const execute = promisify(execFile);

function hasConstSlots(node) {
  const type = typeOf(node);
  const pointer = /\(\s*\*([^)]*)\)/.exec(type);
  return pointer ? /\bconst\b/.test(pointer[1]) : /^const\b/.test(type);
}

function resolveDecl(ref, context, byDecl, exported) {
  const declaration = context.declarations.get(ref?.id);
  return byDecl.get(context)?.get(ref?.id)
    || (declaration && declaration.node.storageClass !== 'static' ? exported.get(ref.name) : undefined);
}

function assemble(root, files, units, warnings, failedFiles, sourcePaths, dispatchPolicy = 'expand') {
  const functions = new Map(), defs = new Map(), externals = new Map();
  const fnDecls = new Map(), varDecls = new Map(), publicFns = new Map();
  const functionRecords = [], recordsById = new Map();
  const addExternal = (id, name) => {
    if (!externals.has(id)) externals.set(id, { id, name, file: '<external>', line: 0, external: true, params: [] });
    return id;
  };
  for (const unit of units) {
    const localFns = new Map(), localVars = new Map();
    fnDecls.set(unit, localFns);
    varDecls.set(unit, localVars);
    for (const record of unit.functions) {
      const fn = functionModel(record);
      record.fn = functions.get(fn.id) || fn;
      functions.set(fn.id, record.fn);
      localFns.set(record.node.id, fn.id);
      if (!fn.isStatic) publicFns.set(fn.name, fn.id);
      functionRecords.push(record);
      if (!recordsById.has(fn.id)) recordsById.set(fn.id, []);
      recordsById.get(fn.id).push(record);
    }
    for (const node of unit.globals) {
      const def = variableModel(node, unit);
      const prev = defs.get(def.id);
      if (!prev || (prev.isExtern && !def.isExtern)) defs.set(def.id, def);
      localVars.set(node.id, def.id);
    }
    for (const [decls, locals] of [[unit.functions.map((r) => r.node), localFns], [unit.globals, localVars]]) {
      for (const node of decls) {
        const id = locals.get(node.id);
        let previous = node.previousDecl;
        while (previous && !locals.has(previous)) {
          locals.set(previous, id);
          previous = unit.declarations.get(previous)?.node.previousDecl;
        }
      }
    }
  }
  const resolveFunction = (ref, unit) => resolveDecl(ref, unit, fnDecls, publicFns)
    || addExternal(`ext::${ref.name}`, ref.name);
  // 局部变量即使与全局同名也不能从名字回退到全局定义。
  const resolveVariable = (ref, unit) => ref?.kind === 'VarDecl' ? varDecls.get(unit).get(ref.id) : undefined;

  // AST 地址只在单个编译单元内唯一。局部对象用声明节点本身作为键。
  const objectKey = (decl, unit) => resolveVariable(decl, unit) ?? unit.declarations.get(decl?.id)?.node;
  const tables = new Map(), addressTaken = new Map(), calls = [], byRecordField = new Map(), declWrites = new Map();
  // 同一头文件声明在不同编译单元有不同 AST id，但共享源码位置。
  const fieldKey = (unit, id) => {
    const field = unit.declarations.get(id);
    return field?.position?.file && `${field.position.file}:${field.position.offset}:${field.node.name}`;
  };
  // 字段声明不携带外层对象路径，但字段自身的数组下标仍约束候选。
  const memberIndices = slot => {
    const start = slot.indexOf('[', slot.lastIndexOf('.') + 1);
    return start < 0 ? '' : slot.slice(start);
  };
  const indexField = (fields, unit, id, slot, target) => {
    const key = fieldKey(unit, id);
    if (!key) return;
    if (!fields.has(key)) fields.set(key, new Map());
    const indices = memberIndices(slot), slots = fields.get(key);
    if (!slots.has(indices)) slots.set(indices, new Set());
    slots.get(indices).add(target);
  };
  const noteAddress = (ref, unit) => {
    const target = resolveFunction(ref.referencedDecl, unit);
    const sig = functionSignature(typeOf(ref.referencedDecl) || typeOf(ref), unit);
    if (!addressTaken.has(sig)) addressTaken.set(sig, new Set());
    addressTaken.get(sig).add(target);
  };
  const indirectFieldWrites = new Map(), forwardedParams = new Set();
  const localFields = new WeakMap();
  const fieldsFor = (unit, node) => {
    const scope = unit.scopeOf.get(node);
    if (!localFields.has(scope)) localFields.set(scope, new Map());
    return localFields.get(scope);
  };
  const indexTable = (node, unit, fields) => {
    const candidateSlots = new Map();
    const slots = pointerSlots(node, unit, resolveFunction, candidateSlots,
      (id, slot, target) => indexField(fields, unit, id, slot, target));
    if (slots.size || candidateSlots.size) {
      tables.set(objectKey(node, unit), { slots, candidateSlots, constant: hasConstSlots(node) });
    }
  };
  for (const unit of units) {
    for (const node of unit.globals) {
      if (node.init) indexTable(node, unit, byRecordField);
      const init = node.init && children(node).find((n) => !n.kind.endsWith('Attr'));
      if (init) for (const child of walk(init)) {
        if (child.kind === 'DeclRefExpr' && child.referencedDecl?.kind === 'FunctionDecl') noteAddress(child, unit);
      }
    }
    for (const record of unit.functions) {
      const direct = new Set();
      for (const node of walk(record.body)) {
        for (const value of transferredValues(node)) {
          if (!typeOf(value).includes('*')) continue;
          for (const use of walk(value)) {
            const ref = use.referencedDecl;
            if (ref?.kind === 'ParmVarDecl') forwardedParams.add(objectKey(ref, unit));
          }
        }
        if (node.kind === 'VarDecl' && node.init && node.storageClass !== 'extern') {
          indexTable(node, unit, fieldsFor(unit, node));
        }
        if (node.kind === 'CallExpr' && node.inner?.length) {
          const [callee] = node.inner, ref = fnRef(callee);
          if (ref) direct.add(ref);
          calls.push({ record, node, callee, ref });
        }
        if (node.kind === 'DeclRefExpr' && node.referencedDecl?.kind === 'FunctionDecl' && !direct.has(node)) noteAddress(node, unit);
      }
      for (const w of collectAssignmentWrites(record.body, unit, resolveFunction)) {
        const declKey = objectKey(w.decl, unit);
        if (!declWrites.has(declKey)) declWrites.set(declKey, []);
        declWrites.get(declKey).push({ ...w, record });
        if (w.fieldId) {
          const fields = typeof declKey === 'string' || w.decl.kind === 'ParmVarDecl' ? byRecordField : fieldsFor(unit, w.node);
          for (const target of w.targets) {
            indexField(fields, unit, w.fieldId, w.slot, target);
            if (w.throughPointer) indexField(indirectFieldWrites, unit, w.fieldId, w.slot, target);
          }
        }
      }
    }
  }

  const slotReaders = new WeakMap();
  function trackedTargets(record, pointer, call) {
    if (!pointer?.member || pointer.throughPointer) return null;
    if (!slotReaders.has(record)) {
      const ambientTargets = (key, slot) => {
        if (typeof key !== 'string') return [];
        const ids = [];
        const table = tables.get(key);
        for (const [path, id] of table?.slots || []) if (matchingSlot(path, slot)) ids.push(id);
        for (const [path, targets] of table?.candidateSlots || []) if (matchingSlot(path, slot)) ids.push(...targets);
        for (const w of declWrites.get(key) || []) if (w.record !== record && matchingSlot(w.slot, slot)) ids.push(...w.targets);
        return ids;
      };
      // 只看直接被调函数对应形参的写入。地址经别名或未知函数传递时，按声明字段保留间接写候选。
      const parameterWrites = (callee, index) => {
        const unit = record.context;
        const id = resolveDecl(fnRef(callee)?.referencedDecl, unit, fnDecls, publicFns);
        const definitions = recordsById.get(id);
        const target = definitions?.find(r => r.context === unit) || definitions?.[0];
        const param = children(target?.node).filter(n => n.kind === 'ParmVarDecl')[index];
        if (!param) return [null];
        const writes = (declWrites.get(param) || []).filter(w => w.throughPointer);
        if (forwardedParams.has(param)) writes.push(null);
        return writes;
      };
      const fieldWrites = (fieldId, slot) => {
        const entries = indirectFieldWrites.get(fieldKey(record.context, fieldId));
        const ids = [];
        for (const [indices, targets] of entries || []) {
          if (matchingSlot(indices, memberIndices(slot))) ids.push(...targets);
        }
        return ids;
      };
      slotReaders.set(record, aggregateCopyReader(record, objectKey, resolveFunction, ambientTargets, { parameterWrites, fieldWrites }));
    }
    return slotReaders.get(record)(pointer, call);
  }
  const edges = new Map(), callTargets = new WeakMap(), indirectCalls = [];
  const includes = new Map();
  for (const unit of units) for (const entry of unit.loc.includes) includes.set(...entry);
  for (const { record, node, callee, ref } of calls) {
    const { context, fn } = record;
    const pos = context.loc.begin(node);
    const line = pos?.line ?? fn.line;
    let candidates, kind, via, siteId, resolution, dynamicDispatch = false;
    if (ref) {
      candidates = [resolveFunction(ref.referencedDecl, context)];
      const macro = [pos, context.loc.end(node), context.loc.begin(ref)].find((p) => p?.macro && !p.macroArgument);
      kind = macro ? 'macro' : 'direct';
      if (macro) via = context.loc.token(macro) || ref.referencedDecl.name;
    } else {
      kind = 'fnptr';
      siteId = `${fn.id}@${line}:${pos?.col ?? 0}`;
      const pointer = pointerExpression(callee, context);
      const expression = context.loc.text(callee) || pointer?.decl?.name || '<间接调用>';
      const signature = functionSignature(typeOf(callee), context);
      const varKey = objectKey(pointer?.decl, context);
      const table = tables.get(varKey);
      const tracked = trackedTargets(record, pointer, node);
      // 空数组表示追踪过该成员，但目前的值未知；不能重新引入旧初始化值。
      const exact = tracked === null && pointer?.exact && table?.constant && table.slots.get(pointer.slot);
      const targets = addressTaken.get(signature);
      const matchingSlots = tracked || [];
      if (tracked === null && table) {
        if (pointer.slot.includes('[*]')) {
          for (const [slot, to] of table.slots) if (matchingSlot(slot, pointer.slot)) matchingSlots.push(to);
          for (const [slot, tos] of table.candidateSlots) if (matchingSlot(slot, pointer.slot)) matchingSlots.push(...tos);
        } else {
          if (table.slots.has(pointer.slot)) matchingSlots.push(table.slots.get(pointer.slot));
          matchingSlots.push(...(table.candidateSlots.get(pointer.slot) || []));
        }
      }
      const objectWrites = declWrites.get(varKey) || [];
      const writesForVar = tracked === null ? objectWrites.filter(w => matchingSlot(w.slot, pointer.slot)) : [];
      const writtenTargets = writesForVar.flatMap(w => w.targets);
      const field = fieldKey(context, pointer?.fieldId);
      const fieldCandidates = new Set();
      const knownObject = table || (pointer?.decl?.kind === 'VarDecl' && !pointer.throughPointer &&
        (pointer.member || objectWrites.length || /\[[^\]]*\]$/.test(typeOf(pointer.decl))));
      if (field && !knownObject) {
        const indices = memberIndices(pointer.slot);
        const collect = fields => {
          for (const [slot, ids] of fields?.get(field) || []) {
            if (matchingSlot(slot, indices)) for (const id of ids) fieldCandidates.add(id);
          }
        };
        collect(byRecordField);
        for (let scope = context.scopeOf.get(node); scope; scope = context.scopeOf.get(scope)) collect(localFields.get(scope));
      }
      if (dispatchPolicy === 'strict') {
        if (exact && !writesForVar.length) {
          candidates = [exact];
          resolution = 'exact';
          via = `${expression}（初始化槽位）`;
        } else {
          candidates = [];
          resolution = 'unresolved';
          const fallbackList = [...new Set([...matchingSlots, ...writtenTargets, ...fieldCandidates])];
          indirectCalls.push({
            caller: fn.id, callerName: fn.name, file: fn.file, line, col: pos?.col, siteId,
            expr: expression, receiver: pointer?.decl?.name || null, member: pointer?.member || null,
            resolution, truncated: false, matchedSlots: fallbackList.length,
            candidates: fallbackList.map(id => ({ slot: pointer?.slot || '', name: (functions.get(id) || externals.get(id))?.name || id, id })),
          });
        }
      } else {
        const combinedSlots = [...new Set([...matchingSlots, ...writtenTargets])];
        const signatureTargets = !knownObject && !(pointer?.member && pointer.baseType) ? targets : null;
        if (exact && !writesForVar.length) {
          candidates = [exact];
          resolution = 'exact';
          via = `${expression}（初始化槽位）`;
        } else if (combinedSlots.length) {
          candidates = combinedSlots.slice(0, 32);
          resolution = 'possible';
          dynamicDispatch = true;
          via = `${expression}（静态槽位展开）`;
        } else if (fieldCandidates.size) {
          candidates = [...fieldCandidates].slice(0, 32);
          resolution = 'possible';
          dynamicDispatch = true;
          via = `${expression}（结构体字段 ${pointer.baseType}.${pointer.member}）`;
        } else if (signatureTargets?.size) {
          candidates = [...signatureTargets].slice(0, 32);
          resolution = 'possible';
          dynamicDispatch = true;
          via = `${expression}（类型签名 ${signature} + 已取地址函数）`;
        } else {
          candidates = [addExternal(`ext::fnptr::${fn.file}::${expression}::${signature}`, expression)];
          resolution = 'unresolved';
          via = `${expression}（未解析，类型 ${signature || '未知'}）`;
        }
        if (resolution !== 'exact') {
          const icCands = candidates.filter(id => !id.startsWith('ext::fnptr::')).map(id => ({
            slot: pointer?.slot || '',
            name: (functions.get(id) || externals.get(id))?.name || id,
            id,
          }));
          indirectCalls.push({
            caller: fn.id, callerName: fn.name, file: fn.file, line, col: pos?.col, siteId,
            expr: expression, receiver: pointer?.decl?.name || null, member: pointer?.member || null,
            resolution, truncated: (combinedSlots.length || fieldCandidates.size || signatureTargets?.size || 0) > 32,
            matchedSlots: icCands.length, candidates: icCands,
          });
        }
      }
    }
    callTargets.set(node, candidates.flatMap((id) => {
      const records = recordsById.get(id);
      if (!records) return [];
      return [records.find((r) => r.context === context) || records[0]];
    }));
    for (const to of candidates) {
      const edge = {
        from: fn.id, to, callee: (functions.get(to) || externals.get(to)).name, kind, line, col: pos?.col, via,
        ...(siteId ? { siteId, resolution, ...(dynamicDispatch ? { dynamicDispatch: true } : {}) } : {}),
      };
      edges.set(JSON.stringify([edge.from, to, line, kind, via, pos?.offset]), edge);
    }
  }

  const macros = addSchedulingEvidence(functions, functionRecords, units, defs, edges, files, sourcePaths);
  const externalDeps = [...new Set(units.flatMap(unit => [...unit.loc.externalFiles]))]
    .map(file => dependencyStamp(file) || { file });
  const df = collectDataflow(units, functionRecords, defs, resolveVariable, callTargets);
  df.failedFiles = failedFiles;
  const enumConstants = new Map(), enumDeclarations = new Map();
  for (const unit of units) {
    for (const item of unit.enumById.values()) {
      if (!item.id) continue;
      const key = JSON.stringify([item.id, item.value]);
      if (!enumConstants.has(key)) enumConstants.set(key, { ...item, units: [] });
      enumConstants.get(key).units.push(unit.unit.rel);
    }
    for (const item of unit.enumDeclarations) enumDeclarations.set(JSON.stringify([item.file, item.hash]), item);
  }
  const model = { root, files, functions: [...functions.values()], externals: [...externals.values()],
    edges: [...edges.values()], macros, externalDeps, _df: df, includes: [...includes.values()], warnings, indirectCalls,
    enumConstants: [...enumConstants.values()], enumDeclarations: [...enumDeclarations.values()],
    fnptrTables: [...tables].filter(([id]) => defs.has(id)).map(([id, { slots }]) => ({
      id, name: defs.get(id).name, file: defs.get(id).file,
      map: Object.fromEntries([...slots].map(([slot, to]) => [slot, (functions.get(to) || externals.get(to)).name])),
    })),
  };
  applyDataflow(model, df);
  return model;
}

// 以 AST 确认的定义与调用位置为准，从原始源码提取调度器约定。
function addSchedulingEvidence(functions, records, units, defs, edges, files, sourcePaths) {
  const headerMacros = new Map(), macros = new Map(), sources = new Map();
  for (const file of [...files.filter(f => f.isHeader), ...files.filter(f => !f.isHeader)]) {
    const input = lex(decodeSource(fs.readFileSync(sourcePaths.get(file.rel))), file.rel);
    const scope = fileMacroScope(headerMacros, new Map(), { trackPositions: true });
    const { tokens } = preprocess(input, scope, file.rel);
    sources.set(file.rel, { tokens, scope, lines: Map.groupBy(tokens, t => t.line) });
    for (const [name, def] of scope.changes) {
      if (def) macros.set(name, def);
      if (file.isHeader) {
        if (def) headerMacros.set(name, def);
        else headerMacros.delete(name);
      }
    }
  }
  const byName = Map.groupBy(functions.values(), fn => fn.name);
  const calls = Map.groupBy(edges.values(), edge => edge.from);
  const globals = Map.groupBy(units.flatMap(unit => unit.globals.map(node => ({
    start: unit.loc.begin(node), end: unit.loc.end(node),
  }))), item => item.start?.file);
  for (const [file, { tokens, scope }] of sources) {
    const rows = staticSchedule(tokens, file, scope);
    applyStaticSchedule(rows.filter(row => (globals.get(file) || []).some(({ start, end }) =>
      row.line >= start.line && row.line <= end?.line)), byName);
  }
  const seen = new Set();
  for (const { fn, body, node, context } of records) {
    if (seen.has(fn.id)) continue;
    seen.add(fn.id);
    const { lines, scope } = sources.get(fn.file);
    const first = context.loc.begin(body), last = context.loc.end(body);
    if (!first?.col || !last?.col) continue;
    const sites = new Set();
    for (const part of walk(body)) {
      for (const position of [context.loc.begin(part), context.loc.end(part)]) {
        if (position?.file === fn.file) sites.add(position.line + ':' + position.col);
      }
    }
    const inBody = [];
    for (let line = first.line; line <= last.line; line++) {
      for (const token of lines.get(line) || []) {
        if ((line !== first.line || token.col > first.col) && (line !== last.line || token.col < last.col)) inBody.push(token);
      }
    }
    const active = new Set(inBody.filter(t => sites.has(t.line + ':' + t.col)).map(t => t.cond));
    const params = children(node).filter(n => n.kind === 'ParmVarDecl').map(n => n.name);
    const evidence = collectTaskEvidence({ ...fn, params }, inBody.filter(t => !t.cond || active.has(t.cond)).map(({ cond, ...token }) => token),
      scope, calls.get(fn.id));
    applyTaskEvidence(fn, evidence, byName);
    for (const counter of [...(fn.counterIncrements || []), ...(fn.callDividers || []).flatMap(site => site.gates)]) {
      if (counter.local) continue;
      const local = 'var::' + fn.file + '::' + counter.counter, global = 'var::' + counter.counter;
      if (defs.has(local)) counter.variable = local;
      else if (defs.has(global)) counter.variable = global;
    }
  }
  return [...macros.values()];
}

function readDependencies(file, cwd) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').replace(/\\\r?\n/g, ' ').replace(/^callgraph:/, '');
  return [...text.matchAll(/(?:\\[ \t#\\]|[^\s])+/g)].map(([word]) => path.resolve(cwd,
    word.replace(/\\([ \t#\\])/g, '$1').replaceAll('$$', '$')));
}

async function parseClang(root, { sourceFiles, scan, parserOptions: options }) {
  const started = Date.now();
  root = path.resolve(root);
  const { compileCommandsPath, execClang, clangBin } = options;
  const warnings = [...(scan?.warnings || [])];
  const database = findCompileCommands(root, compileCommandsPath);
  const bin = clangBin || process.env.CALLGRAPH_CLANG || 'clang';
  let workRoot = root, dependenciesDir;
  const remap = (file) => {
    const rel = relativeFile(root, file);
    return rel === null ? file : path.join(workRoot, rel);
  };
  try {
    // 对照版本按原项目相对路径独立编译，保持头文件搜索顺序与符号 ID。
    if (sourceFiles) {
      workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-clang-'));
      for (const [rel, from] of sourceFiles) {
        const file = path.resolve(workRoot, rel);
        if (!relativeFile(workRoot, file)) throw new Error(`无效对照文件路径：${rel}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(from, file);
      }
    }
    const found = !sourceFiles && scan?.files ? scan.files : scanSources(workRoot, warnings);
    const names = new Map(found.map((f) => [fileKey(f.rel), f.rel]));
    const headers = found.filter((f) => f.isHeader);
    const includeArgs = [...new Set([workRoot, ...headers.map((f) => path.dirname(f.abs))])].flatMap((dir) => ['-I', dir]);
    if (!database && options.strictCompileCommands) {
      throw new Error('严格编译数据库模式需要有效的 compile_commands.json');
    }
    const responseFiles = new Map();
    const units = database
      ? (options.strictCompileCommands
        ? readCompileCommands(root, database, { files: found, remap, responseFiles, includeTemplates: false })
        : completeCompileUnits(
          readCompileCommands(root, database, { files: found, remap, responseFiles, includeTemplates: true }), found, includeArgs))
      : found.filter((f) => !f.isHeader).map((f) => ({ rel: f.rel, file: f.abs, cwd: workRoot, args: includeArgs }));
    const selected = new Set(units.map((unit) => unit.rel));
    if (!units.length) {
      // 选中配置的全部编译单元可能在本次变更中新增或删除；比较的这一侧即为空图。
      if (sourceFiles && options.buildProfileId && options.strictCompileCommands) {
        return { ...assemble(root, [], [], warnings, 0, new Map()), elapsedMs: Date.now() - started };
      }
      throw new Error('Clang AST 未找到当前工程的编译单元');
    }
    const parsed = [];
    if (!execClang) dependenciesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-deps-'));
    const dependencyFile = dependenciesDir && path.join(dependenciesDir, 'headers.d');
    let failedFiles = warnings.length;
    for (const unit of units) {
      const dependencyArgs = dependencyFile ? ['-MD', '-MF', dependencyFile, '-MT', 'callgraph'] : [];
      const args = ['-fsyntax-only', '-Xclang', '-ast-dump=json', ...unit.args, ...dependencyArgs, '--', unit.file];
      try {
        if (sourceFiles && relativeFile(workRoot, unit.cwd) !== null) fs.mkdirSync(unit.cwd, { recursive: true });
        if (dependencyFile) fs.rmSync(dependencyFile, { force: true });
        const result = execClang ? await execClang(unit.file, args, { cwd: unit.cwd })
          : await execute(bin, args, { cwd: unit.cwd, maxBuffer: 128 * 1024 * 1024, timeout: 120000, windowsHide: true });
        const output = result?.stdout ?? result;
        const ast = Buffer.isBuffer(output) || typeof output === 'string' ? JSON.parse(output.toString()) : output;
        const parsedUnit = readTranslationUnit(ast, workRoot, unit, names);
        if (dependencyFile) for (const dep of readDependencies(dependencyFile, unit.cwd)) {
          const rel = relativeFile(workRoot, dep);
          if (rel === null || !names.has(fileKey(rel))) parsedUnit.loc.externalFiles.add(dep);
        }
        parsed.push(parsedUnit);
        for (const { target } of parsedUnit.loc.includes.values()) selected.add(target);
      } catch (error) {
        failedFiles++;
        const details = String(error.stderr || error.message || error).trim().slice(0, 4000);
        warnings.push({ file: unit.rel, error: `Clang 解析失败：${details}` });
      }
    }
    if (!parsed.length) throw new Error(warnings.map((w) => `${w.file}：${w.error}`).join('；'));
    const files = found.filter((f) => f.isHeader || selected.has(f.rel)).map(({ abs, ...f }) => f);
    return { ...assemble(root, files, parsed, warnings, failedFiles, new Map(found.map(f => [f.rel, f.abs])), options.dispatchPolicy === 'strict' ? 'strict' : 'expand'),
      ...(responseFiles.size && { responseFiles: [...responseFiles] }), elapsedMs: Date.now() - started };
  } finally {
    if (dependenciesDir) fs.rmSync(dependenciesDir, { recursive: true, force: true });
    if (workRoot !== root) fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

export const clangParser = {
  id: 'clang-ast',
  name: 'Clang AST 编译器前端 (100% 预处理/类型级)',
  available: (options = {}) => typeof options.execClang === 'function'
    ? { ok: true, version: 'injected', reason: null } : detectClang(options.clangBin),
  cacheKey: clangCacheKey,
  fingerprint,
  parse: parseClang,
};
