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
import { argumentSource, callbackSlotReader, hasStaticStorage, matchingSlot, relativeSlot, writeProjection } from './clang-copy.js';
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
      // extern 重声明继承此前在同一编译单元内可见的内部链接。
      const prior = defs.get(localVars.get(node.previousDecl));
      if (prior?.isStatic) {
        def.id = prior.id;
        def.isStatic = true;
      }
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
  const objectKey = (decl, unit) => {
    const id = resolveVariable(decl, unit);
    if (!id) return unit.declarations.get(decl?.id)?.node;
    const def = defs.get(id);
    // 头文件里的 static 只有一个源码声明，每个编译单元却分别分配存储。
    return def.isStatic && def.file !== unit.unit.rel ? JSON.stringify([unit.unit.rel, id]) : id;
  };
  const tables = new Map(), addressTaken = new Map(), calls = [], byRecordField = new Map(), declWrites = new Map();
  const addressUsers = new Map(), initialEscapes = new Map(), writesByNode = new WeakMap();
  function storageAddress(node, unit) {
    if (!(node.kind === 'UnaryOperator' && node.opcode === '&') && node.castKind !== 'ArrayToPointerDecay') return null;
    const p = pointerExpression(children(node)[0], unit);
    if (p?.decl?.kind !== 'VarDecl' || p.throughPointer) return null;
    const key = objectKey(p.decl, unit);
    return hasStaticStorage(key) ? { key, slot: p.slot } : null;
  }
  function noteInitialAddresses(node, unit) {
    if (!node?.kind) return;
    const addr = storageAddress(node, unit);
    if (addr) {
      if (!initialEscapes.has(addr.key)) initialEscapes.set(addr.key, new Set());
      // 指向某个数组元素的地址可在本数组内移动，结构体成员地址则不跨到兄弟成员。
      initialEscapes.get(addr.key).add(addr.slot.replace(/\[-?\d+\]$/, '[*]'));
      return;
    }
    const items = children(node);
    let values;
    if (node.kind === 'ConditionalOperator') values = items.slice(1);
    else if (node.kind === 'InitListExpr') values = node.array_filler || items;
    else if (node.kind.endsWith('CastExpr') || ['ParenExpr','CompoundLiteralExpr','ConstantExpr'].includes(node.kind) ||
        (node.kind === 'BinaryOperator' && typeOf(node).includes('*'))) values = items;
    for (const value of values || []) noteInitialAddresses(value, unit);
  }
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
  // 未知接收对象从声明归集；含联合体的访问还须限定联合体声明及其内部槽位。
  const fieldLocation = (unit, id, slot, unionId) => {
    const arm = slot.lastIndexOf('.|');
    return unionId && arm >= 0 ? [fieldKey(unit, unionId), slot.slice(arm)] : [fieldKey(unit, id), memberIndices(slot)];
  };
  const indexField = (fields, unit, id, slot, target, unionId) => {
    const put = ([key, path]) => {
      if (!key) return;
      if (!fields.has(key)) fields.set(key, new Map());
      const slots = fields.get(key);
      if (!slots.has(path)) slots.set(path, new Set());
      slots.get(path).add(target);
    };
    put(fieldLocation(unit, id, slot));
    if (unionId) put(fieldLocation(unit, id, slot, unionId));
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
    const candidateSlots = new Map(), sourceSlots = new Map();
    const slots = pointerSlots(node, unit, resolveFunction, candidateSlots,
      (id, slot, target, unionId) => indexField(fields, unit, id, slot, target, unionId), sourceSlots);
    if (slots.size || candidateSlots.size) {
      const key = objectKey(node, unit), id = resolveVariable(node, unit);
      tables.set(key, { slots, candidateSlots, sourceSlots, constant: hasConstSlots(node), def: defs.get(id),
        translationUnit: id && key !== id ? unit.unit.rel : null });
    }
  };
  const definitionOf = (ref, unit) => {
    const definitions = recordsById.get(resolveDecl(ref?.referencedDecl, unit, fnDecls, publicFns));
    return definitions?.find(r => r.context === unit) || definitions?.[0] || null;
  };
  for (const unit of units) {
    for (const node of unit.globals) {
      if (node.init) indexTable(node, unit, byRecordField);
      const init = node.init && children(node).find((n) => !n.kind.endsWith('Attr'));
      if (init) {
        noteInitialAddresses(init, unit);
        for (const child of walk(init)) {
          if (child.kind === 'DeclRefExpr' && child.referencedDecl?.kind === 'FunctionDecl') noteAddress(child, unit);
        }
      }
    }
    for (const record of unit.functions) {
      const direct = new Set();
      for (const node of walk(record.body)) {
        const addr = storageAddress(node, unit);
        if (addr) {
          if (!addressUsers.has(addr.key)) addressUsers.set(addr.key, new Set());
          addressUsers.get(addr.key).add(record);
        }
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
      for (const w of collectAssignmentWrites(record.body, unit)) {
        const declKey = objectKey(w.decl, unit);
        w.record = record;
        writesByNode.set(w.node, w);
        // 普通局部聚合体由调用点读取器追踪。跨调用只索引实际存储或形参所指对象。
        if (w.aggregate && (w.throughPointer ? w.decl.kind !== 'ParmVarDecl' :
          !hasStaticStorage(declKey))) continue;
        if (!declWrites.has(declKey)) declWrites.set(declKey, []);
        declWrites.get(declKey).push(w);
        if (w.fieldId && !w.aggregate) {
          const fields = typeof declKey === 'string' || w.decl.kind === 'ParmVarDecl' ? byRecordField : fieldsFor(unit, w.node);
          indexField(fields, unit, w.fieldId, w.slot, w, w.unionId);
          if (w.throughPointer) indexField(indirectFieldWrites, unit, w.fieldId, w.slot, w, w.unionId);
        }
      }
    }
  }

  const readers = new WeakMap(), writeValues = new WeakMap();
  let writeDepth = 0;
  function writeValue(write, slot = '') {
    if (!writeValues.has(write)) writeValues.set(write, new Map());
    const slots = writeValues.get(write);
    if (!slots.has(slot)) {
      // 跨对象或跨函数的循环依赖只提供未知值，不用已经过期的初始化器填补。
      const incomplete = { targets: [], unknown: true, parameters: [] };
      if (writeDepth >= 32) return incomplete;
      slots.set(slot, incomplete);
      writeDepth++;
      try { slots.set(slot, readerFor(write.record).atAssignment(write, slot)); }
      finally { writeDepth--; }
    }
    return slots.get(slot);
  }
  function fieldValues(fields, [key, indices]) {
    const targets = new Set();
    let unknown = false, uncertainLayout = false;
    for (const [slot, entries] of fields?.get(key) || []) {
      const match = matchingSlot(slot, indices);
      if (!match) continue;
      uncertainLayout ||= match === 'overlap';
      for (const entry of entries) {
        if (typeof entry === 'string') targets.add(entry);
        else {
          const value = writeValue(entry);
          for (const id of value.targets) targets.add(id);
          unknown ||= value.unknown || value.parameters.length > 0;
          uncertainLayout ||= value.uncertainLayout;
        }
      }
    }
    return { targets: [...targets], unknown, uncertainLayout };
  }
  // 已知函数只引入自身及其被调函数在同一静态存储槽位上的写入。
  const reachable = new Map(), argumentWrites = new WeakMap();
  const targetOfCall = (call, unit) => definitionOf(fnRef(children(call)[0]), unit);
  function reachableCallees(direct) {
    const records = new Set([direct]), callers = new Map();
    for (const record of records) {
      if (!record) continue;
      for (const nested of readerFor(record).calls) {
        const target = targetOfCall(nested, record.context);
        if (target) {
          if (!callers.has(target)) callers.set(target, []);
          callers.get(target).push({ record, call: nested });
        }
        if (records.has(target)) continue;
        if (records.size >= 128) {
          records.add(null);
          return { records, callers };
        }
        records.add(target);
      }
    }
    return { records, callers };
  }
  function* storageWrites(key, slot, records) {
    // 保存在静态初始化器中的地址也可传到工程外，只影响其指向的区域。
    if (!records && !tables.get(key)?.constant) for (const prefix of initialEscapes.get(key) || []) {
      const match = relativeSlot(prefix, slot);
      if (match) yield { write: null, rest: match.rest };
    }
    for (const w of declWrites.get(key) || []) {
      if (records && !records.has(w.record)) continue;
      const match = writeProjection(w, w.slot, slot);
      if (!match || !readerFor(w.record).isEvaluated(w.node)) continue;
      yield { write: w, rest: match.rest };
    }
    for (const record of addressUsers.get(key) || []) {
      if (!records || records.has(record)) yield* readerFor(record).addressWrites(key, slot);
    }
  }
  function callWrites(call, unit, key, slot) {
    const direct = targetOfCall(call, unit);
    if (!reachable.has(direct)) reachable.set(direct, reachableCallees(direct));
    const { records, callers } = reachable.get(direct), opaque = records.has(null);
    const targets = new Set(), pending = [], parameters = [];
    const mutable = !tables.get(key)?.constant;
    // 外部代码可以按名改写外部链接对象。私有对象只能经本项目可见的写入或传址改变。
    let unknown = opaque && mutable && defs.get(key)?.isStatic === false, uncertainLayout = false;
    function collect(value, record) {
      for (const id of value.targets) targets.add(id);
      unknown ||= value.unknown;
      uncertainLayout ||= value.uncertainLayout;
      for (const p of value.parameters) {
        if (!records.has(record)) { unknown = true; continue; }
        if (pending.some(({ parameter: q }) => p.decl === q.decl && p.slot === q.slot && p.pointee === q.pointee)) continue;
        pending.push({ record, parameter: p });
        if (record === direct) parameters.push(p);
      }
    }
    for (const { write, rest } of storageWrites(key, slot, opaque ? null : records)) {
      if (write) {
        collect(writeValue(write, rest), write.record);
        uncertainLayout ||= rest === '.?';
      } else if (mutable) unknown = true;
    }
    // 仅沿本次调用可达的实参回溯未绑定形参，同一声明/路径只展开一次。
    let budget = 128;
    bindings: for (const { record, parameter } of pending) {
      for (const site of callers.get(record) || []) {
        if (--budget < 0) { unknown = true; break bindings; }
        const arg = argumentSource(record, site.call, parameter);
        if (!arg) { unknown = true; continue; }
        if (!argumentWrites.has(arg)) argumentWrites.set(arg, { record: site.record, node: site.call, value: arg });
        collect(writeValue(argumentWrites.get(arg), parameter.slot), site.record);
      }
    }
    return { targets, direct, parameters, unknown, uncertainLayout };
  }
  function readerFor(record) {
    if (!readers.has(record)) {
      const ambient = (key, slot) => {
        if (!hasStaticStorage(key)) return { targets: [], unknown: false };
        const ids = [];
        let unknown = !!defs.get(key)?.isExtern && !slot, uncertainLayout = false;
        const matches = path => {
          const match = matchingSlot(path, slot);
          uncertainLayout ||= match === 'overlap';
          return match;
        };
        const table = tables.get(key);
        for (const [path, id] of table?.slots || []) if (matches(path)) ids.push(id);
        for (const [path, targets] of table?.candidateSlots || []) if (matches(path)) ids.push(...targets);
        for (const { write, rest } of storageWrites(key, slot)) {
          if (!write) { unknown = true; continue; }
          uncertainLayout ||= rest === '.?';
          const value = writeValue(write, rest);
          ids.push(...value.targets);
          unknown ||= value.unknown || value.parameters.length > 0;
          uncertainLayout ||= value.uncertainLayout;
        }
        return { targets: ids, unknown, uncertainLayout };
      };
      const parameterWrites = (callee, index) => {
        const unit = record.context;
        const target = definitionOf(fnRef(callee), unit);
        const param = children(target?.node).filter(n => n.kind === 'ParmVarDecl')[index];
        if (!param) return [null];
        const writes = (declWrites.get(param) || []).filter(w => w.throughPointer);
        if (forwardedParams.has(param)) writes.push(null);
        return writes;
      };
      const fieldWrites = (id, slot, unionId) => fieldValues(indirectFieldWrites, fieldLocation(record.context, id, slot, unionId));
      readers.set(record, callbackSlotReader(record, objectKey, resolveFunction, { ambient, parameterWrites, fieldWrites, writeValue, callWrites, writesByNode }));
    }
    return readers.get(record);
  }
  const edges = new Map(), callTargets = new WeakMap(), indirectCalls = [];
  const includes = new Map();
  for (const unit of units) for (const entry of unit.loc.includes) includes.set(...entry);
  const sourceSite = (fn, pos) => `${fn.id}@${pos?.line ?? fn.line}:${pos?.col ?? 0}`;
  const fixedTarget = (pointer, table) => pointer?.exact && table?.constant && table.slots.get(pointer.slot);
  // 头文件函数的各实例在图中共用一个源码调用点。仅当各实例一致时才把它标为精确。
  const headerSites = new Map();
  for (const call of calls) {
    const { context, fn } = call.record;
    if (call.ref || fn.file === context.unit.rel || recordsById.get(fn.id).length < 2) continue;
    const id = sourceSite(fn, context.loc.begin(call.node));
    if (!headerSites.has(id)) headerSites.set(id, new Set());
    call.headerTargets = headerSites.get(id);
    call.pointer = pointerExpression(call.callee, context);
    const table = tables.get(objectKey(call.pointer?.decl, context));
    call.headerTargets.add(fixedTarget(call.pointer, table) || null);
  }
  for (const { record, node, callee, ref, headerTargets, pointer: headerPointer } of calls) {
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
      siteId = sourceSite(fn, pos);
      const pointer = headerTargets ? headerPointer : pointerExpression(callee, context);
      const provenance = headerTargets ? { translationUnit: context.unit.rel } : {};
      const expression = context.loc.text(callee) || pointer?.decl?.name || '<间接调用>';
      const signature = functionSignature(typeOf(callee), context);
      const varKey = objectKey(pointer?.decl, context);
      const table = tables.get(varKey);
      const tracked = pointer?.decl ? readerFor(record).atCall(pointer, node) : null;
      // 空数组表示追踪过该成员，但目前的值未知；不能重新引入旧初始化值。
      const exact = tracked === null && (headerTargets?.size ?? 1) === 1 && fixedTarget(pointer, table);
      const targets = addressTaken.get(signature);
      // C 的旧式无原型函数也可能与调用签名兼容。已证明同一槽位的值不需要这个回退筛选。
      const resultType = signature.split('(')[0], oldStyle = resultType + '()';
      const compatible = id => targets?.has(id) || addressTaken.get(oldStyle)?.has(id) ||
        (signature === oldStyle && [...addressTaken].some(([sig, ids]) => sig.startsWith(resultType + '(') && ids.has(id)));
      const slotTargets = tracked?.uncertainLayout ? tracked.targets.filter(compatible) : [...(tracked?.targets || [])];
      if (tracked === null && table) {
        if (pointer.slot.includes('[*]') || pointer.slot.includes('.|')) {
          const add = (slot, ids) => {
            const match = matchingSlot(slot, pointer.slot);
            if (match) slotTargets.push(...(match === 'overlap' ? ids.filter(compatible) : ids));
          };
          for (const [slot, to] of table.slots) add(slot, [to]);
          for (const [slot, tos] of table.candidateSlots) add(slot, tos);
        } else {
          if (table.slots.has(pointer.slot)) slotTargets.push(table.slots.get(pointer.slot));
          slotTargets.push(...(table.candidateSlots.get(pointer.slot) || []));
        }
      }
      const objectWrites = varKey == null ? [] : declWrites.get(varKey) || [];
      let hasWrite = false, unknownValue = tracked?.unknown || tracked?.parameters.length > 0;
      if (tracked === null && varKey != null) for (const { write, rest } of storageWrites(varKey, pointer.slot)) {
        hasWrite = true;
        if (!write) { unknownValue = true; continue; }
        const value = writeValue(write, rest);
        unknownValue ||= value.unknown || value.parameters.length > 0;
        const uncertain = value.uncertainLayout || rest === '.?';
        slotTargets.push(...(uncertain ? value.targets.filter(compatible) : value.targets));
      }
      const fieldCandidates = new Set();
      const variable = defs.get(resolveVariable(pointer?.decl, context));
      const knownObject = tracked || table || (!pointer?.throughPointer && variable && !variable.isExtern) || (pointer?.decl?.kind === 'VarDecl' && !pointer.throughPointer &&
        (pointer.member || objectWrites.length || /\[[^\]]*\]$/.test(typeOf(pointer.decl))));
      if (pointer?.fieldId && !knownObject) {
        const location = fieldLocation(context, pointer.fieldId, pointer.slot, pointer.unionId);
        const collect = fields => {
          const value = fieldValues(fields, location);
          for (const id of value.targets) if (!value.uncertainLayout || compatible(id)) fieldCandidates.add(id);
          unknownValue ||= value.unknown;
        };
        collect(byRecordField);
        for (let scope = context.scopeOf.get(node); scope; scope = context.scopeOf.get(scope)) collect(localFields.get(scope));
      }
      if (dispatchPolicy === 'strict') {
        if (exact && !hasWrite) {
          candidates = [exact];
          resolution = 'exact';
          via = `${expression}（初始化槽位）`;
        } else {
          candidates = [];
          resolution = 'unresolved';
          const fallbackList = [...new Set([...slotTargets, ...fieldCandidates])];
          indirectCalls.push({
            caller: fn.id, callerName: fn.name, file: fn.file, line, col: pos?.col, siteId, ...provenance,
            expr: expression, receiver: pointer?.decl?.name || null, member: pointer?.member || null,
            resolution, truncated: false, matchedSlots: fallbackList.length,
            candidates: fallbackList.map(id => ({ slot: pointer?.sourceSlot || '', name: (functions.get(id) || externals.get(id))?.name || id, id })),
          });
        }
      } else {
        const combinedSlots = [...new Set([...slotTargets,
          ...(unknownValue ? [...fieldCandidates, ...(targets || [])] : [])])];
        const signatureTargets = !knownObject && !(pointer?.member && pointer.baseType) ? targets : null;
        if (exact && !hasWrite) {
          candidates = [exact];
          resolution = 'exact';
          via = `${expression}（初始化槽位）`;
        } else if (combinedSlots.length) {
          candidates = combinedSlots.slice(0, 32);
          resolution = 'possible';
          dynamicDispatch = true;
          via = unknownValue && targets?.size ? `${expression}（槽位与同签名的已取地址函数）` : `${expression}（静态槽位展开）`;
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
            slot: pointer?.sourceSlot || '',
            name: (functions.get(id) || externals.get(id))?.name || id,
            id,
          }));
          indirectCalls.push({
            caller: fn.id, callerName: fn.name, file: fn.file, line, col: pos?.col, siteId, ...provenance,
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
    fnptrTables: [...tables.values()].filter(t => t.def).map(({ def, slots, sourceSlots, translationUnit }) => ({
      id: def.id, name: def.name, file: def.file, ...(translationUnit ? { translationUnit } : {}),
      map: Object.fromEntries([...slots].map(([slot, to]) => [sourceSlots.get(slot) ?? slot, (functions.get(to) || externals.get(to)).name])),
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
