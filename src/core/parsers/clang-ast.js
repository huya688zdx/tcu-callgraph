import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sourceDecoder } from '../source-files.js';
import { lex } from '../lexer.js';
import { fingerprint } from '../source-fingerprint.js';
import { fileKey, relativeFile } from './clang-config.js';

export const children = (node) => node?.inner ?? [];
export const typeOf = (node) => node?.type?.desugaredQualType || node?.type?.qualType || '';
// Clang 的关联记录没有 kind。case 先列类型再列结果，default 只列结果。
function genericResult(node) {
  const selected = children(node).filter(a => a.selected === true);
  if (selected.length !== 1) return null;
  const [association] = selected, items = children(association);
  const length = { case: 2, default: 1 }[association.associationKind];
  const result = items.at(-1);
  return items.length === length && result?.valueCategory && result.kind ? result : null;
}

export const unwrap = (node) => {
  while (node) {
    if (node.kind === 'GenericSelectionExpr') {
      const result = genericResult(node);
      if (!result) break;
      node = result;
    } else if (['ImplicitCastExpr', 'CStyleCastExpr', 'ParenExpr', 'ConstantExpr', 'ExprWithCleanups'].includes(node.kind)
        && children(node).length === 1) node = node.inner[0];
    else break;
  }
  return node;
};
export const fnRef = (node) => {
  node = unwrap(node);
  while (node?.kind === 'UnaryOperator' && ['&', '*'].includes(node.opcode)) node = unwrap(node.inner[0]);
  return node?.kind === 'DeclRefExpr' && node.referencedDecl?.kind === 'FunctionDecl' ? node : null;
};
const initializers = (node) => node.array_filler?.length ? node.array_filler.slice(1) : children(node);
export const initializer = (node) => children(node).find((n) => !n.kind?.endsWith('Attr'));

// 只有传递、保存或返回指针值才可能让地址逃逸。比较地址、取 sizeof 等不构成传址写入。
export function transferredValues(node) {
  if (node.kind === 'CallExpr') return children(node).slice(1);
  if (node.kind === 'VarDecl' && node.init) return [initializer(node)];
  if (node.kind === 'BinaryOperator' && node.opcode === '=') return [children(node)[1]];
  return node.kind === 'ReturnStmt' ? children(node) : [];
}

export function* walk(node, childrenOf = children) {
  yield node;
  for (const child of childrenOf(node)) yield* walk(child, childrenOf);
  if (node.array_filler) for (const child of node.array_filler) yield* walk(child, childrenOf);
}

// 源码位置、声明及指纹仍使用原始树。运行时效果只遍历实际参与求值的操作数。
export function evaluatedChildren(node) {
  const items = children(node);
  if (node.kind === 'GenericSelectionExpr') {
    const result = genericResult(node);
    return result ? [result] : [];
  }
  if (node.kind !== 'UnaryExprOrTypeTraitExpr') return items;
  if (node.name !== 'sizeof') return [];
  if (node.argType) return items; // Clang 将运行时求值的 VLA 类型边界列为子表达式。
  const operand = items[0];
  if (typeOf(operand).endsWith(']')) {
    // 对 VLA 表达式取 sizeof 时操作数会执行；普通数组的引用被 Clang 标为 unevaluated。
    for (const n of walk(operand)) if (n.kind === 'DeclRefExpr' && !n.nonOdrUseReason) return items;
  }
  return [];
}
export const walkEvaluated = node => walk(node, evaluatedChildren);

function sourceLocations(root, unit, files) {
  const locations = new WeakMap();
  // Clang 省略与上一个序列化位置相同的文件和行。顺着 JSON 顺序恢复文件，再用字节偏移补行。
  let lastFile = unit.file, lastLine = 1;
  const sources = new Map();
  const includes = new Map();
  const externalFiles = new Set();
  const sourceOf = (file) => {
    if (!sources.has(file)) {
      let bytes;
      try { bytes = fs.readFileSync(file); } catch { bytes = Buffer.alloc(0); }
      const decoder = sourceDecoder(bytes);
      const lines = [0];
      const lf = decoder.encoding === 'utf-16le' ? Buffer.from([10, 0])
        : decoder.encoding === 'utf-16be' ? Buffer.from([0, 10]) : Buffer.from([10]);
      for (let i = bytes.indexOf(lf); i !== -1; i = bytes.indexOf(lf, i + 1)) {
        if (i % lf.length === 0) lines.push(i + lf.length);
      }
      // AST 偏移始终指向原文件字节。只跳过文件开头的 BOM，片段沿用整文件判定的编码。
      const decodeRange = (start, end) => decoder.decode(bytes.subarray(Math.max(start, decoder.bomLength), end));
      sources.set(file, { bytes, lines, decodeRange });
    }
    return sources.get(file);
  };
  const fileOf = (file) => path.resolve(unit.cwd, file);
  const readLocation = (raw) => {
    if (!raw) return null;
    if (raw.spellingLoc || raw.expansionLoc) {
      const spelling = readLocation(raw.spellingLoc);
      const expansion = readLocation(raw.expansionLoc);
      return expansion ? { ...expansion, macro: true, macroArgument: !!raw.expansionLoc.isMacroArgExpansion, spelling } : spelling;
    }
    if (raw.file == null && raw.line == null && raw.offset == null) return null;
    const abs = raw.file ? fileOf(raw.file) : lastFile;
    const rel = relativeFile(root, abs);
    const file = rel ? files.get(fileKey(rel)) : null;
    if (rel === null && !raw.file?.startsWith('<')) externalFiles.add(abs);
    if (raw.includedFrom?.file && !raw.includedFrom.file.startsWith('<')) {
      const parent = fileOf(raw.includedFrom.file);
      if (relativeFile(root, parent) === null) externalFiles.add(parent);
    }
    if (file && raw.includedFrom?.file) {
      const parent = relativeFile(root, fileOf(raw.includedFrom.file));
      const from = parent && files.get(fileKey(parent));
      if (from && from !== file) includes.set(JSON.stringify([from, file]), { file: from, target: file });
    }
    let line = raw.line;
    if (!line && file && Number.isInteger(raw.offset)) {
      const { lines, bytes } = sourceOf(abs);
      if (raw.offset < bytes.length) {
        let low = 0, high = lines.length;
        while (low + 1 < high) {
          const mid = (low + high) >> 1;
          if (lines[mid] <= raw.offset) low = mid;
          else high = mid;
        }
        line = low + 1;
      }
    }
    lastLine = line || (abs === lastFile ? lastLine : 1);
    lastFile = abs;
    // Clang 的位置按原文件字节计数，词法器的列按 UTF-16 码元计数。
    const source = file && Number.isInteger(raw.offset) ? sourceOf(abs) : null;
    const lineStart = source?.lines[lastLine - 1];
    const col = lineStart != null ? source.decodeRange(lineStart, raw.offset).length + 1 : raw.col;
    return { file, abs, line: lastLine, col, offset: raw.offset, length: raw.tokLen || 0 };
  };
  const record = (node) => {
    const loc = readLocation(node.loc), begin = readLocation(node.range?.begin), end = readLocation(node.range?.end);
    locations.set(node, { loc, begin, end });
    // array_filler 先于 inner 输出。
    for (const child of node.array_filler || []) record(child);
    for (const child of children(node)) record(child);
  };
  const slice = (a, b) => a?.file && a.abs === b?.abs && Number.isInteger(a.offset) && Number.isInteger(b.offset)
    ? sourceOf(a.abs).decodeRange(a.offset, b.offset + b.length) : '';
  return {
    record, includes, externalFiles,
    loc: (n) => locations.get(n)?.loc || locations.get(n)?.begin,
    begin: (n) => locations.get(n)?.begin,
    end: (n) => locations.get(n)?.end,
    slice,
    text: (n) => slice(locations.get(n)?.begin, locations.get(n)?.end),
    token: (loc) => slice(loc, loc),
  };
}

function fingerprintAST(node, context) {
  const hash = createHash('sha256');
  const uses = new Map();
  for (const n of walk(node)) {
    const constant = context.enumById.get(n.referencedDecl?.id);
    if (constant?.id) uses.set(constant.id, constant.value);
    hash.update(JSON.stringify([
      n.kind, n.name, n.opcode, n.isPostfix, n.value, n.castKind, n.referencedDecl?.name, typeOf(n),
      n.argType?.desugaredQualType || n.argType?.qualType, constant?.value, children(n).length, n.array_filler?.length,
    ]));
  }
  return { semanticFingerprint: hash.digest('hex'), ...(uses.size && { enumUses: Object.fromEntries(uses) }) };
}

// 第一个名字前，配平的括号可能属于 typeof、属性或内联结构体。未闭合的括号和顶层 * 属于声明符。
function sharedSpecifiers(prefix) {
  const stack = [];
  for (const token of lex(prefix)) {
    if (!stack.length && token.v === '*') return prefix.slice(0, token.s).trimEnd();
    if (['(', '{', '['].includes(token.v)) stack.push(token.s);
    if ([')', '}', ']'].includes(token.v)) stack.pop();
  }
  return prefix.slice(0, stack[0] ?? prefix.length).trimEnd();
}

function declaratorSeparator(tail) {
  // VarDecl.range 可能在变量名处结束，后面还有含逗号的 __attribute__((...))。
  let depth = 0;
  for (const token of lex(tail)) {
    if (!depth && token.v === ',') return token;
    if (['(', '{', '['].includes(token.v)) depth++;
    if ([')', '}', ']'].includes(token.v)) depth--;
  }
}

function collectEnum(node, context, insideFunction) {
  const { loc, enumDeclarations, enumById } = context;
  const members = children(node).filter(n => n.kind === 'EnumConstantDecl');
  const file = loc.loc(node)?.file;
  if (!insideFunction && file && members.length) enumDeclarations.push({ file, hash: fingerprint(loc.text(node)) });
  let next = 0n;
  for (const member of members) {
    const expression = initializer(member);
    // Clang 会在较宽的枚举值外包一层隐式转换。没有初始化式时由前一值递增。
    const evaluated = expression && [...walk(expression)].find(n => n.kind === 'ConstantExpr')?.value;
    const value = expression ? evaluated : next?.toString();
    next = value != null && /^-?\d+$/.test(value) ? BigInt(value) + 1n : null;
    if (value == null) continue;
    const memberFile = loc.loc(member)?.file;
    enumById.set(member.id, { id: !insideFunction && memberFile ? `enum::${memberFile}::${member.name}` : null,
      file: memberFile, name: member.name, value });
  }
}

// 结构体成员按声明序号定位。联合体同类型成员共享全部存储；不同结构体只保证公共初始序列。
function storageFields(records, context) {
  const slots = new Map(), unionOwners = new Map();
  const fieldsOf = record => children(record).filter(n => n.kind === 'FieldDecl');
  const builtin = /^(?:void|char|short|int|long|float|double|signed|unsigned|_Bool|_Complex|const|volatile|restrict)$/;
  const special = node => node.isBitfield || children(node).some(n => n.kind?.endsWith('Attr'));
  const fieldType = field => {
    if (special(field)) return field;
    const type = typeOf(field);
    const record = context.valueRecords.get(field);
    if (record && !/[\[*]/.test(type)) return record;
    // 无法从完整类型拼写确认声明身份时，不用同名标签推断相同布局。
    return type && (type.match(/[A-Za-z_]\w*/g) || []).every(word => builtin.test(word)) ? type : field;
  };
  for (const record of new Set(records.values())) {
    const fields = fieldsOf(record);
    if (record.tagUsed !== 'union') {
      fields.forEach((f, i) => { if (f.id) slots.set(f.id, '.f' + i); });
      continue;
    }
    const groups = new Map(), memberTypes = new Map();
    for (const field of fields) {
      if (!field.id) continue;
      const type = fieldType(field);
      if (!groups.has(type)) {
        const prefix = [];
        if (type?.tagUsed === 'struct' && !special(type)) {
          for (const member of fieldsOf(type)) {
            if (special(member)) break;
            const key = fieldType(member);
            if (!memberTypes.has(key)) memberTypes.set(key, memberTypes.size);
            prefix.push(memberTypes.get(key));
          }
        }
        groups.set(type, '.|' + groups.size + ':' + prefix.join(','));
      }
      slots.set(field.id, groups.get(type));
      unionOwners.set(field.id, record.id);
    }
  }
  return { slots, unionOwners };
}

export function readTranslationUnit(ast, root, unit, files) {
  if (ast?.kind !== 'TranslationUnitDecl') throw new Error('Clang 未返回 TranslationUnitDecl');
  const loc = sourceLocations(root, unit, files);
  loc.record(ast);
  const context = { unit, loc, functions: [], globals: [], declarations: new Map(), aliases: new Map(), records: new Map(),
    declaratorSources: new WeakMap(), valueRecords: new WeakMap(), scopeOf: new WeakMap(), enumById: new Map(), enumDeclarations: [] };
  const recordsById = new Map(), anonymousAt = new Map();
  const recordScopes = [context.records], typedefRecords = new Map(), unknownSelections = new Set();
  function collect(node, insideFunction, parentScope) {
    const position = loc.loc(node);
    const { id, kind, name } = node;
    if (kind === 'GenericSelectionExpr' && !genericResult(node)) unknownSelections.add(node);
    const newScope = ['FunctionDecl', 'CompoundStmt', 'ForStmt'].includes(kind);
    if (insideFunction && (newScope || ['VarDecl', 'CallExpr', 'BinaryOperator'].includes(kind))) {
      context.scopeOf.set(node, parentScope);
    }
    if (newScope) recordScopes.push(new Map());
    const scope = recordScopes.at(-1);
    if (id && kind?.endsWith('Decl')) context.declarations.set(id, { node, position });
    if (kind === 'EnumDecl') collectEnum(node, context, insideFunction);
    if (kind === 'RecordDecl' && node.completeDefinition) {
      for (let decl = node; decl && !recordsById.has(decl.id); decl = context.declarations.get(decl.previousDecl)?.node) {
        recordsById.set(decl.id, node);
      }
      if (name) scope.set(`${node.tagUsed} ${name}`, node);
      else if (position?.abs) anonymousAt.set(`${position.abs}:${position.line}:${node.loc?.col ?? position.col}`, node);
      // 内嵌匿名记录的 FieldDecl 与定义从同一源位置开始。保留 Clang 的完整类型名。
      const anonymous = new Map();
      for (const child of children(node)) {
        const start = loc.begin(child);
        if (!start) continue;
        const key = `${start.abs}:${start.offset}`;
        if (child.kind === 'RecordDecl' && !child.name && child.completeDefinition) anonymous.set(key, child);
        if (child.kind === 'FieldDecl' && anonymous.has(key)) {
          scope.set(typeOf(child).replace(/\s*\[[^\]]*\]/g, ''), anonymous.get(key));
        }
      }
    }
    if (kind === 'TypedefDecl' && name && !node.isImplicit) {
      context.aliases.set(name, typeOf(node));
      const tag = [...walk(node)].find((child) => child.ownedTagDecl || child.decl?.kind === 'RecordDecl');
      if (tag) {
        const decl = tag.ownedTagDecl || tag.decl;
        typedefRecords.set(id, decl);
        scope.set(name, decl);
      }
    }
    if (node.type && (kind.endsWith('Expr') || ['VarDecl', 'FieldDecl', 'BinaryOperator', 'ConditionalOperator', 'UnaryOperator'].includes(kind))) {
      // Clang 的 typedef id 优先；同名结构标签按初始化器所在块查找。
      let decl = typedefRecords.get(node.type?.typeAliasDeclId);
      const type = typeOf(node).replace(/\b(const|volatile|restrict)\b/g, '').trim();
      for (let i = recordScopes.length - 1; !decl && i >= 0; i--) decl = recordScopes[i].get(type);
      if (!decl && type.includes('(unnamed')) {
        // 独立的匿名结构体变量没有 typedef；Clang 的完整类型给出标签的定义位置。
        const site = /^(?:struct|union) \(unnamed(?: (?:struct|union))? at (.+):(\d+):(\d+)\)$/.exec(type);
        if (site) decl = anonymousAt.get(path.resolve(unit.cwd, site[1]) + ':' + site[2] + ':' + site[3]);
      }
      if (decl) context.valueRecords.set(node, recordsById.get(decl.id) || decl);
    }
    if (position?.file && name && !node.isImplicit) {
      if (kind === 'FunctionDecl') {
        const body = children(node).find((child) => child.kind === 'CompoundStmt');
        if (body) context.functions.push({ node, body, context });
      }
      if (kind === 'VarDecl' && (!insideFunction || node.storageClass === 'extern')) context.globals.push(node);
    }
    let first, previousEnd, specifiers;
    for (const child of children(node)) {
      if (child.kind === 'VarDecl' || child.kind === 'FunctionDecl') {
        const start = loc.begin(child), end = loc.end(child);
        if (start?.file && start.abs === first?.abs && start.offset === first.offset && previousEnd?.abs === start.abs) {
          const tail = loc.slice({ ...previousEnd, offset: previousEnd.offset + previousEnd.length }, end);
          const separator = declaratorSeparator(tail);
          if (separator) {
            specifiers ??= sharedSpecifiers(loc.slice(first, { ...first.nameLoc, length: 0 }));
            context.declaratorSources.set(child, specifiers + ' ' + tail.slice(separator.e).trimStart());
          }
        } else {
          first = start && { ...start, nameLoc: loc.loc(child) };
          specifiers = undefined;
        }
        previousEnd = end;
      }
      collect(child, insideFunction || kind === 'FunctionDecl', newScope ? node : parentScope);
    }
    if (newScope) recordScopes.pop();
  }
  collect(ast, false);
  if (unknownSelections.size) {
    // 只报告可能执行的未知选择，通过既有编译单元诊断保留其他文件的图。
    for (const root of [...context.functions.map(f => f.body), ...context.globals]) {
      for (const n of walkEvaluated(root)) if (unknownSelections.has(n)) {
        throw new Error(`无法确定 _Generic 的选中结果（${loc.begin(n)?.file || unit.rel}:${loc.begin(n)?.line ?? '?'}）`);
      }
    }
  }
  context.storageFields = storageFields(recordsById, context);
  for (const [name, decl] of context.records) {
    if (recordsById.has(decl.id)) context.records.set(name, recordsById.get(decl.id));
  }
  return context;
}

export function functionModel({ node, body, context }) {
  const { loc } = context;
  const { file, line } = loc.loc(node);
  const params = children(node).filter((child) => child.kind === 'ParmVarDecl');
  return {
    id: `${file}::${node.name}`, name: node.name, file, line, endLine: loc.end(node)?.line ?? line,
    isStatic: node.storageClass === 'static',
    params: params.map((p) => loc.text(p) || [typeOf(p), p.name].filter(Boolean).join(' ')),
    signature: typeOf(node), sourceText: loc.text(node), ...fingerprintAST(body, context),
  };
}

export function variableModel(node, context) {
  const { file, line } = context.loc.loc(node);
  const isStatic = node.storageClass === 'static';
  const typeText = typeOf(node);
  function containsUnion(type, seen) {
    if (/^union\b/.test(type)) return true;
    if (seen.has(type)) return false;
    const record = recordType(type.replace(/\[[^\]]*\]/g, ''), context);
    if (!record) return false;
    seen.add(type);
    return record.tagUsed === 'union' || children(record).some((field) =>
      field.kind === 'FieldDecl' && containsUnion(typeOf(field), seen));
  }
  return {
    id: isStatic ? `var::${file}::${node.name}` : `var::${node.name}`,
    name: node.name, file, line, typeText, isStatic, isExtern: node.storageClass === 'extern' && !node.init,
    isArray: /\[.*\]/.test(typeText), containsUnion: containsUnion(typeText, new Set()),
    sourceText: context.declaratorSources.get(node) ?? context.loc.text(node), ...fingerprintAST(node, context),
  };
}

function recordType(type, context) {
  const key = type.replace(/\b(const|volatile|restrict)\b/g, '').trim();
  return context.records.get(key) || context.records.get(key.replace(/^struct /, ''));
}

export function constIndexValue(node, context) {
  // 只有整个下标或不改变数值的包装层可以提供精确值。窄化转换不能剥除。
  let u = node;
  while (u) {
    if (u.kind === 'GenericSelectionExpr') u = genericResult(u);
    else if (u.kind === 'ParenExpr' || (u.kind === 'ImplicitCastExpr' && u.castKind === 'NoOp')) u = children(u)[0];
    else break;
  }
  if (u?.kind === 'ConstantExpr' && /^-?\d+$/.test(String(u.value))) {
    const v = Number(u.value);
    return Number.isSafeInteger(v) ? v : null;
  }
  if (u?.kind === 'IntegerLiteral' && u.value != null) {
    const v = Number(u.value);
    return Number.isSafeInteger(v) ? v : null;
  }
  if (u?.kind === 'CharacterLiteral' && Number.isSafeInteger(u.value)) return u.value;
  if (u?.kind === 'DeclRefExpr' && u.referencedDecl?.kind === 'EnumConstantDecl') {
    const ev = context?.enumById?.get(u.referencedDecl.id)?.value;
    if (ev != null && /^-?\d+$/.test(String(ev))) {
      const v = Number(ev);
      return Number.isSafeInteger(v) ? v : null;
    }
  }
  return null;
}

export function initializerMembers(value, context) {
  const fields = children(context.valueRecords.get(value)).filter(field => field.kind === 'FieldDecl');
  const isArray = /\[[^\]]*\]$/.test(typeOf(value));
  return initializers(value).map((child, i) => {
    const field = value.field || fields[i];
    const sourceSuffix = field?.name ? '.' + field.name : isArray ? '[' + i + ']' : '';
    return { child, field, suffix: context.storageFields.slots.get(field?.id) ?? sourceSuffix, sourceSuffix };
  });
}

/** Clang 的语义 InitListExpr 已把位置和指定初始化排列到了字段/下标对应的槽上。 */
export function pointerSlots(node, context, resolveFunction, candidateSlots, indexField, sourceSlots) {
  const slots = new Map();
  function collectRhsRefs(expr, out) {
    const u = unwrap(expr);
    if (!u) return;
    const ref = fnRef(u);
    if (ref) {
      out.push(resolveFunction(ref.referencedDecl, context));
      return;
    }
    if (u.kind === 'ConditionalOperator') {
      collectRhsRefs(children(u)[1], out);
      collectRhsRefs(children(u)[2], out);
    }
  }
  function visit(value, slot, fieldId, sourceSlot, unionId) {
    value = unwrap(value);
    if (!value) return;
    const ref = fnRef(value);
    if (ref) {
      const target = resolveFunction(ref.referencedDecl, context);
      slots.set(slot, target);
      sourceSlots?.set(slot, sourceSlot);
      if (fieldId) indexField(fieldId, slot, target, unionId);
    } else if (value.kind === 'ConditionalOperator' && candidateSlots) {
      const cands = [];
      collectRhsRefs(value, cands);
      if (cands.length) candidateSlots.set(slot, [...new Set(cands)]);
      if (fieldId) for (const target of cands) indexField(fieldId, slot, target, unionId);
    } else if (value.kind === 'InitListExpr') {
      for (const { child, field, suffix, sourceSuffix } of initializerMembers(value, context)) {
        visit(child, slot + suffix, field?.id || (suffix.startsWith('[') ? fieldId : null), sourceSlot + sourceSuffix,
          context.storageFields.unionOwners.get(field?.id) || unionId);
      }
    }
  }
  visit(initializer(node), '', null, '');
  return slots;
}

function cleanType(type, aliases) {
  const expand = (text, seen) => text.replace(/\b(?:(?:struct|union|enum)\s+[A-Za-z_]\w*|[A-Za-z_]\w*)\b/g, (name) => {
    const alias = aliases.get(name);
    return alias && !seen.has(name) ? expand(alias, new Set([...seen, name])) : name;
  });
  return expand(type, new Set()).replace(/\s+/g, ' ').replace(/\s*([,()*])\s*/g, '$1').trim();
}

export function functionSignature(type, context) {
  const normalized = cleanType(type, context.aliases);
  // 函数指针与函数声明共享返回类型和参数列表。保留参数中的指针层级和可变参数。
  const start = normalized.indexOf('(');
  if (start < 0) return normalized;
  return normalized.slice(0, start) + normalized.slice(start).replace(/^\(\*(?:const|volatile|restrict|\*)*\)(?=\()/, '');
}

export function normalizeRecordBaseType(type, context) {
  if (!type) return null;
  let cleaned = type.replace(/\b(const|volatile|restrict)\b/g, '').replace(/[*&]/g, '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (context?.aliases?.has(cleaned)) {
    const expanded = context.aliases.get(cleaned).replace(/\b(const|volatile|restrict)\b/g, '').trim();
    if (expanded) return expanded;
  }
  return cleaned;
}

export function pointerExpression(node, context = null) {
  node = unwrap(node);
  if (node?.kind === 'DeclRefExpr') {
    return { decl: node.referencedDecl, slot: '', sourceSlot: '', member: null, baseType: normalizeRecordBaseType(typeOf(node), context), exact: true };
  }
  if (!node) return null;
  if (node.kind === 'MemberExpr' || node.kind === 'ArraySubscriptExpr') {
    const baseNode = children(node)[0];
    const base = pointerExpression(baseNode, context);
    if (!base) return null;
    const rawIndex = children(node)[1];
    const constant = node.kind === 'ArraySubscriptExpr' ? constIndexValue(rawIndex, context) : null;
    const rawBaseType = node.kind === 'MemberExpr' ? normalizeRecordBaseType(typeOf(baseNode), context) : base.baseType;
    const sourceSuffix = node.kind === 'MemberExpr' ? (node.name ? '.' + node.name : '') : `[${constant ?? '*'}]`;
    return {
      ...base,
      slot: base.slot + (context?.storageFields?.slots.get(node.referencedMemberDecl) ?? sourceSuffix),
      unionId: context?.storageFields?.unionOwners.get(node.referencedMemberDecl) || base.unionId,
      sourceSlot: base.sourceSlot + sourceSuffix,
      ...(node.kind === 'ArraySubscriptExpr' && constant === null
        ? { bounds: [...(base.bounds || []), Number(/\[(\d+)\]/.exec(typeOf(unwrap(baseNode)))?.[1])] } : {}),
      ...(node.kind === 'ArraySubscriptExpr' && !base.slot && !base.throughPointer && baseNode.castKind !== 'ArrayToPointerDecay'
        ? { pointerIndex: constant ?? '*' } : {}),
      throughPointer: base.throughPointer || node.isArrow ||
        (node.kind === 'ArraySubscriptExpr' && baseNode.castKind !== 'ArrayToPointerDecay'),
      fieldId: node.kind === 'MemberExpr' ? node.referencedMemberDecl : base.fieldId,
      member: node.kind === 'MemberExpr' ? node.name : base.member,
      baseType: rawBaseType || base.baseType,
      exact: base.exact && !node.isArrow && (node.kind !== 'ArraySubscriptExpr' || constant !== null),
    };
  }
  if (node.kind === 'UnaryOperator' && node.opcode === '*') {
    const operand = children(node)[0], base = pointerExpression(operand, context);
    // (*cb)() 对函数指示符的解引用等价于 cb()，而 (*slot)() 仍需读取另一个对象。
    if (context && cleanType(typeOf(node), context.aliases) === functionSignature(typeOf(operand), context)) return base;
    return base && { ...base, throughPointer: true };
  }
  return null;
}

export function collectAssignmentWrites(body, context) {
  const writes = [];
  for (const node of walkEvaluated(body)) {
    if (node.kind !== 'BinaryOperator' || node.opcode !== '=') continue;
    const [target, value] = children(node);
    const dest = unwrap(target);
    const callback = /\(\s*\*/.test(cleanType(typeOf(target), context.aliases));
    if (!callback && (typeOf(dest).includes('*') || !context.valueRecords.has(dest))) continue;
    const lhs = pointerExpression(target, context);
    if (!lhs?.decl) continue;
    // 只有整个函数就是 *p = value 时，直接传入的确定对象一定被替换。
    const replacesPointee = !callback && children(body).length === 1 && children(body)[0] === node &&
      dest.kind === 'UnaryOperator' && dest.opcode === '*' && unwrap(children(dest)[0])?.kind === 'DeclRefExpr';
    writes.push({ node, value, decl: lhs.decl, throughPointer: lhs.throughPointer, pointerIndex: lhs.pointerIndex,
      slot: lhs.slot, fieldId: lhs.fieldId, unionId: lhs.unionId, aggregate: !callback, replacesPointee });
  }
  return writes;
}
