// 布局与标注沿用函数 → 变量的存储键，读写箭头按数据实际传递的方向绘制。
export const isDataEdge = e => e.kind === 'var' || e.kind === 'dataflow' || e.kind?.startsWith('df-') === true;

export const EDGE_DASH = [7, 4];
const dashPeriod = EDGE_DASH[0] + EDGE_DASH[1];

/** 同一直线从世界坐标原点开始排虚线。反向走过同一段也使用递增轴向。 */
export function dashSegments(points) {
  const segments = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const axis = a[0] === b[0] ? 1 : 0;
    if (a[axis] === b[axis]) continue;
    const reversed = a[axis] > b[axis];
    const start = reversed ? b : a, end = reversed ? a : b;
    segments.push({ start, end, reversed, offset: ((start[axis] % dashPeriod) + dashPeriod) % dashPeriod });
  }
  return segments;
}

export function edgeDirection(e) {
  if (e.kind !== 'var') return 'forward';
  if (e.via === '读写') return 'both';
  if (e.via === '读') return 'reverse';
  if (e.via === '写') return 'forward';
  return 'unknown';
}

export function edgeCaption(e, name) {
  const direction = edgeDirection(e);
  const arrow = { forward: ' → ', reverse: ' ← ', both: ' ↔ ', unknown: ' — ' }[direction];
  return name(e.from) + arrow + name(e.to);
}

export function svgMarkers(e, marker, first = true, last = true, reversed = false) {
  const direction = edgeDirection(e);
  const start = first && (direction === 'both' || direction === 'reverse');
  const end = last && (direction === 'both' || direction === 'forward');
  return [
    (reversed ? end : start) ? ` marker-start="url(#${marker})"` : '',
    (reversed ? start : end) ? ` marker-end="url(#${marker})"` : '',
  ].join('');
}

/** 生成与画布一致的圆角正交折线 SVG path d（折点使用二次贝塞尔过渡） */
export function buildRoundedSvgPath(pts, radius = 7) {
  if (!Array.isArray(pts) || pts.length < 2) return '';
  const clean = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = clean[clean.length - 1];
    if (Math.hypot(pts[i][0] - prev[0], pts[i][1] - prev[1]) >= 0.01) clean.push(pts[i]);
  }
  if (clean.length < 2) return '';
  const f = (x) => Math.round(x * 10) / 10;
  if (radius <= 0 || clean.length === 2) {
    return clean.map(([x, y], idx) => `${idx ? 'L' : 'M'} ${f(x)} ${f(y)}`).join(' ');
  }
  const cmds = [`M ${f(clean[0][0])} ${f(clean[0][1])}`];
  for (let i = 1; i < clean.length - 1; i++) {
    const prev = clean[i - 1], cur = clean[i], next = clean[i + 1];
    const dx1 = prev[0] - cur[0], dy1 = prev[1] - cur[1], d1 = Math.hypot(dx1, dy1);
    const dx2 = next[0] - cur[0], dy2 = next[1] - cur[1], d2 = Math.hypot(dx2, dy2);
    if (d1 < 0.01 || d2 < 0.01) continue;
    const u1x = dx1 / d1, u1y = dy1 / d1, u2x = dx2 / d2, u2y = dy2 / d2;
    if (Math.abs(u1x * u2y - u1y * u2x) < 1e-4) {
      cmds.push(`L ${f(cur[0])} ${f(cur[1])}`);
      continue;
    }
    const rad = Math.min(radius, d1 * 0.45, d2 * 0.45);
    cmds.push(`L ${f(cur[0] + u1x * rad)} ${f(cur[1] + u1y * rad)} Q ${f(cur[0])} ${f(cur[1])} ${f(cur[0] + u2x * rad)} ${f(cur[1] + u2y * rad)}`);
  }
  const last = clean[clean.length - 1];
  cmds.push(`L ${f(last[0])} ${f(last[1])}`);
  return cmds.join(' ');
}

/** 三个导出入口共用描边；只有整条边的真实端点带箭头。 */
export function svgEdgeStroke(e, d, color, width, marker, data) {
  const path = (geometry, dash, arrows) =>
    `<path d="${geometry}" fill="none" stroke="${color}" stroke-width="${width}"${dash}${arrows} ${data}/>`;
  if (!isDataEdge(e)) return path(d, '', svgMarkers(e, marker));
  const segments = dashSegments(e.points || []);
  return segments.map(({ start, end, offset, reversed }, i) => path(
    `M ${Number(start[0])} ${Number(start[1])} L ${Number(end[0])} ${Number(end[1])}`,
    ` stroke-dasharray="${EDGE_DASH.join(' ')}" stroke-dashoffset="${offset}"`,
    svgMarkers(e, marker, i === 0, i === segments.length - 1, reversed)
  )).join('');
}
