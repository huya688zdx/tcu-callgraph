export const CHANGE_STATES = ['existing', 'modified', 'added', 'deleted'];

export function statusOverrides(value, validIds) {
  if (value == null) return new Map();
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('状态调整必须是对象');
  const entries = Object.entries(value);
  if (entries.length > 600) throw new Error('一次最多调整 600 个对象的状态');
  for (const [id, change] of entries) {
    if (!validIds.has(id) || !CHANGE_STATES.includes(change)) throw new Error('状态调整包含无效对象或状态');
  }
  return new Map(entries);
}

export function comparisonStatus(target, overrides, id) {
  const detectedChange = target.detectedChange || target.change || 'existing';
  return { ...target, detectedChange, change: overrides?.get(id) || detectedChange,
    statusSource: overrides?.has(id) ? 'manual' : 'automatic' };
}

export function statusSummary(comparison) {
  const summary = {};
  for (const [key, list] of [['functions', comparison.model.functions], ['variables', comparison.model.variables]]) {
    const counts = Object.fromEntries(CHANGE_STATES.map((s) => [s, 0]));
    for (const n of list) counts[comparison.statusOverrides.nodes.get(n.id) || n.change || 'existing']++;
    summary[key] = counts;
  }
  return summary;
}
