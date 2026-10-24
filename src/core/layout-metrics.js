// ELK 节点尺寸与连线度量工具。
import { edgeStyleKey, routeOverlapConflicts } from './routing.js';

export function textWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += ch.charCodeAt(0) > 255 ? 14 : 7.6;
  }
  return w;
}

export function routeLengthAndCrossings(edges) {
  const horizontal = [];
  const vertical = [];
  const pathKeys = new Set();
  let bends = 0;
  let rawLength = 0;
  for (const e of edges) {
    const pts = e.points || [];
    const signature = edgeStyleKey(e) + ':' + pts.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`).join(';');
    if (signature && !pathKeys.has(signature)) {
      pathKeys.add(signature);
      bends += Math.max(0, pts.length - 2);
      let pathLength = 0;
      for (let i = 0; i < pts.length - 1; i++) pathLength += Math.abs(pts[i + 1][0] - pts[i][0]) + Math.abs(pts[i + 1][1] - pts[i][1]);
      rawLength += pathLength;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      if (Math.abs(y1 - y2) < 0.5) {
        horizontal.push({ y: Math.round((y1 + y2) / 2), x1: Math.min(x1, x2), x2: Math.max(x1, x2), edge: e });
      } else if (Math.abs(x1 - x2) < 0.5) {
        vertical.push({ x: Math.round((x1 + x2) / 2), y1: Math.min(y1, y2), y2: Math.max(y1, y2), edge: e });
      }
    }
  }

  // 共线共享干线只按画面上实际占用的长度计一次。
  const unionLength = (segments, axis, coord) => {
    const byLine = new Map();
    for (const s of segments) {
      const key = edgeStyleKey(s.edge) + ':' + Math.round(s[axis] / 2) * 2;
      if (!byLine.has(key)) byLine.set(key, []);
      byLine.get(key).push([s[coord[0]], s[coord[1]]]);
    }
    let total = 0;
    for (const list of byLine.values()) {
      list.sort((a, b) => a[0] - b[0]);
      let lo = null;
      let hi = null;
      for (const [a, b] of list) {
        if (lo === null) [lo, hi] = [a, b];
        else if (a <= hi + 1) hi = Math.max(hi, b);
        else {
          total += hi - lo;
          [lo, hi] = [a, b];
        }
      }
      if (lo !== null) total += hi - lo;
    }
    return total;
  };
  const length = unionLength(horizontal, 'y', ['x1', 'x2']) + unionLength(vertical, 'x', ['y1', 'y2']);

  const intersections = new Set();
  for (const h of horizontal) {
    for (const v of vertical) {
      if (v.x <= h.x1 + 0.5 || v.x >= h.x2 - 0.5 || h.y <= v.y1 + 0.5 || h.y >= v.y2 - 0.5) continue;
      const related = h.edge.from === v.edge.from || h.edge.from === v.edge.to || h.edge.to === v.edge.from || h.edge.to === v.edge.to;
      if (!related) intersections.add(`${Math.round(v.x)},${Math.round(h.y)}`);
    }
  }
  const overlapLength = routeOverlapConflicts(edges).length;
  return { length, rawLength, sharedLength: Math.max(0, rawLength - length - overlapLength), overlapLength, crossings: intersections.size, bends };
}
