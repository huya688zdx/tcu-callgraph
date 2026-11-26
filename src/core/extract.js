/**
 * 调用关系提取
 * 1) 识别函数定义（含 static / 返回类型 / 参数）
 * 2) 识别函数指针初始化表（静态可解析的间接调用）
 * 3) 扫描函数体，把宏展开后的调用算进图里
 */

import { collectArgs, lex } from './lexer.js';
import { expandSeq } from './preproc.js';

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'return',
  'break', 'continue', 'goto', 'sizeof', 'typedef', 'struct', 'union', 'enum',
  'static', 'extern', 'const', 'volatile', 'register', 'inline', 'void', 'char',
  'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', 'auto',
  'restrict', '_Bool', '_Complex', '_Atomic',
]);

const TYPE_WORDS = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed',
  'unsigned', 'const', 'volatile', 'struct', 'union', 'enum', 'static',
  'extern', 'register', 'inline', 'auto', 'restrict', '_Bool',
]);

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'do', 'return', 'sizeof', 'else']);

/** 从 openIdx 处的 '{' 找到匹配的 '}' */
export function matchBrace(tokens, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i].v === '{') depth++;
    else if (tokens[i].v === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

/** 返回一条完整 C 语句后的下标，包括复合语句、else 分支和 do-while 尾部。 */
export function statementEnd(tokens, i, end = tokens.length) {
  const op = tokens[i]?.v;
  if (op === '{') return matchBrace(tokens, i) + 1;
  if (['if', 'for', 'while', 'switch'].includes(op) && tokens[i + 1]?.v === '(') {
    const start = collectArgs(tokens, i + 1)[1];
    const next = statementEnd(tokens, start, end);
    return op === 'if' && tokens[next]?.v === 'else' ? statementEnd(tokens, next + 1, end) : next;
  }
  if (op === 'do') {
    const next = statementEnd(tokens, i + 1, end);
    if (tokens[next]?.v !== 'while' || tokens[next + 1]?.v !== '(') return next;
    return Math.min(end, collectArgs(tokens, next + 1)[1] + 1);
  }
  while (i < end && tokens[i].v !== ';') i++;
  return Math.min(i + 1, end);
}

/** 从右圆括号或右方括号反向找到成对的左括号。 */
function matchOpenBack(tokens, closeIdx) {
  const close = tokens[closeIdx].v;
  const open = close === ']' ? '[' : '(';
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    if (tokens[i].v === close) depth++;
    else if (tokens[i].v === open) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 函数声明/定义前后的注解关键字：void f(void) __attribute__((noreturn)) { } */
const ANNOTATIONS = new Set([
  '__attribute__', '__attribute', '_attribute', '__declspec', '__asm', '__asm__', 'asm', '_Pragma',
]);

/** 若 idx 处的 ')' 是 __attribute__((..)) / __declspec(..) 这类注解块的右括号，返回注解关键字下标 */
function annotationStartAt(tokens, idx) {
  if (idx < 0 || tokens[idx].v !== ')') return -1;
  const open = matchOpenBack(tokens, idx);
  if (open < 1) return -1;
  const kw = tokens[open - 1];
  if (!kw || kw.t !== 'id' || !ANNOTATIONS.has(kw.v)) return -1;
  return open - 1;
}

/**
 * 从 idx 处的 ')' 往前定位真正的参数列表：跳过尾部的注解块
 * 返回 { open, close }（参数列表的 '(' 与 ')' 下标），失败返回 null
 */
function paramListEnd(tokens, idx) {
  let end = idx;
  for (;;) {
    const kw = annotationStartAt(tokens, end);
    if (kw < 0) break;
    end = kw - 1;
    if (end < 0 || tokens[end].v !== ')') return null;
  }
  const open = matchOpenBack(tokens, end);
  if (open < 1) return null;
  return { open, close: end };
}

/** ')' 与 '{' 之间是否只由老式参数声明组成（int a; char *b;） */
function isKnRDecls(tokens, from, to) {
  if (to - from < 2) return false; // 至少要有 "int a;"
  if (tokens[to - 1].v !== ';') return false;
  for (let k = from; k < to; k++) {
    const v = tokens[k].v;
    if (v === '(' || v === ')' || v === '=' || v === '{' || v === '}') return false;
  }
  return true;
}

/** 从一段参数 token 里取参数名，追加进 names（重名只留一个） */
function pushParamName(names, toks) {
  if (!toks.length) return;
  const name = declarationName(toks)?.v;
  if (!name) {
    names.push('_');
    return;
  }
  if (!names.includes(name)) names.push(name);
}

/**
 * 识别函数定义
 * 支持：普通定义、带 __attribute__/__declspec 注解、K&R 老式定义
 * @returns {Array<{name,line,endLine,params,isStatic,cond,bodyStart,bodyEnd}>}
 */
export function findFunctions(tokens, file) {
  const fns = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].v !== '{') continue;
    const prev = tokens[i - 1];
    if (!prev) continue;

    let pl = null;
    let knr = false;
    if (prev.v === ')') {
      pl = paramListEnd(tokens, i - 1);
    } else if (prev.v === ';') {
      // K&R 定义：int add(a, b) int a; int b; { ... } —— '{' 前是 ';'
      // 回溯限制在 80 个 token 内，避免在长文件里跨语句线性回溯
      let k = i - 2;
      while (k >= 0 && k > i - 80 && tokens[k].v !== ')') k--;
      if (k >= 0 && tokens[k].v === ')') {
        const cand = paramListEnd(tokens, k);
        // 中间必须是老式参数声明，排除 return foo(1); { 这类假阳
        if (cand && isKnRDecls(tokens, cand.close + 1, i)) {
          pl = cand;
          knr = true;
        }
      }
    }
    if (!pl) continue;

    const { open, close: paramsClose } = pl;
    const nameTok = tokens[open - 1];
    if (!nameTok || nameTok.t !== 'id') continue;
    if (CONTROL.has(nameTok.v)) continue;

    // 函数名前面必须像类型（id / * / 类型关键字），排除 a = foo() { 这类；
    // 函数名与类型之间可能夹着注解块：void __attribute__((unused)) f(void)
    let j = open - 2;
    for (;;) {
      if (j >= 0 && (tokens[j].v === '*' || tokens[j].v === 'const')) {
        j--;
        continue;
      }
      const kw = annotationStartAt(tokens, j);
      if (kw >= 0) {
        j = kw - 1;
        continue;
      }
      break;
    }
    const typeTok = tokens[j];
    if (!typeTok || (typeTok.t !== 'id' && typeTok.v !== ']')) continue;
    if (typeTok.v === '=' || typeTok.v === ',' || typeTok.v === '(') continue;

    // 参数：K&R 时参数列表只到 paramsClose，后面的老式声明另行补名字
    const params = [];
    const inner = tokens.slice(open + 1, paramsClose);
    if (!(inner.length === 1 && inner[0].v === 'void') && inner.length) {
      let cur = [];
      let depth = 0;
      for (const t of inner) {
        if (t.v === '(' || t.v === '[') depth++;
        if (t.v === ')' || t.v === ']') depth--;
        if (t.v === ',' && depth === 0) {
          pushParamName(params, cur);
          cur = [];
          continue;
        }
        cur.push(t);
      }
      if (cur.length) pushParamName(params, cur);
    }
    if (knr) {
      // int a; int b; —— 只补名字（已有同名参数时不重复）
      let cur = [];
      for (let k = paramsClose + 1; k < i; k++) {
        if (tokens[k].v === ';') {
          pushParamName(params, cur);
          cur = [];
          continue;
        }
        cur.push(tokens[k]);
      }
      if (cur.length) pushParamName(params, cur);
    }

    const close = matchBrace(tokens, i);

    // static 判定：向前找最近的 ; { } 之间是否有 static
    let isStatic = false;
    for (let k = open - 2; k >= 0 && k > open - 24; k--) {
      if (tokens[k].v === ';' || tokens[k].v === '}' || tokens[k].v === '{') break;
      if (tokens[k].v === 'static') {
        isStatic = true;
        break;
      }
    }

    fns.push({
      name: nameTok.v,
      file,
      line: nameTok.line,
      endLine: tokens[close] ? tokens[close].line : nameTok.line,
      params,
      isStatic,
      cond: nameTok.cond,
      bodyStart: i,
      bodyEnd: close,
    });

    i = close;
  }
  return fns;
}

const NON_FN_IDENTS = new Set(['NULL', 'nullptr', 'true', 'false', 'TRUE', 'FALSE', 'STD_ON', 'STD_OFF', 'E_OK', 'E_NOT_OK']);

/** 仅移除包住整个表达式的括号，保留强制转换、实参列表等内部结构。 */
function stripOuterParens(tokens) {
  let start = 0, end = tokens.length - 1;
  while (tokens[start]?.v === '(' && tokens[end]?.v === ')' && matchOpenBack(tokens, end) === start) {
    start++;
    end--;
  }
  return start ? tokens.slice(start, end + 1) : tokens;
}

/** 剥除取址、解引用和类型转换，复杂表达式返回 null。 */
function simpleInitializerOperand(tokens) {
  let value = stripOuterParens(tokens);
  while (value.length > 1) {
    if (value[0].v === '&' || value[0].v === '*') {
      value = stripOuterParens(value.slice(1));
      continue;
    }
    if (value[0].v !== '(') return null;
    const [args, next] = collectArgs(value, 0);
    const type = args?.[0];
    if (args?.length !== 1 || type[0]?.t !== 'id' || next >= value.length) return null;
    // (factory)(arg) 也可能是实际调用；仅对能辨明的类型跳过这种前缀。
    if (value[next].v === '(' && !TYPE_WORDS.has(type[0].v) && !type.some(t => t.v === '*')) return null;
    value = stripOuterParens(value.slice(next));
  }
  return value[0] ?? null;
}

/** 切分顶层初始化项或成员声明，保留内部括号中的分隔符。 */
function splitAtTopLevel(tokens, separator = ',') {
  const items = [];
  let cur = [];
  let depth = 0;
  for (const tk of tokens) {
    if (tk.v === '(' || tk.v === '{' || tk.v === '[') depth++;
    else if (tk.v === ')' || tk.v === '}' || tk.v === ']') depth--;
    if (tk.v === separator && depth === 0) {
      if (cur.length) items.push(cur);
      cur = [];
      continue;
    }
    cur.push(tk);
  }
  if (cur.length) items.push(cur);
  return items;
}

const standardTypeNames = new Set([
  'bool', 'size_t', 'ptrdiff_t', 'max_align_t', 'wchar_t', 'wint_t', 'char8_t', 'char16_t', 'char32_t',
  'intptr_t', 'uintptr_t', 'intmax_t', 'uintmax_t', 'time_t', 'clock_t', 'sig_atomic_t', 'va_list',
]);

function isStandardTypeName(name) {
  return standardTypeNames.has(name) || /^u?int(?:_least|_fast)?(?:8|16|32|64)_t$/.test(name);
}

/** 记录函数原型，以及分派表初始化或调用所在函数中的局部对象声明。 */
export function collectDispatchDeclarations(tokens, dispatchScopes, record, macros) {
  const scopes = [{ end: null, trackObjects: false }];
  const recordStatement = (statement, scope, fileScope) => {
    const [first, second] = statement;
    const typePrefix = first?.t === 'id' && (TYPE_WORDS.has(first.v) || (!KEYWORDS.has(first.v) &&
      (second?.t === 'id' || second?.v === '*')));
    if (!typePrefix) return;
    // 在块内，T *obj 同时也可能是乘法，等包含的头文件收齐后再确认 T 是否为类型。
    const typeToCheck = !fileScope && second?.v === '*' && !TYPE_WORDS.has(first.v) && !isStandardTypeName(first.v) ? first : null;
    const isExtern = statement.some(t => t.v === 'extern');
    for (const part of splitAtTopLevel(statement)) {
      const eq = part.findIndex(t => t.v === '=');
      const declarator = eq < 0 ? part : part.slice(0, eq);
      const name = declarationName(declarator);
      if (!name || name === first) continue;
      const isFunction = declarator[declarator.indexOf(name) + 1]?.v === '(';
      if (isFunction || scope.trackObjects) {
        const alias = scope.trackObjects && eq >= 0 && pointerBefore(declarator, declarator.indexOf(name))
          ? aliasReference(part.slice(eq + 1), macros) : null;
        record({ declaration: name, scope, fileScope, isFunction, typeToCheck, isExtern, alias });
      }
    }
  };
  let start = 0, hasParen = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.v === 'for' && scopes.at(-1).trackObjects && tokens[i + 1]?.v === '(') {
      const body = collectArgs(tokens, i + 1)[1];
      if (tokens[i + 2]?.t === 'id') {
        const [initializer] = splitAtTopLevel(tokens.slice(i + 2, body - 1), ';');
        if (initializer) recordStatement(initializer, { trackObjects: true, end: tokens[statementEnd(tokens, body) - 1] }, false);
      }
      start = body;
      i = body - 1;
      hasParen = false;
      continue;
    }
    if (token.v === '(') hasParen = true;
    if (![';', '{', '}'].includes(token.v)) continue;
    const scope = scopes.at(-1);
    const fileScope = scopes.length === 1;
    // 左花括号也可能开始初始化，此时声明名已经可见。
    if ((token.v === ';' || (token.v === '{' && tokens[i - 1]?.v === '=')) && (hasParen || scope.trackObjects)) {
      recordStatement(tokens.slice(start, i), scope, fileScope);
    }
    if (token.v === '{') scopes.push({ end: null, trackObjects: scope.trackObjects || dispatchScopes.has(token) });
    if (token.v === '}' && !fileScope) scopes.pop().end = token;
    start = i + 1;
    hasParen = false;
  }
}

function declarationName(part) {
  let name = null, depth = 0;
  for (let j = 0; j < part.length; j++) {
    const t = part[j];
    if (!depth && t.t === 'id' && !KEYWORDS.has(t.v) && !ANNOTATIONS.has(t.v)) name = t;
    if (!depth && t.v === '(' && part[j + 1]?.v === '*') {
      let k = j + 2;
      while (part[k]?.v === '*' || TYPE_WORDS.has(part[k]?.v)) k++;
      if (part[k]?.t === 'id') name = part[k];
    }
    if (['(', '[', '{'].includes(t.v)) depth++;
    if ([')', ']', '}'].includes(t.v)) depth--;
  }
  return name;
}

function declarationType(tokens) {
  const tag = tokens.findIndex(t => t.v === 'struct' || t.v === 'union');
  if (tag >= 0) return tokens[tag + 1]?.t === 'id' ? tokens[tag].v + ' ' + tokens[tag + 1].v : null;
  return tokens.find(t => t.t === 'id' && !KEYWORDS.has(t.v))?.v ?? null;
}

/** 保留初始化器需要的声明形状，包括声明顺序、数组维度和指针。 */
function initializerDeclarations(statement, macros) {
  const parts = splitAtTopLevel(statement);
  const first = parts[0] || [];
  const base = declarationType(first.slice(0, first.indexOf(declarationName(first))));
  const open = first.findIndex(t => t.v === '{');
  const fields = open >= 0 ? initializerMembers(first.slice(open + 1, matchBrace(first, open)), macros) : null;
  const shapes = new Map();
  for (const part of parts) {
    const token = declarationName(part);
    if (!token) continue;
    const name = part.indexOf(token);
    let j = name + 1;
    const extents = [];
    while (part[j]?.v === '[') {
      const start = j + 1;
      let depth = 1;
      for (j++; j < part.length && depth; j++) {
        if (part[j].v === '[') depth++;
        if (part[j].v === ']') depth--;
      }
      extents.push(parseConstIndex(part.slice(start, j - 1), macros));
    }
    let before = name - 1;
    while (['const', 'volatile', 'restrict'].includes(part[before]?.v)) before--;
    shapes.set(token.v, { token, type: base, extents, pointer: part[before]?.v === '*', union: first.some(t => t.v === 'union') && first.findIndex(t => t.v === 'union') < open, fields });
  }
  return shapes;
}

function initializerMembers(body, macros) {
  const fields = new Map();
  for (const part of splitAtTopLevel(body, ';')) {
    if (['struct', 'union'].includes(part[0]?.v) && part[1]?.v === '{' && matchBrace(part, 1) === part.length - 1) {
      fields.set('@anonymous:' + part[0].s, { anonymous: true });
      continue;
    }
    for (const [name, shape] of initializerDeclarations(part, macros)) fields.set(name, shape);
  }
  return fields;
}

/** 收集类型声明及作用域；成员声明帮助区分标量与只初始化了一项的数组。 */
export function findTypedefs(tokens, macros) {
  const aliases = new Map();
  const scopes = [{ end: null }];
  const record = (name, declaration, shape) => {
    if (!aliases.has(name)) aliases.set(name, []);
    aliases.get(name).push({ declaration, shape, scope: scopes.at(-1), fileScope: scopes.length === 1 });
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.v === '{') { scopes.push({ end: null }); continue; }
    if (token.v === '}' && scopes.length > 1) { scopes.pop().end = token; continue; }
    if ((token.v === 'struct' || token.v === 'union') && tokens[i + 1]?.t === 'id' && tokens[i + 2]?.v === '{') {
      const close = matchBrace(tokens, i + 2);
      record(token.v + ' ' + tokens[i + 1].v, token, {
        union: token.v === 'union', fields: initializerMembers(tokens.slice(i + 3, close), macros),
      });
      i = close;
      continue;
    }
    if (token.v !== 'typedef') continue;
    let end = i + 1, depth = 0;
    for (; end < tokens.length; end++) {
      const value = tokens[end].v;
      if (!depth && (value === ';' || value === '}')) break;
      if (['(', '[', '{'].includes(value)) depth++;
      if ([')', ']', '}'].includes(value)) depth--;
    }
    if (tokens[end]?.v !== ';') continue;
    for (const [name, shape] of initializerDeclarations(tokens.slice(i + 1, end), macros)) {
      record(name, shape.token, shape);
      if (shape.fields && shape.type && !aliases.get(shape.type)?.some(entry => entry.declaration === token)) {
        record(shape.type, token, { fields: shape.fields, union: shape.union });
      }
    }
    i = end;
  }
  return aliases;
}

/** 解析常量整数索引（如 0, 1, 0x02），非常量返回 null */
function parseConstIndex(tokens, macros) {
  if (macros && tokens.some(t => t.t === 'id')) tokens = expandSeq(tokens, macros);
  tokens = stripOuterParens(tokens);
  if (tokens.length !== 1 || tokens[0].t !== 'num') return null;
  const s = tokens[0].v.replace(/[uUlL]+$/, '');
  let value;
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) value = Number(s);
  else if (/^0[0-7]*$/.test(s)) value = Number.parseInt(s, 8);
  else if (/^[1-9]\d*$/.test(s)) value = Number(s);
  return Number.isSafeInteger(value) ? value : null;
}

function formatInitIndex(index) {
  if (typeof index === 'number') return `[${index}]`;
  return `[?${index.expr}${index.offset ? '+' + index.offset : ''}]`;
}

const anonymousInitLayout = { anonymous: true };

/** 延迟展开成员类型，遇到指针就停止，递归结构体不会无限展开。 */
function initializerLayout(root, file, lookup) {
  const cache = new Map();
  const resolve = (declaration, source) => {
    if (!declaration) return null;
    if (declaration.anonymous) return anonymousInitLayout;
    if (cache.has(declaration)) return cache.get(declaration);
    const extents = [];
    const seen = new Set();
    let shape = declaration;
    while (shape && !seen.has(shape)) {
      seen.add(shape);
      extents.push(...(shape.extents || []));
      if (shape.fields || shape.pointer || !shape.type) break;
      let found = lookup(source, shape.type, shape.token);
      if (!found && /^(struct|union) /.test(shape.type)) {
        // typedef 可先引用不完整标签，等到表定义时才需要完整的字段列表。
        if (source !== file) found = lookup(source, shape.type, { s: Infinity });
        found ??= lookup(file, shape.type, root.token);
      }
      if (!found) break;
      source = found.file;
      shape = found.shape;
    }
    const fields = shape?.pointer ? null : shape?.fields;
    let layout = fields ? {
      names: [...fields.keys()], union: !!shape.union, hasAnonymous: [...fields.values()].some(field => field.anonymous),
      field: name => resolve(fields.get(name), source),
    } : { pointer: !!shape?.pointer };
    for (let i = extents.length - 1; i >= 0; i--) layout = { element: layout, length: extents[i] };
    cache.set(declaration, layout);
    return layout;
  };
  return resolve(root, file);
}

function initChild(layout, part) {
  if (layout?.anonymous) return layout;
  if (typeof part !== 'string') return layout?.element;
  return layout?.field?.(part) ?? (layout?.hasAnonymous ? anonymousInitLayout : undefined);
}

/** 消耗一个子对象，将游标进位到下一个成员或数组元素。 */
function nextInitPath(path, root) {
  const parents = [root];
  for (const part of path) parents.push(initChild(parents.at(-1), part));
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const part = path[depth], parent = parents[depth];
    if (typeof part === 'string') {
      const pos = parent?.names?.indexOf(part) ?? -1;
      if (pos < 0) return null;
      if (!parent.union && pos + 1 < parent.names.length) return [...path.slice(0, depth), parent.names[pos + 1]];
    } else {
      if (depth && (typeof part !== 'number' || parent?.length == null)) return null;
      if (!depth || part + 1 < parent.length) {
        const next = typeof part === 'number' ? part + 1 : { ...part, offset: part.offset + 1 };
        return [...path.slice(0, depth), next];
      }
    }
  }
  return null;
}

function appendInitSlot(slot, part) {
  return slot + (typeof part === 'string' ? (slot ? '.' : '') + part : formatInitIndex(part));
}

function clearInitSlot(slot, table, status) {
  delete table.map[slot];
  delete table.slotLines[slot];
  table.slots.delete(slot);
  status.unresolvedSlots.delete(slot);
}

function clearAggregateSlots(slot, table, status) {
  clearInitSlot(slot, table, status);
  if (!status.initializedAggregates.delete(slot)) return;
  for (const key of table.slots.keys()) {
    if (key.startsWith(slot + '.') || key.startsWith(slot + '[')) clearInitSlot(key, table, status);
  }
}

function isStringInitializer(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (['L', 'u', 'U', 'u8'].includes(tokens[i].v)) i++;
    if (tokens[i]?.t !== 'str' || !tokens[i].v.startsWith('"')) return false;
  }
  return true;
}

/** 每一对花括号都有独立的游标。数组按维度进位，结构体按字段声明顺序进位。 */
function collectInitSlots(inner, prefix, layout, table, status, scalarBrace = false, designatedParent = false, parentUnions = []) {
  const items = splitAtTopLevel(inner);
  let cursor = layout?.names?.length ? [layout.names[0]] : scalarBrace && items.length === 1 ? [] : [0];
  for (const item of items) {
    const designators = [];
    let k = 0;
    while (k < item.length) {
      if (item[k].v === '.' && item[k + 1]?.t === 'id') {
        designators.push(item[k + 1].v);
        k += 2;
      } else if (item[k].v === '[') {
        const start = ++k;
        let depth = 1;
        for (; k < item.length && depth; k++) {
          if (item[k].v === '[') depth++;
          if (item[k].v === ']') depth--;
        }
        const expr = item.slice(start, k - 1);
        designators.push(parseConstIndex(expr) ?? { expr: expr.map(t => t.v).join(''), offset: 0 });
      } else break;
    }
    const designated = designators.length && item[k]?.v === '=';
    const val = designated ? item.slice(k + 1) : item;
    if (!val.length) continue;
    const braced = val[0].v === '{' && val.at(-1).v === '}';
    const path = designated ? designators : cursor?.slice();
    let unknownPosition = !path;
    const parts = path ?? [{ expr: `@${item[0].line}:${item[0].col}`, offset: 0 }];
    if (parts.some(p => typeof p === 'object')) status.incomplete = true;
    const operand = braced ? null : simpleInitializerOperand(val);
    const stringInitializer = !braced && isStringInitializer(val);
    let child = parts.reduce(initChild, layout);
    let descended;
    // 省略聚合括号时，已知标量继续下沉。未知表达式可能复制整个结构体。
    while (!braced) {
      if (child?.element) {
        // 字符串消耗整个字符数组，仍需下沉多维数组的外层。
        if (!child.element.element && !child.element.pointer && !child.element.names &&
            stringInitializer) break;
        parts.push(0);
        child = child.element;
      } else if (child?.names?.length && (operand?.t === 'num' || val[0].v === '&' ||
          (operand?.t === 'id' && (status.isFunction(operand) || status.enumNames.has(operand.v))) ||
          (stringInitializer || val[0].t === 'str' || val[0].v === 'sizeof'))) {
        descended ??= new Set();
        if (descended.has(child)) { status.incomplete = true; break; }
        descended.add(child);
        const first = child.names[0];
        parts.push(first);
        child = child.field(first);
      } else break;
    }
    if (child?.anonymous) {
      // 匿名聚合会提升字段名，无法确定布局时不将值误分配给后续字段。
      status.incomplete = true;
      unknownPosition = true;
      parts.splice(0, parts.length, { expr: '@' + item[0].line + ':' + item[0].col, offset: 0 });
      child = null;
    }
    const slotPath = [...prefix, ...parts];
    let slot = '';
    let parent = layout;
    let unions = parentUnions;
    for (let i = 0; i < slotPath.length; i++) {
      const part = slotPath[i];
      if (i >= prefix.length) {
        if (parent?.union && typeof part === 'string') {
          unions = [...unions, i];
          // union 成员重叠。切换成员后，前一个成员的值不再能确定调用目标。
          clearInitSlot(slot, table, status);
          const previous = status.activeUnionMembers.get(slot);
          if (previous !== undefined && previous !== part) {
            clearAggregateSlots(appendInitSlot(slot, previous), table, status);
          }
          status.activeUnionMembers.set(slot, part);
        }
        parent = initChild(parent, part);
      }
      slot = appendInitSlot(slot, part);
      if (i < slotPath.length - 1) status.initializedAggregates.add(slot);
    }
    // 新的聚合初始化覆盖整个子对象，包括没有显式列出的成员。
    if (braced || child?.names) clearAggregateSlots(slot, table, status);
    if (braced) {
      const scalar = !child?.element && !child?.names &&
        (child?.pointer || (typeof parts.at(-1) !== 'string' && (!!layout?.element || scalarBrace)));
      collectInitSlots(val.slice(1, -1), slotPath, child, table, status, scalar, designatedParent || designated, unions);
    } else {
      // 同一槽位的后一个初始化覆盖前一个。未知的整个结构体可能提供任一成员。
      status.unresolvedSlots.delete(slot);
      if (!child?.names && operand?.t === 'id' && !KEYWORDS.has(operand.v) && !NON_FN_IDENTS.has(operand.v)) {
        table.map[slot] = operand.v;
        table.slotLines[slot] = operand.line;
      } else {
        delete table.map[slot];
        delete table.slotLines[slot];
        if (child?.names || !operand || (operand.t === 'num' && val.length > 1 && parseConstIndex([operand]) !== 0)) {
          status.unresolvedSlots.add(slot);
        }
      }
      if (Object.hasOwn(table.map, slot) || status.unresolvedSlots.has(slot)) {
        table.slots.set(slot, {
          parts: slotPath.map(p => typeof p === 'object' ? null : p),
          unknownPosition: slotPath.some(p => typeof p === 'object' && p.expr.startsWith('@')),
          designated: designatedParent || designated,
          ...(unions.length ? { unions } : {}),
        });
      } else table.slots.delete(slot);
    }
    // 无法判定是聚合复制还是标量时，后续位置保持不确定，避免生成错误确定边。
    cursor = unknownPosition || (!braced && child?.names) ? null : nextInitPath(parts, layout);
  }
}

/**
 * 识别函数指针初始化表（单结构体、1D/2D 函数指针数组、结构体数组）
 * 形如：
 *   const ShiftOps g_ops = { .shift_up = Gear_ShiftUp, .apply = (cast)Gear_Apply };
 *   const fn_t z[] = { fn_a, fn_b };
 *   const fn_t e[2][3] = { {vvv, ggg, jjj}, {ghh, jkk, kkk} };
 *   const Entry tbl[] = { { .enter = Enter_A, .run = Run_A }, ... };
 */
export function findFnPtrTables(tokens, file = '', { functionId = null, macros, pendingFields } = {}) {
  const tables = new Map();
  const scopes = [{ end: null }];
  const enumNames = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].v !== 'enum') continue;
    const open = tokens[i + 1]?.v === '{' ? i + 1 : tokens[i + 2]?.v === '{' ? i + 2 : -1;
    if (open < 0) continue;
    const close = matchBrace(tokens, open);
    for (const part of splitAtTopLevel(tokens.slice(open + 1, close))) if (part[0]?.t === 'id') enumNames.add(part[0].v);
  }
  let localTypes;
  let localFunctions;
  const localFunction = token => {
    localFunctions ??= new Set(findFunctions(tokens, file).map(fn => fn.name));
    return localFunctions.has(token.v);
  };
  const localLookup = (_, name, at) => {
    localTypes ??= findTypedefs(tokens, macros);
    const entry = localTypes.get(name)?.findLast(e => e.declaration.s <= at.s && (!e.scope.end || e.scope.end.s > at.s));
    return entry && { file, shape: entry.shape };
  };
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.v === '{') { scopes.push({ end: null }); continue; }
    if (tk.v === '}' && scopes.length > 1) { scopes.pop().end = tk; continue; }
    if (tk.v !== '=' || (!functionId && scopes.length !== 1)) continue;
    if (!tokens[i + 1] || tokens[i + 1].v !== '{') continue;

    // 向前解析声明名与数组维度，兼容：
    //   name = { ... }
    //   name[N] = { ... } / name[R][C] = { ... }
    //   void (*const name[N])(void) = { ... }
    let p = i - 1;
    const extents = [];
    for (let start; (start = annotationStartAt(tokens, p)) >= 0;) p = start - 1;
    if (p >= 0 && tokens[p].v === ')') {
      // 函数指针数组声明器：跳过形参列表 (...) 再进左侧 (*name[...])
      let d = 1;
      p--;
      while (p >= 0 && d > 0) {
        if (tokens[p].v === ')') d++;
        else if (tokens[p].v === '(') d--;
        p--;
      }
      if (tokens[p]?.v !== ')') continue;
      p--;
    }
    while (tokens[p]?.v === ']') {
      const close = p--;
      let depth = 1;
      while (p >= 0 && depth > 0) {
        if (tokens[p].v === ']') depth++;
        else if (tokens[p].v === '[') depth--;
        p--;
      }
      extents.unshift(parseConstIndex(tokens.slice(p + 2, close), macros));
    }
    const nameTok = tokens[p];
    if (nameTok?.t !== 'id' || TYPE_WORDS.has(nameTok.v)) continue;

    // 检查声明语句里的 static / const 修饰符
    let isStatic = false;
    let isConst = false;
    let beforeDeclaration = p - 1;
    for (; beforeDeclaration >= 0 && ![';', '{', '}'].includes(tokens[beforeDeclaration].v); beforeDeclaration--) {
      const word = tokens[beforeDeclaration].v;
      if (word === 'static' || word === 'STATIC') isStatic = true;
      if (word === 'const' || word === 'CONST') isConst = true;
    }

    const close = matchBrace(tokens, i + 1);
    const source = tokens.slice(i + 2, close);
    const inner = macros ? expandSeq(source, macros) : source;
    const rootShape = { type: declarationType(tokens.slice(beforeDeclaration + 1, p)), token: nameTok, extents };
    if (!rootShape.type && tokens[beforeDeclaration]?.v === '}') {
      // struct { ... } ops = { ... } 将类型定义与变量声明写在同一处。
      let open = beforeDeclaration - 1, depth = 1;
      for (; open >= 0 && depth; open--) {
        if (tokens[open].v === '}') depth++;
        if (tokens[open].v === '{') depth--;
      }
      const kind = ['struct', 'union'].includes(tokens[open]?.v) ? tokens[open].v : tokens[open - 1]?.v;
      if (['struct', 'union'].includes(kind)) {
        rootShape.fields = initializerMembers(tokens.slice(open + 2, beforeDeclaration), macros);
        rootShape.union = kind === 'union';
        for (let j = open; j >= 0 && ![';', '{', '}'].includes(tokens[j].v); j--) {
          if (['static', 'STATIC'].includes(tokens[j].v)) isStatic = true;
          if (['const', 'CONST'].includes(tokens[j].v)) isConst = true;
        }
      }
    }
    const table = {
      name: nameTok.v,
      file,
      line: nameTok.line,
      isStatic,
      isConst,
      dims: extents.length,
      map: {},
      slotLines: {},
      slots: new Map(),
      ...(functionId && { functionId, declaration: nameTok, scope: scopes.at(-1) }),
    };
    const fill = (lookup, isFunction = localFunction) => {
      const status = {
        incomplete: false,
        enumNames,
        unresolvedSlots: new Set(),
        initializedAggregates: new Set(),
        activeUnionMembers: new Map(),
        isFunction: token => isFunction(token, file, functionId),
      };
      const layout = initializerLayout(rootShape, file, lookup);
      collectInitSlots(inner, [], layout, table, status);
      table.dims = 0;
      for (let dim = layout; dim?.element; dim = dim.element) table.dims++;
      if (status.incomplete) table.incomplete = true;
      if (status.unresolvedSlots.size) table.unresolvedSlots = [...status.unresolvedSlots];
    };
    // 表和它的嵌套成员都可能引用头文件中定义的类型。
    if (pendingFields && (rootShape.type || rootShape.fields)) {
      pendingFields.push(fill);
    } else {
      fill(localLookup);
      if (!table.unresolvedSlots && !Object.keys(table.map).length) { i = close; continue; }
    }
    tables.set(functionId ? i : nameTok.v, table);
    i = close;
  }
  return tables;
}

/** 提取去掉末尾下标的接收表达式，例如 p->table 或 rows[i].table。 */
function receiverBefore(tokens, end) {
  let start = end + 1;
  for (let i = end; i >= 0;) {
    const t = tokens[i];
    if (t.v === ')' || t.v === ']') {
      const open = matchOpenBack(tokens, i);
      if (open < 0 || (t.v === ')' && conditionKeywords.has(tokens[open - 1]?.v))) break;
      start = open;
      i = open - 1;
    } else if (t.t === 'id' && !KEYWORDS.has(t.v)) {
      start = i;
      if (!['.', '->'].includes(tokens[i - 1]?.v)) break;
      start = i - 1;
      i -= 2;
    } else break;
  }
  if (start > end) return null;
  const expr = tokens.slice(start, end + 1);
  let inner = stripOuterParens(expr);
  // 宏常把对象地址写成 (&ops)->run；它与 ops.run 绑定同一张表。
  const memberOp = tokens[end + 1]?.v;
  if ((memberOp === '->' && inner[0]?.v === '&') || (memberOp === '.' && inner[0]?.v === '*')) {
    inner = stripOuterParens(inner.slice(1));
  }
  const name = inner.length === 1 && inner[0].t === 'id' ? inner[0].v : expr.map(t => t.v).join('');
  return { name, start };
}

/** 从调用位置回溯到根对象，保留下标与成员交错出现的顺序。 */
function dispatchReference(tokens, end, macros) {
  let j = end;
  const path = [];
  const indexExprs = [];
  while (j >= 0) {
    if (tokens[j].v === ']') {
      const open = matchOpenBack(tokens, j);
      if (open < 0) return null;
      const expr = tokens.slice(open + 1, j);
      path.unshift(parseConstIndex(expr, macros));
      indexExprs.unshift(expr.map(t => t.v).join(''));
      j = open - 1;
    } else if (tokens[j].t === 'id' && ['.', '->'].includes(tokens[j - 1]?.v)) {
      path.unshift(tokens[j].v);
      j -= 2;
    } else break;
  }
  const base = receiverBefore(tokens, j);
  if (!base) return null;
  return {
    receiver: base.name, start: base.start, firstOp: tokens[j + 1]?.v, path, indexExprs,
    member: path.filter(p => typeof p === 'string').join('.') || null,
    via: tokens.slice(base.start, end + 1).map(t => t.v).join(''),
  };
}

function pointerBefore(tokens, index) {
  while (index > 0 && typeQualifiers.has(tokens[index - 1].v)) index--;
  return tokens[index - 1]?.v === '*';
}

/** 只跟踪取址和裸数组退化，调用、算术及条件表达式都没有唯一的静态来源。 */
function aliasReference(tokens, macros) {
  let value = stripOuterParens(macros ? expandSeq(tokens, macros) : tokens);
  const address = value[0]?.v === '&';
  if (address) value = stripOuterParens(value.slice(1));
  if (value[0]?.t !== 'id' || (!address && value.length !== 1)) return null;
  const ref = dispatchReference(value, value.length - 1);
  if (!ref || ref.start !== 0 || ref.receiver !== value[0].v) return null;
  return { receiver: ref.receiver, path: ref.path, indexExprs: ref.indexExprs, address, line: value[0].line, col: value[0].col };
}

/** 收集可能改写分派表或改变局部指针绑定的位置，等作用域收齐后再绑定。 */
export function findDispatchWrites(body, macros, aliasUses = []) {
  const tokens = expandSeq(body, macros);
  const writes = [];
  const pointerNames = new Set();
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].v === '=' && tokens[i - 1].t === 'id' && pointerBefore(tokens, i - 1)) pointerNames.add(tokens[i - 1].v);
  }
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i];
    if (name.t !== 'id' || KEYWORDS.has(name.v) || ['.', '->'].includes(tokens[i - 1]?.v)) continue;
    if (pointerNames.has(name.v) && tokens[i + 1]?.v !== '->') {
      // 仅通过 -> 读取成员不会改变绑定；其余用法（包括宏里的逃逸和自增）保守降级。
      let alternative = null;
      if (tokens[i + 1]?.v === '=' && !pointerBefore(tokens, i)) {
        let end = i + 2;
        while (end < tokens.length && ![';', ',', '}'].includes(tokens[end].v)) end++;
        alternative = aliasReference(tokens.slice(i + 2, end));
      }
      aliasUses.push({ name: name.v, line: name.line, col: name.col, alternative });
    }
    let start = i, end = i + 1, member = null;
    const indices = [];
    const path = [];
    for (;;) {
      if (tokens[end]?.v === '[') {
        const first = ++end;
        let depth = 1;
        while (end < tokens.length && depth) {
          if (tokens[end].v === '[') depth++;
          if (tokens[end].v === ']') depth--;
          end++;
        }
        const index = parseConstIndex(tokens.slice(first, end - 1));
        indices.push(index);
        path.push(index);
      } else if (['.', '->'].includes(tokens[end]?.v) && tokens[end + 1]?.t === 'id') {
        member ??= tokens[end + 1].v;
        path.push(tokens[end + 1].v);
        end += 2;
      } else if (tokens[end]?.v === ')' && tokens[start - 1]?.v === '(' &&
          (tokens[start - 2]?.t !== 'id' || tokens[start - 2]?.v === 'return')) {
        start--;
        end++;
      } else if (tokens[end]?.v === ')' && tokens[start - 1]?.v === '*' && tokens[start - 2]?.v === '(') {
        start -= 2;
        end++;
      } else break;
    }
    const prev = tokens[start - 1]?.v, next = tokens[end]?.v;
    // 表的声明初始化不是一次运行时覆写。数组退化或取地址交给外部时也可能经别名写回。
    const assigned = next === '=' && tokens[end + 1]?.v !== '{';
    const addressed = prev === '&';
    const decayed = ['=', '(', ',', 'return'].includes(prev) && [')', ',', ';', '+'].includes(next) &&
      !(prev === '(' && CONTROL.has(tokens[start - 2]?.v));
    if (assigned || addressed || decayed) writes.push({
      receiver: name.v, line: name.line, col: name.col,
      indices, member, path, escape: addressed ? 'address' : !assigned && decayed ? 'array' : null,
    });
  }
  return writes;
}

/** 粗略判断是否为块内局部函数原型声明，如 `void proto(void);` / `extern int foo(int x);` */
function isLocalPrototype(tokens, idIdx) {
  const prev = tokens[idIdx - 1];
  if (!prev || !(TYPE_WORDS.has(prev.v) || prev.v === '*')) return false;
  const [args, next] = collectArgs(tokens, idIdx + 1);
  if (!args || tokens[next]?.v !== ';') return false;
  let start = idIdx - 1;
  while (start > 0 && ![';', '{', '}'].includes(tokens[start - 1].v)) start--;
  // 初始化表达式中也可能出现 `*f()`，声明前缀只能包含类型、标签和指针修饰。
  const prefix = tokens.slice(start, idIdx);
  if (!prefix.every(t => TYPE_WORDS.has(t.v) || t.v === '*' || (t.t === 'id' && !KEYWORDS.has(t.v)))) return false;
  if (args.length === 1 && args[0].length === 1 && args[0][0].v === 'void') return true;
  return TYPE_WORDS.has(prefix[0].v) &&
    args.every(arg => !arg.length || arg.some(t => TYPE_WORDS.has(t.v) || t.v === '*'));
}

const typeQualifiers = new Set(['const', 'volatile', 'restrict']);
const taggedTypes = new Set(['struct', 'union', 'enum']);
const conditionKeywords = new Set(['if', 'for', 'while', 'switch']);

/** sizeof 的数组类型名可以求值维度，普通表达式和指向 VLA 的指针类型不求值。 */
function scanSizeofBounds(tokens, ctx, out, macroChain) {
  const operand = expandSeq(tokens, ctx.macros);
  let index = operand.findIndex(t => t.v === '[');
  if (index < 1) return;
  let type = null;
  for (let i = 0; i < index; i++) {
    const token = operand[i];
    if (token.v === '*' || typeQualifiers.has(token.v)) continue;
    if (taggedTypes.has(token.v) && operand[i + 1]?.t === 'id') {
      type ??= token;
      i++;
    } else if (TYPE_WORDS.has(token.v) || (!type && token.t === 'id' && !KEYWORDS.has(token.v))) {
      type ??= token;
    } else return;
  }
  if (!type) return;
  const bounds = [];
  while (operand[index]?.v === '[') {
    let depth = 1, end = index + 1;
    for (; end < operand.length && depth; end++) {
      if (operand[end].v === '[') depth++;
      if (operand[end].v === ']') depth--;
    }
    if (depth) return;
    bounds.push(operand.slice(index + 1, end - 1));
    index = end;
  }
  if (index !== operand.length) return;
  const start = out.length;
  for (const bound of bounds) scanCalls(bound, ctx, out, macroChain);
  if (!TYPE_WORDS.has(type.v) && !isStandardTypeName(type.v)) {
    for (let i = start; i < out.length; i++) out[i].requiresTypes = [...(out[i].requiresTypes || []), type];
  }
}

/**
 * 扫描一段 token 中的调用
 * @param {Array} tokens
 * @param {object} ctx { macros, fnptr }
 * @param {Array} out 输出
 * @param {Array<string>} macroChain 宏展开链
 */
export function scanCalls(tokens, ctx, out, macroChain = []) {
  const chainedArgs = new Map();
  const recordDispatch = (ref, token, requirements) => {
    const { receiver, member, path, indexExprs, via, firstOp } = ref;
    const table = ctx.fnptr?.get(receiver);
    const map = table?.map || table;
    const target = path.length === 1 && member && map && Object.hasOwn(map, member) ? map[member] : null;
    out.push({
      callee: target, receiver, member, path, indexExprs, firstOp,
      kind: target ? 'fnptr' : indexExprs.length ? 'fnptr_indexed' : member ? 'unknown' : 'fnptr_ptr',
      ...requirements, line: token.line, col: token.col, cond: token.cond,
      via: path.length ? via : `(*${receiver})`,
      macroChain: (token.macroOrigins || macroChain).slice(),
    });
  };
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];

    if (['__attribute__', '__attribute', '_attribute', '__declspec'].includes(tk.v) && tokens[i + 1]?.v === '(') {
      i = collectArgs(tokens, i + 1)[1] - 1;
      continue;
    }
    // sizeof 普通操作数不求值，变长数组类型的维度除外。
    if (tk.t === 'id' && tk.v === 'sizeof' && tokens[i + 1]?.v === '(') {
      const [args, next] = collectArgs(tokens, i + 1);
      if (next > i + 1) {
        if (args?.length === 1) scanSizeofBounds(args[0], ctx, out, macroChain);
        i = next - 1;
        continue;
      }
    }

    // 括号包裹调用：(fn)()、(*fp)()、(*z[idx])()、(*e[r][c])()
    if (tk.v === '(') {
      let depth = 1, close = i + 1;
      for (; close < tokens.length && depth > 0; close++) {
        if (tokens[close].v === '(') depth++;
        else if (tokens[close].v === ')') depth--;
      }
      if (depth === 0 && tokens[close]?.v === '(') {
        const prev = tokens[i - 1];
        const castType = chainedArgs.get(i);
        if (prev?.t === 'id' && conditionKeywords.has(prev.v)) continue;
        if (castType === null || prev?.v === ']' || (prev?.t === 'id' && !KEYWORDS.has(prev.v))) {
          chainedArgs.set(close, null);
          continue;
        }
        const requiresType = castType ? { requiresTypes: [castType] } : {};
        let inner = stripOuterParens(tokens.slice(i + 1, close - 1));
        const name = inner.length === 1 ? inner[0] : null;
        // (FN)() 中 FN 可为对象宏，多层别名按调用行展开；括号隔开了函数式宏与实参。
        if (name?.t === 'id' && ctx.macros.get(name.v, name.line)?.params === null) {
          inner = stripOuterParens(expandSeq(inner, ctx.macros));
        }
        if (inner.length === 1 && inner[0].t === 'id' && !KEYWORDS.has(inner[0].v) && !isStandardTypeName(inner[0].v)) {
          const calleeTok = inner[0];
          const origins = calleeTok.macroOrigins || macroChain;
          out.push({
            callee: calleeTok.v,
            parenthesized: true,
            ...requiresType,
            kind: origins.length ? 'macro' : 'direct',
            line: calleeTok.line, col: calleeTok.col,
            cond: calleeTok.cond,
            via: origins.length ? origins.join(' > ') : undefined,
            macroChain: origins.slice(),
          });
          chainedArgs.set(close, calleeTok);
          i = close - 1;
          continue;
        }
        if (inner.length >= 2 && inner[0].v === '*') {
          const deref = stripOuterParens(inner.slice(1));
          const ref = dispatchReference(deref, deref.length - 1, ctx.macros);
          if (ref?.start === 0 && (ref.path.length || deref.length === 1)) {
            // 下标和复杂接收表达式本身也可能包含调用。
            scanCalls(deref, ctx, out, macroChain);
            recordDispatch(ref, tk, requiresType);
            chainedArgs.set(close, null);
            i = close - 1;
            continue;
          }
        }
      }
    }

    // 同一种路径表示覆盖 rows[i].sub.fn()、ops.slots[i]() 与纯数组调用。
    if (tokens[i + 1]?.v === '(' &&
        (tk.v === ']' || (tk.t === 'id' && ['.', '->'].includes(tokens[i - 1]?.v)))) {
      const ref = dispatchReference(tokens, i, ctx.macros);
      if (ref) recordDispatch(ref, tk);
      continue;
    }

    if (tk.t !== 'id') continue;
    if (KEYWORDS.has(tk.v) || tk.v === 'asm' || tk.v === '__asm' || tk.v === '__asm__') continue;

    // 宏调用：按当前行号查定义（修复同文件 #undef / 重定义宏错连）
    const m = ctx.macros.get(tk.v, tk.line);
    if (m && !macroChain.includes(tk.v)) {
      if (m.params === null) {
        // 对象宏也可能是函数别名：展开时必须带上调用括号和实参，
        // 否则只剩一个裸函数名，递归扫描无法识别调用。
        const call = tokens[i + 1]?.v === '(' ? collectArgs(tokens, i + 1) : null;
        const next = call?.[0] ? call[1] : i + 1;
        const expanded = expandSeq(tokens.slice(i, next).map((t) => ({ ...t, macroOrigins: t.macroOrigins || [] })), ctx.macros);
        scanCalls(expanded, ctx, out, [...macroChain, tk.v]);
        i = next - 1;
        continue;
      }
      if (tokens[i + 1] && tokens[i + 1].v === '(') {
        const [args, next] = collectArgs(tokens, i + 1);
        if (args) {
          let expanded = expandSeq(tokens.slice(i, next).map((t) => ({ ...t, macroOrigins: t.macroOrigins || [] })), ctx.macros);
          let endIdx = next;
          // 函数式宏返回函数名后外层紧跟 ()（如 ID(A)() 或 CAT(P, X)()）：拼入后续调用括号一起扫描。
          if (expanded.length && expanded[expanded.length - 1].t === 'id' && tokens[next]?.v === '(') {
            const [outerArgs, outerNext] = collectArgs(tokens, next);
            if (outerArgs) {
              expanded = [...expanded, ...tokens.slice(next, outerNext)];
              endIdx = outerNext;
            }
          }
          scanCalls(expanded, ctx, out, [...macroChain, tk.v]);
          i = endIdx - 1;
          continue;
        }
      }
    }

    // 普通调用
    if (tokens[i + 1] && tokens[i + 1].v === '(') {
      const prev = tokens[i - 1];
      if (prev && (prev.v === '.' || prev.v === '->')) continue;
      if (isLocalPrototype(tokens, i)) continue;
      const origins = tk.macroOrigins || macroChain;
      out.push({
        callee: tk.v,
        kind: origins.length ? 'macro' : 'direct',
        line: tk.line, col: tk.col,
        cond: tk.cond,
        via: origins.length ? origins.join(' > ') : undefined,
        macroChain: origins.slice(),
      });
    }
  }
  return out;
}
