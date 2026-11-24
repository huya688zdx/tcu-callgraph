import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scanSources } from '../source-files.js';
import { clangCacheKey, detectClang, fileKey, findCompileCommands, readCompileCommands, relativeFile } from './clang-config.js';
import { children, fnRef, functionModel, functionSignature, pointerExpression, pointerSlots,
  readTranslationUnit, typeOf, variableModel, walk } from './clang-ast.js';
import { collectDataflow } from './clang-dataflow.js';
import { applyDataflow } from './ir.js';

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

function assemble(root, files, units, warnings, failedFiles) {
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

  const tables = new Map(), addressTaken = new Map(), calls = [];
  const noteAddress = (ref, unit) => {
    const target = resolveFunction(ref.referencedDecl, unit);
    const sig = functionSignature(typeOf(ref.referencedDecl) || typeOf(ref), unit);
    if (!addressTaken.has(sig)) addressTaken.set(sig, new Set());
    addressTaken.get(sig).add(target);
  };
  for (const unit of units) {
    for (const node of unit.globals) {
      const slots = pointerSlots(node, unit, resolveFunction);
      if (slots.size) {
        const id = varDecls.get(unit).get(node.id);
        tables.set(id, { slots, constant: hasConstSlots(node) });
      }
      const init = node.init && children(node).find((n) => !n.kind.endsWith('Attr'));
      if (init) for (const child of walk(init)) {
        if (child.kind === 'DeclRefExpr' && child.referencedDecl?.kind === 'FunctionDecl') noteAddress(child, unit);
      }
    }
    for (const record of unit.functions) {
      const direct = new Set();
      for (const node of walk(record.body)) {
        if (node.kind === 'CallExpr' && node.inner?.length) {
          const [callee] = node.inner, ref = fnRef(callee);
          if (ref) direct.add(ref);
          calls.push({ record, node, callee, ref });
        }
        if (node.kind === 'DeclRefExpr' && node.referencedDecl?.kind === 'FunctionDecl' && !direct.has(node)) noteAddress(node, unit);
      }
    }
  }

  const edges = new Map(), callTargets = new WeakMap();
  const includes = new Map();
  for (const unit of units) for (const entry of unit.loc.includes) includes.set(...entry);
  for (const { record, node, callee, ref } of calls) {
    const { context, fn } = record;
    const pos = context.loc.begin(node);
    const line = pos?.line ?? fn.line;
    let candidates, kind, via;
    if (ref) {
      candidates = [resolveFunction(ref.referencedDecl, context)];
      const macro = [pos, context.loc.end(node), context.loc.begin(ref)].find((p) => p?.macro && !p.macroArgument);
      kind = macro ? 'macro' : 'direct';
      if (macro) via = context.loc.token(macro) || ref.referencedDecl.name;
    } else {
      kind = 'fnptr';
      const pointer = pointerExpression(callee);
      const expression = context.loc.text(callee) || pointer?.decl?.name || '<间接调用>';
      const signature = functionSignature(typeOf(callee), context);
      const table = tables.get(resolveVariable(pointer?.decl, context));
      const exact = pointer?.exact && table?.constant && table.slots.get(pointer.slot);
      const targets = addressTaken.get(signature);
      const slotPattern = table?.constant && pointer?.slot.includes('[*]')
        ? new RegExp('^' + pointer.slot.split('[*]').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\[\\d+\\]') + '$') : null;
      const matchingSlots = slotPattern ? [...table.slots].filter(([slot, to]) => slotPattern.test(slot) && targets?.has(to))
        .map(([, to]) => to) : [];
      candidates = exact ? [exact] : matchingSlots.length ? [...new Set(matchingSlots)] : [...(targets || [])];
      if (!candidates.length) candidates = [addExternal(`ext::fnptr::${fn.file}::${expression}::${signature}`, expression)];
      via = `${expression}（${exact ? '初始化槽位' : targets?.size
        ? `类型签名 ${signature} + 已取地址函数${matchingSlots.length ? ' + 表字段' : ''}`
        : `未解析，类型 ${signature || '未知'}`}）`;
    }
    callTargets.set(node, candidates.flatMap((id) => {
      const records = recordsById.get(id);
      if (!records) return [];
      return [records.find((r) => r.context === context) || records[0]];
    }));
    for (const to of candidates) {
      const edge = { from: fn.id, to, callee: (functions.get(to) || externals.get(to)).name, kind, line, via };
      edges.set(JSON.stringify([edge.from, to, line, kind, via, pos?.offset]), edge);
    }
  }

  const df = collectDataflow(functionRecords, defs, resolveVariable, callTargets);
  df.failedFiles = failedFiles;
  const model = { root, files, functions: [...functions.values()], externals: [...externals.values()],
    edges: [...edges.values()], _df: df, includes: [...includes.values()], warnings,
    fnptrTables: [...tables].map(([id, { slots }]) => ({
      id, name: defs.get(id).name, file: defs.get(id).file,
      map: Object.fromEntries([...slots].map(([slot, to]) => [slot, (functions.get(to) || externals.get(to)).name])),
    })),
  };
  applyDataflow(model, df);
  return model;
}

async function parseClang(root, { sourceFiles, scan, parserOptions: options }) {
  const started = Date.now();
  root = path.resolve(root);
  const { compileCommandsPath, execClang, clangBin } = options;
  const warnings = [...(scan?.warnings || [])];
  const database = findCompileCommands(root, compileCommandsPath);
  const bin = clangBin || process.env.CALLGRAPH_CLANG || 'clang';
  let workRoot = root;
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
    const units = database ? readCompileCommands(root, database, { files: found, remap })
      : found.filter((f) => !f.isHeader).map((f) => ({ rel: f.rel, file: f.abs, cwd: workRoot, args: includeArgs }));
    const selected = new Set(units.map((unit) => unit.rel));
    if (!units.length) throw new Error('Clang AST 未找到当前工程的编译单元');
    const parsed = [];
    let failedFiles = warnings.length;
    for (const unit of units) {
      const args = ['-fsyntax-only', '-Xclang', '-ast-dump=json', ...unit.args, '--', unit.file];
      try {
        if (sourceFiles && relativeFile(workRoot, unit.cwd) !== null) fs.mkdirSync(unit.cwd, { recursive: true });
        const result = execClang ? await execClang(unit.file, args, { cwd: unit.cwd })
          : await execute(bin, args, { cwd: unit.cwd, maxBuffer: 128 * 1024 * 1024, timeout: 120000, windowsHide: true });
        const output = result?.stdout ?? result;
        const ast = Buffer.isBuffer(output) || typeof output === 'string' ? JSON.parse(output.toString()) : output;
        const parsedUnit = readTranslationUnit(ast, workRoot, unit, names);
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
    return { ...assemble(root, files, parsed, warnings, failedFiles), elapsedMs: Date.now() - started };
  } finally {
    if (workRoot !== root) fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

export const clangParser = {
  id: 'clang-ast',
  name: 'Clang AST 编译器前端 (100% 预处理/类型级)',
  available: (options = {}) => typeof options.execClang === 'function'
    ? { ok: true, version: 'injected', reason: null } : detectClang(options.clangBin),
  cacheKey: clangCacheKey,
  parse: parseClang,
};
