import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ELK from 'elkjs/lib/elk.bundled.js';
import { collectFunctions, declaratorName, getParser } from './cparse.js';
import { findFunctions } from './extract.js';
import { collectArgs, lex } from './lexer.js';
import { expandSeq, fileMacroScope, preprocess } from './preproc.js';
import { decodeSource, HDR_EXT } from './source-files.js';
import { fingerprint } from './source-fingerprint.js';
import { taskDeclarations } from './task-declarations.js';

const elk = new ELK();
const field = (node, name) => node?.childForFieldName(name);
const compact = text => text.replace(/("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|\s+/g,
  (_, literal) => literal ?? ' ').trim();
const point = ({ x, y }) => [x, y];
const directive = token => /^#\s*(\w+)\s*([\s\S]*)/.exec(token.v);
const isDecision = kind => kind === 'decision' || kind === 'preproc_decision';
const isTerminal = kind => kind === 'start' || kind === 'end';
const headerIndexes = new WeakMap();
const sourceEntries = new WeakMap();
const callTargetHashes = new WeakMap();

export const isFlowchartFunction = fn => !!fn?.endLine && !fn.external && fn.kind !== 'var' && !fn.headerSymbol;

function flowchartHeaders(model, fn) {
  const includes = model.includes;
  const includeCount = includes?.length ?? 0;
  let index = headerIndexes.get(model);
  if (index?.files !== model.files || index.includes !== includes ||
      index.fileCount !== model.files.length || index.includeCount !== includeCount) {
    const headers = model.files.filter(file => file.isHeader || HDR_EXT.test(file.rel)).map(file => file.rel);
    const direct = new Map();
    if (includeCount) {
      const paths = new Set(model.files.map(file => file.rel));
      const suffixes = new Map();
      for (const rel of headers) {
        for (let i = rel.indexOf('/'); i !== -1; i = rel.indexOf('/', i + 1)) {
          const suffix = rel.slice(i + 1);
          suffixes.set(suffix, suffixes.has(suffix) ? null : rel);
        }
      }
      for (const { file, target } of includes) {
        const normalized = path.posix.normalize(target.replace(/\\/g, '/'));
        const relative = path.posix.join(path.posix.dirname(file), normalized);
        // Clang 已给出项目相对路径。内置解析器保留 include 指令中的原始路径。
        const resolved = model.parserId === 'clang-ast' && paths.has(normalized) ? normalized
          : paths.has(relative) ? relative : paths.has(normalized) ? normalized : suffixes.get(normalized);
        if (!resolved) continue;
        if (!direct.has(file)) direct.set(file, []);
        direct.get(file).push(resolved);
      }
    }
    index = { files: model.files, fileCount: model.files.length, includes, includeCount, headers, direct, bySource: new Map() };
    headerIndexes.set(model, index);
  }
  if (!index.bySource.has(fn.file)) {
    const reachable = new Set([fn.file]);
    for (const file of reachable) {
      for (const target of index.direct.get(file) || []) reachable.add(target);
    }
    index.bySource.set(fn.file, index.headers.filter(file => file !== fn.file && (!includeCount || reachable.has(file))));
  }
  return index.bySource.get(fn.file);
}

function sourceReader(model, sourceRoot, fileStats) {
  let entries = sourceEntries.get(model);
  if (!entries) sourceEntries.set(model, entries = new Map());
  const directories = new Map();
  let roots;
  const withinRoots = realFile => {
    roots ??= [model.root, ...(sourceRoot ? [sourceRoot] : [])].map(root => fs.realpathSync(root));
    return roots.some(root => {
      const rel = path.relative(root, realFile);
      return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
    });
  };
  const remember = (file, bytes, origin) => {
    const source = decodeSource(bytes).replace(/\r\n?/g, '\n');
    const entry = { ...origin, source, hash: createHash('sha256').update(source).digest('hex') };
    entries.set(file, entry);
    return entry;
  };
  return file => {
    const cached = entries.get(file);
    const buffered = model._sourceBuffers?.get(file);
    if (buffered) return cached?.buffered === buffered ? cached : remember(file, buffered, { buffered });

    const override = model._sourceFiles?.get(file);
    let location = cached?.location;
    if (!location || location.root !== model.root || location.override !== override) {
      const filename = override ?? path.join(model.root, file);
      location = { root: model.root, override, filename, directory: path.dirname(filename) };
    }
    const { filename, directory } = location;
    const invalidPath = '源码文件必须位于当前工程或对照目录内';
    let stat = fileStats?.get(filename);
    if (!stat) {
      stat = fs.lstatSync(filename, { bigint: true });
      fileStats?.set(filename, stat);
    }
    let realFile;
    if (stat.isSymbolicLink()) {
      realFile = fs.realpathSync(filename);
      if (!withinRoots(realFile)) throw new Error(invalidPath);
      stat = fs.statSync(realFile, { bigint: true });
    } else {
      // 同一次查找按目录检查真实路径，常规文件只需要一次元数据查询。
      let realDirectory = directories.get(directory);
      if (!realDirectory) {
        realDirectory = fs.realpathSync(directory);
        if (!withinRoots(realDirectory)) throw new Error(invalidPath);
        directories.set(directory, realDirectory);
      }
      realFile = directory === realDirectory ? filename : path.join(realDirectory, path.basename(filename));
    }
    if (!stat.isFile()) throw new Error(invalidPath);

    // ctime 可识别保留原 mtime 的等长改写。
    const previous = cached?.stat;
    if (cached?.location === location && cached.realFile === realFile && previous.dev === stat.dev && previous.ino === stat.ino &&
        previous.size === stat.size && previous.mtimeNs === stat.mtimeNs && previous.ctimeNs === stat.ctimeNs &&
        previous.birthtimeNs === stat.birthtimeNs) return cached;
    return remember(file, fs.readFileSync(realFile), { location, realFile, stat });
  };
}

function literalTruth(expression) {
  const tokens = lex(expression);
  let start = 0, end = tokens.length - 1;
  while (tokens[start]?.v === '(' && tokens[end]?.v === ')') {
    start++;
    end--;
  }
  if (start !== end) return undefined;
  const value = tokens[start]?.v;
  if (value === 'false') return false;
  if (value === 'true') return true;
  if (/^(?:0[xX][\da-fA-F]+|0[bB][01]+|0[0-7]*|[1-9]\d*)[uUlL]*$/.test(value)) {
    return /[1-9a-f]/i.test(value.replace(/^0[xb]/i, ''));
  }
  return undefined;
}

function collectMacros(tokens, scope, file) {
  preprocess(tokens.map(token => {
    if (token.t !== 'preproc') return token;
    const [, name, expr] = directive(token) || [];
    if (!['if', 'elif'].includes(name)) return token;
    const truth = literalTruth(expr);
    return truth === undefined ? token : { ...token, v: `#${name} ${Number(truth)}` };
  }), scope, file);
}

function locateBody(parser, source, tokens, fn, scope) {
  const range = tokens.filter(t => t.line >= fn.line && t.line <= fn.endLine);
  if (!range.length) return null;
  const offset = range[0].s;
  const excerpt = source.slice(offset, range.at(-1).e);
  const task = taskDeclarations(excerpt, lex(excerpt));
  const tree = parser.parse(task.source);
  try {
    const definition = tree.rootNode.namedChildren.find(n => n.type === 'function_definition' &&
      declaratorName(field(n, 'declarator')) === fn.name);
    const body = field(definition, 'body');
    if (body && !task.names.size && body.lastChild?.type === '}' && !body.lastChild.isMissing) {
      const open = offset + body.startIndex;
      const close = offset + body.lastChild.startIndex;
      const closeToken = range.find(t => t.s === close);
      if (closeToken?.line === fn.endLine) return { open, close, signature: source.slice(offset + definition.startIndex, open) };
    }
  } finally {
    tree.delete();
  }

  // TASK/ISR、AUTOSAR FUNC 和编译器属性可能让原始函数头无法直接通过 C 语法解析。
  // 从索引行范围内定位函数体，后续只用标准 C 声明包装真实函数体。
  for (let i = 0; i < range.length; i++) {
    if (range[i].v !== '{') continue;
    const header = range.slice(0, i);
    const signature = source.slice(offset, range[i].s);
    const expanded = expandSeq(header, scope);
    const hasName = expanded.some((t, j) => t.v === fn.name && expanded[j + 1]?.v === '(') ||
      taskDeclarations(signature + '{', lex(signature + '{')).names.has(fn.name) ||
      header.some((t, j) => t.v === fn.name && header[j + 1]?.v === '(');
    if (!hasName) continue;
    const [_, next] = collectArgs(range, i);
    const balanced = range[next - 1];
    const close = balanced?.v === '}' && balanced.line === fn.endLine
      ? balanced : range.findLast(t => t.v === '}' && t.line === fn.endLine);
    if (close) return { open: range[i].s, close: close.s, signature };
  }
  return null;
}

function splitDirectives(tokens) {
  const root = [];
  const stack = [];
  let items = root;
  for (const token of tokens) {
    const [, name, expr] = token.t === 'preproc' ? directive(token) || [] : [];
    if (['if', 'ifdef', 'ifndef'].includes(name)) {
      const branches = [];
      items.push({ branches });
      stack.push({ items, branches });
    } else if (name === 'endif' && stack.length) {
      items = stack.pop().items;
      continue;
    } else if (!['elif', 'elifdef', 'elifndef', 'else'].includes(name) || !stack.length) {
      items.push(token);
      continue;
    }
    items = [];
    stack.at(-1).branches.push({ token, name, expr, items });
  }
  return root;
}

function effectiveBranches(branches) {
  const result = [];
  for (const branch of branches) {
    const truth = branch.name === 'else' ? true
      : ['if', 'elif'].includes(branch.name) ? literalTruth(branch.expr) : undefined;
    if (truth === false) continue;
    result.push({ ...branch, unconditional: truth === true });
    if (truth === true) break;
  }
  return result;
}

function mergeMacroScopes(scope, alternatives) {
  for (const name of new Set(alternatives.flatMap(alt => [...alt.keys()]))) {
    const defs = alternatives.map(alt => alt.get(name));
    const first = defs[0];
    // 各编译分支定义不一致时，保留汇流之后的宏名，避免把某个分支的值写进共用代码。
    scope.set(name, defs.every(def => def === first ||
      (def && first && def.raw === first.raw && JSON.stringify(def.params) === JSON.stringify(first.params))) ? first : null);
  }
}

function expectsStatement(tokens) {
  const last = tokens.at(-1)?.v;
  if (last === 'else' || last === 'do') return true;
  if (last !== ')') return false;
  let depth = 1;
  for (let i = tokens.length - 2; i > 0; i--) {
    if (tokens[i].v === ')') depth++;
    if (tokens[i].v === '(' && --depth === 0) {
      return ['if', 'while', 'for', 'switch'].includes(tokens[i - 1].v);
    }
  }
  return false;
}

function prepareBody(source, tokens, initial, file, expandMacros) {
  const used = new Set();
  const locations = [];
  let input = 'void flowchart(void) ';
  const wrapped = new Set();
  const emit = (value, first, last = first, macros) => {
    locations.push({ start: input.length, end: input.length + value.length, first, last, macros });
    input += value;
  };
  const key = t => `${t.line}:${t.col}`;

  function emitCode(pending, scope) {
    if (!pending.length) return;
    const original = new Map(pending.map(t => [key(t), t]));
    const usages = new Map();
    const expanded = expandSeq(pending, scope, 0, new Set(), (def, site, last) => {
      const first = original.get(key(site));
      const end = original.get(key(last));
      if (!first) return;
      if (!usages.has(first)) usages.set(first, { last: first, defs: new Set() });
      const usage = usages.get(first);
      usage.defs.add(def);
      if (end?.s > usage.last.s) usage.last = end;
      used.add(def);
    });
    const stream = expandMacros ? expanded : pending;
    let previous;
    for (const token of stream) {
      const first = original.get(key(token));
      if (!first) continue;
      const usage = usages.get(first);
      if (previous) {
        const prev = previous.token;
        if (token === first && prev === previous.first) {
          input += source.slice(prev.e, first.s);
        } else {
          const adjacentInMacro = previous.first === first && prev.e === token.s &&
            prev.macroOrigins?.join(' ') === token.macroOrigins?.join(' ');
          const onlyDelimiter = [')', ']', ';', ',', '->', '.'].includes(token.v) ||
            ['(', '[', '->', '.'].includes(prev.v) ||
            (token.v === '(' && (prev.v === ')' || (prev.t === 'id' && !['if', 'while', 'switch', 'return'].includes(prev.v))));
          if (!adjacentInMacro && !onlyDelimiter) input += ' ';
        }
      }
      emit(token.v, first, usage?.last ?? first, usage?.defs);
      previous = { token, first };
    }
    input += '\n';
  }

  function visit(items, scope) {
    let pending = [];
    for (const item of items) {
      if (item.t && item.t !== 'preproc') {
        pending.push(item);
        continue;
      }
      const needsBody = expectsStatement(pending);
      emitCode(pending, scope);
      pending = [];
      if (item.t) {
        preprocess([item], scope, file);
        continue;
      }
      const branches = effectiveBranches(item.branches);
      if (!branches.length) continue;
      if (branches[0].unconditional) {
        visit(branches[0].items, scope);
        continue;
      }
      if (needsBody) {
        if (!branches.at(-1).unconditional) throw new Error('条件编译跨越运行期语句体，缺少完整的编译分支');
        wrapped.add(input.length);
        input += '{\n';
      }
      const alternatives = branches.map((branch, i) => {
        const { token, name, expr, unconditional } = branch;
        const type = !i ? ({ elif: 'if', elifdef: 'ifdef', elifndef: 'ifndef' }[name] ?? name)
          : unconditional ? 'else' : name;
        const defs = new Set();
        if (!unconditional) for (const t of lex(expr)) {
          const def = scope.get(t.v);
          if (t.t === 'id' && def) {
            defs.add(def);
            used.add(def);
          }
        }
        if (i && ['elifdef', 'elifndef'].includes(type)) {
          emit(`#elif ${type === 'elifndef' ? '!' : ''}defined(${expr})`, token, token, defs);
        } else {
          emit(`#${type}${unconditional ? '' : ' ' + expr}`, token, token, defs);
        }
        input += '\n';
        const branchScope = new Map(scope);
        visit(branch.items, branchScope);
        return branchScope;
      });
      input += '#endif\n';
      if (needsBody) input += '}\n';
      if (!branches.at(-1).unconditional) alternatives.push(scope);
      mergeMacroScopes(scope, alternatives);
    }
    emitCode(pending, scope);
  }

  // 展开前后的 token 都指向原始调用点。宏内生成的多条语句共享该调用点。
  visit(splitDirectives(tokens), initial);
  function originalOf(node, lastNode = node) {
    let low = 0, high = locations.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (locations[mid].end <= node.startIndex) low = mid + 1;
      else high = mid;
    }
    const first = locations[low]?.first;
    let last = first;
    const defs = new Set();
    for (let i = low; i < locations.length && locations[i].start < lastNode.endIndex; i++) {
      const entry = locations[i];
      if (entry.last.e > last.e) last = entry.last;
      for (const def of entry.macros || []) defs.add(def);
    }
    if (!first) return { defs };
    return { line: first.line, endLine: last.line + source.slice(last.s, last.e).split('\n').length - 1,
      first, last, code: source.slice(first.s, last.e), defs };
  }
  return { input, used, originalOf, wrapped };
}

function buildGraph(body, fn, model, signature, originalOf) {
  const nodes = [], edges = [], gotos = [];
  const labels = new Map();
  const callsByLine = new Map();
  for (const call of model._index.outAdj.get(fn.id) || []) {
    if (call.kind === 'var') continue;
    if (!callsByLine.has(call.line)) callsByLine.set(call.line, []);
    callsByLine.get(call.line).push(call);
  }

  function calleesOf(ast, location) {
    const callees = new Map();
    const add = id => {
      const target = model._index.byId.get(id);
      if (isFlowchartFunction(target)) callees.set(id, { id, name: target.name });
    };
    const stack = [ast];
    while (stack.length) {
      const current = stack.pop();
      if (current.type === 'call_expression') {
        const callee = field(current, 'function');
        const name = callee?.type === 'identifier' ? callee.text : null;
        const member = field(callee, 'field')?.text;
        const expression = callee?.text.replace(/\s+/g, '');
        const { first, last, line, endLine, defs } = originalOf(current);
        let resolved = false;
        for (let row = line; row <= endLine; row++) {
          for (const call of callsByLine.get(row) || []) {
            const sameSite = !call.col || ((row !== line || call.col >= first.col) &&
              (row !== endLine || call.col < last.col + last.v.length));
            const targetExpression = call.via?.split('（', 1)[0].replace(/\s+/g, '');
            const matchesPointer = call.kind === 'fnptr' && targetExpression &&
              (targetExpression === expression || (member && !targetExpression.includes('[') &&
                targetExpression.endsWith('.' + member)));
            const matchesMacro = [...defs].some(def => def.name === name &&
              (call.macroChain?.includes(name) || (call.kind === 'macro' && call.via === name)));
            if (sameSite && (call.callee === name || matchesPointer || matchesMacro)) {
              add(call.to);
              resolved = true;
            }
          }
        }
        if (!resolved && name && ![...defs].some(def => def.name === name)) {
          const candidates = (model._index.byName.get(name) || []).filter(target => !target.isStatic || target.file === fn.file);
          const local = candidates.find(target => target.file === fn.file);
          if (local || candidates.length === 1) add((local ?? candidates[0]).id);
        }
      }
      stack.push(...current.namedChildren.toReversed());
    }
    // 当语句仍显示调用宏名时，调用图可提供它封装的真实目标。
    if (!callees.size && location.defs.size) {
      for (let row = location.line; row <= location.endLine; row++) {
        for (const call of callsByLine.get(row) || []) {
          if (call.col === location.first.col && [...location.defs].some(def => call.macroChain?.includes(def.name))) add(call.to);
        }
      }
    }
    return [...callees.values()];
  }

  function node(kind, text, ast, end = ast, callAst) {
    const loc = ast ? originalOf(ast, end) : { line: fn.line, endLine: fn.line, code: signature.trim(), defs: new Set() };
    const callees = callAst ? calleesOf(callAst, loc) : [];
    const item = { id: 'n' + nodes.length, kind: kind === 'process' && callees.length ? 'call' : kind, text,
      line: loc.line, endLine: loc.endLine, code: loc.code,
      macros: [...loc.defs].map(({ name, raw, params }) => ({ name, raw, params })), callees };
    nodes.push(item);
    return item.id;
  }

  const showGuards = guards => guards.map(({ condition, branch }) => condition + ' ' + branch).join(' && ');
  const exit = (from, branch, label = branch) => ({ from, ...(branch ? { branch, label } : {}) });
  function connect(incoming, to) {
    for (const edge of incoming) edges.push({ ...edge, to });
  }

  function sequence(statements, incoming, context) {
    for (const statement of statements) incoming = visit(statement, incoming, context);
    return incoming;
  }

  function conditional(ast, incoming, context, preproc) {
    const condition = field(ast, 'condition') ?? field(ast, 'name');
    const alternative = field(ast, 'alternative');
    const head = preproc ? ast.firstChild : ast;
    const text = preproc ? compact(originalOf(head).first?.v ?? head.text) : 'if ' + compact(condition?.text ?? '()');
    const id = node(preproc ? 'preproc_decision' : 'decision', text, head, preproc ? head : condition ?? head);
    connect(incoming, id);
    const on = [exit(id, 'ON')], off = [exit(id, 'OFF')];
    const guarded = branch => preproc && context.dispatch ? { ...context,
      guards: [...context.guards, { condition: text, branch }] } : context;
    const yes = preproc
      ? sequence(ast.namedChildren.filter(child => child.id !== condition?.id && child.id !== alternative?.id), on, guarded('ON'))
      : visit(field(ast, 'consequence'), on, context);
    return [...yes, ...visit(alternative, off, guarded('OFF'))];
  }

  function loop(ast, incoming, context) {
    const type = ast.type;
    const condition = field(ast, 'condition'), body = field(ast, 'body');
    const bodyFirst = type === 'do_statement';
    const breaks = [];
    const truth = condition ? literalTruth(condition.text) : true;
    if (bodyFirst && truth === false) {
      const next = visit(body, incoming, { ...context, breaks, continues: breaks });
      return [...next, ...breaks];
    }
    const initializer = field(ast, 'initializer'), update = field(ast, 'update');
    if (initializer) incoming = visit(initializer, incoming, context);
    const keyword = type === 'for_statement' ? 'for' : bodyFirst ? 'do while' : 'while';
    const expression = compact(condition?.text ?? '');
    const text = type === 'for_statement' ? `for (; ${expression}; )` : keyword + ' ' + expression;
    const head = bodyFirst ? ast.children.find(child => child.type === 'while') : ast;
    const end = type === 'for_statement' ? ast.children.findLast(child => child.type === ')') : condition;
    const id = node(condition ? 'decision' : 'process', text, head, end ?? ast.firstChild);
    const continues = [];
    const firstEdge = edges.length;
    const entryMarker = Symbol();
    const bodyEntry = bodyFirst ? [exit(entryMarker)] : truth === false ? [] : [exit(id, condition ? 'ON' : undefined)];
    const bodyExits = visit(body, bodyEntry,
      { ...context, breaks, continues });
    let repeat = [...bodyExits, ...continues];
    if (update) repeat = visit(update, repeat, context);
    connect(repeat, id);
    if (bodyFirst) {
      // 标记体的词法入口，即使 do-while 前没有顺序边（例如 goto 跳到体内）。
      const marker = edges.findIndex((edge, i) => i >= firstEdge && edge.from === entryMarker);
      const entry = marker < 0 ? id : edges.splice(marker, 1)[0].to;
      connect([...incoming, exit(id, 'ON')], entry);
    } else connect(incoming, id);
    return [...(truth !== true ? [exit(id, 'OFF')] : []), ...breaks];
  }

  function visit(ast, incoming, context) {
    if (!ast || ast.isMissing) return incoming;
    switch (ast.type) {
      case 'comment':
      case 'preproc_def':
      case 'preproc_function_def':
      case 'preproc_call':
        return incoming;
      case 'compound_statement':
      case 'else_clause':
      case 'preproc_else':
        return sequence(ast.namedChildren, incoming, context);
      case 'if_statement':
        return conditional(ast, incoming, context, false);
      case 'preproc_if':
      case 'preproc_ifdef':
      case 'preproc_elif':
        return conditional(ast, incoming, context, true);
      case 'while_statement':
      case 'for_statement':
      case 'do_statement':
        return loop(ast, incoming, context);
      case 'switch_statement': {
        const condition = field(ast, 'condition');
        const id = node('switch', 'switch ' + compact(condition?.text ?? '()'), ast, condition ?? ast);
        const dispatch = { id, defaults: [] };
        const breaks = [];
        connect(incoming, id);
        const next = visit(field(ast, 'body'), [], { ...context, dispatch, breaks, guards: [] });
        if (dispatch.defaults.some(guards => !guards.length)) return [...next, ...breaks];
        const excluded = dispatch.defaults.map(showGuards);
        const unmatched = exit(id, 'CASE', excluded.length ? 'default（仅当 ' + excluded.join(' 或 ') + ' 均不成立）' : 'default');
        if (excluded.length) unmatched.unless = dispatch.defaults;
        return [...next, ...breaks, unmatched];
      }
      case 'case_statement': {
        const value = field(ast, 'value');
        const caption = value ? 'case ' + compact(value.text) : 'default';
        const id = node('process', caption + ':', ast, ast.children.find(child => child.type === ':') ?? value ?? ast);
        const dispatch = context.dispatch;
        if (dispatch) {
          const { guards } = context;
          if (!value) dispatch.defaults.push(guards);
          const edge = exit(dispatch.id, 'CASE', guards.length ? caption + '（' + showGuards(guards) + '）' : caption);
          if (guards.length) edge.guards = guards;
          connect([edge], id);
        }
        connect(incoming, id);
        return sequence(ast.namedChildren.filter(child => child.id !== value?.id), [exit(id)], context);
      }
      case 'labeled_statement': {
        const label = field(ast, 'label');
        const id = node('process', (label?.text ?? '') + ':', ast, ast.children.find(child => child.type === ':') ?? label ?? ast);
        if (label) labels.set(label.text, id);
        connect(incoming, id);
        return sequence(ast.namedChildren.filter(child => child.id !== label?.id), [exit(id)], context);
      }
      default: {
        const text = compact(ast.text);
        if (text === ';') return incoming;
        const jump = { break_statement: context.breaks, continue_statement: context.continues }[ast.type];
        const id = node(ast.type === 'return_statement' ? 'return' : 'process', text, ast, ast, ast);
        connect(incoming, id);
        if (jump) jump.push(exit(id));
        if (ast.type === 'goto_statement') gotos.push({ id, name: field(ast, 'label')?.text });
        if (['break_statement', 'continue_statement', 'goto_statement', 'return_statement'].includes(ast.type)) return [];
        return [exit(id)];
      }
    }
  }

  const start = node('start', 'START\n' + compact(signature));
  const incoming = visit(body, [exit(start)], {});
  if (incoming.length) connect(incoming, node('end', 'END', body.lastChild));
  for (const jump of gotos) {
    const target = labels.get(jump.name);
    if (target) connect([exit(jump.id)], target);
  }

  // 先解析所有标签和跳转，再从 START 移除真正不可达的语句。
  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }
  const seen = new Set(), pending = [start];
  while (pending.length) {
    const id = pending.pop();
    if (!seen.has(id)) {
      seen.add(id);
      pending.push(...(outgoing.get(id) || []));
    }
  }
  return { nodes: nodes.filter(item => seen.has(item.id)),
    edges: edges.filter(edge => seen.has(edge.from)).map((edge, i) => ({ id: 'e' + i, ...edge })) };
}

const DISPLAY_LINE_WIDTH = 46;

function displayLineLength(chars) {
  if (chars.length <= DISPLAY_LINE_WIDTH) return chars.length;
  const space = chars.lastIndexOf(' ', DISPLAY_LINE_WIDTH);
  return space > 16 ? space : DISPLAY_LINE_WIDTH;
}

function displayLines(text) {
  const lines = [];
  for (const original of text.split('\n')) {
    let remaining = Array.from(original);
    while (remaining.length > DISPLAY_LINE_WIDTH && lines.length < 3) {
      const split = displayLineLength(remaining);
      lines.push(remaining.slice(0, split).join(''));
      remaining = remaining.slice(split);
      if (remaining[0] === ' ') remaining.shift();
    }
    if (lines.length < 3) lines.push(remaining.join(''));
    else {
      lines[2] += '…';
      break;
    }
  }
  return lines;
}

async function layout({ nodes, edges }) {
  const children = nodes.map(node => {
    node.lines = displayLines(node.text);
    const lines = node.diffLines?.map(line => line.map(({ text }) => text).join('')) ?? node.lines;
    const textWidth = lines.reduce((width, line) => {
      const lineWidth = Array.from(line).reduce((w, char) => w + (/[^\x00-\x7f]/.test(char) ? 14 : 8), 0);
      return Math.max(width, lineWidth);
    }, 0);
    const diamond = isDecision(node.kind) || node.kind === 'switch';
    const height = diamond ? Math.max(90, lines.length * 40 + 42) : Math.max(42, lines.length * 18 + 22);
    // 菱形靠近顶点处更窄，按最外侧一行的截面留出文字空间。
    const diamondScale = diamond && node.diffLines
      ? Math.max(1.45, height / (height - (lines.length - 1) * 18 - 16)) : 1.45;
    const width = diamond ? Math.max(164, Math.ceil((textWidth + 34) * diamondScale)) : Math.max(104, textWidth + 46);
    const port = (side, x, y) => ({ id: node.id + ':' + side, x, y, width: 0, height: 0,
      layoutOptions: { 'elk.port.side': side } });
    return {
      id: node.id, width, height, layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      ports: [port('NORTH', width / 2, 0), port('SOUTH', width / 2, height),
        ...(isDecision(node.kind) ? [port('EAST', width, height / 2)] : [])],
    };
  });
  const result = await elk.layout({
    id: 'flowchart', children,
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'DOWN', 'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '60', 'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.layered.spacing.edgeNodeBetweenLayers': '24',
      'elk.padding': '[top=32,left=32,bottom=32,right=32]',
    },
    edges: edges.map(edge => ({
      id: edge.id,
      sources: [edge.from + (edge.branch === 'OFF' ? ':EAST' : ':SOUTH')],
      targets: [edge.to + ':NORTH'],
      ...(edge.label ? { labels: [{ text: edge.label, width: Math.max(36, edge.label.length * 8 + 12), height: 20,
        layoutOptions: { 'elk.edgeLabels.placement': edge.branch === 'CASE' ? 'CENTER' : 'TAIL' } }] } : {}),
    })),
  });
  const positions = new Map(result.children.map(item => [item.id, item]));
  const routes = new Map(result.edges?.map(item => [item.id, item]));
  return {
    nodes: nodes.map(node => {
      const { x, y, width, height } = positions.get(node.id);
      return { ...node, x, y, w: width, h: height };
    }),
    edges: edges.map(edge => {
      const route = routes.get(edge.id);
      const section = route.sections[0];
      const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint].map(point)
        .filter(([x, y], i, all) => !i || x !== all[i - 1][0] || y !== all[i - 1][1]);
      const label = route.labels?.[0];
      if (!label) return { ...edge, points };
      let labelX = label.x + label.width / 2, labelY = label.y + label.height / 2;
      if (edge.branch !== 'CASE' && points.length > 1) {
        const [[x, y], [nextX, nextY]] = points;
        const horizontal = nextY === y;
        const half = (horizontal ? label.width : label.height) / 2;
        const distance = half + 14;
        if (Math.abs(nextX - x) + Math.abs(nextY - y) > distance + half + 12) {
          labelX = x + Math.sign(nextX - x) * distance;
          labelY = y + Math.sign(nextY - y) * distance;
        }
      }
      return { ...edge, points, labelX, labelY };
    }),
    width: result.width,
    height: result.height,
  };
}

function nodeSignature(node) {
  const source = fingerprint(node.code || node.text || '');
  const macros = (node.macros || []).map(({ name, params, raw }) => [name, params, fingerprint(raw || '')]);
  // 展开后的不同语句可能回溯到同一段调用源码，保留各自的语句标识。
  const expanded = macros.length ? fingerprint(node.text || '') : '';
  // 单文件对照可能缺少可下钻目标，同一条调用语句仍应匹配。
  const kind = node.kind === 'call' ? 'process' : node.kind;
  return JSON.stringify([kind, source, macros, expanded]);
}

const MAX_DIFF_CELLS = 250000;

function alignSequence(a, b, score) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const weight = score(a[i], b[j]);
      dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1], weight ? dp[i + 1][j + 1] + weight : 0);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    const weight = score(a[i], b[j]);
    if (weight && dp[i][j] === dp[i + 1][j + 1] + weight) {
      pairs.push([i++, j++]);
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function markModifiedBlocks(a, b, changes) {
  if (!a.length || !b.length) return;
  if (a.length * b.length > MAX_DIFF_CELLS) {
    const byKind = new Map();
    for (const { node } of b.toReversed()) {
      if (!byKind.has(node.kind)) byKind.set(node.kind, []);
      byKind.get(node.kind).push(node);
    }
    for (const { node, index } of a) {
      const counterpartNode = byKind.get(node.kind)?.pop();
      if (counterpartNode) changes[index] = { change: 'modified', counterpartNode };
    }
    return;
  }

  // 同类节点优先匹配相近的源码，避免把新分支中的语句错配给后面的修改。
  const comparable = ({ node }) => ({ kind: node.kind, tokens: new Set(lex(node.code || node.text || '')
    .filter(token => token.t !== 'punct').map(token => token.v)) });
  const pairs = alignSequence(a.map(comparable), b.map(comparable), (x, y) => {
    if (x.kind !== y.kind) return 0;
    let shared = 0;
    for (const token of x.tokens) if (y.tokens.has(token)) shared++;
    return 1 + Math.round(40 * shared / (x.tokens.size + y.tokens.size || 1));
  });
  for (const [i, j] of pairs) changes[a[i].index] = { change: 'modified', counterpartNode: b[j].node };
}

/** 先对齐未变节点，再按类型和源码相似度比较锚点之间的节点。 */
function matchFlowchartNodes(primaryNodes, otherNodes, version) {
  const unmatched = version === 'before' ? 'deleted' : 'added';
  const changes = primaryNodes.map(({ kind }) => ({ change: isTerminal(kind) ? 'existing' : unmatched }));
  const blocks = nodes => nodes.flatMap((node, index) => isTerminal(node.kind) ? []
    : [{ node, index, signature: nodeSignature(node) }]);
  const a = blocks(primaryNodes), b = blocks(otherNodes);
  if (!a.length || !b.length) return changes;
  if (a.length * b.length > MAX_DIFF_CELLS) {
    // 超大函数先按签名计数，保留变化块的空间给后续类型匹配。
    const bySignature = new Map();
    const remaining = new Set(b);
    for (const block of b) {
      if (!bySignature.has(block.signature)) bySignature.set(block.signature, []);
      bySignature.get(block.signature).push(block);
    }
    const changed = a.filter(block => {
      const match = bySignature.get(block.signature)?.pop();
      if (!match) return true;
      remaining.delete(match);
      changes[block.index].change = 'existing';
      return false;
    });
    markModifiedBlocks(changed, [...remaining], changes);
    return changes;
  }
  const anchors = alignSequence(a, b, (x, y) => Number(x.signature === y.signature));
  anchors.push([a.length, b.length]);
  let prevA = 0, prevB = 0;
  for (const [endA, endB] of anchors) {
    markModifiedBlocks(a.slice(prevA, endA), b.slice(prevB, endB), changes);
    if (endA < a.length) changes[a[endA].index].change = 'existing';
    prevA = endA + 1;
    prevB = endB + 1;
  }
  return changes;
}

export function diffFlowchartNodes(primaryNodes, otherNodes, version = 'after') {
  return matchFlowchartNodes(primaryNodes, otherNodes, version).map(({ change }) => change);
}

function displayTokens(text) {
  // 把行首的 # 单独保留，让词法分析器逐个读取预处理指令里的标记。
  const preproc = text.startsWith('#');
  const code = preproc ? text.slice(1) : text;
  const tokens = preproc ? ['#'] : [];
  let offset = 0;
  for (const { s, e } of lex(code)) {
    if (s > offset) tokens.push(code.slice(offset, s));
    tokens.push(code.slice(s, e));
    offset = e;
  }
  if (offset < code.length) tokens.push(code.slice(offset));
  return tokens;
}

function appendSegment(segments, text, op) {
  if (!text) return;
  const last = segments.at(-1);
  if (last?.op === op) last.text += text;
  else segments.push({ text, op });
}

function wrapDiffLines(segments) {
  const chars = segments.flatMap(({ text, op }) => Array.from(text, char => ({ char, op })));
  const lines = [];
  for (let start = 0; start < chars.length;) {
    const preview = chars.slice(start, start + DISPLAY_LINE_WIDTH + 1).map(({ char }) => char);
    const newline = preview.indexOf('\n');
    const length = newline < 0 ? displayLineLength(preview) : newline;
    const line = [];
    for (const { char, op } of chars.slice(start, start + length)) appendSegment(line, char, op);
    lines.push(line);
    start += length + (newline < 0 ? 0 : 1);
  }
  return lines;
}

function diffDisplayLines(beforeText, afterText) {
  if (beforeText === afterText) return [];
  const before = displayTokens(beforeText), after = displayTokens(afterText);
  let start = 0, beforeEnd = before.length, afterEnd = after.length;
  while (start < beforeEnd && start < afterEnd && before[start] === after[start]) start++;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }
  const removed = before.slice(start, beforeEnd), added = after.slice(start, afterEnd);
  // 长表达式先保留共同首尾，限制中间部分的 LCS 计算量。
  const pairs = removed.length && added.length && removed.length * added.length <= MAX_DIFF_CELLS
    ? alignSequence(removed, added, (a, b) => Number(a === b)) : [];
  pairs.push([removed.length, added.length]);
  const segments = [];
  appendSegment(segments, before.slice(0, start).join(''), 'same');
  let i = 0, j = 0;
  for (const [endA, endB] of pairs) {
    appendSegment(segments, removed.slice(i, endA).join(''), 'del');
    appendSegment(segments, added.slice(j, endB).join(''), 'add');
    appendSegment(segments, removed[endA], 'same');
    i = endA + 1;
    j = endB + 1;
  }
  appendSegment(segments, before.slice(beforeEnd).join(''), 'same');
  return wrapDiffLines(segments);
}

function extractFlowchartGraph(parser, model, fn, expandMacros, sourceRoot) {
  if (!isFlowchartFunction(fn) || !model.files.some(file => file.rel === fn.file)) {
    throw new Error('无法找到函数源码');
  }
  const read = sourceReader(model, sourceRoot);
  const { source } = read(fn.file);
  const tokens = lex(source, fn.file);
  const headers = new Map();
  for (const file of flowchartHeaders(model, fn)) {
    const entry = read(file);
    if (!entry.macros) {
      const scope = fileMacroScope(headers);
      collectMacros(lex(entry.source, file).filter(token => token.t === 'preproc'), scope, file);
      entry.macros = scope.changes;
    }
    for (const [name, def] of entry.macros) {
      if (def) headers.set(name, def);
      else headers.delete(name);
    }
  }
  return { ...buildSourceGraph(parser, model, fn, source, tokens, headers, expandMacros), headers };
}

function buildSourceGraph(parser, model, fn, source, tokens, headers, expandMacros) {
  const local = fileMacroScope(headers);
  collectMacros(tokens.filter(token => token.t === 'preproc' && token.line < fn.line), local, fn.file);
  const bounds = locateBody(parser, source, tokens, fn, local);
  if (!bounds) throw new Error(`无法定位函数定义：${fn.name}`);
  const bodyTokens = tokens.filter(token => token.s >= bounds.open && token.s <= bounds.close);
  const scope = new Map([...headers, ...local.changes]);
  const { input, used, originalOf, wrapped } = prepareBody(source, bodyTokens, scope, fn.file, expandMacros);
  const tree = parser.parse(input);
  let graph;
  try {
    const body = field(tree.rootNode.namedChildren.find(node => node.type === 'function_definition'), 'body');
    if (!body || body.lastChild?.isMissing) throw new Error(`无法解析函数体：${fn.name}`);
    const hasConditional = bodyTokens.some(t => t.t === 'preproc' && /^#\s*if/.test(t.v));
    if (hasConditional && body.hasError) throw new Error('条件编译分支跨越了不完整的 C 语句，无法生成流程图');
    const pending = [body];
    while (wrapped.size && pending.length) {
      const ast = pending.pop();
      if (ast.type === 'compound_statement' && wrapped.delete(ast.startIndex)) {
        let branch = ast.namedChildren[0];
        while (branch) {
          const condition = field(branch, 'condition') ?? field(branch, 'name');
          const alternative = field(branch, 'alternative');
          const statements = branch.namedChildren.filter(n => n.id !== condition?.id && n.id !== alternative?.id &&
            !['comment', 'preproc_def', 'preproc_function_def'].includes(n.type));
          if (statements.length !== 1) throw new Error('条件编译的每个分支必须提供一条完整的运行期语句');
          branch = alternative;
        }
      }
      pending.push(...ast.namedChildren);
    }
    graph = buildGraph(body, fn, model, bounds.signature, originalOf);
  } finally {
    tree.delete();
  }
  const macrosUsed = [...used].map(({ name, params, raw, file, line }) => ({ name, params, raw, file, line }));
  return { graph, macrosUsed };
}

function findSourceFunction(parser, source, tokens, fn, headers) {
  const task = taskDeclarations(source, tokens);
  const tree = parser.parse(task.source);
  try {
    const definition = collectFunctions(tree.rootNode).get(fn.name);
    const close = field(definition, 'body')?.lastChild;
    if (close?.type === '}' && !close.isMissing) {
      return { ...fn, line: definition.startPosition.row + 1, endLine: close.startPosition.row + 1 };
    }
  } finally {
    tree.delete();
  }
  // 宏封装的函数签名可能需要展开后才能从单文件中识别。
  const scope = fileMacroScope(headers);
  const input = task.names.size ? lex(task.source, fn.file) : tokens;
  const { tokens: expanded } = preprocess(input, scope, fn.file, { expand: true });
  const definition = findFunctions(expanded, fn.file).find(item => item.name === fn.name);
  if (!definition) throw new Error(`无法定位对照函数定义：${fn.name}`);
  return { ...fn, line: definition.line, endLine: definition.endLine };
}

function extractSourceComparison(parser, model, fn, otherSourceText, headers, expandMacros) {
  const source = otherSourceText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const tokens = lex(source, fn.file);
  const definition = findSourceFunction(parser, source, tokens, fn, headers);
  // 对照文件复用工程符号，调用位置以对照源码为准。
  const sourceModel = { _index: { ...model._index, outAdj: new Map() } };
  return buildSourceGraph(parser, sourceModel, definition, source, tokens, headers, expandMacros);
}

function addCallInputs(hash, index, fn) {
  if (!index?.byName) return;
  let targetsHash = callTargetHashes.get(index);
  if (!targetsHash) {
    const targets = [...index.byName.values()].flat().map(target =>
      [target.id, target.name, target.file, !!target.isStatic, isFlowchartFunction(target)]);
    targetsHash = createHash('sha256').update(JSON.stringify(targets)).digest('hex');
    callTargetHashes.set(index, targetsHash);
  }
  const calls = (index.outAdj.get(fn.id) || []).filter(call => call.kind !== 'var')
    .map(({ to, callee, kind, line, col, via, macroChain }) => [to, callee, kind, line, col, via, macroChain]);
  hash.update(targetsHash).update(JSON.stringify(calls));
}

export function flowchartCacheHash(model, fn, { version = 'after', expandMacros = false, fnChange = 'existing',
  otherModel = null, otherFn = null, otherSourceText, sourceRoot, otherSourceRoot } = {}) {
  const h = createHash('sha1');
  h.update(`fc-v6\0${version}\0${expandMacros ? 1 : 0}\0${fnChange}\0`);
  // 目录对照的两侧可映射到同一份工程文件，在本次调用内共用文件状态。
  const fileStats = otherModel ? new Map() : undefined;
  function fileInputs(graphModel, graphFn, graphRoot) {
    const read = sourceReader(graphModel, graphRoot, fileStats);
    // 缓存键与生成图使用同一批文件，包括对照侧实际参与预处理的头文件。
    return JSON.stringify([graphFn.file, ...flowchartHeaders(graphModel, graphFn)].map(file => {
      try { return [file, read(file).hash]; }
      catch { return [file, null]; }
    }));
  }
  function addInputs(side, graphModel, graphFn, files) {
    h.update(JSON.stringify([side, graphFn.id, graphFn.name, graphFn.file, graphFn.line, graphFn.endLine])).update(files);
    addCallInputs(h, graphModel._index, graphFn);
  }
  const currentFiles = fileInputs(model, fn, sourceRoot);
  addInputs('current', model, fn, currentFiles);
  if (fnChange !== 'added' && fnChange !== 'deleted') {
    if (otherModel && isFlowchartFunction(otherFn)) {
      const sameFiles = otherModel === model && otherFn.file === fn.file && otherSourceRoot === sourceRoot;
      addInputs('other', otherModel, otherFn, sameFiles ? currentFiles : fileInputs(otherModel, otherFn, otherSourceRoot));
    } else if (typeof otherSourceText === 'string') h.update('otherSourceText\0').update(otherSourceText);
  }
  return h.digest('hex');
}

export async function buildFlowchart(model, fn, { expandMacros = false, version = 'after', hasBefore = false,
  hasAfter = true, sourceRoot, fnChange = 'existing', otherModel = null, otherFn = null,
  otherSourceText, otherSourceRoot } = {}) {
  const parser = await getParser();
  const { graph, macrosUsed, headers } = extractFlowchartGraph(parser, model, fn, expandMacros, sourceRoot);
  const defaultChange = fnChange === 'added' || fnChange === 'deleted' ? fnChange : 'existing';
  let changes;
  if (defaultChange === 'existing') {
    try {
      const counterpart = otherModel && isFlowchartFunction(otherFn)
        ? extractFlowchartGraph(parser, otherModel, otherFn, expandMacros, otherSourceRoot)
        : typeof otherSourceText === 'string'
          ? extractSourceComparison(parser, model, fn, otherSourceText, headers, expandMacros) : null;
      if (counterpart) changes = matchFlowchartNodes(graph.nodes, counterpart.graph.nodes, version);
    } catch { /* 对照版本无法解析时，仅保留函数级状态。 */ }
  }
  const nodeChangeById = new Map();
  graph.nodes = graph.nodes.map((node, idx) => {
    const { change = defaultChange, counterpartNode } = changes?.[idx] ?? {};
    nodeChangeById.set(node.id, change);
    const item = { ...node, change };
    if (change === 'modified' && counterpartNode) {
      // 两侧的 text 是生成 lines 的显示标签，在折行前比较可保留完整的 C 标记。
      const [before, after] = version === 'before' ? [node, counterpartNode] : [counterpartNode, node];
      const diffLines = diffDisplayLines(before.text, after.text);
      if (diffLines.length) item.diffLines = diffLines;
    }
    return item;
  });
  graph.edges = graph.edges.map((edge) => {
    const fc = nodeChangeById.get(edge.from);
    const tc = nodeChangeById.get(edge.to);
    const change = fc === 'added' || tc === 'added' ? 'added'
      : fc === 'deleted' || tc === 'deleted' ? 'deleted'
      : 'existing';
    return { ...edge, change };
  });
  return {
    ok: true,
    fn: { id: fn.id, name: fn.name, file: fn.file, line: fn.line, endLine: fn.endLine, change: fnChange, hasBefore, hasAfter },
    version,
    expandMacros,
    macrosUsed,
    ...await layout(graph),
  };
}
