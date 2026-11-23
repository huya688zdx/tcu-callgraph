/**
 * 失效（孤儿）标注检测
 *
 * 源码删掉一个函数之后，它的标注还留在库里，图上永远看不到，也没法清理。
 * 这里把库里存的目标跟当前模型对一遍，找出指向「已经不存在的东西」的条目。
 *
 * 抽成独立模块而不是塞在 server.js 里，是因为这段判定规则容易出错（见下面注释），
 * 需要能直接拿真实模型写单测。
 */

/** 当前模型里有效的节点 id 集合 */
export function validNodeIds(model) {
  const ids = new Set(model._index?.byId?.keys() || []);
  // MODEL.variables 只装了正则版索引认得的类型（白名单），
  // 像 ShiftOps const 这种 typedef 变量、以及 GearCtx 这类复杂类型，
  // 只有 AST 数据流索引里才有——漏掉它们会把变量标注全判成孤儿。
  const df = model._df;
  if (df && df.byId) for (const id of df.byId.keys()) ids.add(id);
  for (const v of model.variables || []) ids.add(v.id);
  return ids;
}

/** 当前模型里有效的连线 key 集合（与前端 edgeKey 一致） */
export function validEdgeKeys(model) {
  return new Set([...(model.edges || []), ...(model.headerEdges || [])].map((e) => `${e.from}->${e.to}:${e.line}`));
}

/**
 * @param {object} model 当前工程模型
 * @param {object} targets store.listAllTargets() 的结果
 * @returns {{annotations:Array, deleted:Array, layoutSlots:Array, layoutNodes:Array}}
 */
export function collectOrphans(model, targets) {
  const nodes = validNodeIds(model);
  const edges = validEdgeKeys(model);
  const out = { annotations: [], deleted: [], layoutSlots: [], layoutNodes: [] };
  const isBad = (kind, id) => (kind === 'node' ? !nodes.has(id) : !edges.has(id));

  for (const a of targets.annotations || []) {
    if (isBad(a.kind, a.id)) out.annotations.push({ kind: a.kind, id: a.id });
  }
  for (const d of targets.deleted || []) {
    if (isBad(d.kind, d.id)) out.deleted.push({ kind: d.kind, id: d.id });
  }
  for (const s of targets.layouts || []) {
    const roots = String(s.viewKey || '')
      .split('+')
      .filter(Boolean);
    // 入口函数全没了，整个视图槽位的坐标才没意义；
    // 多选入口里少一个不算——剩下的入口还能用这个槽位，只清死节点就够
    if (roots.length && !roots.some((r) => nodes.has(r))) {
      out.layoutSlots.push({ viewKey: s.viewKey, mode: s.mode });
      continue;
    }
    const dead = Object.keys(s.nodes || {}).filter((id) => !nodes.has(id));
    if (dead.length) out.layoutNodes.push({ viewKey: s.viewKey, mode: s.mode, ids: dead });
  }
  return out;
}

export const countOrphans = (o) =>
  o.annotations.length +
  o.deleted.length +
  o.layoutSlots.length +
  o.layoutNodes.reduce((s, n) => s + n.ids.length, 0);
