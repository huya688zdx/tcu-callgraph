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

/** 取一段 token 里最后一个非类型标识符 */
function lastIdent(tokens) {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.t === 'id' && !TYPE_WORDS.has(t.v)) return t.v;
  }
  return null;
}

/**
 * 识别函数指针初始化表
 * 形如： const ShiftOps g_ops = { .shift_up = Gear_ShiftUp, .apply = (cast)Gear_Apply };
 */
export function findFnPtrTables(tokens) {
  const tables = new Map();
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].v !== '=') continue;
    if (!tokens[i + 1] || tokens[i + 1].v !== '{') continue;
    const nameTok = tokens[i - 1];
    if (!nameTok || nameTok.t !== 'id') continue;

    const close = matchBrace(tokens, i + 1);
    const inner = tokens.slice(i + 2, close);
    const map = {};
    let k = 0;
    while (k < inner.length) {
      // 跳过到下一个赋值或逗号
      let field = null;
      if (inner[k].v === '.') {
        field = inner[k + 1]?.v ?? null;
        k += 2;
      }
      if (field && inner[k]?.v === '=') {
        k++;
        // 收集到顶层逗号
        let depth = 0;
        const val = [];
        for (; k < inner.length; k++) {
          const v = inner[k].v;
          if (v === '(' || v === '{' || v === '[') depth++;
          if (v === ')' || v === '}' || v === ']') depth--;
          if (v === ',' && depth === 0) break;
          val.push(inner[k]);
        }
        const fn = lastIdent(val);
        if (fn) map[field] = fn;
        k++;
        continue;
      }
      k++;
    }
    if (Object.keys(map).length) tables.set(nameTok.v, map);
  }
  return tables;
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

    // 成员调用 a->b(...) / a.b(...)，含 &a 形式
    if (tk.v === '->' || tk.v === '.') {
      const member = tokens[i + 1];
      if (member && member.t === 'id' && tokens[i + 2] && tokens[i + 2].v === '(') {
        let j = i - 1;
        while (j >= 0 && tokens[j].t !== 'id') j--;
        const recv = j >= 0 ? tokens[j].v : null;
        const table = recv ? ctx.fnptr.get(recv) : null;
        if (table && table[member.v]) {
          out.push({
            callee: table[member.v],
            kind: 'fnptr',
            line: member.line,
            cond: member.cond,
            via: `${recv}.${member.v}`,
            macroChain: (member.macroOrigins || macroChain).slice(),
          });
        } else {
          out.push({
            callee: null,
            member: member.v,
            kind: 'unknown',
            line: member.line,
            cond: member.cond,
            via: recv ? `${recv}.${member.v}` : member.v,
            macroChain: (member.macroOrigins || macroChain).slice(),
          });
        }
        i += 2;
        continue;
      }
    }

    if (tk.t !== 'id') continue;
    if (KEYWORDS.has(tk.v)) continue;

    // 宏调用：展开后继续扫
    if (ctx.macros.has(tk.v) && !macroChain.includes(tk.v)) {
      const m = ctx.macros.get(tk.v);
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
          const expanded = expandSeq(tokens.slice(i, next).map((t) => ({ ...t, macroOrigins: t.macroOrigins || [] })), ctx.macros);
          scanCalls(expanded, ctx, out, [...macroChain, tk.v]);
          i = next - 1;
          continue;
        }
      }
    }

    // 普通调用
    if (tokens[i + 1] && tokens[i + 1].v === '(') {
      const prev = tokens[i - 1];
      if (prev && (prev.v === '.' || prev.v === '->')) continue;
      const origins = tk.macroOrigins || macroChain;
      out.push({
        callee: tk.v,
        kind: origins.length ? 'macro' : 'direct',
        line: tk.line,
        cond: tk.cond,
        via: origins.length ? origins.join(' > ') : undefined,
        macroChain: origins.slice(),
      });
    }
  }
  return out;
}
