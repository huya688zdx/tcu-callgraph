import { createHash } from 'node:crypto';
import { getParser, collectDefinitions, collectFunctions, declaratorName } from '../cparse.js';
import { lex } from '../lexer.js';
import { expandSeq } from '../preproc.js';
import { analysisSources } from './builtin-dataflow.js';

export const fingerprint = (text) => createHash('sha256').update(JSON.stringify(lex(text).flatMap((t) =>
  t.t === 'preproc' ? lex(t.v.slice(1)).map((p) => [p.t, p.v]) : [[t.t, t.v]]))).digest('hex');
const unionKeys = (a, b) => new Set([...a.keys(), ...b.keys()]);
const earlyExits = new Set(['return_statement', 'break_statement', 'continue_statement', 'goto_statement']);
const loops = new Set(['for_statement', 'while_statement', 'do_statement']);
const accessFields = (record, variable) => record && !record.whole && !record.indirect && !variable.containsUnion
  ? [...record.fields] : [''];

function reference(node) {
  if (!node) return null;
  if (node.type === 'identifier') return { name: node.text, field: '' };
  const argument = node.childForFieldName('argument');
  if (node.type === 'field_expression') {
    const base = reference(argument);
    const field = node.childForFieldName('field')?.text;
    return base && field ? { name: base.name, field: [base.field, field].filter(Boolean).join('.') } : null;
  }
  if (node.type === 'subscript_expression' || node.type === 'pointer_expression') return reference(argument);
  if (node.type === 'parenthesized_expression' || node.type === 'cast_expression') return reference(node.namedChildren.at(-1));
  return null;
}

function localTarget(node) {
  let partial = false;
  while (node) {
    if (node.type === 'identifier') return { name: node.text, partial };
    if (node.type === 'parenthesized_expression') {
      node = node.namedChildren.at(-1);
      continue;
    }
    // 通过指针访问成员时，写入不会改变指针变量本身。
    if (node.type !== 'subscript_expression' &&
        (node.type !== 'field_expression' || node.childForFieldName('operator')?.text !== '.')) break;
    partial = true;
    node = node.childForFieldName('argument');
  }
  return null;
}

// 用数据流索引确认全局读写，再按 AST 拆分同行语句和不同成员。
function functionWrites(fn, model, id, findMacros) {
  const { reads, writes } = model._df.fnAccess.get(id) || {};
  if (!writes?.size) return new Map();
  const byName = (records) => new Map([...records].map(([varId, rec]) => {
    const variable = model._df.byId.get(varId);
    return [variable.name, { varId, rec, variable }];
  }));
  const readNames = byName(reads), writeNames = byName(writes);
  const callees = model._index.outAdj.get(id) || [];
  const results = new Map(), locals = new Map();
  const lineOf = n => n.startPosition.row + 1;

  function dependencies(node, inputs, localEffects) {
    if (!node) return;
    const ref = reference(node);
    if (ref) {
      const read = readNames.get(ref.name);
      if (locals.has(ref.name)) {
        for (const local of locals.get(ref.name)) {
          inputs.push(...local.inputs);
          localEffects.add(local);
        }
      } else if (read?.rec.lines.has(lineOf(node))) {
        inputs.push({ id: read.varId, field: accessFields(read.rec, read.variable).includes('') ? '' : ref.field });
      }
      for (let part = node; part; part = part.childForFieldName('argument')) {
        if (part.type === 'parenthesized_expression' || part.type === 'cast_expression') {
          dependencies(part.namedChildren.at(-1), inputs, localEffects);
          break;
        }
        dependencies(part.childForFieldName('index'), inputs, localEffects);
      }
      return;
    }
    if (node.type === 'call_expression') {
      const name = node.childForFieldName('function')?.text.replace(/\s/g, '');
      for (const edge of callees) {
        if (edge.kind !== 'var' && edge.line === lineOf(node) && (edge.callee === name || edge.via === name)) {
          inputs.push({ id: edge.to, field: '' });
        }
      }
    }
    for (const child of node.namedChildren) dependencies(child, inputs, localEffects);
  }

  function effect(node, guards, sources) {
    const inputs = [], locals = new Set();
    for (const { control } of guards) {
      inputs.push(...control.inputs);
      for (const local of control.locals) locals.add(local);
    }
    for (const source of sources) dependencies(source, inputs, locals);
    const refs = [...new Map(inputs.map(dep => [JSON.stringify(dep), dep])).values()];
    const macroNames = findMacros ? new Set([
      ...findMacros(node.text), ...guards.flatMap(g => [...g.control.macroNames]),
      ...[...locals].flatMap(local => [...local.macroNames]),
    ]) : undefined;
    const signature = JSON.stringify([fingerprint(node.text), guards.map(g => [g.branch, g.control.signature]),
      [...locals].map(local => local.signature), refs]);
    return { inputs: refs, signature: createHash('sha256').update(signature).digest('hex'), macroNames };
  }

  function record(target, operation, guards, sources, indirect = false) {
    const ref = reference(target);
    if (!ref || locals.has(ref.name)) return;
    const write = writeNames.get(ref.name);
    if (!write?.rec.lines.has(lineOf(target)) || (indirect && !write.rec.indirect)) return;
    if (ref.field && !write.rec.fields.has(ref.field) && !write.rec.indirect) return;
    if (!ref.field && !write.rec.whole && !write.rec.indirect) return;
    const field = write.variable.containsUnion || write.rec.indirect ? '' : ref.field;
    if (!results.has(write.varId)) results.set(write.varId, new Map());
    const fields = results.get(write.varId);
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push(effect(operation, guards, sources));
  }

  function visit(node, guards, shadowed) {
    const field = name => node.childForFieldName(name);
    const scope = node.type === 'compound_statement' || node.type === 'for_statement' ? new Map() : shadowed;
    if (node.type === 'declaration') for (const child of node.childrenForFieldName('declarator')) {
      if (child.type !== 'identifier' && child.type !== 'array_declarator') continue;
      const name = declaratorName(child);
      if (!name) continue;
      if (!scope.has(name)) scope.set(name, locals.get(name));
      locals.set(name, []);
    }
    if (node.type === 'assignment_expression' || node.type === 'update_expression' || node.type === 'init_declarator') {
      const target = field('left') || field('argument') || field('declarator');
      const value = field('right') || field('value');
      const assigns = field('operator')?.text === '=';
      const sources = [value];
      if (!assigns) sources.push(target);
      else for (let part = target; part; part = part.type === 'parenthesized_expression'
        ? part.namedChildren.at(-1) : part.childForFieldName('argument')) {
        sources.push(part.childForFieldName('index'));
      }
      if (node.type === 'init_declarator') {
        const name = target?.type === 'identifier' || target?.type === 'array_declarator' ? declaratorName(target) : null;
        if (name) {
          if (!scope.has(name)) scope.set(name, locals.get(name));
          locals.set(name, [effect(node, guards, [value])]);
        }
      } else {
        record(target, node, guards, sources);
        const local = localTarget(target);
        if (local && locals.has(local.name)) {
          const next = effect(node, guards, sources);
          // 成员和下标写入只更新对象的一部分，保留先前的依赖。
          locals.set(local.name, local.partial || guards.length ? [...locals.get(local.name), next] : [next]);
        }
      }
    } else if (node.type === 'call_expression') {
      for (const arg of field('arguments')?.namedChildren || []) record(arg, node, guards, [node], true);
    }
    const condition = field('condition') || (node.type === 'case_statement' ? field('value') : null);
    const alternative = field('alternative'), initializer = field('initializer');
    const sequential = node.type === 'compound_statement' || node.type === 'case_statement';
    let activeGuards = guards;
    let control;
    let exits = earlyExits.has(node.type) ? new Map([[node.type, new Set()]]) : null;
    for (const child of node.namedChildren) {
      const guarded = condition && child.id !== condition.id && child.id !== initializer?.id;
      if (guarded && !control) {
        const inputs = [], localEffects = new Set();
        dependencies(condition, inputs, localEffects);
        control = { inputs, locals: localEffects, signature: fingerprint(condition.text), macroNames: findMacros?.(condition.text) };
      }
      const guard = guarded ? { control, branch: child.id === alternative?.id ? 'else' : 'then' } : null;
      const childExits = visit(child, guard ? [...activeGuards, guard] : activeGuards, scope);
      if (!childExits) continue;
      for (const [kind, controls] of childExits) {
        // break / continue 只影响其目标循环或 switch 内的后续语句。
        if ((kind === 'break_statement' && (node.type === 'switch_statement' || loops.has(node.type))) ||
            (kind === 'continue_statement' && loops.has(node.type))) continue;
        exits ??= new Map();
        if (!exits.has(kind)) exits.set(kind, new Set());
        const collected = exits.get(kind);
        if (guard) collected.add(guard);
        for (const control of controls) collected.add(control);
      }
      if (sequential && exits) activeGuards = [...guards, ...new Set([...exits.values()].flatMap(controls => [...controls]))];
    }
    if (scope !== shadowed) for (const [name, prior] of scope) {
      if (prior) locals.set(name, prior);
      else locals.delete(name);
    }
    return exits;
  }
  visit(fn.childForFieldName('body'), [], new Map());

  // 指针形参和无法定位到具体语句的写入继续采用保守口径。
  for (const [varId, rec] of writes) {
    const fields = results.get(varId) || new Map();
    const variable = model._df.byId.get(varId);
    for (const field of accessFields(rec, variable)) {
      if (!fields.has(field) && !fields.has('')) fields.set(field, [{ signature: fingerprint(fn.text), macroNames: findMacros?.(fn.text),
        inputs: [...reads].flatMap(([id, access]) => accessFields(access, model._df.byId.get(id)).map(field => ({ id, field }))) }]);
    }
    results.set(varId, fields);
  }
  return results;
}

export async function definitionsOf(model, findMacros) {
  const { sources, failedFiles } = analysisSources(model);
  if (failedFiles) throw new Error('部分源码读取失败，无法完成工程比较');
  const parser = await getParser();
  const raw = new Map(), expanded = new Map(), other = new Map(), writes = new Map(), rawWrites = new Map();
  for (const f of sources) {
    for (const [text, target] of [[f.src, raw], [f.expanded, expanded]]) {
      const tree = parser.parse(text);
      try {
        const collected = collectDefinitions(tree.rootNode);
        if (target === raw) other.set(f.rel, fingerprint(collected.other.join('\n')));
        for (const d of collected.definitions) {
          const id = d.kind === 'fn' ? `${f.rel}::${d.name}` : d.isStatic ? `var::${f.rel}::${d.name}` : `var::${d.name}`;
          const prev = target.get(id);
          if (!prev || (prev.isExtern && !d.isExtern)) target.set(id, { text: d.text, value: fingerprint(d.text), isExtern: d.isExtern });
        }
        for (const [name, fn] of collectFunctions(tree.rootNode)) {
          const id = `${f.rel}::${name}`;
          if (!model._df.fnAccess.get(id)?.writes.size) continue;
          if (target === expanded) writes.set(id, functionWrites(fn, model, id));
          else if (findMacros(fn.text).size) rawWrites.set(id, functionWrites(fn, model, id, findMacros));
        }
      } finally { tree.delete(); }
    }
  }
  return { raw, expanded, other, writes, rawWrites };
}

export function macroDiff(beforeModel, afterModel) {
  const macroKey = (m) => `${m.file}::${m.name}`;
  const oldMacros = new Map(beforeModel.macros.map((m) => [macroKey(m), m]));
  const newMacros = new Map(afterModel.macros.map((m) => [macroKey(m), m]));
  const signature = (macro) => macro && fingerprint(JSON.stringify(macro.params) + ' ' + macro.raw);
  const macroChanges = [...unionKeys(oldMacros, newMacros)].filter(key => signature(oldMacros.get(key)) !== signature(newMacros.get(key)));
  const before = new Map(beforeModel.macros.map(m => [m.name, m]));
  const after = new Map(afterModel.macros.map(m => [m.name, m]));
  const names = new Set(macroChanges.map(key => (newMacros.get(key) || oldMacros.get(key)).name));
  const numeric = (body) => /^[+-]?\s*(?:0[xX][\da-fA-F]+[uUlL]*|0[bB][01]+[uUlL]*|\d+[uUlL]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[fFlL]?)$/.test(body.replace(/[()]/g, '').trim());
  const macroDetails = [...names].map(name => {
    const a = before.get(name), b = after.get(name);
    return { id: 'macro::' + name, name, file: (b || a).file, before: a?.raw ?? null, after: b?.raw ?? null,
      isNumeric: [a, b].filter(Boolean).every(m => m.params === null && numeric(m.raw)) };
  });
  const references = (definition, macros) => {
    const visited = new Set();
    const scan = (tokens, params) => {
      for (const [i, token] of tokens.entries()) {
        if (token.t !== 'id' || visited.has(token.v) || params?.includes(token.v)) continue;
        const macro = macros.get(token.v);
        if (!macro || (macro.params !== null && tokens[i + 1]?.v !== '(')) continue;
        visited.add(token.v);
        scan(macro.body, macro.params);
      }
    };
    scan(lex(definition), null);
    return visited;
  };
  const used = (definition, macros) => {
    if (!macroDetails.length) return new Set();
    const refs = references(definition, macros);
    return new Set([...refs].filter(name => names.has(name)));
  };
  const macrosIn = text => new Set([...used(text, before), ...used(text, after)]);
  const changedExpansion = (definition) => {
    const candidates = macrosIn(definition);
    if (!candidates.size) return candidates;
    const tokens = lex(definition);
    const expanded = (macros) => JSON.stringify(expandSeq(tokens, macros).map(t => [t.t, t.v]));
    const current = expanded(after);
    return new Set([...candidates].filter(name => current !== expanded({ get: key => key === name ? before.get(key) : after.get(key) })));
  };
  return { macroChanges, macroDetails, macrosIn, changedExpansion };
}
