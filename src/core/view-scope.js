import { createHash } from 'node:crypto';
import { resolveGroupMode } from './store.js';
import { normalizeExpansions } from './expansion.js';

const sortStrings = (arr) => [...new Set((Array.isArray(arr) ? arr : []).filter((v) => typeof v === 'string' && v))].sort();

/**
 * 归一化画布视图作用域（供书签保存、脏状态比较、时间轴 diff 使用）。
 */
export function normalizeViewScope(scope = {}) {
  const s = scope && typeof scope === 'object' ? scope : {};
  const groupMode = resolveGroupMode(s.groupMode, s.group);
  const clampDepth = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(20, Math.trunc(n))) : fallback;
  };
  return {
    roots: sortStrings(s.roots),
    up: clampDepth(s.up, 1),
    down: clampDepth(s.down, 1),
    group: groupMode !== 'flat',
    groupMode,
    vars: sortStrings(s.vars),
    hiddenVars: sortStrings(s.hiddenVars),
    expansions: normalizeExpansions(s.expansions || []),
  };
}

/** 计算视图作用域的稳定 SHA-1 指纹，用于判断书签是否有未保存改动。 */
export function viewScopeFingerprint(scope = {}) {
  const norm = normalizeViewScope(scope);
  return createHash('sha1').update(JSON.stringify(norm)).digest('hex');
}

const shortName = (id) => {
  if (typeof id !== 'string') return '';
  if (id.startsWith('var::')) return id.slice(5).split('::').pop();
  return id.split('::').pop();
};

/** 对比前后两个视图作用域，生成可读的结构化变更摘要。 */
export function diffViewScopes(before = {}, after = {}) {
  const prev = normalizeViewScope(before);
  const next = normalizeViewScope(after);
  const prevNodeIds = new Set([...prev.roots, ...prev.expansions.map((e) => e.root)]);
  const nextNodeIds = new Set([...next.roots, ...next.expansions.map((e) => e.root)]);
  const addedNodes = [...nextNodeIds].filter((id) => !prevNodeIds.has(id));
  const removedNodes = [...prevNodeIds].filter((id) => !nextNodeIds.has(id));
  const prevVarSet = new Set(prev.vars);
  const nextVarSet = new Set(next.vars);
  const addedVars = next.vars.filter((v) => !prevVarSet.has(v));
  const removedVars = prev.vars.filter((v) => !nextVarSet.has(v));
  const prevExpMap = new Map(prev.expansions.map((e) => [e.root, `${e.up}:${e.down}`]));
  const nextExpMap = new Map(next.expansions.map((e) => [e.root, `${e.up}:${e.down}`]));
  const expansionDepthChanged =
    [...prevExpMap.entries()].some(([root, depth]) => nextExpMap.has(root) && nextExpMap.get(root) !== depth) ||
    (!addedNodes.length && !removedNodes.length &&
      (prevExpMap.size !== nextExpMap.size || [...nextExpMap.entries()].some(([root, depth]) => prevExpMap.get(root) !== depth)));
  const depthChanged = prev.up !== next.up || prev.down !== next.down;
  const layoutChanged = prev.groupMode !== next.groupMode;
  const hiddenChanged = JSON.stringify(prev.hiddenVars) !== JSON.stringify(next.hiddenVars);

  const parts = [];
  if (addedNodes.length) {
    const names = addedNodes.slice(0, 3).map(shortName).join('、');
    parts.push(`+${addedNodes.length} 个函数${names ? `（${names}${addedNodes.length > 3 ? '…' : ''}）` : ''}`);
  }
  if (removedNodes.length) {
    parts.push(`-${removedNodes.length} 个函数`);
  }
  if (addedVars.length) parts.push(`+${addedVars.length} 个变量`);
  if (removedVars.length) parts.push(`-${removedVars.length} 个变量`);
  if (depthChanged) parts.push(`深度 ↑${next.up}↓${next.down}`);
  if (expansionDepthChanged) parts.push('调整局部展开层数');
  if (layoutChanged) parts.push(`布局→${next.groupMode === 'period' ? '按轮次' : next.groupMode === 'flat' ? '扁平' : '按文件'}`);
  if (!parts.length && hiddenChanged) parts.push('更新变量显隐');

  return {
    addedNodes,
    removedNodes,
    addedVars,
    removedVars,
    depthChanged,
    expansionDepthChanged,
    layoutChanged,
    hiddenChanged,
    changed: parts.length > 0,
    summary: parts.join('，') || '视图范围未变化',
  };
}
