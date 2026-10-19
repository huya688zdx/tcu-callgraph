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

/**
 * 识别函数定义
 * @returns {Array<{name,line,endLine,params,isStatic,cond,bodyStart,bodyEnd}>}
 */
export function findFunctions(tokens, file) {
  const fns = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].v !== '{') continue;
    const prev = tokens[i - 1];
    if (!prev || prev.v !== ')') continue;

    const open = matchParenBack(tokens, i - 1);
    if (open < 1) continue;

    const nameTok = tokens[open - 1];
    if (!nameTok || nameTok.t !== 'id') continue;
    if (CONTROL.has(nameTok.v)) continue;

    // 函数名前面必须像类型（id / * / 类型关键字），排除 a = foo() { 这类
    let j = open - 2;
    while (j >= 0 && (tokens[j].v === '*' || tokens[j].v === 'const')) j--;
    const typeTok = tokens[j];
    if (!typeTok || (typeTok.t !== 'id' && typeTok.v !== ']')) continue;
    if (typeTok.v === '=' || typeTok.v === ',' || typeTok.v === '(') continue;

    // 参数
    const params = [];
    const inner = tokens.slice(open + 1, i - 1);
    if (!(inner.length === 1 && inner[0].v === 'void') && inner.length) {
      let cur = [];
      let depth = 0;
      for (const t of inner) {
        if (t.v === '(' || t.v === '[') depth++;
        if (t.v === ')' || t.v === ']') depth--;
        if (t.v === ',' && depth === 0) {
          params.push(cur);
          cur = [];
          continue;
        }
        cur.push(t);
      }
      if (cur.length) params.push(cur);
    }

    const close = matchBrace(tokens, i);

    // static 判定：向前找最近的 ; { } 之间是否有 static
    let isStatic = false;
    for (let k = open - 2; k >= 0 && k > open - 12; k--) {
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
      params: params.map((p) => {
        const ids = p.filter((t) => t.t === 'id' && !TYPE_WORDS.has(t.v));
        return ids.length ? ids[ids.length - 1].v : '_';
      }),
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
            macroChain: macroChain.slice(),
          });
        } else {
          out.push({
            callee: null,
            member: member.v,
            kind: 'unknown',
            line: member.line,
            cond: member.cond,
            via: recv ? `${recv}.${member.v}` : member.v,
            macroChain: macroChain.slice(),
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
        const expanded = expandSeq([tk], ctx.macros);
        scanCalls(expanded, ctx, out, [...macroChain, tk.v]);
        continue;
      }
      if (tokens[i + 1] && tokens[i + 1].v === '(') {
        const [args, next] = collectArgs(tokens, i + 1);
        if (args) {
          const expanded = expandSeq(tokens.slice(i, next), ctx.macros);
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
      out.push({
        callee: tk.v,
        kind: macroChain.length ? 'macro' : 'direct',
        line: tk.line,
        cond: tk.cond,
        via: macroChain.length ? macroChain.join(' > ') : undefined,
        macroChain: macroChain.slice(),
      });
    }
  }
  return out;
}
