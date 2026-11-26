/**
 * 轻量预处理器
 * - 建立 #define 宏表（对象宏 / 函数式宏）
 * - 维护 #if / #ifdef / #elif / #else 嵌套栈，给每个 token 打上 condition 标签
 * - 保留各分支并标注 condition；明确恒假分支不修改宏表
 */

import { lex, collectArgs } from './lexer.js';

const DIRECTIVE = /^#\s*([A-Za-z_]+)\s*([\s\S]*)$/;

/** 文件只保存自己修改的宏，null 表示屏蔽继承来的定义。 */
export function fileMacroScope(base, changes = new Map(), { trackPositions = false } = {}) {
  const history = trackPositions ? new Map() : null;
  const update = (name, value, line) => {
    changes.set(name, value);
    if (!history) return;
    if (!history.has(name)) history.set(name, []);
    history.get(name).push({ value, line });
  };
  return {
    changes,
    get(name, line) {
      if (history && line !== undefined) {
        const entry = history.get(name)?.findLast(change => change.line < line);
        return entry ? entry.value : base.get(name);
      }
      return changes.has(name) ? changes.get(name) : base.get(name);
    },
    isUnknown(name, line) {
      if (history && line !== undefined) {
        const entry = history.get(name)?.findLast(change => change.line < line);
        return entry ? entry.value === undefined : !!base.isUnknown?.(name);
      }
      return changes.has(name) ? changes.get(name) === undefined : !!base.isUnknown?.(name);
    },
    set(name, def, line = def.line) { update(name, def, line); },
    delete(name, line) { update(name, null, line); },
    forget(name, line) { update(name, undefined, line); },
  };
}

function parseDefineParams(text) {
  // text 形如 "(a, b) body..." 或 "(fmt, ...) body..." 或 "(args...) body..."
  const params = [];
  let variadic = false;
  let variadicName = '__VA_ARGS__';
  let depth = 0;
  let i = 0;
  let cur = '';
  const pushParam = (raw) => {
    const p = raw.trim();
    if (!p) return;
    if (p === '...') {
      variadic = true;
      variadicName = '__VA_ARGS__';
    } else if (p.endsWith('...')) {
      variadic = true;
      variadicName = p.slice(0, -3).trim() || '__VA_ARGS__';
    } else {
      params.push(p);
    }
  };
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
      pushParam(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  pushParam(cur);
  return { params, variadic, variadicName, rest: text.slice(i + 1) };
}

export function parseMacroDefinition(text, file, line, cond) {
  const name = /^([A-Za-z_]\w*)/.exec(text)?.[1];
  if (!name) return null;
  const after = text.slice(name.length);
  const { params = null, variadic, variadicName, rest } = after.startsWith('(')
    ? parseDefineParams(after) : { rest: after };
  return {
    name, params, ...(variadic ? { variadic: true, variadicName } : {}),
    body: lex(rest, file), file, line, cond, raw: rest.trim(),
  };
}

/** 仅用于构建配置裁剪模式的轻量 C 预处理器常量表达式求值（支持 defined、!、&&、||、==、!=、<、<=、>、>=、位/算术运算）。 */
function evalPreprocExpr(exprText, macros, line, keepUnknown = false) {
  const tokens = lex(exprText);
  const input = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = { ...tokens[i], line };
    if (token.v === 'defined') {
      // defined 检查操作数的宏名，先于普通替换处理。
      const grouped = tokens[i + 1]?.v === '(';
      const name = tokens[i + (grouped ? 2 : 1)];
      if (name?.t !== 'id' || (grouped && tokens[i + 3]?.v !== ')')) return undefined;
      const def = macros.get(name.v, line);
      if (def === undefined && (keepUnknown || macros.isUnknown?.(name.v, line))) return undefined;
      input.push({ ...token, t: 'num', v: def ? '1' : '0' });
      i += grouped ? 3 : 1;
    } else {
      input.push(token);
    }
  }
  const expanded = expandSeq(input, macros);
  if (expanded.some((token, i) => token.t === 'id' &&
      (macros.isUnknown?.(token.v, line) || (keepUnknown && macros.get(token.v, line) === undefined)) &&
      !(/^(?:u8|[LuU])$/.test(token.v) && expanded[i + 1]?.v.startsWith("'")))) return undefined;
  const toks = expanded.map(token => token.v);
  if (!toks.length) return undefined;
  // C 预处理表达式按 intmax_t/uintmax_t 求值，避免 JS 的 32 位截断。
  const integer = (v, unsigned = false) => ({ v: unsigned ? BigInt.asUintN(64, v) : BigInt.asIntN(64, v), unsigned });
  const truth = x => x.v !== 0n;
  const bool = x => integer(x ? 1n : 0n);
  const precedence = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
    '<': 7, '<=': 7, '>': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
  let pos = 0;
  const primary = () => {
    let tk = toks[pos++];
    if (/^(?:u8|[LuU])$/.test(tk) && toks[pos]?.startsWith("'")) tk += toks[pos++];
    if (tk === '(') { const v = expression(); if (toks[pos++] !== ')') throw Error(); return v; }
    if (['!', '~', '+', '-'].includes(tk)) {
      const x = primary();
      if (tk === '!') return bool(!truth(x));
      return integer(tk === '~' ? ~x.v : tk === '-' ? -x.v : x.v, x.unsigned);
    }
    if (/^(?:u8|[LuU])?'/.test(tk)) {
      const body = tk.slice(tk.indexOf("'") + 1, -1);
      const chars = body.match(/\\(?:x[0-9a-fA-F]+|[0-7]{1,3}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)|[^\\]/gu) || [];
      let value = 0n;
      const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
      for (const char of chars) {
        const escaped = char.slice(1);
        const code = !char.startsWith('\\') ? char.codePointAt(0)
          : /^[xXuU]/.test(escaped) ? parseInt(escaped.slice(1), 16)
          : /^[0-7]/.test(escaped) ? parseInt(escaped, 8)
          : escapes[escaped] ?? escaped.codePointAt(0);
        value = (value << 8n) | BigInt(code);
      }
      return integer(value);
    }
    if (/^[A-Za-z_]/.test(tk)) return integer(0n);
    const raw = tk.replace(/[uUlL]+$/, '');
    const value = BigInt(/^0[0-7]+$/.test(raw) ? '0o' + raw.slice(1) : raw);
    return integer(value, /u/i.test(tk) || value > 0x7fffffffffffffffn);
  };
  const binary = (op, left, right) => {
    if (op === '&&') return bool(truth(left) && truth(right));
    if (op === '||') return bool(truth(left) || truth(right));
    if (op === '<<' || op === '>>') {
      if (right.v < 0n || right.v >= 64n) return integer(0n);
      return integer(op === '<<' ? left.v << right.v : left.v >> right.v, left.unsigned);
    }
    const unsigned = left.unsigned || right.unsigned;
    const a = integer(left.v, unsigned).v, b = integer(right.v, unsigned).v;
    switch (op) {
      case '==': return bool(a === b); case '!=': return bool(a !== b);
      case '<': return bool(a < b); case '<=': return bool(a <= b);
      case '>': return bool(a > b); case '>=': return bool(a >= b);
      case '+': return integer(a + b, unsigned); case '-': return integer(a - b, unsigned);
      case '*': return integer(a * b, unsigned); case '/': return integer(b ? a / b : 0n, unsigned);
      case '%': return integer(b ? a % b : 0n, unsigned); case '&': return integer(a & b, unsigned);
      case '|': return integer(a | b, unsigned); case '^': return integer(a ^ b, unsigned);
    }
  };
  const expression = (minimum = 0) => {
    let value = primary();
    while ((precedence[toks[pos]] || 0) > minimum) {
      const op = toks[pos++];
      value = binary(op, value, expression(precedence[op]));
    }
    if (minimum === 0 && toks[pos] === '?') {
      pos++;
      const yes = expression();
      if (toks[pos++] !== ':') throw Error();
      const no = expression();
      value = integer((truth(value) ? yes : no).v, yes.unsigned || no.unsigned);
    }
    return value;
  };
  try {
    const value = expression();
    return pos === toks.length ? Number(truth(value)) : undefined;
  } catch { return undefined; }
}

/**
 * 处理单个文件的 token 流
 * @param {Array} tokens
 * @param {Map} macros  全局宏表（跨文件共享）
 * @param {string} file
 */
export function preprocess(tokens, macros, file, {
  expand = false, pruneInactive = false, onInclude, onPragmaOnce, hasUnresolvedIncludes, onUnresolvedInclude,
} = {}) {
  const out = [];
  let pending = [];
  // 遇到指令前展开，保证 #define / #undef 只作用于后面的代码。
  const flush = () => {
    for (const tk of expandSeq(pending, macros)) out.push(tk);
    pending = [];
  };
  const includes = [];
  const frames = []; // {expr, inactive, definitelyTaken}

  // 识别 include guard：#ifndef X 紧跟 #define X，不参与 condition 计算
  let guardName = null;
  const preprocs = [];
  for (const tk of tokens) {
    if (tk.t === 'preproc') preprocs.push(tk);
    if (preprocs.length === 2) break;
  }
  if (preprocs.length >= 2) {
    const m1 = /^#\s*ifndef\s+([A-Za-z_]\w*)/.exec(preprocs[0].v);
    const m2 = /^#\s*define\s+([A-Za-z_]\w*)/.exec(preprocs[1].v);
    if (m1 && m2 && m1[1] === m2[1]) guardName = m1[1];
  }
  const currentCond = () => {
    const parts = frames.map((f) => f.expr).filter(Boolean);
    return parts.length ? parts.join(' && ') : undefined;
  };
  const isInactive = () => frames.some((f) => f.inactive);
  const isUncertain = () => frames.some((f) => f.uncertain);
  const forget = (name, line) => (macros.forget || macros.delete).call(macros, name, line);
  let cond;

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];

    if (tk.t !== 'preproc') {
      if (pruneInactive && isInactive()) continue;
      (expand ? pending : out).push(cond ? { ...tk, cond } : tk);
      continue;
    }

    if (expand) flush();

    const m = DIRECTIVE.exec(tk.v);
    if (!m) continue;
    const dir = m[1].toLowerCase();
    const rest = m[2].trim();

    if ((dir === 'define' || dir === 'undef') && isInactive()) continue;

    if (dir === 'define') {
      const def = parseMacroDefinition(rest, file, tk.line, currentCond());
      if (def) {
        if (isUncertain()) forget(def.name, tk.line);
        else macros.set(def.name, def);
      }
      continue;
    }

    if (dir === 'undef') {
      const nm = /^([A-Za-z_]\w*)/.exec(rest);
      if (nm) {
        if (isUncertain()) forget(nm[1], tk.line);
        else macros.delete(nm[1], tk.line);
      }
      continue;
    }

    if (dir === 'include' || (onInclude && dir === 'include_next')) {
      if (isInactive()) continue;
      const operand = onInclude && !/^[<"]/.test(rest)
        ? expandSeq(lex(rest, file).map(t => ({ ...t, line: tk.line })), macros).map(t => t.v).join('')
        : rest;
      const im = /^[<"]([^>"]+)[>"]/.exec(operand);
      if (im) {
        const entry = { file, target: im[1], line: tk.line };
        if (onInclude) entry.resolved = onInclude(entry, operand.startsWith('"'), dir === 'include_next', isUncertain()) ?? null;
        includes.push(entry);
      } else onUnresolvedInclude?.();
      continue;
    }

    if (dir === 'pragma' && rest === 'once' && !isInactive() && !isUncertain()) {
      onPragmaOnce?.();
      continue;
    }

    if (dir === 'ifdef' || dir === 'ifndef') {
      const nm = /^([A-Za-z_]\w*)/.exec(rest);
      const n = nm ? nm[1] : '?';
      const parentInactive = isInactive();
      if (guardName && tk === preprocs[0] && frames.length === 0) {
        const taken = !parentInactive && (!pruneInactive || !macros.get(n));
        frames.push({ expr: null, inactive: !taken, definitelyTaken: taken });
      } else if (pruneInactive) {
        const definition = nm ? macros.get(n, tk.line) : null;
        const uncertain = definition === undefined && (hasUnresolvedIncludes?.() || macros.isUnknown?.(n, tk.line));
        const defined = Boolean(definition);
        const taken = dir === 'ifdef' ? defined : !defined;
        frames.push({
          expr: dir === 'ifdef' ? n : `!${n}`,
          inactive: parentInactive || (!uncertain && !taken),
          definitelyTaken: !parentInactive && !uncertain && taken,
          uncertain,
        });
      } else {
        frames.push({ expr: dir === 'ifdef' ? n : `!${n}` });
      }
      cond = currentCond();
      continue;
    }
    if (dir === 'if') {
      const parentInactive = isInactive();
      if (pruneInactive) {
        const decision = parentInactive ? 0 : evalPreprocExpr(rest, macros, tk.line, hasUnresolvedIncludes?.());
        frames.push({
          expr: rest.replace(/\s+/g, ' '),
          inactive: decision === 0,
          definitelyTaken: decision !== undefined && decision !== 0,
          uncertain: decision === undefined,
        });
      } else {
        frames.push({ expr: rest.replace(/\s+/g, ' '), inactive: rest === '0', definitelyTaken: rest === '1' });
      }
      cond = currentCond();
      continue;
    }
    if (dir === 'elif') {
      if (frames.length) {
        const frame = frames[frames.length - 1];
        const parentInactive = frames.slice(0, -1).some((f) => f.inactive);
        frame.expr = rest.replace(/\s+/g, ' ');
        if (pruneInactive) {
          if (parentInactive || frame.definitelyTaken) {
            frame.inactive = true;
          } else {
            const decision = evalPreprocExpr(rest, macros, tk.line, hasUnresolvedIncludes?.());
            frame.inactive = decision === 0;
            frame.definitelyTaken = decision !== undefined && decision !== 0;
            frame.uncertain ||= decision === undefined;
          }
        } else {
          frame.inactive = frame.definitelyTaken || rest === '0';
          frame.definitelyTaken ||= rest === '1';
        }
        cond = currentCond();
      }
      continue;
    }
    if (dir === 'else') {
      if (frames.length) {
        const frame = frames[frames.length - 1];
        const parentInactive = frames.slice(0, -1).some((f) => f.inactive);
        const cur = frame.expr || '';
        frame.expr = cur.startsWith('!') ? cur.slice(1) : `!(${cur})`;
        frame.inactive = parentInactive || !!frame.definitelyTaken;
        cond = currentCond();
      }
      continue;
    }
    if (dir === 'endif') {
      frames.pop();
      cond = currentCond();
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
  const macroOrigins = [...(siteTok.macroOrigins || []), m.name];
  const vaTokens = () => {
    const rest = args.slice(m.params ? m.params.length : 0);
    const joined = [];
    for (let r = 0; r < rest.length; r++) {
      if (r > 0) joined.push({ t: 'op', v: ',', line: siteTok.line, col: siteTok.col, cond: siteTok.cond });
      for (const tok of rest[r]) joined.push(tok);
    }
    return joined;
  };
  const isVa = (name) => Boolean(m.variadic && name === (m.variadicName || '__VA_ARGS__'));
  let operandStart = 0;
  for (let i = 0; i < body.length; i++) {
    const tk = body[i];

    if (tk.v === '##' && body[i + 1]) {
      const right = body[i + 1];
      const variadic = isVa(right.v);
      const param = m.params.indexOf(right.v);
      let rightTokens = [right];
      if (variadic) rightTokens = vaTokens();
      else if (param >= 0) rightTokens = args[param] || [];
      let tail = 0;
      if (variadic && body[i - 1]?.v === ',') {
        // GNU 扩展仅对宏体中的字面逗号生效，显式传入空实参时保留逗号。
        if (args.length <= m.params.length) out.pop();
      } else if (rightTokens.length) {
        // 空左实参不产生 token，不能取走宏体中更早的标点。
        const left = out.length > operandStart ? out.pop() : null;
        const first = rightTokens[0];
        const value = (left?.v || '') + first.v;
        out.push({
          t: left ? (lex(value)[0]?.t || left.t) : first.t,
          v: value, line: siteTok.line, col: siteTok.col, cond: siteTok.cond, macroOrigins,
        });
        tail = 1;
      }
      for (let j = tail; j < rightTokens.length; j++) {
        const t = rightTokens[j];
        out.push({ ...t, line: siteTok.line, col: siteTok.col,
          cond: siteTok.cond ?? t.cond, macroOrigins: t.macroOrigins || [] });
      }
      i++;
      continue;
    }
    operandStart = out.length;
    if (tk.v === '#' && body[i + 1] && (m.params.includes(body[i + 1].v) || isVa(body[i + 1].v))) {
      const targetName = body[i + 1].v;
      const argToks = isVa(targetName) ? vaTokens() : (args[m.params.indexOf(targetName)] || []);
      out.push({
        t: 'str',
        v: `"${stringifyTokens(argToks)}"`,
        line: siteTok.line,
        col: siteTok.col,
        cond: siteTok.cond,
        macroOrigins,
      });
      i++;
      continue;
    }

    if (isVa(tk.v)) {
      for (const t of vaTokens()) {
        out.push({
          ...t,
          line: siteTok.line,
          col: siteTok.col,
          cond: siteTok.cond ?? t.cond,
          macroOrigins: [...macroOrigins, ...(t.macroOrigins || [])],
        });
      }
      continue;
    }

    const pidx = m.params ? m.params.indexOf(tk.v) : -1;
    if (pidx >= 0) {
      const a = args[pidx] || [];
      for (let j = 0; j < a.length; j++) {
        const t = a[j];
        const isCallee = body[i + 1]?.v === '(' && j === a.length - 1 && t.t === 'id' &&
          (a.length === 1 || ['.', '->'].includes(a[j - 1]?.v));
        out.push({ ...t, line: siteTok.line, col: siteTok.col, cond: siteTok.cond ?? t.cond,
          macroOrigins: isCallee ? [...macroOrigins, ...(t.macroOrigins || [])] : t.macroOrigins || [] });
      }
      continue;
    }
    out.push({ ...tk, line: siteTok.line, col: siteTok.col, cond: siteTok.cond ?? tk.cond, macroOrigins });
  }
  return out;
}

/**
 * 递归展开 token 序列中的所有宏调用
 * onExpand 接收实际展开的定义和本次调用的首尾 token，供调用方映射源码。
 */
export function expandSeq(tokens, macros, depth = 0, seen = new Set(), onExpand) {
  if (depth > 12) return tokens.slice();
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const m = tk.t === 'id' ? macros.get(tk.v, tk.line) : undefined;
    if (!m || seen.has(tk.v) || (m.params !== null && tokens[i + 1]?.v !== '(')) {
      out.push(tk);
      continue;
    }
    let body;
    if (m.params === null) {
      onExpand?.(m, tk, tk);
      body = m.body.map(b => ({
        ...b, line: tk.line, col: tk.col, cond: tk.cond ?? b.cond,
        macroOrigins: [...(tk.macroOrigins || []), m.name],
      }));
    } else {
      const [args, next] = collectArgs(tokens, i + 1);
      onExpand?.(m, tk, tokens[next - 1]);
      body = substitute(m, args, tk);
      i = next - 1;
    }
    const nextSeen = new Set(seen).add(tk.v);
    let expanded = expandSeq(body, macros, depth + 1, nextSeen, onExpand);
    // 替换结果末尾的函数式宏可以使用原序列中紧跟的实参，例如 MAKE -> MATRIX。
    while (tokens[i + 1]?.v === '(') {
      const tail = expanded.at(-1);
      const fn = tail?.t === 'id' && macros.get(tail.v, tail.line);
      if (!fn?.params || nextSeen.has(tail.v) || tail.macroOrigins?.includes(tail.v)) break;
      const [args, next] = collectArgs(tokens, i + 1);
      onExpand?.(fn, tail, tokens[next - 1]);
      out.push(...expanded.slice(0, -1));
      nextSeen.add(tail.v);
      expanded = expandSeq(substitute(fn, args, tail), macros, depth + 1, nextSeen, onExpand);
      i = next - 1;
    }
    out.push(...expanded);
  }
  return out;
}
