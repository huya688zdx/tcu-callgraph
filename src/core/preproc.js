/**
 * 轻量预处理器
 * - 建立 #define 宏表（对象宏 / 函数式宏）
 * - 维护 #if / #ifdef / #elif / #else 嵌套栈，给每个 token 打上 condition 标签
 * - 不做真假求值：所有分支都保留，靠 condition 标签在界面上按配置过滤
 */

import { lex, collectArgs } from './lexer.js';

const DIRECTIVE = /^#\s*([A-Za-z_]+)\s*([\s\S]*)$/;

function parseDefineParams(text) {
  // text 形如 "(a, b) body..."
  const params = [];
  let depth = 0;
  let i = 0;
  let cur = '';
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '(') {
      depth++;
      if (depth === 1) continue;
    }
    if (c === ')') {
      depth--;
      if (depth === 0) break;
    }
    if (c === ',' && depth === 1) {
      params.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) params.push(cur.trim());
  return { params, rest: text.slice(i + 1) };
}

/**
 * 处理单个文件的 token 流
 * @param {Array} tokens
 * @param {Map} macros  全局宏表（跨文件共享）
 * @param {string} file
 */
export function preprocess(tokens, macros, file, { expand = false } = {}) {
  const out = [];
  let pending = [];
  // 遇到指令前展开，保证 #define / #undef 只作用于后面的代码。
  const flush = () => {
    for (const tk of expandSeq(pending, macros)) out.push(tk);
    pending = [];
  };
  const includes = [];
  const frames = []; // {expr}

  // 识别 include guard：#ifndef X 紧跟 #define X，不参与 condition 计算
  let guardName = null;
  const preprocs = tokens.filter((t) => t.t === 'preproc');
  if (preprocs.length >= 2) {
    const m1 = /^#\s*ifndef\s+([A-Za-z_]\w*)/.exec(preprocs[0].v);
    const m2 = /^#\s*define\s+([A-Za-z_]\w*)/.exec(preprocs[1].v);
    if (m1 && m2 && m1[1] === m2[1]) guardName = m1[1];
  }
  const currentCond = () => {
    const parts = frames.map((f) => f.expr).filter(Boolean);
    return parts.length ? parts.join(' && ') : undefined;
  };

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];

    if (tk.t !== 'preproc') {
      (expand ? pending : out).push({ ...tk, cond: currentCond() });
      continue;
    }

    if (expand) flush();

    const m = DIRECTIVE.exec(tk.v);
    if (!m) continue;
    const dir = m[1].toLowerCase();
    const rest = m[2].trim();

    if (dir === 'define') {
      const nm = /^([A-Za-z_]\w*)/.exec(rest);
      if (!nm) continue;
      const name = nm[1];
      const after = rest.slice(name.length);
      let params = null;
      let bodyText = after;
      if (after.startsWith('(')) {
        const p = parseDefineParams(after);
        params = p.params;
        bodyText = p.rest;
      }
      const body = lex(bodyText, file);
      macros.set(name, {
        name,
        params,
        body,
        file,
        line: tk.line,
        cond: currentCond(),
        raw: bodyText.trim(),
      });
      continue;
    }

    if (dir === 'undef') {
      const nm = /^([A-Za-z_]\w*)/.exec(rest);
      if (nm) macros.delete(nm[1]);
      continue;
    }

    if (dir === 'include') {
      const im = /^[<"]([^>"]+)[>"]/.exec(rest);
      if (im) includes.push({ file, target: im[1], line: tk.line });
      continue;
    }

    if (dir === 'ifdef' || dir === 'ifndef') {
      const nm = /^([A-Za-z_]\w*)/.exec(rest);
      const n = nm ? nm[1] : '?';
      if (guardName && n === guardName && frames.length === 0) {
        frames.push({ expr: null });
      } else {
        frames.push({ expr: dir === 'ifdef' ? n : `!${n}` });
      }
      continue;
    }
    if (dir === 'if') {
      frames.push({ expr: rest.replace(/\s+/g, ' ') });
      continue;
    }
    if (dir === 'elif') {
      if (frames.length) frames[frames.length - 1].expr = rest.replace(/\s+/g, ' ');
      continue;
    }
    if (dir === 'else') {
      if (frames.length) {
        const cur = frames[frames.length - 1].expr || '';
        frames[frames.length - 1].expr = cur.startsWith('!') ? cur.slice(1) : `!(${cur})`;
      }
      continue;
    }
    if (dir === 'endif') {
      frames.pop();
      continue;
    }
  }

  if (expand) flush();
  return { tokens: out, includes };
}

function stringifyTokens(tokens) {
  return tokens.map((t) => t.v).join(' ');
}

function substitute(m, args, siteTok) {
  const out = [];
  const body = m.body;
  for (let i = 0; i < body.length; i++) {
    const tk = body[i];

    if (tk.v === '#' && body[i + 1] && m.params.includes(body[i + 1].v)) {
      const ai = m.params.indexOf(body[i + 1].v);
      out.push({
        t: 'str',
        v: `"${stringifyTokens(args[ai] || [])}"`,
        line: siteTok.line,
        col: siteTok.col,
        cond: siteTok.cond,
      });
      i++;
      continue;
    }

    if (tk.v === '##' && out.length && body[i + 1]) {
      const right = body[i + 1];
      const left = out.pop();
      const rv = m.params.includes(right.v)
        ? (args[m.params.indexOf(right.v)] || []).map((t) => t.v).join('')
        : right.v;
      out.push({
        t: 'id',
        v: left.v + rv,
        line: siteTok.line,
        col: siteTok.col,
        cond: siteTok.cond,
      });
      i++;
      continue;
    }

    const pidx = m.params ? m.params.indexOf(tk.v) : -1;
    if (pidx >= 0) {
      const a = args[pidx] || [];
      for (const t of a) {
        out.push({ ...t, line: siteTok.line, col: siteTok.col, cond: siteTok.cond ?? t.cond });
      }
      continue;
    }
    out.push({ ...tk, line: siteTok.line, col: siteTok.col, cond: siteTok.cond ?? tk.cond });
  }
  return out;
}

/**
 * 递归展开 token 序列中的所有宏调用
 */
export function expandSeq(tokens, macros, depth = 0, seen = new Set()) {
  if (depth > 12) return tokens.slice();
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.t === 'id' && macros.has(tk.v) && !seen.has(tk.v)) {
      const m = macros.get(tk.v);

      if (m.params === null) {
        const body = m.body.map((b) => ({
          ...b,
          line: tk.line,
          col: tk.col,
          cond: tk.cond ?? b.cond,
        }));
        const nextSeen = new Set(seen);
        nextSeen.add(tk.v);
        out.push(...expandSeq(body, macros, depth + 1, nextSeen));
        continue;
      }

      if (tokens[i + 1] && tokens[i + 1].v === '(') {
        const [args, next] = collectArgs(tokens, i + 1);
        if (args) {
          const body = substitute(m, args, tk);
          const nextSeen = new Set(seen);
          nextSeen.add(tk.v);
          out.push(...expandSeq(body, macros, depth + 1, nextSeen));
          i = next - 1;
          continue;
        }
      }
    }
    out.push(tk);
  }
  return out;
}
