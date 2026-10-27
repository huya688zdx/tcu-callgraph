/** 在总代码工程上应用局部 before/after 对照，分析定义差分与潜在影响。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildIndex, rebuildIndex } from './index.js';
import { comparisonFiles } from './compare-files.js';
import { getParser, collectDefinitions } from './cparse.js';
import { analysisSources, buildDataflowIndex, dataflowFor } from './dataflow.js';
import { lex } from './lexer.js';

const fingerprint = (text) => createHash('sha256').update(JSON.stringify(lex(text).flatMap((t) =>
  t.t === 'preproc' ? lex(t.v.slice(1)).map((p) => [p.t, p.v]) : [[t.t, t.v]]))).digest('hex');
const location = (n) => n ? { file: n.file, line: n.line, endLine: n.endLine } : null;
const blankCounts = () => ({ existing: 0, modified: 0, added: 0, deleted: 0 });

async function definitionsOf(model) {
  const { sources, failedFiles } = analysisSources(model);
  if (failedFiles) throw new Error('部分源码读取失败，无法完成工程比较');
  const parser = await getParser();
  const raw = new Map(), expanded = new Map(), other = new Map();
  for (const f of sources) {
    for (const [text, target] of [[f.src, raw], [f.expanded, expanded]]) {
      const tree = parser.parse(text);
      try {
        const collected = collectDefinitions(tree.rootNode);
        if (target === raw) other.set(f.rel, fingerprint(collected.other.join('\n')));
        for (const d of collected.definitions) {
          const id = d.kind === 'fn' ? `${f.rel}::${d.name}` : d.isStatic ? `var::${f.rel}::${d.name}` : `var::${d.name}`;
          const prev = target.get(id);
          if (!prev || (prev.isExtern && !d.isExtern)) target.set(id, { value: fingerprint(d.text), isExtern: d.isExtern });
        }
      } finally { tree.delete(); }
    }
  }
  return { raw, expanded, other };
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
  const beforeDefs = await definitionsOf(beforeModel), afterDefs = await definitionsOf(afterModel);
  const warnings = [...beforeModel.warnings, ...afterModel.warnings].map((w) => `${w.file}：${w.error}`);
  for (const mapping of mappings) if (mapping.source !== mapping.target) warnings.push(`${mapping.version}/${mapping.source} → ${mapping.target}`);
  for (const file of new Set([...beforeDefs.other.keys(), ...afterDefs.other.keys()])) {
    const a = beforeDefs.other.get(file) || fingerprint(''), b = afterDefs.other.get(file) || fingerprint('');
    if (a !== b) warnings.push(`${file} 存在类型或声明变更，请结合定义差分核对影响`);
  }
  const summary = { functions: blankCounts(), variables: blankCounts() };
  const merged = new Map();
  const indirect = new Set();
  for (const [kind, listKey] of [['fn', 'functions'], ['var', 'variables'], ['external', 'externals']]) {
    const old = new Map((beforeModel[listKey] || []).map((n) => [n.id, n]));
    const now = new Map((afterModel[listKey] || []).map((n) => [n.id, n]));
    for (const id of new Set([...old.keys(), ...now.keys()])) {
      const a = old.get(id), b = now.get(id), reasons = [];
      let change = a ? b ? 'existing' : 'deleted' : 'added';
      if (a && b && kind !== 'external') {
        if (beforeDefs.raw.has(id) && afterDefs.raw.has(id) && beforeDefs.raw.get(id).value !== afterDefs.raw.get(id).value) {
          change = 'modified'; reasons.push('定义修改');
        } else if (!beforeDefs.raw.has(id) || !afterDefs.raw.has(id) || !beforeDefs.expanded.has(id) || !afterDefs.expanded.has(id)) {
          indirect.add(id); reasons.push('定义解析不完整，未判为代码修改，请核对源码');
          warnings.push(`${id} 的完整定义未能解析`);
        } else if (beforeDefs.expanded.get(id).value !== afterDefs.expanded.get(id).value) {
          indirect.add(id); reasons.push('宏展开变化（定义源码未修改）');
        }
      }
      if (change === 'added') reasons.push('仅修改后存在');
      if (change === 'deleted') reasons.push('仅修改前存在');
      if (summary[listKey]) summary[listKey][change]++;
      merged.set(id, { ...(b || a), kind: kind === 'external' ? 'fn' : kind, change, reasons, ...(indirect.has(id) ? { impact: true } : {}),
        locations: { before: location(a), after: location(b) }, versions: [a && 'before', b && 'after'].filter(Boolean) });
    }
  }
  const oldEdges = groupedEdges(beforeModel), newEdges = groupedEdges(afterModel), edges = [];
  for (const key of new Set([...oldEdges.keys(), ...newEdges.keys()])) {
    const a = oldEdges.get(key), b = newEdges.get(key);
    edges.push({ ...(b || a), comparison: true, comparisonKey: key, change: a ? b ? 'existing' : 'deleted' : 'added',
      beforeCalls: a?.calls || [], afterCalls: b?.calls || [],
      locations: { before: a ? { file: beforeModel._index.byId.get(a.from)?.file, line: a.line } : null,
        after: b ? { file: afterModel._index.byId.get(b.from)?.file, line: b.line } : null },
      versions: [a && 'before', b && 'after'].filter(Boolean) });
  }
  const direct = new Set([...merged.values()].filter((n) => !n.external && n.change !== 'existing').map((n) => n.id));
  // 关系变动本身也必须入图，例如指针实参绑定改变而函数文本没变。
  const visible = new Set([...direct, ...indirect]);
  for (const e of edges.filter((e) => e.change !== 'existing')) { visible.add(e.from); visible.add(e.to); }
  const starts = [...visible];
  for (const id of starts) if (!direct.has(id) && merged.has(id)) {
    merged.get(id).impact = true;
    merged.get(id).reasons.push('调用或变量引用关系变化');
  }
  for (const [version, m] of [['before', beforeModel], ['after', afterModel]]) {
    const queue = starts.filter((id) => m._index.byId.has(id));
    const visited = new Set();
    const add = (id, reason) => {
      const n = merged.get(id);
      if (!n) return;
      visible.add(id);
      n.impact = true;
      const evidence = `${version === 'before' ? '修改前' : '修改后'}：${reason}`;
      if (!n.reasons.includes(evidence) && n.reasons.length < 6) n.reasons.push(evidence);
      if (!visited.has(id)) queue.push(id);
    };
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (visited.has(id)) continue;
      visited.add(id);
      const n = m._index.byId.get(id);
      if (!n) continue;
      if (n.kind === 'var') {
        const peers = new Set([...(m._df.readers.get(id) || []), ...(direct.has(id) ? m._df.writers.get(id) || [] : [])]);
        for (const fn of peers) add(fn, `经共享变量 ${n.name} 关联`);
      } else {
        for (const e of m._index.inAdj.get(id) || []) if (e.kind !== 'var') add(e.from, `调用 ${n.name}()`);
        for (const a of n.varAccess || []) if (a.write) add(a.id, `由 ${n.name}() 写入`);
        if (direct.has(id) || indirect.has(id)) for (const e of m._index.outAdj.get(id) || []) {
          const target = merged.get(e.to);
          if (target) { visible.add(e.to); target.context = true; }
        }
      }
    }
  }
  const nodes = [...merged.values()];
  const model = rebuildIndex({ ...afterModel,
    files: [...new Map([...beforeModel.files, ...afterModel.files].map((f) => [f.rel, f])).values()],
    functions: nodes.filter((n) => n.kind === 'fn' && !n.external), variables: nodes.filter((n) => n.kind === 'var'),
    externals: nodes.filter((n) => n.external), edges, _df: null, _dfPending: null });
  const macroKey = (m) => `${m.file}::${m.name}`;
  const oldMacros = new Map(beforeModel.macros.map((m) => [macroKey(m), m]));
  const newMacros = new Map(afterModel.macros.map((m) => [macroKey(m), m]));
  const macroChanges = [...new Set([...oldMacros.keys(), ...newMacros.keys()])].filter((key) =>
    fingerprint(JSON.stringify(oldMacros.get(key)?.params) + (oldMacros.get(key)?.raw || '')) !==
    fingerprint(JSON.stringify(newMacros.get(key)?.params) + (newMacros.get(key)?.raw || '')));
  return { projectPath, beforePath, afterPath, beforeModel, afterModel, model, summary, roots: [...visible], warnings, mappings,
    macroChanges, totalNodes: visible.size };
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
  return { ok: true, fn: node ? { id, name: node.name, file: node.file, line: node.line } : null, dir,
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
