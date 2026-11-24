// ELK 节点尺寸与连线度量工具。
import { callEndpoints, semanticFaces, nearestSide, edgeStyleKey, canShareTrunk, routeBounds, boundsMeet, routeOverlapConflicts, routeEdges, collectSegments,
  pathBlockedByNodes, pathCrossesBody, collapse, STUB } from './routing.js';

export function textWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += ch.charCodeAt(0) > 255 ? 14 : 7.6;
  }
  return w;
}

function measureLines(edges, geometryOnly = false) {
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
  return { length, rawLength, crossings: intersections.size, bends };
}

export function routeLengthAndCrossings(edges, geometryOnly = false) {
  const lines = measureLines(edges, geometryOnly);
  if (geometryOnly) return lines;
  const { length: overlapLength, styleLength: styleOverlapLength } = routeOverlapConflicts(edges);
  // length 已按线型取并集，同一根干线上有再多调用也只画一段。
  return { ...lines, sharedLength: Math.max(0, lines.rawLength - lines.length), overlapLength, styleOverlapLength };
}

function layoutMetrics(edges) {
  const { length: styleOverlapLength } = routeOverlapConflicts(edges, { differentStylesOnly: true });
  return { ...measureLines(edges), styleOverlapLength };
}

function scoreMetrics(m) {
  return m.crossings * 40 + m.styleOverlapLength / 20 + m.bends * 2 + m.length / 50 + m.rawLength / 200;
}

export const routeScore = (edges) => scoreMetrics(layoutMetrics(edges));

/** 统计同层目录与文件框之间的留白，父框的标题和边距不计入。 */
export function directoryWhitespace({ groups, containers }) {
  const siblings = new Map();
  const add = (box, directory) => {
    const parent = box.id.slice(0, Math.max(0, box.id.lastIndexOf('/')));
    if (!siblings.has(parent)) siblings.set(parent, { boxes: [], directory: false });
    const entry = siblings.get(parent);
    entry.boxes.push(box);
    entry.directory ||= directory;
  };
  for (const box of containers) add(box, true);
  for (const box of groups) add(box, false);

  let empty = 0;
  for (const { boxes, directory } of siblings.values()) {
    if (!directory || boxes.length < 2) continue;
    const width = Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x));
    const height = Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y));
    const occupied = boxes.reduce((area, b) => area + b.w * b.h, 0);
    empty += Math.max(0, width * height - occupied);
  }
  return empty;
}

/** 保留同线型的公共干线，处理不同线型相互遮盖及跨区绕行，只改动 subset。 */
export function improveEdgeRoutes(view, subset, simplify = () => true) {
  if (!subset.length) return;
  const detour = (e) => {
    const p = e.points;
    let length = 0;
    for (let i = 1; i < p.length; i++) length += Math.abs(p[i][0] - p[i - 1][0]) + Math.abs(p[i][1] - p[i - 1][1]);
    return length - Math.abs(p.at(-1)[0] - p[0][0]) - Math.abs(p.at(-1)[1] - p[0][1]);
  };
  const { byEdge } = routeOverlapConflicts(view.edges, { differentStylesOnly: true });
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const callNodes = callEndpoints(view.edges);
  const facePenalty = (e) => {
    const a = byId.get(e.from), b = byId.get(e.to);
    const roles = semanticFaces(e, a, b, view.layoutDirection, callNodes);
    const side = (node, [x, y]) => nearestSide(node, { x, y });
    return roles ? 24 * (Number(side(a, e.points[0]) !== roles[0]) +
      Number(side(b, e.points.at(-1)) !== roles[1])) : 0;
  };
  const ranked = subset.filter((e) => !e.custom && !e.fromSide && !e.toSide && e.from !== e.to && e.points?.length >= 2)
    .map((edge) => ({ edge, overlap: byEdge.get(edge) || 0, detour: detour(edge) }))
    .filter(({ edge, overlap, detour }) => overlap || facePenalty(edge) || (simplify(edge) && (detour > 0.5 || edge.points.length > 4)))
    .sort((a, b) => b.overlap - a.overlap || b.detour - a.detour).slice(0, 12);
  if (!ranked.length) return;
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
      routeEdges(view.nodes, [candidate], { existing, layoutDirection: view.layoutDirection, callNodes });
      if (candidate.blocked || candidate.points.some(([x, y]) => (view.width != null && (x < 0 || x > view.width)) ||
        (view.height != null && (y < 0 || y > view.height)))) continue;
      candidates.push(candidate);
    }
    if (!candidates.length) continue;
    // 只改变一条线。比较原线与全部候选附近的同一批边，远处边对分差的贡献为零。
    const boxes = [bounds.get(edge), ...candidates.map((e) => routeBounds(e.points))];
    const nearby = others.filter((e) => boxes.some((box) => boundsMeet(box, bounds.get(e), 1)));
    const current = layoutMetrics([...nearby, edge]);
    let best = scoreMetrics(current) + facePenalty(edge), bestStyleOverlap = current.styleOverlapLength;
    for (const candidate of candidates) {
      const next = layoutMetrics([...nearby, candidate]);
      // 只为解开重线允许一个新的交点，避免从拥挤的公共通道中逐条抽线穿过整图。
      const fewerConflicts = next.styleOverlapLength < current.styleOverlapLength - 0.5;
      if (next.styleOverlapLength > bestStyleOverlap + 0.5 || next.crossings > current.crossings + Number(fewerConflicts)) continue;
      const score = scoreMetrics(next) + facePenalty(candidate);
      // 坐标变换会带来浮点尾差；等价路径保留原线，避免 GUI 与离线拖动选出不同连接面。
      if (next.styleOverlapLength < bestStyleOverlap - 0.5 || score < best - 1e-6) {
        edge.points = candidate.points;
        best = score;
        bestStyleOverlap = next.styleOverlapLength;
      }
    }
    bounds.set(edge, routeBounds(edge.points));
  }
}

const samePoint = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
const segmentAxis = (a, b) => Math.abs(a[1] - b[1]) < 1e-6 ? 0 : Math.abs(a[0] - b[0]) < 1e-6 ? 1 : -1;

// 短交叠也可接入同一走廊，前提是吸附后的折点接上同向的垂直分支。
function joinsBranch(q, j, p, i, axis, coord) {
  const sameDirection = (q[j + 1][axis] - q[j][axis]) * (p[i + 1][axis] - p[i][axis]) > 0;
  return [0, 1].some((end) => {
    const donorEnd = sameDirection ? end : 1 - end;
    const branch = p[i + (donorEnd ? 2 : -1)];
    return branch && Math.abs(q[j + end][axis] - p[i + donorEnd][axis]) < 0.5 &&
      Math.abs(branch[axis] - p[i + donorEnd][axis]) < 0.5 &&
      (q[j + (end ? 2 : -1)][1 - axis] - coord) * (branch[1 - axis] - coord) > 0;
  });
}

/** 汇合同端点分支，消除容器壁冗余折返，并吸附同样式的平行走廊。 */
export function mergeSharedRoutes(view, subset = view.edges) {
  const affected = new Set(subset), nodes = new Map(view.nodes.map((n) => [n.id, n]));
  if (!affected.size) return;
  const bounds = new Map(view.edges.map((e) => [e, routeBounds(e.points)]));
  const cost = (edges) => { const m = routeLengthAndCrossings(edges, true); return m.length + STUB * m.bends; };
  const replacementCost = (edge, points) => cost(view.edges.map((e) => e === edge ? { ...e, points } : e));
  const automatic = view.edges.filter((e) => !e.custom && !e.fromSide && !e.toSide && e.from !== e.to && e.points?.length >= 2);
  const callNodes = callEndpoints(view.edges);
  let viewCost;
  const length = (pts) => pts.slice(1).reduce((sum, p, i) => sum + Math.abs(p[0] - pts[i][0]) + Math.abs(p[1] - pts[i][1]), 0);
  const clearsNodes = (edge, points) => !pathBlockedByNodes(points, view.nodes, new Set([edge.from, edge.to])) &&
    !pathCrossesBody(points, nodes.get(edge.from)) && !pathCrossesBody(points, nodes.get(edge.to));
  const addsConflict = (edge) => {
    // 每条原线路的冲突只计算一次，其他边在其候选比较期间保持不变。
    const conflicts = new Map();
    const others = view.edges.filter((other) => !canShareTrunk(edge, other));
    return (points) => {
      const candidate = { ...edge, points }, box = routeBounds(points);
      return others.some((other) => {
        if (!boundsMeet(box, bounds.get(other))) return false;
        const trial = routeLengthAndCrossings([candidate, other]);
        if (!trial.overlapLength && !trial.crossings) return false;
        if (!conflicts.has(other)) conflicts.set(other, routeLengthAndCrossings([edge, other]));
        const old = conflicts.get(other);
        return trial.overlapLength > old.overlapLength + 1e-6 || trial.crossings > old.crossings;
      });
    };
  };

  // 先消除 ELK 跨容器边界产生的阶梯折弯与 U 型回头弯，拉直后再做干线汇流。
  const straighten = () => {
    for (const edge of automatic) {
      if (!affected.has(edge) || edge.points.length < 4) continue;
      let changed = true;
      while (changed && edge.points.length >= 4) {
        changed = false;
        const pts = edge.points;
        const origLen = length(pts);
        const conflicts = addsConflict(edge);
        for (let i = 0; i <= pts.length - 4; i++) {
          const a = pts[i], b = pts[i + 1], c = pts[i + 2], d = pts[i + 3];
          const h1 = Math.abs(a[1] - b[1]) < 0.5, h2 = Math.abs(b[1] - c[1]) < 0.5, h3 = Math.abs(c[1] - d[1]) < 0.5;
          if (h1 !== h3 || h1 === h2) continue;
          const cands = [];
          if (i + 3 < pts.length - 1) {
            const m1 = h1 ? [d[0], a[1]] : [a[0], d[1]];
            cands.push(collapse([...pts.slice(0, i + 1), m1, ...pts.slice(i + 3)]));
          }
          if (i > 0) {
            const m2 = h1 ? [a[0], d[1]] : [d[0], a[1]];
            cands.push(collapse([...pts.slice(0, i + 1), m2, ...pts.slice(i + 3)]));
          }
          for (const cand of cands) {
            if (cand.length >= pts.length || cand.length < 2) continue;
            if (!samePoint(cand[0], pts[0]) || !samePoint(cand.at(-1), pts.at(-1))) continue;
            if (cand.some((pt, idx) => idx > 0 && segmentAxis(cand[idx - 1], pt) < 0)) continue;
            if (length(cand) > origLen + 0.5 || !clearsNodes(edge, cand) || conflicts(cand)) continue;
            edge.points = cand;
            bounds.set(edge, routeBounds(cand));
            viewCost = undefined;
            changed = true;
            break;
          }
          if (changed) break;
        }
      }
    }
  };

  straighten();

  for (const role of ['from', 'to']) {
    const groups = new Map();
    for (const e of automatic) {
      const key = e[role] + '|' + edgeStyleKey(e);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    for (const edges of groups.values()) {
      if (edges.length < 2 || !edges.some((e) => affected.has(e))) continue;
      let groupCost = cost(edges);
      for (const edge of edges.filter((e) => affected.has(e)).sort((a, b) => b.points.length - a.points.length)) {
        const q = role === 'from' ? edge.points : edge.points.slice().reverse();
        const roles = semanticFaces(edge, nodes.get(edge.from), nodes.get(edge.to), view.layoutDirection, callNodes);
        const keepPort = roles && nearestSide(nodes.get(edge[role]), { x: q[0][0], y: q[0][1] }) === roles[role === 'from' ? 0 : 1];
        let best = null, gain = 0;
        const originalLength = length(edge.points);
        const conflicts = addsConflict(edge);
        // 只比较邻近的少量分支，避免大扇出在拖动松手时全组两两枚举。
        const end = (e) => role === 'from' ? e.points.at(-1) : e.points[0];
        const distance = (e) => Math.abs(end(e)[0] - end(edge)[0]) + Math.abs(end(e)[1] - end(edge)[1]);
        const donors = edges.filter((e) => e !== edge).sort((a, b) => distance(a) - distance(b)).slice(0, 20);
        for (const donor of donors) {
          const p = role === 'from' ? donor.points : donor.points.slice().reverse();
          if (keepPort && !samePoint(p[0], q[0])) continue;
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
            if (next <= gain + 0.5 || length(points) > originalLength + Math.max(96, next * 1.25) ||
                !clearsNodes(edge, points) || conflicts(points)) continue;
            best = points; gain = next;
          }
        }
        if (!best) continue;
        const next = cost(edges.map((e) => e === edge ? { ...e, points: best } : e));
        // 同目标汇流也不能拆散其他同源组已有的干线。
        if (next >= groupCost - 0.5) continue;
        viewCost ??= cost(view.edges);
        const total = replacementCost(edge, best);
        if (total < viewCost - 0.5) {
          edge.points = best; groupCost = next; viewCost = total;
          bounds.set(edge, routeBounds(best));
        }
      }
    }
  }

  const corridors = new Map();
  for (const edge of automatic) {
    if (edge.points.length < 3) continue;
    const style = edgeStyleKey(edge);
    if (!corridors.has(style)) corridors.set(style, []);
    corridors.get(style).push(edge);
  }
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const edges of corridors.values()) for (const edge of edges) {
      if (!affected.has(edge) || edge.points.length < 4) continue;
      const conflicts = addsConflict(edge);
      // 逐段尝试吸附到平行主干走廊，使一条边的水平段和垂直段都能分别并入对应干线。
      for (let j = 1; j <= edge.points.length - 3; j++) {
        const q = edge.points;
        const axis = segmentAxis(q[j], q[j + 1]);
        if (axis < 0) continue;
        const normal = 1 - axis;
        const lo = Math.min(q[j][axis], q[j + 1][axis]), hi = Math.max(q[j][axis], q[j + 1][axis]);
        const coords = new Set();
        let best = null, bestCost = Infinity;
        for (const donor of edges) {
          if (donor === edge || donor.points.length < 3 || !boundsMeet(bounds.get(edge), bounds.get(donor), 97)) continue;
          const related = donor.from === edge.from || donor.to === edge.to;
          const p = donor.points;
          const sameStart = p.length >= 4 && samePoint(q[0], p[0]);
          const sameEnd = p.length >= 4 && samePoint(q.at(-1), p.at(-1));
          for (let i = 0; i < p.length - 1; i++) {
            const coord = p[i][normal], distance = Math.abs(coord - q[j][normal]);
            if (distance <= 0.5 || distance > (related ? 96 : 36) || coords.has(coord) || segmentAxis(p[i], p[i + 1]) !== axis) continue;
            const overlap = Math.min(hi, Math.max(p[i][axis], p[i + 1][axis])) -
              Math.max(lo, Math.min(p[i][axis], p[i + 1][axis]));
            const portBend = (sameStart && j === 1 && i === 1) ||
              (sameEnd && j === q.length - 3 && i === p.length - 3);
            if (overlap < 16 && !portBend && !joinsBranch(q, j, p, i, axis, coord)) continue;
            coords.add(coord);
            const shifted = q.slice();
            shifted[j] = [...q[j]];
            shifted[j + 1] = [...q[j + 1]];
            shifted[j][normal] = shifted[j + 1][normal] = coord;
            const points = collapse(shifted);
            if (!related && length(points) > length(q) + 16) continue;
            if (points.length < 2 || !samePoint(points[0], q[0]) || !samePoint(points.at(-1), q.at(-1)) ||
                points.some((pt, idx) => idx > 0 && segmentAxis(points[idx - 1], pt) < 0) ||
                !clearsNodes(edge, points) || conflicts(points)) continue;
            viewCost ??= cost(view.edges);
            const total = replacementCost(edge, points);
            if (total < viewCost - 0.5 && total < bestCost) {
              best = points;
              bestCost = total;
            }
          }
        }
        if (best) {
          const prevLen = edge.points.length;
          edge.points = best;
          viewCost = bestCost;
          bounds.set(edge, routeBounds(best));
          changed = true;
          if (edge.points.length < prevLen) j = Math.max(0, j - 1);
        }
      }
    }
    if (!changed) break;
  }
}
