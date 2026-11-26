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

/** 从 closeIdx 处的 ')' 反向找到匹配的 '(' */
function matchParenBack(tokens, closeIdx) {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    if (tokens[i].v === ')') depth++;
    else if (tokens[i].v === '(') {
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
  const open = matchParenBack(tokens, idx);
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
  const open = matchParenBack(tokens, end);
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
  const ids = toks.filter((t) => t.t === 'id' && !TYPE_WORDS.has(t.v));
  if (!ids.length) {
    names.push('_');
    return;
  }
  const name = ids[ids.length - 1].v;
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

/** 取一段简单初始化值里的目标函数标识符（跳过纯算术表达式与常见常量） */
function extractTargetIdent(tokens) {
  if (!tokens.length) return null;
  for (const t of tokens) {
    if (['+', '-', '*', '/', '%', '|', '^', '<<', '>>', '==', '!=', '<', '>', '<=', '>=', '&&', '||', '?'].includes(t.v)) {
      // 允许类型强转里的 *，如 (void (*)(void))fn；跳过明显算术/逻辑运算
      if (t.v !== '*') return null;
    }
  }
  const last = tokens[tokens.length - 1];
  if (last && last.t === 'id' && !TYPE_WORDS.has(last.v) && !KEYWORDS.has(last.v) && !NON_FN_IDENTS.has(last.v)) {
    return { name: last.v, line: last.line };
  }
  return null;
}

/** 切分顶层逗号分隔项 */
function splitTopCommas(tokens) {
  const items = [];
  let cur = [];
  let depth = 0;
  for (const tk of tokens) {
    if (tk.v === '(' || tk.v === '{' || tk.v === '[') depth++;
    else if (tk.v === ')' || tk.v === '}' || tk.v === ']') depth--;
    if (tk.v === ',' && depth === 0) {
      if (cur.length) items.push(cur);
      cur = [];
      continue;
    }
    cur.push(tk);
  }
  if (cur.length) items.push(cur);
  return items;
}

/** 解析常量整数索引（如 0, 1, 0x02），非常量返回 null */
function parseConstIndex(tokens) {
  if (!tokens.length) return null;
  const s = tokens.map((t) => t.v).join('').replace(/[uUlL]+$/, '');
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) return Number.parseInt(s, 16);
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  return null;
}

/** 递归提取结构体 / 1D / 2D 数组初始化列表里的函数指针槽位 */
function collectInitSlots(inner, prefix, isRootStruct, map, slotLines) {
  const items = splitTopCommas(inner);
  let pos = 0;
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
        const idx = parseConstIndex(item.slice(k + 1, m - 1));
        designators.push({ kind: 'index', value: idx ?? pos });
        if (idx !== null && designators.length === 1) pos = idx;
        k = m;
      } else {
        break;
      }
    }
    if (designators.length && item[k]?.v === '=') {
      hasEq = true;
      k++;
    }
    const val = hasEq ? item.slice(k) : item;
    if (!val.length) { pos++; continue; }

    let nextPrefix = prefix;
    if (hasEq) {
      for (const d of designators) {
        if (d.kind === 'index') nextPrefix += `[${d.value}]`;
        else nextPrefix += (isRootStruct && !nextPrefix ? d.value : `.${d.value}`);
      }
    } else {
      nextPrefix += `[${pos}]`;
    }

    if (val[0].v === '{' && val[val.length - 1].v === '}') {
      collectInitSlots(val.slice(1, -1), nextPrefix, false, map, slotLines);
    } else {
      const target = extractTargetIdent(val);
      if (target) {
        map[nextPrefix] = target.name;
        slotLines[nextPrefix] = target.line;
      }
    }
    pos++;
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
export function findFnPtrTables(tokens, file = '') {
  const tables = new Map();
  let braceDepth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.v === '{') { braceDepth++; continue; }
    if (tk.v === '}') { braceDepth = Math.max(0, braceDepth - 1); continue; }
    if (braceDepth !== 0 || tk.v !== '=') continue;
    if (!tokens[i + 1] || tokens[i + 1].v !== '{') continue;

    // 向前解析声明名与数组维度，兼容：
    //   name = { ... }
    //   name[N] = { ... } / name[R][C] = { ... }
    //   void (*const name[N])(void) = { ... }
    let p = i - 1;
    let dims = 0;
    let nameTok = null;
    if (p >= 0 && tokens[p].v === ')') {
      // 函数指针数组声明器：跳过形参列表 (...) 再进左侧 (*name[...])
      let d = 1;
      p--;
      while (p >= 0 && d > 0) {
        if (tokens[p].v === ')') d++;
        else if (tokens[p].v === '(') d--;
        p--;
      }
      if (p >= 0 && tokens[p].v === ')') {
        let end = p - 1;
        while (end >= 0 && tokens[end].v === ']') {
          let bd = 1;
          end--;
          while (end >= 0 && bd > 0) {
            if (tokens[end].v === ']') bd++;
            else if (tokens[end].v === '[') bd--;
            end--;
          }
          dims++;
        }
        if (end >= 0 && tokens[end].t === 'id' && !TYPE_WORDS.has(tokens[end].v)) {
          nameTok = tokens[end];
        }
      }
    } else {
      while (p >= 0 && tokens[p].v === ']') {
        let bd = 1;
        p--;
        while (p >= 0 && bd > 0) {
          if (tokens[p].v === ']') bd++;
          else if (tokens[p].v === '[') bd--;
          p--;
        }
        dims++;
      }
      if (p >= 0 && tokens[p].t === 'id' && !TYPE_WORDS.has(tokens[p].v)) {
        nameTok = tokens[p];
      }
    }
    if (!nameTok) continue;

    // 检查声明语句里的 static / const 修饰符
    let isStatic = false;
    let isConst = false;
    for (let s = p; s >= 0 && ![';', '{', '}'].includes(tokens[s].v); s--) {
      if (tokens[s].v === 'static' || tokens[s].v === 'STATIC') isStatic = true;
      if (tokens[s].v === 'const' || tokens[s].v === 'CONST') isConst = true;
    }

    const close = matchBrace(tokens, i + 1);
    const inner = tokens.slice(i + 2, close);
    const map = {};
    const slotLines = {};
    collectInitSlots(inner, '', dims === 0, map, slotLines);
    if (Object.keys(map).length) {
      tables.set(nameTok.v, {
        name: nameTok.v,
        file,
        line: nameTok.line,
        isStatic,
        isConst,
        dims,
        map,
        slotLines,
      });
    }
    i = close;
  }
  return tables;
}

/** 从下标或成员左侧回溯提取真实表名及各维下标，避免把 z[idx].fn() 误认成 idx.fn() */
function extractIndexedReceiver(tokens, endIdx) {
  let j = endIdx;
  const indices = [];
  const indexExprs = [];
  while (j >= 0 && tokens[j].v === ']') {
    let depth = 1;
    let k = j - 1;
    for (; k >= 0 && depth > 0; k--) {
      if (tokens[k].v === ']') depth++;
      else if (tokens[k].v === '[') depth--;
    }
    if (depth !== 0) break;
    const exprToks = tokens.slice(k + 2, j);
    indices.unshift(parseConstIndex(exprToks));
    indexExprs.unshift(exprToks.map((t) => t.v).join(''));
    j = k;
  }
  while (j >= 0 && (tokens[j].v === ')' || tokens[j].v === '*')) j--;
  const recv = j >= 0 && tokens[j].t === 'id' && !KEYWORDS.has(tokens[j].v) ? tokens[j].v : null;
  return { recv, indices, indexExprs };
}

function formatIndexedVia(recv, indexExprs, member) {
  const base = recv || '?';
  const idxPart = (indexExprs || []).map((e) => `[${e || '*'}]`).join('');
  return member ? `${base}${idxPart}.${member}` : `${base}${idxPart}`;
}

/** 粗略判断是否为块内局部函数原型声明，如 `void proto(void);` / `extern int foo(int x);` */
function isLocalPrototype(tokens, idIdx) {
  const prev = tokens[idIdx - 1];
  if (!prev || !(TYPE_WORDS.has(prev.v) || prev.v === '*' || prev.v === 'extern')) return false;
  const [args, next] = collectArgs(tokens, idIdx + 1);
  if (!args || tokens[next]?.v !== ';') return false;
  // 排除 return foo(); 等关键字引导的调用
  if (KEYWORDS.has(prev.v) && !TYPE_WORDS.has(prev.v) && prev.v !== 'extern') return false;
  // 检查参数列表是否为空/void/以类型名开头
  if (args.length === 1 && args[0].length === 1 && args[0][0].v === 'void') return true;
  if (args.every((arg) => !arg.length || arg.some((t) => TYPE_WORDS.has(t.v) || t.v === '*'))) {
    // 若声明首 token 为类型/存储类，基本可确认为局部原型
    let s = idIdx - 1;
    while (s > 0 && ![';', '{', '}'].includes(tokens[s - 1].v)) s--;
    if (TYPE_WORDS.has(tokens[s].v) || tokens[s].v === 'extern') return true;
  }
  return false;
}

/**
 * 扫描一段 token 中的调用
 * @param {Array} tokens
 * @param {object} ctx { macros, fnptr }
 * @param {Array} out 输出
 * @param {Array<string>} macroChain 宏展开链
 */
export function scanCalls(tokens, ctx, out, macroChain = []) {
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];

    // 跳过不求值表达式 sizeof(...)，防止把 sizeof(v()) 误计为真实调用
    if (tk.t === 'id' && tk.v === 'sizeof' && tokens[i + 1]?.v === '(') {
      const [, next] = collectArgs(tokens, i + 1);
      if (next > i + 1) {
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
        const inner = tokens.slice(i + 1, close - 1);
        if (inner.length === 1 && inner[0].t === 'id' && !KEYWORDS.has(inner[0].v)) {
          const calleeTok = inner[0];
          const origins = calleeTok.macroOrigins || macroChain;
          out.push({
            callee: calleeTok.v,
            kind: origins.length ? 'macro' : 'direct',
            line: calleeTok.line, col: calleeTok.col,
            cond: calleeTok.cond,
            via: origins.length ? origins.join(' > ') : undefined,
            macroChain: origins.slice(),
          });
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
              line: deref[0].line, col: deref[0].col,
              cond: deref[0].cond,
              via: `(*${deref[0].v})`,
              macroChain: (deref[0].macroOrigins || macroChain).slice(),
            });
            i = close - 1;
            continue;
          }
          if (deref[deref.length - 1]?.v === ']') {
            const { recv, indices, indexExprs } = extractIndexedReceiver(deref, deref.length - 1);
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
              i = close - 1;
              continue;
            }
          }
        }
      }
    }

    // 下标间接调用：z[idx]() / e[r][c]()
    if (tk.v === ']' && tokens[i + 1]?.v === '(') {
      const { recv, indices, indexExprs } = extractIndexedReceiver(tokens, i);
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
        const { recv, indices, indexExprs } = extractIndexedReceiver(tokens, i - 1);
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
