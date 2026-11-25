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

const sortedPeriods = values => [...new Set(values.filter(us => us > 0))].sort((a, b) => a - b);
const compactPeriod = us => formatPeriod(us).replace(' ', '');
const shortRates = values => values.slice(0, 2).map(compactPeriod).join('·') + (values.length > 2 ? '…' : '');

export function nodePeriodBadge(node) {
  if (node.crossPeriod) {
    const { writerUs, readerUs, hasIsr, protected: guarded } = node.crossPeriod;
    let write = shortRates(writerUs) || 'ISR';
    const read = shortRates(readerUs) || 'ISR';
    const unit = /(?:ms|µs|s)$/.exec(read)?.[0];
    if (unit && writerUs.length === 1 && readerUs.length === 1 && write.endsWith(unit) &&
        /(?:ms|µs|s)$/.exec(write)?.[0] === unit) write = write.slice(0, -unit.length);
    const isr = hasIsr && writerUs.length && readerUs.length ? 'ISR·' : '';
    return { text: `${guarded ? '🔒' : '⚡'}${isr}${write}↔${read}`,
      tier: guarded ? 'cross-safe' : 'cross-hazard' };
  }
  if (node.kind === 'var') return null;
  const contexts = node.taskPeriods || [];
  const rates = sortedPeriods(contexts.map(c => c.us));
  const isr = node.isIsr || contexts.some(c => c.kind === 'isr');
  const multi = Boolean(node.multiRate || rates.length > 1);
  const text = [isr && 'ISR', shortRates(rates)].filter(Boolean).join('·');
  if (!text) return null;
  return { text, multi, tier: multi ? 'multi' : isr ? 'isr' :
    rates[0] <= 2000 ? 'fast' : rates[0] <= 20000 ? 'mid' : 'slow' };
}

/** 画布与导出 SVG 仅在跨周期共享变量节点上绘制角标；普通函数周期走通用连线标签。 */
export function canvasPeriodBadge(node) {
  return node?.crossPeriod ? nodePeriodBadge(node) : null;
}

export const PERIOD_COLORS = {
  isr: { fill: '#FEE2E2', ink: '#B91C1C' },
  fast: { fill: '#FEF3C7', ink: '#B45309' },
  mid: { fill: '#DBEAFE', ink: '#1D4ED8' },
  slow: { fill: '#CCFBF1', ink: '#0F766E' },
  multi: { fill: '#EDE9FE', ink: '#6D28D9' },
  'cross-hazard': { fill: '#FFEDD5', ink: '#C2410C' },
  'cross-safe': { fill: '#DCFCE7', ink: '#166534' },
};

export function periodBadgeBox(node, width, size, recent = false) {
  const right = recent ? 32 : 7;
  const available = node.w - right - (node.isTaskEntry || node.taskEntry ? 50 : 8);
  const w = Math.min(available, width + 12);
  const h = size + 4;
  if (w < 24 || node.h < h + 9) return null;
  return { x: node.x + node.w - right - w, y: node.y - h / 2, w, h };
}

export function periodBadgeSvg(node, badge, escape, measure) {
  const size = 10.5;
  const width = measure ? measure(badge.text, size) : [...badge.text].length * 6.5;
  const box = periodBadgeBox(node, width, size);
  if (!box) return '';
  const { x, y, w, h } = box;
  const { fill, ink } = PERIOD_COLORS[badge.tier];
  const squeeze = width > w - 10 ? ` textLength="${w - 10}" lengthAdjust="spacingAndGlyphs"` : '';
  return `<g data-period-badge="${badge.tier}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${ink}"/><text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="middle" font-size="${size}" font-weight="600" fill="${ink}"${squeeze}>${escape(badge.text)}</text></g>`;
}

export function periodContainerStyle(kind) {
  if (kind === 'period-lane') return { border: '#93B6EA', ...PERIOD_COLORS.mid, body: '#EFF6FF' };
  if (kind === 'signal-bus') return { border: '#9CBAB7', ...PERIOD_COLORS.slow, body: '#F0FAF8', dashed: true };
  return null;
}
