export function formatPeriod(us) {
  if (!(us > 0)) return '周期待确认';
  if (us % 1000000 === 0) return `${us / 1000000} s`;
  return us >= 1000 ? `${us / 1000} ms` : `${us} µs`;
}

export function periodText(contexts) {
  return [...new Set((contexts || []).map(c => c.us))].map(formatPeriod).join(' / ');
}

// 修改前后都有定义时，直接在函数框上提示周期变化。
export function periodCaption(node) {
  const current = periodText(node.taskPeriods);
  if (node.versions?.includes('before')) {
    const prior = periodText(node.previousTaskPeriods);
    if (!node.versions.includes('after')) return prior;
    if (prior !== current) return `${prior || '待确认'} → ${current || '待确认'}`;
  }
  return current;
}

export function periodSubtitle(node) {
  const period = periodCaption(node);
  if (node.taskEntry) return `TASK · ${period || '周期待确认'}`;
  return period ? `周期 ${period}` : '';
}
