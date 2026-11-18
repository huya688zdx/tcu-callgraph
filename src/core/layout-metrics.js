// ELK 节点尺寸与连线度量工具。
import { edgeStyleKey, canShareTrunk, routeBounds, boundsMeet, routeOverlapConflicts, routeEdges, collectSegments,
  pathBlockedByNodes, pathCrossesBody, collapse, STUB } from './routing.js';

export function textWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += ch.charCodeAt(0) > 255 ? 14 : 7.6;
  }
  return w;
}

export function routeLengthAndCrossings(edges, geometryOnly = false) {
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
  // 汇流候选只比较线长和拐点，无需反复计算全组交叉。
  if (geometryOnly) return { length, bends };

  const intersections = new Set();
  vertical.sort((a, b) => a.x - b.x);
  for (const h of horizontal) {
    let lo = 0, hi = vertical.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (vertical[mid].x <= h.x1 + 0.5) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < vertical.length && vertical[i].x < h.x2 - 0.5; i++) {
      const v = vertical[i];
      if (h.y <= v.y1 + 0.5 || h.y >= v.y2 - 0.5) continue;
      const related = h.edge.from === v.edge.from || h.edge.from === v.edge.to || h.edge.to === v.edge.from || h.edge.to === v.edge.to;
      if (!related) intersections.add(`${Math.round(v.x)},${Math.round(h.y)}`);
    }
  }
  const overlapLength = routeOverlapConflicts(edges).length;
  return { length, rawLength, sharedLength: Math.max(0, rawLength - length - overlapLength), overlapLength, crossings: intersections.size, bends };
}

function scoreMetrics(m) {
  return m.crossings * 40 + m.overlapLength / 20 + m.bends * 2 + m.rawLength / 200;
}

export const routeScore = (edges) => scoreMetrics(routeLengthAndCrossings(edges));

/** 优先拆开真正重叠的线，其次简化绕行；拖动及增量请求只允许改动 subset。 */
export function improveEdgeRoutes(view, subset, simplify = () => true) {
  if (!subset.length) return;
  const detour = (e) => {
    const p = e.points;
    let length = 0;
    for (let i = 1; i < p.length; i++) length += Math.abs(p[i][0] - p[i - 1][0]) + Math.abs(p[i][1] - p[i - 1][1]);
    return length - Math.abs(p.at(-1)[0] - p[0][0]) - Math.abs(p.at(-1)[1] - p[0][1]);
  };
  const { byEdge } = routeOverlapConflicts(view.edges);
  const ranked = subset.filter((e) => !e.custom && !e.fromSide && !e.toSide && e.from !== e.to &&
    e.points?.length >= 2 && (byEdge.has(e) || (simplify(e) && e.points.length > 2)))
    .map((edge) => ({ edge, overlap: byEdge.get(edge) || 0, detour: detour(edge) }))
    .sort((a, b) => b.overlap - a.overlap || b.detour - a.detour).slice(0, 6);
  if (!ranked.length) return;
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const bounds = new Map(view.edges.map((e) => [e, routeBounds(e.points)]));
  for (const { edge } of ranked) {
    const a = byId.get(edge.from), b = byId.get(edge.to);
    const right = b.x + b.w / 2 >= a.x + a.w / 2, below = b.y + b.h / 2 >= a.y + a.h / 2;
    const horizontal = [right ? 'right' : 'left', right ? 'left' : 'right'];
    const vertical = [below ? 'bottom' : 'top', below ? 'top' : 'bottom'];
    const others = view.edges.filter((e) => e !== edge);
    const existing = collectSegments(others);
    const candidates = [];
    for (const [fromSide, toSide] of [[vertical[0], horizontal[1]], [horizontal[0], vertical[1]], vertical, horizontal]) {
      const candidate = { ...edge, fromSide, toSide };
      routeEdges(view.nodes, [candidate], { existing });
      if (candidate.blocked || candidate.points.some(([x, y]) => (view.width != null && (x < 0 || x > view.width)) ||
        (view.height != null && (y < 0 || y > view.height)))) continue;
      candidates.push(candidate);
    }
    if (!candidates.length) continue;
    // 只改变一条线。比较原线与全部候选附近的同一批边，远处边对分差的贡献为零。
    const boxes = [bounds.get(edge), ...candidates.map((e) => routeBounds(e.points))];
    const nearby = others.filter((e) => boxes.some((box) => boundsMeet(box, bounds.get(e), 1)));
    let metrics = routeLengthAndCrossings([...nearby, edge]), best = scoreMetrics(metrics);
    for (const candidate of candidates) {
      const next = routeLengthAndCrossings([...nearby, candidate]);
      // 无关连线重叠会伪造关系，优先拆开；不能因少量交叉而保留整段错误共线。
      const fewerConflicts = next.overlapLength < metrics.overlapLength - 0.5;
      if (next.overlapLength > metrics.overlapLength + 0.5 || (next.crossings > metrics.crossings && !fewerConflicts)) continue;
      const score = scoreMetrics(next);
      // 坐标变换会带来浮点尾差；等价路径保留原线，避免 GUI 与离线拖动选出不同连接面。
      if (fewerConflicts || score < best - 1e-6) { edge.points = candidate.points; best = score; metrics = next; }
    }
    bounds.set(edge, routeBounds(edge.points));
  }
}

/** 同源或同目标连线复用干线，允许延伸已有通道接入平行分支。 */
export function mergeSharedRoutes(view, subset = view.edges) {
  const affected = new Set(subset), nodes = new Map(view.nodes.map((n) => [n.id, n]));
  if (!affected.size) return;
  const bounds = new Map(view.edges.map((e) => [e, routeBounds(e.points)]));
  const cost = (edges) => { const m = routeLengthAndCrossings(edges, true); return m.length + STUB * m.bends; };
  let viewCost;
  const length = (pts) => pts.slice(1).reduce((sum, p, i) => sum + Math.abs(p[0] - pts[i][0]) + Math.abs(p[1] - pts[i][1]), 0);
  for (const role of ['from', 'to']) {
    const groups = new Map();
    for (const e of view.edges) {
      if (e.custom || e.fromSide || e.toSide || e.from === e.to || !e.points?.length) continue;
      const key = e[role] + '|' + edgeStyleKey(e);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    for (const edges of groups.values()) {
      if (edges.length < 2 || !edges.some((e) => affected.has(e))) continue;
      let groupCost = cost(edges);
      for (const edge of edges.filter((e) => affected.has(e)).sort((a, b) => b.points.length - a.points.length)) {
        const q = role === 'from' ? edge.points : edge.points.slice().reverse();
        let best = null, gain = 0;
        const originalLength = length(edge.points);
        // 共用端点且样式相同的边可以汇流；其他边逐对检查，避免每个候选都重算全图交叉。
        const conflicts = new Map();
        // 只比较邻近的少量分支，避免大扇出在拖动松手时全组两两枚举。
        const end = (e) => role === 'from' ? e.points.at(-1) : e.points[0];
        const distance = (e) => Math.abs(end(e)[0] - end(edge)[0]) + Math.abs(end(e)[1] - end(edge)[1]);
        const donors = edges.filter((e) => e !== edge).sort((a, b) => distance(a) - distance(b)).slice(0, 8);
        for (const donor of donors) {
          const p = role === 'from' ? donor.points : donor.points.slice().reverse();
          const before = cost([donor, edge]);
          for (let i = 1; i < p.length; i++) for (let j = 1; j < q.length; j++) {
            const ph = Math.abs(p[i][1] - p[i - 1][1]) < 0.5, qh = Math.abs(q[j][1] - q[j - 1][1]) < 0.5;
            if (ph === qh) continue;
            const at = ph ? [q[j][0], p[i][1]] : [p[i][0], q[j][1]];
            // 允许延伸共用通道，但接入点必须落在原分支上。
            if (![0, 1].every((axis) => at[axis] >= Math.min(q[j - 1][axis], q[j][axis]) - 1e-6 &&
                at[axis] <= Math.max(q[j - 1][axis], q[j][axis]) + 1e-6)) continue;
            let points = collapse([...p.slice(0, i), at, ...q.slice(j)]);
            if (role === 'to') points.reverse();
            const next = before - cost([donor, { ...edge, points }]);
            if (next <= gain + 0.5 || length(points) > originalLength + 0.5 ||
                pathBlockedByNodes(points, view.nodes, new Set([edge.from, edge.to])) ||
                pathCrossesBody(points, nodes.get(edge.from)) || pathCrossesBody(points, nodes.get(edge.to))) continue;
            const candidate = { ...edge, points }, box = routeBounds(points);
            if (view.edges.some((other) => {
              if (other === edge || !boundsMeet(box, bounds.get(other)) || canShareTrunk(edge, other)) return false;
              const trial = routeLengthAndCrossings([candidate, other]);
              if (trial.overlapLength <= 0.5 && !trial.crossings) return false;
              if (!conflicts.has(other)) conflicts.set(other, routeLengthAndCrossings([edge, other]));
              const old = conflicts.get(other);
              return trial.overlapLength > old.overlapLength + 0.5 || trial.crossings > old.crossings;
            })) continue;
            best = points; gain = next;
          }
        }
        if (!best) continue;
        const next = cost(edges.map((e) => e === edge ? { ...e, points: best } : e));
        // 同目标汇流也不能拆散其他同源组已有的干线。
        if (next >= groupCost - 0.5) continue;
        viewCost ??= cost(view.edges);
        const total = cost(view.edges.map((e) => e === edge ? { ...e, points: best } : e));
        if (total < viewCost - 0.5) {
          edge.points = best; groupCost = next; viewCost = total;
          bounds.set(edge, routeBounds(best));
        }
      }
    }
  }
}
