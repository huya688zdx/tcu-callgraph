import { comparisonStatus } from './comparison-status.js';
import { traceToTasks } from './task-trace.js';

const edgeKey = e => `${e.from}->${e.to}:${e.line}`;
const statuses = ({ change, detectedChange, statusSource }) => ({ change, detectedChange, statusSource });

export function readChangeQuery(q) {
  const number = (key, fallback, min, max) => {
    if (!q.has(key)) return fallback;
    const value = Number(q.get(key));
    if (!/^\d+$/.test(q.get(key)) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${key} 超出有效整数范围`);
    }
    return value;
  };
  const id = q.get('id'), version = q.get('version');
  if (q.has('id') && !id) throw new Error('节点 id 不能为空');
  if (version != null && (!id || !['before', 'after'].includes(version))) throw new Error('version 需与 id 同用，可选 before 或 after');
  return { id, version, offset: number('offset', 0, 0, Number.MAX_SAFE_INTEGER), limit: number('limit', 32, 1, 100),
    traceOffset: number('traceOffset', 0, 0, Number.MAX_SAFE_INTEGER), traceLimit: number('traceLimit', 32, 1, 100) };
}

/** 分页只影响输出；比较分类来自原比较模型，图上的人工调整另列来源。 */
export function changesPage(comparison, query) {
  const { model, beforeModel, afterModel, statusOverrides } = comparison;
  const { id, version, offset, limit, traceOffset, traceLimit } = query;
  const warnings = comparison.warnings || [];
  const git = comparison.git;
  const info = { warnings: warnings.slice(0, 100), warningCount: warnings.length,
    git: git ? { baseRef: git.baseRef, baseSha: git.baseSha, targetRef: git.targetRef, targetSha: git.targetSha,
      worktreeFingerprint: git.worktreeFingerprint, noSourceChanges: git.noSourceChanges } : null };
  if (!model && git?.noSourceChanges && !id) return { ...info, nodes: [], edges: [], total: 0, nextOffset: null };
  const { byId, inAdj, outAdj } = model._index;
  let edges, nodes, trace;
  const nodeStatus = node => comparisonStatus(node, statusOverrides?.nodes, node.id);
  const edgeStatus = edge => comparisonStatus(edge, statusOverrides?.edges, edge.comparisonKey ?? edgeKey(edge));
  if (id) {
    const focus = byId.get(id);
    if (!focus || focus.headerSymbol) throw new Error(`比较中找不到函数或变量：${id}`);
    edges = [...new Set([...(inAdj.get(id) || []), ...(outAdj.get(id) || [])])];
    const neighbors = new Set([id]);
    for (const e of edges) { neighbors.add(e.from); neighbors.add(e.to); }
    nodes = Array.from(neighbors, nodeId => byId.get(nodeId));
    const traceVersion = version ?? (afterModel._index.byId.has(id) ? 'after' : 'before');
    const source = traceVersion === 'after' ? afterModel : beforeModel;
    if (!source._index.byId.has(id)) throw new Error(`指定的 ${traceVersion} 版本中没有该节点`);
    trace = { traceVersion, ...traceToTasks(source, id, { offset: traceOffset, limit: traceLimit }) };
  } else {
    nodes = [...model.functions, ...model.variables].filter(n =>
      n.change !== 'existing' || (statusOverrides?.nodes.get(n.id) ?? 'existing') !== 'existing');
    edges = model.edges.filter(e => e.change !== 'existing' || e.reasons?.length ||
      (statusOverrides?.edges.get(e.comparisonKey) ?? 'existing') !== 'existing');
  }
  const total = nodes.length + edges.length;
  const nodePage = nodes.slice(offset, offset + limit).map(n => ({
    id: n.id, kind: n.kind, name: n.name, file: n.file, line: n.line,
    locations: n.locations, reasons: n.reasons, ...statuses(nodeStatus(n)),
  }));
  const edgeOffset = Math.max(0, offset - nodes.length);
  const edgePage = edges.slice(edgeOffset, edgeOffset + limit - nodePage.length).map(e => ({
    edgeKey: edgeKey(e), comparisonKey: e.comparisonKey, from: e.from, to: e.to, kind: e.kind, via: e.via,
    locations: e.locations, versions: e.versions, reasons: e.reasons || [],
    beforeCallCount: e.beforeCalls.length, afterCallCount: e.afterCalls.length,
    ...statuses(edgeStatus(e)),
  }));
  return { ...info, nodes: nodePage, edges: edgePage, total, nextOffset: offset + limit < total ? offset + limit : null, trace };
}
