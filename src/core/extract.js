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
  '__attribute__', '__attribute', '__declspec', '__asm', '__asm__', 'asm', '_Pragma',
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
export function collectDispatchDeclarations(tokens, dispatchScopes, record) {
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
      if (isFunction || scope.trackObjects) record({ declaration: name, scope, fileScope, isFunction, typeToCheck, isExtern });
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

/** 只保留辨别标量括号所需的信息：指针、数组层数和记录成员。 */
function initializerDeclarations(statement) {
  const parts = splitAtTopLevel(statement);
  const first = parts[0] || [];
  const base = declarationType(first);
  const open = first.findIndex(t => t.v === '{');
  const fields = open >= 0 ? initializerMembers(first.slice(open + 1, matchBrace(first, open))) : null;
  const shapes = new Map();
  for (const part of parts) {
    const token = declarationName(part);
    if (!token) continue;
    const name = part.indexOf(token);
    let j = name + 1, rank = 0;
    while (part[j]?.v === '[') {
      let depth = 1;
      for (j++; j < part.length && depth; j++) {
        if (part[j].v === '[') depth++;
        if (part[j].v === ']') depth--;
      }
      rank++;
    }
    let before = name - 1;
    while (['const', 'volatile', 'restrict'].includes(part[before]?.v)) before--;
    shapes.set(token.v, { token, type: base, rank, pointer: part[before]?.v === '*', fields });
  }
  return shapes;
}

function initializerMembers(body) {
  const fields = new Map();
  for (const part of splitAtTopLevel(body, ';')) {
    for (const [name, shape] of initializerDeclarations(part)) fields.set(name, shape);
  }
  return fields;
}

/** 收集类型声明及作用域；成员声明帮助区分标量与只初始化了一项的数组。 */
export function findTypedefs(tokens) {
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
      record(token.v + ' ' + tokens[i + 1].v, token, { fields: initializerMembers(tokens.slice(i + 3, close)) });
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
    for (const [name, shape] of initializerDeclarations(tokens.slice(i + 1, end))) {
      record(name, shape.token, shape);
      if (shape.fields && shape.type && !aliases.get(shape.type)?.some(entry => entry.declaration === token)) {
        record(shape.type, token, { fields: shape.fields });
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

function scalarInitializerField(slot, shape, file, lookup) {
  let rank = 0;
  // 每个字段都先还原 typedef，保留别名自身声明的数组层数。
  const resolve = () => {
    const seen = new Set();
    while (shape && !seen.has(shape)) {
      seen.add(shape);
      rank += shape.rank || 0;
      if (shape.fields || shape.pointer) break;
      const found = shape.type && lookup(file, shape.type, shape.token);
      file = found?.file;
      shape = found?.shape;
    }
  };
  resolve();
  for (const [, name, indices] of slot.matchAll(/(?:^|\.)([A-Za-z_]\w*)((?:\[[^\]]*\])*)/g)) {
    shape = shape?.fields?.get(name);
    if (!shape) return false;
    rank = 0;
    resolve();
    if (rank !== (indices.match(/\[/g)?.length || 0)) return false;
  }
  return !!shape?.pointer;
}

/** 消耗一个标量或整个子数组后，进位到同一对花括号里的下一个子对象。 */
function nextInitIndices(indices, extents) {
  const next = indices.slice();
  while (next.length) {
    const depth = next.length - 1;
    const index = next[depth];
    if (depth && (typeof index !== 'number' || extents[depth] == null)) return null;
    if (!depth || index + 1 < extents[depth]) {
      next[depth] = typeof index === 'number' ? index + 1 : { ...index, offset: index.offset + 1 };
      break;
    }
    next.pop();
  }
  return next;
}

/** 递归提取结构体和数组中的函数指针槽位，省略花括号时按声明维度逐项填充。 */
function collectInitSlots(inner, prefix, extents, map, slotLines, macros, status, scalarBrace = false) {
  const items = splitAtTopLevel(inner);
  let cursor = [0];
  for (const item of items) {
    if (!item.length) continue;
    // 检测 C99 指定初始化器：[idx] = val 或 .field = val 或 [idx].field = val
    let k = 0;
    const designators = [];
    let hasEq = false;
    while (k < item.length) {
      if (item[k].v === '.' && item[k + 1]?.t === 'id') {
        designators.push({ kind: 'field', value: item[k + 1].v });
        k += 2;
      } else if (item[k].v === '[') {
        let depth = 1, m = k + 1;
        for (; m < item.length && depth > 0; m++) {
          if (item[m].v === '[') depth++;
          else if (item[m].v === ']') depth--;
        }
        const expr = item.slice(k + 1, m - 1);
        const idx = parseConstIndex(expr, macros);
        designators.push({ kind: 'index', value: idx ?? { expr: expr.map(t => t.v).join(''), offset: 0 } });
        k = m;
      } else {
        break;
      }
    }
    if (designators.length && item[k]?.v === '=') {
      hasEq = true;
      k++;
      if (designators.some(d => d.kind === 'index' && typeof d.value !== 'number')) status.incomplete = true;
    }
    const val = hasEq ? item.slice(k) : item;
    if (!val.length) continue;
    const braced = val[0].v === '{' && val.at(-1).v === '}';
    let indices = cursor?.slice();
    let fields = [];
    if (hasEq) {
      const field = designators.findIndex(d => d.kind === 'field');
      const count = field < 0 ? designators.length : field;
      indices = designators.slice(0, count).map(d => d.value);
      fields = designators.slice(count);
    } else if (scalarBrace && items.length === 1) {
      indices = [];
    }
    // 内层宽度未知时，无法判断上一标量是否填满该行，保留候选直到下一个显式指定位置。
    const unknownPosition = indices == null;
    if (unknownPosition) {
      status.incomplete = true;
      indices = [{ expr: `@${item[0].line}:${item[0].col}`, offset: 0 }];
    } else if (!braced && !fields.length) {
      while (indices.length < extents.length) indices.push(0);
    }
    let nextPrefix = prefix + indices.map(formatInitIndex).join('');
    for (const d of fields) {
      if (d.kind === 'index') nextPrefix += formatInitIndex(d.value);
      else nextPrefix += (nextPrefix ? '.' : '') + d.value;
    }
    if (braced) {
      const remaining = fields.length || unknownPosition ? [] : extents.slice(indices.length);
      const atElement = fields.length ? status.isScalarField(nextPrefix)
        : !remaining.length && (extents.length > 0 || scalarBrace);
      collectInitSlots(val.slice(1, -1), nextPrefix, remaining, map, slotLines, macros, status, atElement);
    } else {
      const operand = simpleInitializerOperand(val);
      // 重复指定一个槽位时，后面的初始化值覆盖先前的函数或未知值。
      status.unresolvedSlots.delete(nextPrefix);
      if (operand?.t === 'id' && !TYPE_WORDS.has(operand.v) && !KEYWORDS.has(operand.v) && !NON_FN_IDENTS.has(operand.v)) {
        map[nextPrefix] = operand.v;
        slotLines[nextPrefix] = operand.line;
      } else {
        delete map[nextPrefix];
        delete slotLines[nextPrefix];
        // 条件表达式和强转得到的非零地址可能指向别处；(Fn)0 等空值没有调用目标。
        if (!operand || (operand.t === 'num' && val.length > 1 && parseConstIndex([operand]) !== 0)) {
          status.unresolvedSlots.add(nextPrefix);
        }
      }
    }
    if (!unknownPosition) cursor = nextInitIndices(indices.length ? indices : cursor ?? [0], extents);
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
  let localTypes;
  const localLookup = (_, name, at) => {
    localTypes ??= findTypedefs(tokens);
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
    const inner = tokens.slice(i + 2, close);
    const rootShape = { type: declarationType(tokens.slice(beforeDeclaration + 1, p)), token: nameTok };
    if (!rootShape.type && tokens[beforeDeclaration]?.v === '}') {
      // struct { ... } ops = { ... } 将类型定义与变量声明写在同一处。
      let open = beforeDeclaration - 1, depth = 1;
      for (; open >= 0 && depth; open--) {
        if (tokens[open].v === '}') depth++;
        if (tokens[open].v === '{') depth--;
      }
      if (['struct', 'union'].includes(tokens[open]?.v) || ['struct', 'union'].includes(tokens[open - 1]?.v)) {
        rootShape.fields = initializerMembers(tokens.slice(open + 2, beforeDeclaration));
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
      ...(functionId && { functionId, declaration: nameTok, scope: scopes.at(-1) }),
    };
    const fill = lookup => {
      const status = {
        incomplete: false,
        unresolvedSlots: new Set(),
        isScalarField: slot => scalarInitializerField(slot, rootShape, file, lookup),
      };
      collectInitSlots(inner, '', extents, table.map, table.slotLines, macros, status);
      if (status.incomplete) table.incomplete = true;
      if (status.unresolvedSlots.size) table.unresolvedSlots = [...status.unresolvedSlots];
    };
    // 仅有指定项带花括号时才需要等待头文件关系，普通表仍当场完成。
    if (pendingFields && inner.some((t, j) => t.v === '=' && inner[j + 1]?.v === '{')) {
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
  return inner.length === 1 && inner[0].t === 'id' ? inner[0].v : expr.map(t => t.v).join('');
}

/** 从下标或成员左侧回溯提取接收表达式及各维下标。 */
function extractIndexedReceiver(tokens, endIdx, macros) {
  let j = endIdx;
  const indices = [];
  const indexExprs = [];
  while (j >= 0 && tokens[j].v === ']') {
    const open = matchOpenBack(tokens, j);
    if (open < 0) break;
    const exprToks = tokens.slice(open + 1, j);
    indices.unshift(parseConstIndex(exprToks, macros));
    indexExprs.unshift(exprToks.map((t) => t.v).join(''));
    j = open - 1;
  }
  return { recv: receiverBefore(tokens, j), indices, indexExprs };
}

/** 收集可能改写分派表的位置，等其他文件的定义和块作用域收齐后再绑定。 */
export function findDispatchWrites(body, macros) {
  const tokens = expandSeq(body, macros);
  const writes = [];
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i];
    if (name.t !== 'id' || KEYWORDS.has(name.v) || ['.', '->'].includes(tokens[i - 1]?.v)) continue;
    let start = i, end = i + 1, member = null;
    const indices = [];
    for (;;) {
      if (tokens[end]?.v === '[') {
        const first = ++end;
        let depth = 1;
        while (end < tokens.length && depth) {
          if (tokens[end].v === '[') depth++;
          if (tokens[end].v === ']') depth--;
          end++;
        }
        indices.push(parseConstIndex(tokens.slice(first, end - 1)));
      } else if (['.', '->'].includes(tokens[end]?.v) && tokens[end + 1]?.t === 'id') {
        member ??= tokens[end + 1].v;
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
      indices, member, escape: addressed ? 'address' : !assigned && decayed ? 'array' : null,
    });
  }
  return writes;
}

function formatIndexedVia(recv, indexExprs, member) {
  const base = recv || '?';
  const idxPart = (indexExprs || []).map((e) => `[${e || '*'}]`).join('');
  return member ? `${base}${idxPart}.${member}` : `${base}${idxPart}`;
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
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];

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
          const deref = inner.slice(1);
          if (deref.length === 1 && deref[0].t === 'id' && !KEYWORDS.has(deref[0].v)) {
            out.push({
              callee: null,
              receiver: deref[0].v,
              member: null,
              indices: [],
              indexExprs: [],
              kind: 'fnptr_ptr',
              ...requiresType,
              line: deref[0].line, col: deref[0].col,
              cond: deref[0].cond,
              via: `(*${deref[0].v})`,
              macroChain: (deref[0].macroOrigins || macroChain).slice(),
            });
            chainedArgs.set(close, null);
            i = close - 1;
            continue;
          }
          if (deref[deref.length - 1]?.v === ']') {
            const { recv, indices, indexExprs } = extractIndexedReceiver(deref, deref.length - 1, ctx.macros);
            if (recv && indices.length) {
              // 下标本身可能调用函数，跳过接收表达式前先扫描它。
              scanCalls(deref, ctx, out, macroChain);
              out.push({
                callee: null,
                receiver: recv,
                member: null,
                indices,
                indexExprs,
                kind: 'fnptr_indexed',
                ...requiresType,
                line: tk.line, col: tk.col,
                cond: tk.cond,
                via: formatIndexedVia(recv, indexExprs, null),
                macroChain: (tk.macroOrigins || macroChain).slice(),
              });
              chainedArgs.set(close, null);
              i = close - 1;
              continue;
            }
          }
        }
      }
    }

    // 下标间接调用：z[idx]() / e[r][c]()
    if (tk.v === ']' && tokens[i + 1]?.v === '(') {
      const { recv, indices, indexExprs } = extractIndexedReceiver(tokens, i, ctx.macros);
      if (recv && indices.length) {
        out.push({
          callee: null,
          receiver: recv,
          member: null,
          indices,
          indexExprs,
          kind: 'fnptr_indexed',
          line: tk.line, col: tk.col,
          cond: tk.cond,
          via: formatIndexedVia(recv, indexExprs, null),
          macroChain: (tk.macroOrigins || macroChain).slice(),
        });
        continue;
      }
    }

    // 成员调用 a->b(...) / a.b(...) / z[idx].fn(...) / e[r][c].fn(...)
    if (tk.v === '->' || tk.v === '.') {
      const member = tokens[i + 1];
      if (member && member.t === 'id' && tokens[i + 2] && tokens[i + 2].v === '(') {
        const { recv, indices, indexExprs } = extractIndexedReceiver(tokens, i - 1, ctx.macros);
        const table = recv ? ctx.fnptr?.get(recv) : null;
        const tableMap = table?.map || table;
        if (!indices.length && tableMap && Object.hasOwn(tableMap, member.v)) {
          out.push({
            callee: tableMap[member.v],
            kind: 'fnptr',
            line: member.line, col: member.col,
            cond: member.cond,
            via: `${recv}.${member.v}`,
            macroChain: (member.macroOrigins || macroChain).slice(),
          });
        } else {
          out.push({
            callee: null,
            receiver: recv,
            member: member.v,
            indices,
            indexExprs,
            kind: indices.length ? 'fnptr_indexed' : 'unknown',
            line: member.line, col: member.col,
            cond: member.cond,
            via: indices.length ? formatIndexedVia(recv, indexExprs, member.v) : (recv ? `${recv}.${member.v}` : member.v),
            macroChain: (member.macroOrigins || macroChain).slice(),
          });
        }
        i += 2;
        continue;
      }
    }

    if (tk.t !== 'id') continue;
    if (KEYWORDS.has(tk.v)) continue;

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
