/** 在总代码工程上应用局部 before/after 对照，分析定义差分与潜在影响。 */
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex, rebuildIndex } from './index.js';
import { comparisonFiles } from './compare-files.js';
import { isScheduleFile, readScheduleFiles } from './tcu-schedule.js';
import { buildDataflowIndex, dataflowFor } from './dataflow.js';
import { getParser } from './parsers/registry.js';
import { fingerprint } from './parsers/builtin-comparison.js';
import { nodeTaskPeriods, periodLabels, taskPeriods, withTaskPeriods } from './task-periods.js';

export { fingerprint };

const location = (n) => n ? { file: n.file, line: n.line, endLine: n.endLine } : null;
const blankCounts = () => ({ existing: 0, modified: 0, added: 0, deleted: 0 });
const unionKeys = (a, b) => new Set([...a.keys(), ...b.keys()]);
const addReason = (node, reason) => {
  if (!node.reasons.includes(reason)) node.reasons.push(reason);
};
const fieldOverlap = (a, b) => !a || !b || a === b || a.startsWith(b + '.') || b.startsWith(a + '.');
const accessFields = (record, variable) => record && !record.whole && !record.indirect && !variable.containsUnion
  ? [...record.fields] : [''];

function groupedEdges(model, fingerprint) {
  const result = new Map();
  for (const e of model.edges) {
    const key = JSON.stringify([e.from, e.to, e.kind === 'var' ? 'var' : 'call', e.kind === 'var' ? e.via : '', fingerprint(e.cond || '')]);
    if (!result.has(key)) result.set(key, { ...e, calls: [] });
    result.get(key).calls.push({ line: e.line, kind: e.kind, cond: e.cond, via: e.via });
  }
  return result;
}

/** 复用引擎提供的定义与数据流。没有语句级写入差分时按函数保守追踪。 */
function definitionsFromGraph(model, _findMacros, fingerprint) {
  const raw = new Map(), expanded = new Map(), writes = new Map();
  for (const node of [...model.functions, ...model.variables]) {
    const text = node.sourceText ?? node.signature ?? node.typeText ?? node.name;
    const value = fingerprint(text);
    raw.set(node.id, { text, value });
    expanded.set(node.id, { text, value: node.semanticFingerprint ?? value });
  }
  for (const [id, { reads, writes: access }] of model._df.fnAccess) {
    const inputs = [...reads].flatMap(([varId, r]) =>
      accessFields(r, model._df.byId.get(varId)).map((field) => ({ id: varId, field })));
    writes.set(id, new Map([...access].map(([varId, r]) => [varId,
      new Map(accessFields(r, model._df.byId.get(varId)).map((field) =>
        [field, [{ signature: expanded.get(id)?.value, inputs }]]))])));
  }
  return { raw, expanded, writes, other: new Map(), rawWrites: new Map() };
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

export async function compareProjects(projectPath, beforePath, afterPath, options = {}) {
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
  const snapshots = options.snapshots;
  const { baseFiles, beforeFiles, afterFiles, mappings } = snapshots || comparisonFiles(projectPath, beforePath, afterPath);
  const scope = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
  if (!snapshots && !scope.size) throw new Error('对照目录中没有可解析的 C 文件或调度配置');
  if (!snapshots && !baseFiles.size) throw new Error('请先打开包含完整 C 源码的总代码目录');
  const withOverrides = (overrides) => {
    if (snapshots) return overrides;
    const files = new Map(baseFiles);
    for (const rel of scope) {
      if (overrides.has(rel)) files.set(rel, overrides.get(rel));
      else files.delete(rel); // 已进入对照范围但某侧缺失，表示该文件在该版本不存在。
    }
    return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
  };
  const sameSources = snapshots ? snapshots.sameSources === true : [...scope].every(isScheduleFile);
  const buildSide = async (overrides, reuse) => {
    const sources = new Map(), schedules = new Map();
    for (const [rel, abs] of withOverrides(overrides)) {
      (isScheduleFile(rel) ? schedules : sources).set(rel, abs);
    }
    // 同一份 C/H 只分析一次；调度目录、来源映射和按模型缓存的周期仍按版本独立。
    const model = reuse ? { ...reuse, _sourceFiles: sources } : await buildIndex(projectPath, sources, null, options);
    model.scheduleConfig = readScheduleFiles(schedules);
    if (model.warnings.length) throw new Error(`部分源码未能完整读取，未发布比较结果：${model.warnings.map((w) => `${w.file}：${w.error}`).join('；')}`);
    if (!snapshots && !model.files.some((f) => /\.(c|h)$/i.test(f.rel))) throw new Error(`目录中没有可解析的 C 文件：${model.root}`);
    if (model.files.some((f) => /\.(cc|cpp|hh|hpp)$/i.test(f.rel))) throw new Error('工程比较目前只支持 C 文件（.c / .h）');
    const df = await buildDataflowIndex(model);
    if (df.failedFiles) throw new Error('部分源码分析失败，无法发布不完整的比较结果');
    return model;
  };
  const beforeModel = await buildSide(beforeFiles);
  const afterModel = await buildSide(afterFiles, sameSources && beforeModel);
  const parser = getParser(beforeModel.parserId);
  const fingerprint = parser.fingerprint || ((value) => value.trim());
  const { macroChanges, macroDetails, macrosIn, changedExpansion } = parser.compareMacros?.(beforeModel, afterModel)
    ?? { macroChanges: [], macroDetails: [], macrosIn: () => new Set(), changedExpansion: () => new Set() };
  const definitionsOf = parser.compareDefinitions || definitionsFromGraph;
  const beforeDefs = await definitionsOf(beforeModel, macrosIn, fingerprint);
  const afterDefs = sameSources ? beforeDefs : await definitionsOf(afterModel, macrosIn, fingerprint);
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
  for (const [version, model] of [['before', beforeModel], ['after', afterModel]]) {
    for (const w of model.scheduleConfig.warnings) warnings.push(`${version}/${w.file}：${w.error}`);
  }
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
  const oldEdges = groupedEdges(beforeModel, fingerprint), newEdges = groupedEdges(afterModel, fingerprint), edges = [];
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
