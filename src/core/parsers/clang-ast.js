import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileKey, relativeFile } from './clang-config.js';

export const children = (node) => node?.inner ?? [];
export const typeOf = (node) => node?.type?.desugaredQualType || node?.type?.qualType || '';
export const unwrap = (node) => {
  while (node && ['ImplicitCastExpr', 'CStyleCastExpr', 'ParenExpr', 'ConstantExpr', 'ExprWithCleanups'].includes(node.kind)
      && children(node).length === 1) node = node.inner[0];
  return node;
};
export const fnRef = (node) => {
  node = unwrap(node);
  while (node?.kind === 'UnaryOperator' && ['&', '*'].includes(node.opcode)) node = unwrap(node.inner[0]);
  return node?.kind === 'DeclRefExpr' && node.referencedDecl?.kind === 'FunctionDecl' ? node : null;
};
const initializers = (node) => node.array_filler?.length ? node.array_filler.slice(1) : children(node);
export const initializer = (node) => children(node).find((n) => !n.kind?.endsWith('Attr'));

export function* walk(node) {
  yield node;
  for (const child of children(node)) yield* walk(child);
  if (node.array_filler) for (const child of node.array_filler) yield* walk(child);
}

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
      const lines = [0];
      for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) lines.push(i + 1);
      sources.set(file, { bytes, lines });
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
    // Clang 的列按 UTF-8 字节计数，词法器按 UTF-16 字符计数。
    const source = file && Number.isInteger(raw.offset) ? sourceOf(abs) : null;
    const lineStart = source?.lines[lastLine - 1];
    const prefix = lineStart != null && source.bytes.subarray(lineStart, raw.offset);
    const col = prefix ? prefix.toString('utf8').replace(/^\uFEFF/, '').length + 1 : raw.col;
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
    ? sourceOf(a.abs).bytes.subarray(a.offset, b.offset + b.length).toString('utf8') : '';
  return {
    record, includes, externalFiles,
    loc: (n) => locations.get(n)?.loc || locations.get(n)?.begin,
    begin: (n) => locations.get(n)?.begin,
    end: (n) => locations.get(n)?.end,
    text: (n) => slice(locations.get(n)?.begin, locations.get(n)?.end),
    token: (loc) => slice(loc, loc),
  };
}

function fingerprintAST(node) {
  const hash = createHash('sha256');
  for (const n of walk(node)) hash.update(JSON.stringify([
    n.kind, n.name, n.opcode, n.isPostfix, n.value, n.castKind, n.referencedDecl?.name, typeOf(n),
    children(n).length, n.array_filler?.length,
  ]));
  return hash.digest('hex');
}

export function readTranslationUnit(ast, root, unit, files) {
  if (ast?.kind !== 'TranslationUnitDecl') throw new Error('Clang 未返回 TranslationUnitDecl');
  const loc = sourceLocations(root, unit, files);
  loc.record(ast);
  const context = { unit, loc, functions: [], globals: [], declarations: new Map(), aliases: new Map(), records: new Map() };
  const recordsById = new Map();
  const aliasRecords = new Map();
  function collect(node, insideFunction) {
    const position = loc.loc(node);
    const { id, kind, name } = node;
    if (id && kind?.endsWith('Decl')) context.declarations.set(id, { node, position });
    if (kind === 'RecordDecl' && node.completeDefinition) {
      recordsById.set(id, node);
      if (name) context.records.set(`${node.tagUsed} ${name}`, node);
    }
    if (kind === 'TypedefDecl' && name && !node.isImplicit) {
      context.aliases.set(name, typeOf(node));
      const tag = [...walk(node)].find((child) => child.ownedTagDecl || child.decl?.kind === 'RecordDecl');
      if (tag) aliasRecords.set(name, (tag.ownedTagDecl || tag.decl).id);
    }
    if (position?.file && name && !node.isImplicit) {
      if (kind === 'FunctionDecl') {
        const body = children(node).find((child) => child.kind === 'CompoundStmt');
        if (body) context.functions.push({ node, body, context });
      }
      if (kind === 'VarDecl' && (!insideFunction || node.storageClass === 'extern')) context.globals.push(node);
    }
    for (const child of children(node)) collect(child, insideFunction || kind === 'FunctionDecl');
  }
  collect(ast, false);
  for (const [name, id] of aliasRecords) if (recordsById.has(id)) context.records.set(name, recordsById.get(id));
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
    signature: typeOf(node), sourceText: loc.text(node), semanticFingerprint: fingerprintAST(body),
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
    sourceText: context.loc.text(node), semanticFingerprint: fingerprintAST(node),
  };
}

function recordType(type, context) {
  const key = type.replace(/\b(const|volatile|restrict)\b/g, '').trim();
  return context.records.get(key) || context.records.get(key.replace(/^struct /, ''));
}

/** Clang 的语义 InitListExpr 已把位置和指定初始化排列到了字段/下标对应的槽上。 */
export function pointerSlots(node, context, resolveFunction) {
  const slots = new Map();
  function visit(value, slot) {
    value = unwrap(value);
    if (!value) return;
    const ref = fnRef(value);
    if (ref) {
      slots.set(slot, resolveFunction(ref.referencedDecl, context));
    } else if (value.kind === 'InitListExpr') {
      const type = typeOf(value);
      const fields = children(recordType(type, context)).filter((field) => field.kind === 'FieldDecl');
      initializers(value).forEach((child, i) => {
        const field = value.field?.name || fields[i]?.name;
        visit(child, field ? `${slot}.${field}` : /\[.*\]/.test(type) ? `${slot}[${i}]` : slot);
      });
    }
  }
  visit(initializer(node), '');
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

export function pointerExpression(node) {
  node = unwrap(node);
  if (node?.kind === 'DeclRefExpr') return { decl: node.referencedDecl, slot: '', exact: true };
  if (!node) return null;
  if (node.kind === 'MemberExpr' || node.kind === 'ArraySubscriptExpr') {
    const base = pointerExpression(children(node)[0]);
    if (!base) return null;
    const index = unwrap(children(node)[1]);
    const constant = index?.kind === 'IntegerLiteral' ? index.value : null;
    return { ...base, slot: base.slot + (node.kind === 'MemberExpr' ? `.${node.name}` : `[${constant ?? '*'}]`),
      exact: base.exact && !node.isArrow && (node.kind !== 'ArraySubscriptExpr' || constant !== null) };
  }
  if (node.kind === 'UnaryOperator' && node.opcode === '*') return pointerExpression(children(node)[0]);
  return null;
}
