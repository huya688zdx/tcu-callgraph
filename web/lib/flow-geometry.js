function luminance(hex) {
  const rgb = hex.match(/[0-9a-f]{2}/gi)?.map(x => parseInt(x, 16) / 255);
  if (rgb?.length !== 3) return 0;
  return rgb.map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
    .reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
}

/** 选中线可自定义颜色，动态选取对比最强的脉冲色，另配双描边。 */
export function flowPulseColor(lineColor) {
  const l = luminance(lineColor);
  const contrast = color => { const n = luminance(color); return (Math.max(l, n) + 0.05) / (Math.min(l, n) + 0.05); };
  return ['#0284C7', '#00E5FF', '#FF8A00', '#7C2D12'].sort((a, b) => contrast(b) - contrast(a))[0];
}

/** 静态重绘时缓存线段长度，动画按实际距离取点。 */
export function flowPath(points) {
  const segments = [];
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i - 1];
    const dx = points[i][0] - x, dy = points[i][1] - y;
    const size = Math.hypot(dx, dy);
    if (!size) continue;
    segments.push({ x, y, dx: dx / size, dy: dy / size, size });
    length += size;
  }
  return { segments, length };
}

/** 同时返回前进方向，供箭头旋转与相向流动分侧显示。 */
export function flowPointAt(path, distance) {
  for (const segment of path.segments) {
    if (distance > segment.size) { distance -= segment.size; continue; }
    return [segment.x + segment.dx * distance, segment.y + segment.dy * distance, segment.dx, segment.dy];
  }
}

/**
 * 将多条选中连线的流动线段按方向与共线区间取并集去重：
 * 共用干线上无论叠了多少条分支，同一段干线只生成一条流动线段，彻底杜绝重叠绘制与 GPU 暴涨。
 */
export function mergeFlowStreams(rawStreams) {
  const byStyle = new Map();
  for (const { pts, color, tailColor, offset = 0 } of rawStreams) {
    if (!pts || pts.length < 2) continue;
    if (!byStyle.has(color)) byStyle.set(color, { color, tailColor, ortho: new Map(), diag: [] });
    const group = byStyle.get(color);
    let phase = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
      const dx = x2 - x1, dy = y2 - y1;
      const size = Math.hypot(dx, dy);
      if (size < 0.5) continue;
      const udx = dx / size, udy = dy / size;
      if (Math.abs(dy) < 0.5) {
        const dir = dx >= 0 ? 1 : -1;
        const yKey = Math.round((y1 + y2) / 2);
        const key = `H|${dir}|${yKey}|${offset}`;
        if (!group.ortho.has(key)) group.ortho.set(key, { horiz: true, dir, fixed: (y1 + y2) / 2, offset, intervals: [] });
        const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
        group.ortho.get(key).intervals.push({ lo, hi, phase });
      } else if (Math.abs(dx) < 0.5) {
        const dir = dy >= 0 ? 1 : -1;
        const xKey = Math.round((x1 + x2) / 2);
        const key = `V|${dir}|${xKey}|${offset}`;
        if (!group.ortho.has(key)) group.ortho.set(key, { horiz: false, dir, fixed: (x1 + x2) / 2, offset, intervals: [] });
        const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
        group.ortho.get(key).intervals.push({ lo, hi, phase });
      } else {
        group.diag.push({ x: x1, y: y1, dx: udx, dy: udy, size, phase, offset });
      }
      phase += size;
    }
  }

  const out = [];
  for (const { color, tailColor, ortho, diag } of byStyle.values()) {
    const segments = [...diag];
    for (const { horiz, dir, fixed, offset, intervals } of ortho.values()) {
      intervals.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
      const merged = [];
      for (const item of intervals) {
        const prev = merged.at(-1);
        if (!prev || item.lo > prev.hi + 0.5) {
          merged.push({ ...item });
        } else if (item.hi > prev.hi) {
          prev.hi = item.hi;
        }
      }
      for (const { lo, hi, phase } of merged) {
        const size = hi - lo;
        if (size < 1) continue;
        if (horiz) {
          segments.push({ x: dir > 0 ? lo : hi, y: fixed, dx: dir, dy: 0, size, phase, offset });
        } else {
          segments.push({ x: fixed, y: dir > 0 ? lo : hi, dx: 0, dy: dir, size, phase, offset });
        }
      }
    }
    if (segments.length) out.push({ color, tailColor, segments });
  }
  return out;
}
