/**
 * C 词法分析器
 * 单遍扫描，保留行号/列号/字节偏移，丢弃注释但保留位置连续性。
 * 预处理指令整行识别为 preproc token（支持 \ 续行）。
 */

const OPS3 = new Set(['<<=', '>>=']);
const OPS2 = new Set([
  '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##',
]);

const isIdStart = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
const isIdChar = (c) => isIdStart(c) || (c >= '0' && c <= '9');
const isDigit = (c) => c >= '0' && c <= '9';

/**
 * @param {string} src
 * @param {string} file
 * @returns {Array<{t:string,v:string,s:number,e:number,line:number,col:number,cond?:string}>}
 */
export function lex(src, file = '') {
  const tokens = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let col = 1;
  let atLineStart = true;

  while (i < n) {
    const c = src[i];

    if (c === '\n') {
      line++;
      col = 1;
      i++;
      atLineStart = true;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      i++;
      col++;
      continue;
    }

    // 预处理指令：允许行首缩进
    if (c === '#' && atLineStart) {
      const s = i;
      const ln = line;
      const cl = col;
      let buf = '';
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') {
          if (src[i + 1] === '\n') {
            buf += ' ';
            i += 2;
            line++;
            col = 1;
            continue;
          }
          if (src[i + 1] === '\r' && src[i + 2] === '\n') {
            buf += ' ';
            i += 3;
            line++;
            col = 1;
            continue;
          }
        }
        if (ch === '\n') break;
        buf += ch;
        i++;
        col++;
      }
      tokens.push({ t: 'preproc', v: buf, s, e: i, line: ln, col: cl });
      atLineStart = false;
      continue;
    }

    atLineStart = false;

    // 注释
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      col += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') {
          line++;
          col = 1;
        } else {
          col++;
        }
        i++;
      }
      i += 2;
      col += 2;
      continue;
    }

    // 字符串 / 字符常量
    if (c === '"' || c === "'") {
      const q = c;
      const s = i;
      const ln = line;
      const cl = col;
      i++;
      col++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          col += 2;
          continue;
        }
        if (src[i] === q) {
          i++;
          col++;
          break;
        }
        if (src[i] === '\n') break;
        i++;
        col++;
      }
      tokens.push({ t: 'str', v: src.slice(s, i), s, e: i, line: ln, col: cl });
      continue;
    }

    // 标识符 / 关键字
    if (isIdStart(c)) {
      const s = i;
      const ln = line;
      const cl = col;
      while (i < n && isIdChar(src[i])) {
        i++;
        col++;
      }
      tokens.push({ t: 'id', v: src.slice(s, i), s, e: i, line: ln, col: cl });
      continue;
    }

    // 数字
    if (isDigit(c)) {
      const s = i;
      const ln = line;
      const cl = col;
      while (i < n && (isIdChar(src[i]) || src[i] === '.')) {
        i++;
        col++;
      }
      tokens.push({ t: 'num', v: src.slice(s, i), s, e: i, line: ln, col: cl });
      continue;
    }

    // 运算符
    const three = src.slice(i, i + 3);
    if (OPS3.has(three)) {
      tokens.push({ t: 'punct', v: three, s: i, e: i + 3, line, col });
      i += 3;
      col += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.has(two)) {
      tokens.push({ t: 'punct', v: two, s: i, e: i + 2, line, col });
      i += 2;
      col += 2;
      continue;
    }
    tokens.push({ t: 'punct', v: c, s: i, e: i + 1, line, col });
    i++;
    col++;
  }

  return tokens;
}

/** 在 tokens 中从 openIdx（必须是 '('）开始配对括号，返回 [参数token数组的数组, 右括号后一位] */
export function collectArgs(tokens, openIdx) {
  if (!tokens[openIdx] || tokens[openIdx].v !== '(') return [null, openIdx];
  const args = [];
  let cur = [];
  let depth = 0;
  let i = openIdx;
  for (; i < tokens.length; i++) {
    const v = tokens[i].v;
    if (v === '(' || v === '[' || v === '{') {
      depth++;
      if (depth === 1) continue;
    } else if (v === ')' || v === ']' || v === '}') {
      depth--;
      if (depth === 0) break;
    } else if (v === ',' && depth === 1) {
      args.push(cur);
      cur = [];
      continue;
    }
    cur.push(tokens[i]);
  }
  if (cur.length || args.length) args.push(cur);
  return [args, i + 1];
}
