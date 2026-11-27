/**
 * 纯几何与布局辅助：命中判定用的矩形计算、正交折线重路由
 * 不涉及 DOM 绘制，方便单独测试
 */
import { state } from './state.js';
import { routeEdges, collectSegments, canShareTrunk, pathBlockedByNodes, pathCrossesBody } from '/core/routing.js';
import { improveEdgeRoutes, mergeSharedRoutes } from '/core/layout-metrics.js';
import { placeNodeInHierarchy } from './hierarchy.js';

/** 节点是否与其它节点相撞（留一点视觉间隙，避免边框贴死） */
function collidesWith(nodes, n, x, y, pad = 6) {
  for (const o of nodes) {
    if (o.id === n.id) continue;
    if (
      x < o.x + o.w + pad &&
      x + n.w + pad > o.x &&
      y < o.y + o.h + pad &&
      y + n.h + pad > o.y
    ) {
      return true;
    }
  }
  return false;
}

function nodeSnapTargets(nodes, node, x, y, tolerance, connected, visible) {
  const targets = {};
  if (tolerance <= 0) return targets;
  const axes = [['x', 'w', x], ['y', 'h', y]];
  for (const other of nodes) {
    if (other.id === node.id) continue;
    const priority = connected.has(other.id) ? 0 : node.group && node.group === other.group ? 1 : 2;
    if (priority === 2 && !visible(other)) continue;
    for (const [axis, size, pointer] of axes) {
      for (const ratio of [0, 0.5, 1]) {
        const at = other[axis] + other[size] * ratio;
        const position = at - node[size] * ratio;
        const distance = Math.abs(position - pointer);
        const best = targets[axis];
        if (distance <= tolerance && (!best || distance < best.distance ||
          (distance === best.distance && priority < best.priority))) {
          targets[axis] = { at, position, distance, priority, other };
        }
      }
    }
  }
  return targets;
}

/** 优先尝试吸附；被节点或容器挡住时沿两个轴分别贴边移动。 */
function moveNodeNoOverlap(drag, tx, ty, { tolerance = 0, connected = new Set(), visible = () => true } = {}) {
  const { node, view, minX, minY } = drag;
  const { x: oldX, y: oldY } = node;
  const x = Math.max(minX, tx), y = Math.max(minY, ty);
  const targets = nodeSnapTargets(view.nodes, node, x, y, tolerance, connected, visible);
  const sx = Math.max(minX, targets.x?.position ?? x);
  const sy = Math.max(minY, targets.y?.position ?? y);
  const place = (nx, ny) => (nx === node.x && ny === node.y) ||
    (!collidesWith(view.nodes, node, nx, ny) && placeNodeInHierarchy(drag, nx, ny));
  const attempts = [[sx, sy], [sx, y], [x, sy], [x, y]];
  if (!attempts.some(([nx, ny], i) => (i === 0 || nx !== oldX || ny !== oldY) && place(nx, ny))) {
    const slide = (axis, target) => {
      const start = node[axis];
      if (start === target) return;
      const tryAt = (at) => axis === 'x' ? place(at, node.y) : place(node.x, at);
      if (tryAt(target)) return;
      let lo = 0, hi = 1;
      for (let i = 0; i < 16 && Math.abs(target - start) * (hi - lo) > 0.02; i++) {
        const mid = (lo + hi) / 2;
        if (tryAt(start + (target - start) * mid)) lo = mid;
        else hi = mid;
      }
    };
    slide('x', x);
    slide('y', y);
    slide('x', x);
  }
  drag.guides = [];
  for (const [axis, across, size] of [['x', 'y', 'h'], ['y', 'x', 'w']]) {
    const match = targets[axis];
    if (match && node[axis] === match.position) {
      drag.guides.push({
        axis, at: match.at,
        from: Math.min(node[across], match.other[across]),
        to: Math.max(node[across] + node[size], match.other[across] + match.other[size]),
      });
    }
  }
  return node.x !== oldX || node.y !== oldY;
}

function segmentSnapTargets(view, edge, axis, across, endpoints, a, b) {
  const horizontal = axis === 1;
  const key = horizontal ? 'y' : 'x';
  const direction = horizontal ? 'x' : 'y';
  const size = horizontal ? 'h' : 'w';
  const span = horizontal ? 'w' : 'h';
  const targets = endpoints.map((n) => ({
    at: n[key] + n[size] / 2, from: n[direction], to: n[direction] + n[span], priority: 0,
  }));
  const lo = Math.min(a[across], b[across]), hi = Math.max(a[across], b[across]);
  const occupied = new Set();
  for (const other of view.edges) {
    if (other === edge) continue;
    const related = ((edge.from && other.from === edge.from) || (edge.to && other.to === edge.to)) &&
      other.kind === edge.kind && (edge.kind !== 'var' || other.via === edge.via) && canShareTrunk(edge, other);
    const corridors = collectSegments([other]);
    for (const s of horizontal ? corridors.h : corridors.v) {
      const from = s[direction + '1'], to = s[direction + '2'];
      if (!related && Math.min(hi, to) - Math.max(lo, from) > 0.5) occupied.add(s[key]);
      else targets.push({ at: s[key], from, to, priority: 1 });
    }
  }
  const start = edge.points[0], end = edge.points.at(-1);
  targets.push({
    at: (start[axis] + end[axis]) / 2,
    from: Math.min(start[across], end[across]), to: Math.max(start[across], end[across]),
    priority: 2,
  });
  return { targets, occupied: [...occupied] };
}

/** 移动正交线段，先试安全的吸附位置，再试原始指针位置。 */
function moveEdgeSegment(view, seg, x, y, tolerance = 0) {
  const axis = seg.orient === 'h' ? 1 : 0, across = 1 - axis;
  const desired = axis === 1 ? y : x;
  const { edge } = seg;
  const points = edge.points;
  const work = points.map((p) => [...p]);
  let i = seg.index;
  if (!seg.prepared && (i === 0 || i === work.length - 2)) {
    // 首尾线段保留引出方向，只移动补出的中段。
    const a = work[i], b = work[i + 1];
    const p = a.map((v, j) => v + (b[j] - v) / 4);
    const q = a.map((v, j) => v + (b[j] - v) * 3 / 4);
    work.splice(i + 1, 0, [...p], p, q, [...q]);
    i += 2;
  }
  const oldA = work[i][axis], oldB = work[i + 1][axis];
  const skip = new Set([edge.from, edge.to]);
  const endpoints = seg.endpoints ??= view.nodes.filter((n) => skip.has(n.id));
  const snap = tolerance > 0 && (seg.snapTargets ??= segmentSnapTargets(view, edge, axis, across, endpoints, work[i], work[i + 1]));
  // 端点或共用分支的辅助线也不能把手柄吸到无关走线上。原始指针位置仍可自由落下。
  const occupied = snap ? snap.occupied.filter(at => Math.abs(at - desired) < 2 * tolerance) : [];
  const targets = snap ? snap.targets
    .filter(({ at }) => Math.abs(at - desired) <= tolerance && !occupied.some(value => Math.abs(value - at) < tolerance))
    .sort((a, b) => Math.abs(a.at - desired) - Math.abs(b.at - desired) || a.priority - b.priority) : [];
  const checked = new Set();
  seg.guides = [];
  for (const match of [...targets, { at: desired }]) {
    if (checked.has(match.at)) continue;
    checked.add(match.at);
    work[i][axis] = work[i + 1][axis] = match.at;
    if (pathBlockedByNodes(work, view.nodes, skip) || endpoints.some((n) => pathCrossesBody(work, n))) continue;
    if (match.priority !== undefined) {
      seg.guides.push({
        axis: axis === 1 ? 'y' : 'x', at: match.at,
        from: Math.min(match.from, work[i][across], work[i + 1][across]),
        to: Math.max(match.to, work[i][across], work[i + 1][across]),
      });
    }
    if (oldA === match.at && oldB === match.at) return false;
    seg.prepared = true;
    seg.index = i;
    edge.points = work;
    return true;
  }
  return false;
}

/** 边的折线由共享路由器维护（严格正交）；此处只做读取 */
function edgePoints(e) {
  return (e && e.points) || [];
}

/** 对一组边做增量重路由（其余边的线段作为避让约束） */
function rerouteScope(subset, preservePaths = false) {
  const v = state.view;
  if (!v || !subset.length) return;
  const affected = new Set(subset);
  const others = v.edges.filter((e) => !affected.has(e));
  routeEdges(v.nodes, subset, { existing: collectSegments(others), preservePaths });
}

/** 节点拖动过程中：只实时重路由与该节点相连的边 */
function liveReroute(nodeId) {
  const v = state.view;
  if (!v) return;
  rerouteScope(v.edges.filter((e) => e.from === nodeId || e.to === nodeId));
}

/** 移动时仅重布受影响的线；颜色等全局变化时重布全部，并扩展画布尺寸。 */
function fullReroute(movedIds = null) {
  const v = state.view;
  if (!v) return;
  let affected = v.edges;
  if (movedIds) {
    const moved = v.nodes.filter((n) => movedIds.has(n.id));
    affected = v.edges.filter((e) => movedIds.has(e.from) || movedIds.has(e.to) ||
      pathBlockedByNodes(e.points, moved, new Set([e.from, e.to])));
    rerouteScope(affected, true);
    // 松手后尝试重新选面，只替换确实更好的边界连线；手工折线和指定端口不改。
    improveEdgeRoutes(v, affected, (e) => movedIds.has(e.from) !== movedIds.has(e.to));
  } else {
    routeEdges(v.nodes, v.edges, { bounds: { minX: 40, maxX: Math.max(v.width, 600) } });
  }
  mergeSharedRoutes(v, affected);
  let maxX = 0;
  let maxY = 0;
  for (const n of v.nodes) {
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  for (const e of v.edges) {
    for (const p of e.points || []) {
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  v.width = Math.max(v.width, maxX + 40);
  v.height = Math.max(v.height, maxY + 40);
  for (const c of v.containers || []) if (c.root) {
    c.w = Math.max(c.w, v.width);
    c.h = Math.max(c.h, v.height);
  }
}

function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a[0], p.y - a[1]);
  let t = ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy));
}
export {
  moveNodeNoOverlap,
  moveEdgeSegment,
  edgePoints,
  rerouteScope,
  liveReroute,
  fullReroute,
  distToSegment,
};
