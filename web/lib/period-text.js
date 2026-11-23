export function formatPeriod(us) {
  if (!(us > 0)) return '';
  if (us % 1000000 === 0) return `${us / 1000000} s`;
  return us >= 1000 ? `${us / 1000} ms` : `${us} µs`;
}

export function periodText(contexts) {
  return [...new Set((contexts || []).map(c => c.us).filter(us => us > 0))].map(formatPeriod).filter(Boolean).join(' / ');
}

function compactPeriods(values, contexts) {
  const text = Array.isArray(values) ? values.filter(Boolean).join(' / ') : periodText(contexts);
  return text.replace(/(\d)\s+(?=(?:s|ms|µs|us)\b)/g, '$1');
}

export function periodCaption(node) {
  const change = node.change || 'existing';
  const before = node.periodBefore ?? node.periods?.before;
  const after = node.periodAfter ?? node.periods?.after;
  const prior = compactPeriods(before, node.previousTaskPeriods);
  const current = compactPeriods(after, node.taskPeriods);
  if (node.versions ? !node.versions.includes('after') : change === 'deleted') return prior || current;
  const hasBefore = node.versions ? node.versions.includes('before') : change !== 'added';
  if (hasBefore && (before != null || node.previousTaskPeriods != null) && prior !== current) {
    return `${prior || '—'} → ${current || '—'}`;
  }
  return current;
}

export function periodSubtitle(node, compareInfo = Boolean(node?.periodImpact || node?.previousTaskPeriods ||
  node?.periodBefore || node?.periodAfter || node?.periods)) {
  if (!node || !compareInfo) return '';
  const caption = periodCaption(node);
  const directChange = node.impactRole === 'direct_change' || (node.change && node.change !== 'existing');
  const impacted = ['macro_lsb_impact', 'period_impact', 'dataflow_impact', 'caller_impact'].includes(node.impactRole);
  return directChange || node.isTaskEntry || node.taskEntry || node.impact || node.macroImpact ||
    node.periodImpact || impacted || caption.includes('→') ? caption : '';
}
