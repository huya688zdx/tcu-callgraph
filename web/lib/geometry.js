/**
 * 纯几何与布局辅助：命中判定用的矩形计算、正交折线重路由
 * 不涉及 DOM 绘制，方便单独测试
 */
import { state } from './state.js';
import { routeEdges, collectSegments } from '/core/routing.js';
/** 节点只能在所属文件框内移动，避免跑出框外导致结构散架 */
function clampToGroup(n) {
  const v = state.view;
  if (!v || !v.groups || !n.group) return;
  const g = v.groups.find((x) => x.id === n.group);
  if (!g) return;
  const pad = 8;
  const left = g.x + pad;
  const right = g.x + g.w - n.w - pad;
  const top = g.y + 32;
  const bottom = g.y + g.h - n.h - pad;
  if (right >= left) n.x = Math.max(left, Math.min(right, n.x));
  if (bottom >= top) n.y = Math.max(top, Math.min(bottom, n.y));
}

/** 节点是否与其它节点相撞（留一点视觉间隙，避免边框贴死） */
function collidesWith(n, pad = 6) {
  const v = state.view;
  if (!v) return false;
  for (const o of v.nodes) {
    if (o.id === n.id) continue;
    if (
      n.x < o.x + o.w + pad &&
      n.x + n.w + pad > o.x &&
      n.y < o.y + o.h + pad &&
      n.y + n.h + pad > o.y
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 拖动落位：整体移动被挡住时退化为单轴滑动（贴着别的节点滑过去），
 * 两个方向都过不去就停在原位 —— 保证拖动过程中节点之间永不重叠
 */
function moveNodeNoOverlap(n, tx, ty) {
  const ox = n.x;
  const oy = n.y;

  n.x = tx;
  n.y = ty;
  clampToGroup(n);
  if (!collidesWith(n)) return;

  n.x = tx;
  n.y = oy;
  clampToGroup(n);
  if (!collidesWith(n)) return;

  n.x = ox;
  n.y = ty;
  clampToGroup(n);
  if (!collidesWith(n)) return;

  n.x = ox;
  n.y = oy;
}

/** 边的折线由共享路由器维护（严格正交）；此处只做读取 */
function edgePoints(e) {
  return (e && e.points) || [];
}

/** 对一组边做增量重路由（其余边的线段作为避让约束） */
function rerouteScope(subset) {
  const v = state.view;
  if (!v || !subset.length) return;
  const others = v.edges.filter((e) => !subset.includes(e));
  routeEdges(v.nodes, subset, { existing: collectSegments(others) });
}

/** 节点拖动过程中：只实时重路由与该节点相连的边 */
function liveReroute(nodeId) {
  const v = state.view;
  if (!v) return;
  rerouteScope(v.edges.filter((e) => e.from === nodeId || e.to === nodeId));
}

/** 全量重路由（拖拽结束等时机），并扩展画布尺寸 */
function fullReroute() {
  const v = state.view;
  if (!v) return;
  routeEdges(v.nodes, v.edges, { bounds: { minX: 40, maxX: Math.max(v.width, 600) } });
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
  clampToGroup,
  collidesWith,
  moveNodeNoOverlap,
  edgePoints,
  rerouteScope,
  liveReroute,
  fullReroute,
  distToSegment,
};
