import fs from 'node:fs';
import path from 'node:path';
import ELK from 'elkjs/lib/elk.bundled.js';
import { declaratorName, getParser } from './cparse.js';
import { collectArgs, lex } from './lexer.js';
import { expandSeq, fileMacroScope, preprocess } from './preproc.js';
import { decodeSource, HDR_EXT } from './source-files.js';
import { taskDeclarations } from './task-declarations.js';

const elk = new ELK();
const field = (node, name) => node?.childForFieldName(name);
const compact = text => text.replace(/\s+/g, ' ').trim();
const point = ({ x, y }) => [x, y];
const directive = token => /^#\s*(\w+)\s*([\s\S]*)/.exec(token.v);
const isDecision = kind => kind === 'decision' || kind === 'preproc_decision';

export const isFlowchartFunction = fn => !!fn?.endLine && !fn.external && fn.kind !== 'var' && !fn.headerSymbol;

function sourceReader(model, sourceRoot) {
  const roots = [model.root, ...(sourceRoot ? [sourceRoot] : [])].map(root => fs.realpathSync(root));
  return file => {
    const realFile = fs.realpathSync(model._sourceFiles?.get(file) ?? path.join(model.root, file));
    const withinRoots = roots.some(root => {
      const rel = path.relative(root, realFile);
      return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
    });
    if (!withinRoots || !fs.statSync(realFile).isFile()) throw new Error('源码文件必须位于当前工程或对照目录内');
    return decodeSource(fs.readFileSync(realFile)).replace(/\r\n?/g, '\n');
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
  if (/^(?:false|(?:0+|0x0+|0b0+)[ul]*)$/i.test(value)) return false;
  if (/^1[ul]*$/i.test(value)) return true;
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

function prepareBody(source, tokens, initial, file, expandMacros) {
  const used = new Set();
  const locations = [];
  let input = 'void flowchart(void) ';
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
  return { input, used, originalOf };
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
    const yes = preproc
      ? sequence(ast.namedChildren.filter(child => child.id !== condition?.id && child.id !== alternative?.id), on, context)
      : visit(field(ast, 'consequence'), on, context);
    return [...yes, ...visit(alternative, off, context)];
  }

  function loop(ast, incoming, context) {
    const type = ast.type;
    const condition = field(ast, 'condition'), body = field(ast, 'body');
    const bodyFirst = type === 'do_statement';
    const breaks = [];
    if (bodyFirst && literalTruth(condition?.text ?? '') === false) {
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
    const bodyExits = visit(body, [bodyFirst ? exit(entryMarker) : exit(id, condition ? 'ON' : undefined)],
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
    return [...(condition ? [exit(id, 'OFF')] : []), ...breaks];
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
        const dispatch = { id, hasDefault: false };
        const breaks = [];
        connect(incoming, id);
        const next = visit(field(ast, 'body'), [], { ...context, dispatch, breaks });
        return [...next, ...breaks, ...(dispatch.hasDefault ? [] : [exit(id, 'CASE', 'default')])];
      }
      case 'case_statement': {
        const value = field(ast, 'value');
        const caption = value ? 'case ' + compact(value.text) : 'default';
        const id = node('process', caption + ':', ast, ast.children.find(child => child.type === ':') ?? value ?? ast);
        const dispatch = context.dispatch;
        if (dispatch) {
          if (!value) dispatch.hasDefault = true;
          connect([exit(dispatch.id, 'CASE', caption)], id);
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

function displayLines(text) {
  const lines = [];
  for (const original of text.split('\n')) {
    let remaining = Array.from(original);
    while (remaining.length > 46 && lines.length < 3) {
      const space = remaining.slice(0, 47).lastIndexOf(' ');
      const split = space > 16 ? space : 46;
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
    const textWidth = Math.max(...node.lines.map(line => Array.from(line).reduce((w, char) => w + (/[^\x00-\x7f]/.test(char) ? 14 : 8), 0)));
    const diamond = isDecision(node.kind) || node.kind === 'switch';
    const width = diamond ? Math.max(164, Math.ceil((textWidth + 34) * 1.45)) : Math.max(104, textWidth + 46);
    const height = diamond ? Math.max(90, node.lines.length * 40 + 42) : Math.max(42, node.lines.length * 18 + 22);
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

export async function buildFlowchart(model, fn, { expandMacros = false, version = 'after', hasBefore = false,
  hasAfter = true, sourceRoot } = {}) {
  if (!isFlowchartFunction(fn) || !model.files.some(file => file.rel === fn.file)) {
    throw new Error('无法找到函数源码');
  }
  const parser = await getParser();
  const read = sourceReader(model, sourceRoot);
  const source = read(fn.file);
  const tokens = lex(source, fn.file);
  const headers = new Map();
  for (const file of model.files) {
    if (file.rel === fn.file || !(file.isHeader || HDR_EXT.test(file.rel))) continue;
    collectMacros(lex(read(file.rel), file.rel).filter(token => token.t === 'preproc'), headers, file.rel);
  }
  const local = fileMacroScope(headers);
  collectMacros(tokens.filter(token => token.t === 'preproc' && token.line < fn.line), local, fn.file);
  const bounds = locateBody(parser, source, tokens, fn, local);
  if (!bounds) throw new Error(`无法定位函数定义：${fn.name}`);
  const bodyTokens = tokens.filter(token => token.s >= bounds.open && token.s <= bounds.close);
  const scope = new Map([...headers, ...local.changes]);
  const { input, used, originalOf } = prepareBody(source, bodyTokens, scope, fn.file, expandMacros);
  const tree = parser.parse(input);
  let graph;
  try {
    const body = field(tree.rootNode.namedChildren.find(node => node.type === 'function_definition'), 'body');
    if (!body || body.lastChild?.isMissing) throw new Error(`无法解析函数体：${fn.name}`);
    graph = buildGraph(body, fn, model, bounds.signature, originalOf);
  } finally {
    tree.delete();
  }
  const macrosUsed = [...used].map(({ name, params, raw, file, line }) => ({ name, params, raw, file, line }));
  return { ok: true, fn: { id: fn.id, name: fn.name, file: fn.file, line: fn.line, endLine: fn.endLine, hasBefore, hasAfter },
    version, expandMacros, macrosUsed, ...await layout(graph) };
}
