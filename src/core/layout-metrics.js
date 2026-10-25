// ELK 节点尺寸与连线度量工具。
import { edgeStyleKey, routeOverlapConflicts, routeEdges, collectSegments, pathBlockedByNodes } from './routing.js';

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

export function routeScore(edges) {
  const m = routeLengthAndCrossings(edges);
  return m.crossings * 40 + m.overlapLength / 20 + m.bends * 2 + m.rawLength / 200;
}

/** 只试最绕的少数边，不动节点，也不覆盖手工折线或指定端口。 */
export function improveEdgeRoutes(view, subset) {
  const detour = (e) => {
    const p = e.points;
    let length = 0;
    for (let i = 1; i < p.length; i++) length += Math.abs(p[i][0] - p[i - 1][0]) + Math.abs(p[i][1] - p[i - 1][1]);
    return length - Math.abs(p.at(-1)[0] - p[0][0]) - Math.abs(p.at(-1)[1] - p[0][1]);
  };
  const edges = subset.filter((e) => !e.custom && !e.fromSide && !e.toSide && e.points.length > 2)
    .sort((a, b) => detour(b) - detour(a)).slice(0, 6);
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  let metrics = routeLengthAndCrossings(view.edges), best = routeScore(view.edges);
  for (const edge of edges) {
    const a = byId.get(edge.from), b = byId.get(edge.to);
    if (a === b) continue;
    const right = b.x + b.w / 2 >= a.x + a.w / 2, below = b.y + b.h / 2 >= a.y + a.h / 2;
    const horizontal = [right ? 'right' : 'left', right ? 'left' : 'right'];
    const vertical = [below ? 'bottom' : 'top', below ? 'top' : 'bottom'];
    const others = view.edges.filter((e) => e !== edge);
    for (const [fromSide, toSide] of [[vertical[0], horizontal[1]], [horizontal[0], vertical[1]], vertical, horizontal]) {
      const candidate = { ...edge, fromSide, toSide, points: edge.points.map((p) => [...p]) };
      routeEdges(view.nodes, [candidate], { existing: collectSegments(others) });
      if (candidate.blocked || pathBlockedByNodes(candidate.points, view.nodes, new Set([edge.from, edge.to]))) continue;
      const trial = [...others, candidate], next = routeLengthAndCrossings(trial);
      if (next.crossings > metrics.crossings || next.overlapLength > metrics.overlapLength + 0.5) continue;
      const score = routeScore(trial);
      if (score < best) { edge.points = candidate.points; best = score; metrics = next; }
    }
  }
}
