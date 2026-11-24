import { projectTasks } from './task-periods.js';

const callKinds = new Set(['direct', 'macro', 'fnptr']);

/** 所有入口共享一次反向广搜；每个调用者仅保留通向目标的一个最短下一跳。 */
export function traceToTasks(model, id, { offset = 0, limit = 32 } = {}) {
  const { byId, inAdj } = model._index;
  const target = byId.get(id);
  const callable = target && target.kind !== 'var';
  const next = new Map();
  if (callable) {
    next.set(id, null);
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      const callee = queue[i];
      // 普通函数的宏/指针调用已经按调用点绑定。宏节点自身只接受实际引用它的调用点；
      // 把宏定义的所有可能目标相互拼接，会为不同宏实参虚构调用路径。
      const callers = i === 0 && target.headerSymbol
        ? (model.headerEdges || []).filter(e => e.to === id)
        : inAdj.get(callee) || [];
      for (const edge of callers) {
        if (!callKinds.has(edge.kind) || next.has(edge.from)) continue;
        next.set(edge.from, edge);
        queue.push(edge.from);
      }
    }
  }

  const entries = new Map();
  if (callable) for (const task of projectTasks(model)) {
    if (!next.has(task.id)) continue;
    if (!entries.has(task.id)) entries.set(task.id, { ...task, periods: [] });
    entries.get(task.id).periods.push({ kind: task.kind, us: task.us, source: task.source, evidence: task.evidence });
  }
  const upstreamTasks = Array.from(entries.values()).slice(offset, offset + limit);
  const upstreamChains = upstreamTasks.map(task => {
    const path = [task.id], edges = [];
    for (let edge = next.get(task.id); edge; edge = next.get(edge.to)) {
      const { from, to, line, kind, via, macroDefinitions, cond } = edge;
      edges.push({ from, to, line, kind, via, macroDefinitions, cond, edgeKey: `${from}->${to}:${line}` });
      path.push(to);
    }
    return { taskId: task.id, path, edges };
  });
  const nextOffset = offset + upstreamTasks.length < entries.size ? offset + upstreamTasks.length : null;
  return {
    upstreamTasks, upstreamChains, totalTasks: entries.size, nextOffset, traceTruncated: nextOffset !== null,
    traceStatus: !callable ? 'not-callable' : entries.size ? 'found' : 'no-task',
  };
}
