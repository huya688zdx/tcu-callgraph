// ELK 节点尺寸与连线度量工具。
import { edgeStyleKey, routeOverlapConflicts, routeEdges, collectSegments, pathBlockedByNodes, pathCrossesBody, collapse, STUB } from './routing.js';

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
      // 坐标变换会带来浮点尾差；等价路径保留原线，避免 GUI 与离线拖动选出不同连接面。
      if (score < best - 1e-6) { edge.points = candidate.points; best = score; metrics = next; }
    }
  }
}

/** 同源或同目标连线复用干线，允许延伸已有通道接入平行分支。 */
export function mergeSharedRoutes(view, subset = view.edges) {
  const affected = new Set(subset), nodes = new Map(view.nodes.map((n) => [n.id, n]));
  // 汇流按画面的颜色和虚实线判断，原始调用种类及既有布局评分不变。
  const visible = (e) => ({ ...e, kind: e.kind === 'var' || e.kind?.startsWith('df-') ? e.kind : 'direct' });
  const cost = (edges) => { const m = routeLengthAndCrossings(edges.map(visible), true); return m.length + STUB * m.bends; };
  const length = (pts) => pts.slice(1).reduce((sum, p, i) => sum + Math.abs(p[0] - pts[i][0]) + Math.abs(p[1] - pts[i][1]), 0);
  for (const role of ['from', 'to']) {
    const groups = new Map();
    for (const e of view.edges) {
      if (e.custom || e.fromSide || e.toSide || e.from === e.to || !e.points?.length) continue;
      const key = e[role] + '|' + edgeStyleKey(visible(e));
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
        const obstacles = view.edges.filter((other) => other !== edge &&
          !(edgeStyleKey(visible(other)) === edgeStyleKey(visible(edge)) &&
            (other.from === edge.from || other.to === edge.to || (other.from === edge.to && other.to === edge.from))));
        const conflicts = obstacles.map((other) => routeLengthAndCrossings([visible(edge), visible(other)]));
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
            if (obstacles.some((other, index) => {
              const trial = routeLengthAndCrossings([visible({ ...edge, points }), visible(other)]), old = conflicts[index];
              return trial.overlapLength > old.overlapLength + 0.5 || trial.crossings > old.crossings;
            })) continue;
            best = points; gain = next;
          }
        }
        if (!best) continue;
        const next = cost(edges.map((e) => e === edge ? { ...e, points: best } : e));
        // 同目标汇流也不能拆散其他同源组已有的干线。
        if (next < groupCost - 0.5 && cost(view.edges.map((e) => e === edge ? { ...e, points: best } : e)) < cost(view.edges) - 0.5) {
          edge.points = best; groupCost = next;
        }
      }
    }
  }
}
