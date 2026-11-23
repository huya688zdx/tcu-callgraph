export function formatPeriod(us) {
  if (!(us > 0)) return '';
  if (us % 1000000 === 0) return `${us / 1000000} s`;
  return us >= 1000 ? `${us / 1000} ms` : `${us} µs`;
}

export function periodText(contexts) {
  return [...new Set((contexts || []).map(c => c.us).filter(us => us > 0))].map(formatPeriod).filter(Boolean).join(' / ');
}

export function periodCaption(node) {
  const current = periodText(node.taskPeriods);
  if (node.versions?.includes('before')) {
    const prior = periodText(node.previousTaskPeriods);
    if (!node.versions.includes('after')) return prior;
    if (prior !== current && (prior || current)) return `${prior || '—'} → ${current || '—'}`;
  }
  return current;
}

export function periodSubtitle() {
  return '';
}
