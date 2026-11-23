/** 在总代码工程上应用局部 before/after 对照，分析定义差分与潜在影响。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildIndex, rebuildIndex } from './index.js';
import { comparisonFiles } from './compare-files.js';
import { getParser, collectDefinitions, collectFunctions } from './cparse.js';
import { analysisSources, buildDataflowIndex, dataflowFor } from './dataflow.js';
import { lex } from './lexer.js';
import { expandSeq } from './preproc.js';
import { nodeTaskPeriods, periodLabels, taskPeriods, withTaskPeriods } from './task-periods.js';

const fingerprint = (text) => createHash('sha256').update(JSON.stringify(lex(text).flatMap((t) =>
  t.t === 'preproc' ? lex(t.v.slice(1)).map((p) => [p.t, p.v]) : [[t.t, t.v]]))).digest('hex');
const location = (n) => n ? { file: n.file, line: n.line, endLine: n.endLine } : null;
const blankCounts = () => ({ existing: 0, modified: 0, added: 0, deleted: 0 });
const unionKeys = (a, b) => new Set([...a.keys(), ...b.keys()]);
const addReason = (node, reason) => {
  if (!node.reasons.includes(reason)) node.reasons.push(reason);
};
const fieldOverlap = (a, b) => !a || !b || a === b || a.startsWith(b + '.') || b.startsWith(a + '.');
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
    for (const { condition } of guards) dependencies(condition, inputs, locals);
    for (const source of sources) dependencies(source, inputs, locals);
    const refs = [...new Map(inputs.map(dep => [JSON.stringify(dep), dep])).values()];
    const macroNames = findMacros ? new Set([
      ...findMacros([node.text, ...guards.map(g => g.condition.text)].join('\n')),
      ...[...locals].flatMap(local => [...local.macroNames]),
    ]) : undefined;
    const signature = JSON.stringify([fingerprint(node.text), guards.map(g => [g.branch, fingerprint(g.condition.text)]),
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
      if (child.type !== 'identifier') continue;
      if (!scope.has(child.text)) scope.set(child.text, locals.get(child.text));
      locals.set(child.text, []);
    }
    if (node.type === 'assignment_expression' || node.type === 'update_expression' || node.type === 'init_declarator') {
      const target = field('left') || field('argument') || field('declarator');
      const value = field('right') || field('value');
      const assigns = field('operator')?.text === '=';
      const sources = [value];
      if (!assigns) sources.push(target);
      else for (let part = target; part; part = part.childForFieldName('argument')) {
        sources.push(part.childForFieldName('index'));
      }
      if (node.type !== 'init_declarator') record(target, node, guards, sources);
      if (target?.type === 'identifier') {
        const previous = locals.get(target.text) || [];
        if (node.type === 'init_declarator') {
          if (!scope.has(target.text)) scope.set(target.text, locals.get(target.text));
          locals.set(target.text, [effect(node, guards, [value])]);
        } else if (locals.has(target.text)) {
          const next = effect(node, guards, sources);
          locals.set(target.text, guards.length ? [...previous, next] : [next]);
        }
      }
    } else if (node.type === 'call_expression') {
      for (const arg of field('arguments')?.namedChildren || []) record(arg, node, guards, [node], true);
    }
    const condition = field('condition') || (node.type === 'case_statement' ? field('value') : null);
    const alternative = field('alternative'), initializer = field('initializer');
    for (const child of node.namedChildren) {
      const guarded = condition && child.id !== condition.id && child.id !== initializer?.id;
      visit(child, guarded ? [...guards, { condition, branch: child.id === alternative?.id ? 'else' : 'then' }] : guards, scope);
    }
    if (scope !== shadowed) for (const [name, prior] of scope) {
      if (prior) locals.set(name, prior);
      else locals.delete(name);
    }
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

async function definitionsOf(model, findMacros) {
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

function groupedEdges(model) {
  const result = new Map();
  for (const e of model.edges) {
    const key = JSON.stringify([e.from, e.to, e.kind === 'var' ? 'var' : 'call', e.kind === 'var' ? e.via : '', fingerprint(e.cond || '')]);
    if (!result.has(key)) result.set(key, { ...e, calls: [] });
    result.get(key).calls.push({ line: e.line, kind: e.kind, cond: e.cond, via: e.via });
  }
  return result;
}

function macroDiff(beforeModel, afterModel) {
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

function changedWrites(before, after) {
  const a = before || new Map(), b = after || new Map();
  const changed = new Map();
  const signatures = (fields, field) => JSON.stringify((fields?.get(field) || []).map(write => write.signature));
  for (const varId of unionKeys(a, b)) {
    const old = a.get(varId) || new Map(), now = b.get(varId) || new Map();
    const fields = [...unionKeys(old, now)].filter(field => signatures(old, field) !== signatures(now, field));
    if (fields.length) changed.set(varId, fields);
  }
  return changed;
}

function analyzeSide(model, definitions, merged, points, changed, version) {
  const side = version === 'before' ? '修改前' : '修改后';
  const details = model._df;
  for (const { point, seeds } of points.values()) {
    const queue = [], seen = new Set();
    const enqueue = (id, input, role, reason, field = '') => {
      const node = merged.get(id);
      if (!node || !model._index.byId.has(id)) return;
      node.impactChainIds.add(point.id);
      if (role) {
        node.impact = true;
        if (role === 'dataflow_impact' || !node.impactRole) node.impactRole = role;
        if (reason && node.reasons.length < 8) addReason(node, `${side}：${reason}`);
      }
      const key = JSON.stringify([id, input, field]);
      if (seen.has(key)) return;
      seen.add(key);
      queue.push({ id, input, field });
    };
    for (const id of seeds) enqueue(id, null);
    for (let i = 0; i < queue.length; i++) {
      const { id, input, field } = queue[i];
      const node = merged.get(id);
      if (node.kind === 'var') {
        const variable = details.byId.get(id);
        for (const fn of details.readers.get(id) || []) {
          const read = details.fnAccess.get(fn)?.reads.get(id);
          if (accessFields(read, variable).some(member => fieldOverlap(member, field))) {
            enqueue(fn, id, 'dataflow_impact', `经共享变量 ${node.name}${field ? '.' + field : ''} 关联`, field);
          }
        }
        if (input === null) for (const fn of details.writers.get(id) || []) {
          // 变量定义或周期变化使写入者需要核查，其他写入取决于具体的读取依赖。
          enqueue(fn, id, 'dataflow_impact', `写入共享变量 ${node.name}`);
        }
        continue;
      }
      for (const e of model._index.inAdj.get(id) || []) if (e.kind !== 'var') {
        enqueue(e.from, id, 'caller_impact', `调用 ${node.name}()`);
      }
      const writes = definitions.writes.get(id) || new Map();
      for (const [varId, fields] of writes) for (const [member, effects] of fields) {
        const rawEffects = point.kind === 'macro_lsb' && definitions.rawWrites.get(id)?.get(varId)?.get(member);
        const diff = changed.get(id);
        const changedFields = (point.kind === 'macro_lsb' ? diff?.expanded : diff?.source)?.get(varId);
        const relevant = input === null
          ? point.kind === 'period' || (changedFields?.some(value => fieldOverlap(value, member)) &&
            (!rawEffects || rawEffects.some(effect => effect.macroNames.has(point.name))))
          : effects.some(effect => effect.inputs.some(dep => dep.id === input && fieldOverlap(dep.field, field)));
        if (relevant) enqueue(varId, id, 'dataflow_impact', `由 ${node.name}() 写入${member ? '成员 ' + member : ''}`, member);
      }
      if (input === null) for (const e of model._index.outAdj.get(id) || []) {
        const target = merged.get(e.to);
        if (e.kind !== 'var' && target) target.context = true;
      }
    }
  }
}

export async function compareProjects(projectPath, beforePath, afterPath) {
  const realDirectory = (value) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('请打开总代码目录，并选择修改前和修改后对照目录');
    const abs = fs.realpathSync(path.resolve(value));
    if (!fs.statSync(abs).isDirectory()) throw new Error(`比较对象必须是目录：${abs}`);
    return abs;
  };
  projectPath = realDirectory(projectPath); beforePath = realDirectory(beforePath); afterPath = realDirectory(afterPath);
  const identities = [projectPath, beforePath, afterPath].map((p) => process.platform === 'win32' ? p.toLowerCase() : p);
  if (new Set(identities).size !== 3) {
    throw new Error('总代码、修改前对照、修改后对照必须是三个不同的目录');
  }
  const { baseFiles, beforeFiles, afterFiles, mappings } = comparisonFiles(projectPath, beforePath, afterPath);
  const scope = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
  if (!scope.size) throw new Error('对照目录中没有可解析的 C 文件');
  if (!baseFiles.size) throw new Error('请先打开包含完整 C 源码的总代码目录');
  const withOverrides = (overrides) => {
    const files = new Map(baseFiles);
    for (const rel of scope) {
      if (overrides.has(rel)) files.set(rel, overrides.get(rel));
      else files.delete(rel); // 已进入对照范围但某侧缺失，表示该文件在该版本不存在。
    }
    return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
  };
  const beforeModel = buildIndex(projectPath, withOverrides(beforeFiles));
  const afterModel = buildIndex(projectPath, withOverrides(afterFiles));
  for (const m of [beforeModel, afterModel]) {
    if (m.warnings.length) throw new Error(`部分源码未能完整读取，未发布比较结果：${m.warnings.map((w) => `${w.file}：${w.error}`).join('；')}`);
    if (!m.files.some((f) => /\.(c|h)$/i.test(f.rel))) throw new Error(`目录中没有可解析的 C 文件：${m.root}`);
    if (m.files.some((f) => /\.(cc|cpp|hh|hpp)$/i.test(f.rel))) throw new Error('工程比较目前只支持 C 文件（.c / .h）');
    const df = await buildDataflowIndex(m);
    if (df.failedFiles) throw new Error('部分源码分析失败，无法发布不完整的比较结果');
  }
  const { macroChanges, macroDetails, macrosIn, changedExpansion } = macroDiff(beforeModel, afterModel);
  const beforeDefs = await definitionsOf(beforeModel, macrosIn), afterDefs = await definitionsOf(afterModel, macrosIn);
  const beforePeriods = taskPeriods(beforeModel), afterPeriods = taskPeriods(afterModel);
  const points = new Map();
  const addPoint = (point) => points.set(point.id, { point, seeds: new Set() });
  const bodyText = (value) => value ?? '—';
  const macroReason = (m) => `宏/LSB 展开变化: ${m.name} (${bodyText(m.before)} → ${bodyText(m.after)})`;
  for (const m of macroDetails) {
    addPoint({ id: m.id, kind: 'macro_lsb', name: m.name, file: m.file,
      change: m.before === null ? 'added' : m.after === null ? 'deleted' : 'modified',
      beforeValue: m.before, afterValue: m.after, summary: macroReason(m) });
  }
  const warnings = [...beforeModel.warnings, ...afterModel.warnings].map((w) => `${w.file}：${w.error}`);
  for (const mapping of mappings) if (mapping.source !== mapping.target) warnings.push(`${mapping.version}/${mapping.source} → ${mapping.target}`);
  for (const file of new Set([...beforeDefs.other.keys(), ...afterDefs.other.keys()])) {
    const a = beforeDefs.other.get(file) || fingerprint(''), b = afterDefs.other.get(file) || fingerprint('');
    if (a !== b) warnings.push(`${file} 存在类型或声明变更，请结合定义差分核对影响`);
  }
  const summary = { functions: blankCounts(), variables: blankCounts() };
  const merged = new Map();
  const changed = new Map();
  const trackWrites = (id, separateMacroWrites) => {
    const expanded = changedWrites(beforeDefs.writes.get(id), afterDefs.writes.get(id));
    const a = beforeDefs.rawWrites.get(id), b = afterDefs.rawWrites.get(id);
    const source = separateMacroWrites && a && b ? changedWrites(a, b) : expanded;
    changed.set(id, { source, expanded });
  };
  const addDefinitionPoint = (n, reason) => {
    if (!points.has(n.id)) addPoint({ id: n.id, kind: n.kind === 'var' ? 'variable' : 'function', name: n.name, file: n.file,
      change: n.change === 'existing' ? 'modified' : n.change,
      beforeValue: beforeDefs.raw.get(n.id)?.text ?? null, afterValue: afterDefs.raw.get(n.id)?.text ?? null, summary: reason });
    points.get(n.id).seeds.add(n.id);
  };
  for (const [kind, listKey] of [['fn', 'functions'], ['var', 'variables'], ['external', 'externals']]) {
    const old = new Map((beforeModel[listKey] || []).map((n) => [n.id, n]));
    const now = new Map((afterModel[listKey] || []).map((n) => [n.id, n]));
    for (const id of new Set([...old.keys(), ...now.keys()])) {
      const a = old.get(id), b = now.get(id), reasons = [];
      const oldRaw = beforeDefs.raw.get(id), newRaw = afterDefs.raw.get(id);
      const oldExpanded = beforeDefs.expanded.get(id), newExpanded = afterDefs.expanded.get(id);
      let change = a ? b ? 'existing' : 'deleted' : 'added';
      let macroImpact = false, macroNames = [];
      if (a && b && kind !== 'external') {
        if (oldRaw && newRaw && oldRaw.value !== newRaw.value) {
          change = 'modified'; reasons.push('定义修改');
        } else if (!oldRaw || !newRaw || !oldExpanded || !newExpanded) {
          reasons.push('定义解析不完整，未判为代码修改，请核对源码');
          warnings.push(`${id} 的完整定义未能解析`);
        }
        if (oldRaw && newRaw && oldExpanded && newExpanded && oldExpanded.value !== newExpanded.value) {
          const names = change === 'existing' ? macrosIn(newRaw.text) : changedExpansion(newRaw.text);
          const macros = macroDetails.filter(m => names.has(m.name));
          macroImpact = change === 'existing' || macros.length > 0;
          macroNames = macros.map(m => m.name);
          if (macroImpact) reasons.push(...(macros.length ? macros.map(macroReason) : ['宏展开变化（宏定义来源待核对）']));
          for (const m of macros) points.get(m.id).seeds.add(id);
        }
      }
      if (change === 'added') reasons.push('仅修改后存在');
      if (change === 'deleted') reasons.push('仅修改前存在');
      if (summary[listKey]) summary[listKey][change]++;
      const periodBefore = a ? periodLabels(nodeTaskPeriods(beforeModel, a, beforePeriods)) : [];
      const periodAfter = b ? periodLabels(nodeTaskPeriods(afterModel, b, afterPeriods)) : [];
      const periodImpact = !!(a && b) && periodBefore.join() !== periodAfter.join();
      const node = { ...(b || a), kind: kind === 'external' ? 'fn' : kind, change, reasons,
        macroImpact, macroNames, periodImpact, periodBefore, periodAfter, periods: { before: periodBefore, after: periodAfter },
        impact: macroImpact || periodImpact, context: false, impactChainIds: new Set(),
        locations: { before: location(a), after: location(b) }, versions: [a && 'before', b && 'after'].filter(Boolean) };
      merged.set(id, node);
      if (kind !== 'external' && (change !== 'existing' || (macroImpact && !macroNames.length))) addDefinitionPoint(node, reasons[0]);
      if (periodImpact) {
        const periodReason = `周期变化: ${periodBefore.join(' / ') || '—'} → ${periodAfter.join(' / ') || '—'}`;
        reasons.unshift(periodReason);
        const periodId = 'period::' + id;
        addPoint({ id: periodId, kind: 'period', name: node.name, file: node.file, change: 'modified',
          beforeValue: periodBefore, afterValue: periodAfter, summary: periodReason });
        points.get(periodId).seeds.add(id);
      }
      if (kind === 'fn' && (change !== 'existing' || oldExpanded?.value !== newExpanded?.value)) {
        trackWrites(id, change === 'modified' && macroImpact);
      }
    }
  }
  const oldEdges = groupedEdges(beforeModel), newEdges = groupedEdges(afterModel), edges = [];
  for (const key of new Set([...oldEdges.keys(), ...newEdges.keys()])) {
    const a = oldEdges.get(key), b = newEdges.get(key);
    const e = b || a;
    const change = a ? b ? 'existing' : 'deleted' : 'added';
    const countReason = a && b && e.kind !== 'var' && a.calls.length !== b.calls.length
      ? `调用次数变化: ${e.callee} (${a.calls.length} → ${b.calls.length} 次)` : null;
    edges.push({ ...e, comparison: true, comparisonKey: key, change, ...(countReason ? { reasons: [countReason] } : {}),
      beforeCalls: a?.calls || [], afterCalls: b?.calls || [],
      locations: { before: a ? { file: beforeModel._index.byId.get(a.from)?.file, line: a.line } : null,
        after: b ? { file: afterModel._index.byId.get(b.from)?.file, line: b.line } : null },
      versions: [a && 'before', b && 'after'].filter(Boolean) });
    if (change === 'existing' && !countReason) continue;
    const caller = merged.get(e.from), target = merged.get(e.to);
    if (!caller || !target) continue;
    const reason = countReason || '调用或变量引用关系变化';
    addReason(caller, reason);
    target.context = true;
    if (caller.change === 'existing' && !caller.macroImpact) {
      caller.impact = true;
      if (e.kind === 'var' || !caller.impactRole) caller.impactRole = e.kind === 'var' ? 'dataflow_impact' : 'caller_impact';
      addDefinitionPoint(caller, reason);
      if (!changed.has(caller.id)) trackWrites(caller.id, false);
    }
  }
  analyzeSide(beforeModel, beforeDefs, merged, points, changed, 'before');
  analyzeSide(afterModel, afterDefs, merged, points, changed, 'after');
  const affected = new Map([...points.keys()].map(id => [id, []]));
  const nodes = [...merged.values()];
  for (const n of nodes) {
    n.context &&= n.change === 'existing' && !n.impact;
    if (n.change !== 'existing') n.impactRole = 'direct_change';
    else if (n.macroImpact) n.impactRole = 'macro_lsb_impact';
    else if (n.periodImpact) n.impactRole = 'period_impact';
    else n.impactRole ||= n.context ? 'callee_context' : 'unrelated';
    n.impactChainIds = [...n.impactChainIds];
    if (!n.external) for (const id of n.impactChainIds) affected.get(id).push(n.id);
  }
  const changePoints = [...points.values()].map(({ point }) => ({ ...point, affectedIds: affected.get(point.id) }));
  const impactIds = nodes.filter(n => n.impact || n.change !== 'existing').map(n => n.id);
  const roots = [...impactIds, ...nodes.filter(n => n.context).map(n => n.id)];
  const model = rebuildIndex({ ...afterModel,
    files: [...new Map([...beforeModel.files, ...afterModel.files].map((f) => [f.rel, f])).values()],
    functions: nodes.filter((n) => n.kind === 'fn' && !n.external), variables: nodes.filter((n) => n.kind === 'var'),
    externals: nodes.filter((n) => n.external),
    headerSymbols: (afterModel.headerSymbols || []).map(n => ({ ...n, change: 'existing', reasons: [], impact: false, context: false,
      macroImpact: false, macroNames: [], periodImpact: false, periodBefore: [], periodAfter: [], periods: { before: [], after: [] },
      impactRole: 'unrelated', impactChainIds: [] })),
    edges, _df: null, _dfPending: null });
  return { projectPath, beforePath, afterPath, beforeModel, afterModel, model, summary, roots, impactIds, warnings, mappings,
    macroChanges, macroDetails, changePoints, totalNodes: roots.length };
}

/** 两侧数据流分别查询再合并，避免制造跨版本的虚假写者/读者配对。 */
export async function comparisonDataflow(comparison, id, dir) {
  const results = [];
  for (const [version, m] of [['before', comparison.beforeModel], ['after', comparison.afterModel]]) {
    if (!m._index.byId.has(id)) continue;
    const result = await dataflowFor(m, id, dir);
    results.push({ ...result, edges: result.edges.map((e) => ({ ...e, version })),
      vars: result.vars.map((v) => ({ ...v, version, peers: v.peers.map((p) => ({ ...p, version })) })) });
  }
  const node = comparison.model._index.byId.get(id);
  const [fn] = node ? withTaskPeriods([{ id, name: node.name, file: node.file, line: node.line, kind: node.kind }], comparison.model, comparison) : [];
  return { ok: true, fn: fn || null, dir,
    vars: results.flatMap((r) => r.vars), nodes: [...new Map(results.flatMap((r) => r.nodes).map((n) => [n.id, n])).values()],
    edges: results.flatMap((r) => r.edges), writes: Math.max(0, ...results.map((r) => r.writes || 0)),
    reads: Math.max(0, ...results.map((r) => r.reads || 0)), truncated: results.some((r) => r.truncated) };
}

/** 页面变量清单只聚合实际存在的引用，不建立新的跨版本数据链。 */
export function comparisonGlobals(comparison) {
  return comparison.model.variables.map((v) => {
    const peers = (kind) => [...new Set([...(comparison.beforeModel._df[kind].get(v.id) || []),
      ...(comparison.afterModel._df[kind].get(v.id) || [])])].map((id) => comparison.model._index.byId.get(id))
      .filter(Boolean).map((n) => ({ id: n.id, name: n.name }));
    return { ...v, writers: peers('writers'), readers: peers('readers') };
  });
}
