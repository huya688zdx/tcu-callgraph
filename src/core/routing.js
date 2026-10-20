/**
 * 正交边路由器（服务端 / 浏览器共享，无平台依赖）
 *
 * 核心思路：
 *  1. 几何分类：按两端节点相对位置决定出/入边方向（可被 e.fromSide/e.toSide 覆盖）
 *  2. 端口分配：同一节点同侧的多条边按对端位置排序后沿边均匀展开
 *  3. 共线合并：同一对节点的同类型调用边共用一条折线（不同调用行不再平行重复）
 *  4. 公用母线：同源（或同目标）的同类型同色直连边共享一条水平母线，只留竖直分支
 *  5. 直连路由（相邻/同排）：单通道 Z 形，通道位置做「节点避障 + 已布通道避让」搜索
 *  6. 长边路由（跨多层 / 回边）：先尝试图内垂直走廊，失败则绕侧边车道
 *  7. 手动布线（e.custom）：保留用户折线，仅随节点移动重新锚定端点
 *
 * 硬性约束：所有输出线段严格水平或垂直（无斜线）。
 */

export const SPACING = 13; // 相邻通道最小间距
export const STUB = 15; // 端口引出线长度
export const CLEAR = 5; // 节点四周安全间隙
export const PORT_INSET = 8; // 端口距节点角落的最小距离
export const LANE_BASE = 30; // 侧边车道离最外节点的起始距离
export const LOOP_THRESHOLD = 200; // 跨度超过该值的长边走走廊/车道

const DIR = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
const SIDES = new Set(['top', 'bottom', 'left', 'right']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------- 基础几何 ----------------

/** 侧向端口位置：frac ∈ [0,1] 沿边分布（两端留 inset） */
export function portAt(n, side, frac = 0.5) {
  const along = (len) => {
    const inset = Math.min(PORT_INSET, len / 4);
    return inset + clamp(frac, 0, 1) * (len - 2 * inset);
  };
  switch (side) {
    case 'top':
      return [n.x + along(n.w), n.y];
    case 'bottom':
      return [n.x + along(n.w), n.y + n.h];
    case 'left':
      return [n.x, n.y + along(n.h)];
    default:
      return [n.x + n.w, n.y + along(n.h)];
  }
}

/** 点相对节点最近的一侧 */
export function nearestSide(n, p) {
  const cx = n.x + n.w / 2;
  const cy = n.y + n.h / 2;
  const dx = (p.x - cx) / Math.max(1, n.w / 2);
  const dy = (p.y - cy) / Math.max(1, n.h / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

/** 水平线段 y，从 x1 到 x2 是否撞到节点（clear 间隙） */
function hLineBlocked(y, x1, x2, nodes, skip, clear = CLEAR) {
  const lo = Math.min(x1, x2);
  const hi = Math.max(x1, x2);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (skip && skip.has(n.id)) continue;
    if (y > n.y - clear && y < n.y + n.h + clear && lo < n.x + n.w + clear && hi > n.x - clear) {
      return true;
    }
  }
  return false;
}

/** 垂直线段 x，从 y1 到 y2 是否撞到节点 */
function vLineBlocked(x, y1, y2, nodes, skip, clear = CLEAR) {
  const lo = Math.min(y1, y2);
  const hi = Math.max(y1, y2);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (skip && skip.has(n.id)) continue;
    if (x > n.x - clear && x < n.x + n.w + clear && lo < n.y + n.h + clear && hi > n.y - clear) {
      return true;
    }
  }
  return false;
}

/** 节点矩形（扩 clear）与点是否相交 */
function rectHitsPoint(n, x, y, clear = CLEAR) {
  return x > n.x - clear && x < n.x + n.w + clear && y > n.y - clear && y < n.y + n.h + clear;
}

// ---------------- 已布通道登记（按坐标排序 + 二分查询） ----------------

function insSorted(arr, rec) {
  let i = arr.length;
  while (i > 0 && arr[i - 1].k > rec.k) i--;
  arr.splice(i, 0, rec);
}

function addH(placed, y, x1, x2) {
  if (Math.abs(x2 - x1) < 0.5) return;
  insSorted(placed.h, { k: y, y, x1: Math.min(x1, x2), x2: Math.max(x1, x2) });
}

function addV(placed, x, y1, y2) {
  if (Math.abs(y2 - y1) < 0.5) return;
  insSorted(placed.v, { k: x, x, y1: Math.min(y1, y2), y2: Math.max(y1, y2) });
}

function hitsH(placed, y, x1, x2) {
  const arr = placed.h;
  let lo = 0;
  let hi = arr.length;
  const minY = y - SPACING;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].k < minY) lo = m + 1;
    else hi = m;
  }
  for (let i = lo; i < arr.length && arr[i].k <= y + SPACING; i++) {
    const s = arr[i];
    if (Math.abs(s.y - y) < SPACING * 0.8 && x1 < s.x2 + 4 && x2 > s.x1 - 4) return true;
  }
  return false;
}

function hitsV(placed, x, y1, y2) {
  const arr = placed.v;
  let lo = 0;
  let hi = arr.length;
  const minX = x - SPACING;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].k < minX) lo = m + 1;
    else hi = m;
  }
  for (let i = lo; i < arr.length && arr[i].k <= x + SPACING; i++) {
    const s = arr[i];
    if (Math.abs(s.x - x) < SPACING * 0.8 && y1 < s.y2 + 4 && y2 > s.y1 - 4) return true;
  }
  return false;
}

// ---------------- 通道搜索 ----------------

/** 在 [lo, hi] 内找一条不撞节点、不与已布通道打架的水平线（优先 prefer，再从中点向两侧步进） */
function findFreeH(prefer, lo, hi, x1, x2, nodes, skip, placed) {
  const ok = (y) =>
    y >= lo - 4 &&
    y <= hi + 4 &&
    !hLineBlocked(y, x1, x2, nodes, skip) &&
    !hitsH(placed, y, Math.min(x1, x2), Math.max(x1, x2));
  const cands = [];
  if (Number.isFinite(prefer)) cands.push(prefer);
  const mid = (lo + hi) / 2;
  cands.push(mid);
  const steps = Math.min(64, Math.ceil((hi - lo) / SPACING) + 4);
  for (let k = 1; k <= steps; k++) {
    cands.push(mid + k * SPACING, mid - k * SPACING);
  }
  for (const y of cands) if (ok(y)) return y;
  return clamp(Number.isFinite(prefer) ? prefer : mid, lo, hi);
}

function findFreeV(prefer, lo, hi, y1, y2, nodes, skip, placed) {
  const ok = (x) =>
    x >= lo - 4 &&
    x <= hi + 4 &&
    !vLineBlocked(x, y1, y2, nodes, skip) &&
    !hitsV(placed, x, Math.min(y1, y2), Math.max(y1, y2));
  const cands = [];
  if (Number.isFinite(prefer)) cands.push(prefer);
  const mid = (lo + hi) / 2;
  cands.push(mid);
  const steps = Math.min(64, Math.ceil((hi - lo) / SPACING) + 4);
  for (let k = 1; k <= steps; k++) {
    cands.push(mid + k * SPACING, mid - k * SPACING);
  }
  for (const x of cands) if (ok(x)) return x;
  return clamp(Number.isFinite(prefer) ? prefer : mid, lo, hi);
}

/** 垂直段被挡时，找最近的替代 x（沿阻挡节点两侧绕开；jogY/jogX 给出需同时保持畅通的水平折线） */
function vEscape(x, yA, yB, nodes, skip, jogY = null, jogX = null) {
  let best = null;
  for (const n of nodes) {
    if (skip.has(n.id)) continue;
    if (x <= n.x - CLEAR || x >= n.x + n.w + CLEAR) continue;
    if (Math.min(yA, yB) >= n.y + n.h + CLEAR || Math.max(yA, yB) <= n.y - CLEAR) continue;
    for (const c of [n.x - CLEAR - 0.5, n.x + n.w + CLEAR + 0.5]) {
      if (vLineBlocked(c, yA, yB, nodes, skip)) continue;
      if (jogY !== null && hLineBlocked(jogY, c, jogX, nodes, skip)) continue;
      if (best === null || Math.abs(c - x) < Math.abs(best - x)) best = c;
    }
  }
  return best;
}

function hEscape(y, xA, xB, nodes, skip, jogX = null, jogY = null) {
  let best = null;
  for (const n of nodes) {
    if (skip.has(n.id)) continue;
    if (y <= n.y - CLEAR || y >= n.y + n.h + CLEAR) continue;
    if (Math.min(xA, xB) >= n.x + n.w + CLEAR || Math.max(xA, xB) <= n.x - CLEAR) continue;
    for (const c of [n.y - CLEAR - 0.5, n.y + n.h + CLEAR + 0.5]) {
      if (hLineBlocked(c, xA, xB, nodes, skip)) continue;
      if (jogX !== null && vLineBlocked(jogX, c, jogY, nodes, skip)) continue;
      if (best === null || Math.abs(c - y) < Math.abs(best - y)) best = c;
    }
  }
  return best;
}

function pathBlockedByNodes(points, nodes, skip) {
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    if (Math.abs(y1 - y2) < 0.5) {
      if (hLineBlocked(y1, x1, x2, nodes, skip)) return true;
    } else if (Math.abs(x1 - x2) < 0.5) {
      if (vLineBlocked(x1, y1, y2, nodes, skip)) return true;
    } else return true;
  }
  return false;
}

/** 直连通道被占时，沿所有节点包络之外绕行，避免退回穿过函数框。 */
function routeOuterLane(p0, p1, a, b, sa, sb, ctx) {
  if (DIR[sa][1] !== 0 || DIR[sb][1] !== 0) return null;
  const nodes = ctx.nodes;
  const skip = new Set([a.id, b.id]);
  const x0 = p0[0] + DIR[sa][0] * STUB;
  const x1 = p1[0] + DIR[sb][0] * STUB;
  const minY = Math.min(...nodes.map((n) => n.y)) - CLEAR - SPACING;
  const maxY = Math.max(...nodes.map((n) => n.y + n.h)) + CLEAR + SPACING;
  let best = null;
  for (const y of [minY, maxY]) {
    const points = collapse([p0, [x0, p0[1]], [x0, y], [x1, y], [x1, p1[1]], p1]);
    if (pathBlockedByNodes(points, nodes, skip)) continue;
    const length = points.slice(1).reduce((sum, p, i) =>
      sum + Math.abs(p[0] - points[i][0]) + Math.abs(p[1] - points[i][1]), 0);
    if (!best || length < best.length) best = { points, length };
  }
  return best?.points || null;
}

function routeOuterColumn(p0, p1, a, b, sa, sb, ctx) {
  if (DIR[sa][0] !== 0 || DIR[sb][0] !== 0) return null;
  const nodes = ctx.nodes;
  const skip = new Set([a.id, b.id]);
  const y0 = p0[1] + DIR[sa][1] * STUB;
  const y1 = p1[1] + DIR[sb][1] * STUB;
  const minX = Math.min(...nodes.map((n) => n.x)) - CLEAR - SPACING;
  const maxX = Math.max(...nodes.map((n) => n.x + n.w)) + CLEAR + SPACING;
  let best = null;
  for (const x of [minX, maxX]) {
    const points = collapse([p0, [p0[0], y0], [x, y0], [x, y1], [p1[0], y1], p1]);
    if (pathBlockedByNodes(points, nodes, skip)) continue;
    const length = points.slice(1).reduce((sum, p, i) =>
      sum + Math.abs(p[0] - points[i][0]) + Math.abs(p[1] - points[i][1]), 0);
    if (!best || length < best.length) best = { points, length };
  }
  return best?.points || null;
}

// ---------------- 折线整理 ----------------

/** 去掉零长度段、合并共线点，保证输出为严格正交折线 */
function collapse(pts) {
  const dedup = [];
  for (const p of pts) {
    const n = dedup.length;
    if (n && Math.abs(dedup[n - 1][0] - p[0]) < 0.5 && Math.abs(dedup[n - 1][1] - p[1]) < 0.5) continue;
    dedup.push([p[0], p[1]]);
  }
  const out = [];
  for (const p of dedup) {
    const n = out.length;
    if (n >= 2) {
      const a = out[n - 2];
      const b = out[n - 1];
      const colX = Math.abs(a[0] - b[0]) < 0.5 && Math.abs(b[0] - p[0]) < 0.5;
      const colY = Math.abs(a[1] - b[1]) < 0.5 && Math.abs(b[1] - p[1]) < 0.5;
      if (colX || colY) {
        // 链式合并的相对容差会让漂移逐段累积（0.4+0.4=0.8），直接融合产生斜线。
        // 只有合并后 a→p 仍轴向对齐才融合；否则在折点处补肘弯保持严格正交。
        const okX = colX && Math.abs(a[0] - p[0]) < 0.5;
        const okY = colY && Math.abs(a[1] - p[1]) < 0.5;
        if (okX || okY) {
          out[n - 1] = [p[0], p[1]];
          continue;
        }
        if (colX && Math.abs(b[1] - a[1]) >= 0.5 && Math.abs(p[1] - b[1]) >= 0.5) {
          out[n - 1] = [a[0], b[1]];
          out.push([p[0], b[1]], [p[0], p[1]]);
          continue;
        }
        if (colY && Math.abs(b[0] - a[0]) >= 0.5 && Math.abs(p[0] - b[0]) >= 0.5) {
          out[n - 1] = [b[0], a[1]];
          out.push([b[0], p[1]], [p[0], p[1]]);
          continue;
        }
        out.push([p[0], p[1]]);
        continue;
      }
    }
    out.push([p[0], p[1]]);
  }
  return out;
}

// ---------------- 分类 ----------------

function classify(e, a, b) {
  let sa = SIDES.has(e.fromSide) ? e.fromSide : null;
  let sb = SIDES.has(e.toSide) ? e.toSide : null;
  let g0;
  let g1;
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  const gapX = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const gapY = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  // 先选两节点之间空隙更大的方向。若上下有重叠，优先从左右出线，
  // 避免纵向路由为了靠近目标而把通道折回源节点内部。
  const horizontal = gapX > gapY || (gapX === gapY && Math.abs(dx) >= Math.abs(dy));
  if (horizontal) {
    g0 = dx >= 0 ? 'right' : 'left';
    g1 = dx >= 0 ? 'left' : 'right';
  } else {
    g0 = dy >= 0 ? 'bottom' : 'top';
    g1 = dy >= 0 ? 'top' : 'bottom';
  }
  sa = sa || g0;
  sb = sb || g1;
  if (DIR[sa][1] !== 0 && DIR[sb][1] !== 0) {
    const span = DIR[sa][1] > 0 ? b.y - (a.y + a.h) : a.y - (b.y + b.h);
    return { sa, sb, type: span > LOOP_THRESHOLD ? 'long' : 'direct' };
  }
  if (DIR[sa][0] !== 0 && DIR[sb][0] !== 0) return { sa, sb, type: 'direct' };
  return { sa, sb, type: 'mixed' };
}

// ---------------- 端口分配 ----------------

function assignPorts(autos, nodeMap) {
  const pools = new Map();
  const add = (id, side, it, isOut) => {
    const k = id + '|' + side;
    if (!pools.has(k)) pools.set(k, []);
    pools.get(k).push({ it, isOut });
  };
  for (const it of autos) {
    add(it.e.from, it.sa, it, true);
    add(it.e.to, it.sb, it, false);
  }
  for (const [k, list] of pools) {
    const [id, side] = k.split('|');
    const n = nodeMap.get(id);
    if (!n) continue;
    const horiz = side === 'top' || side === 'bottom';
    for (const item of list) {
      const other = nodeMap.get(item.isOut ? item.it.e.to : item.it.e.from);
      item.pos = other ? (horiz ? other.x + other.w / 2 : other.y + other.h / 2) : 0;
    }
    list.sort((u, v) => u.pos - v.pos || (u.it.e.line || 0) - (v.it.e.line || 0));
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const p = portAt(n, side, (i + 1) / (list.length + 1));
      if (item.isOut) item.it.e._p0 = p;
      else item.it.e._p1 = p;
    }
  }
}

/** 同侧同色自动出边共用一个源端口，后续母线再从公共出口处分叉。 */
function shareSourcePorts(items, edges) {
  const bySourceSide = new Map();
  const sideUsers = new Map();
  const addUser = (id, side, item, isSource) => {
    const key = `${id}\u0000${side}`;
    if (!sideUsers.has(key)) sideUsers.set(key, []);
    sideUsers.get(key).push({ item, isSource });
  };

  for (const item of items) {
    addUser(item.e.from, item.sa, item, true);
    addUser(item.e.to, item.sb, item, false);
    const key = `${item.e.from}\u0000${item.sa}\u0000${item.sb}\u0000${item.e.kind || 'direct'}`;
    if (!bySourceSide.has(key)) bySourceSide.set(key, []);
    bySourceSide.get(key).push(item);
  }

  for (const list of bySourceSide.values()) {
    if (list.length < 2) continue;
    const source = list[0].a;
    const side = list[0].sa;
    // 用户显式指定的端口或手工折线优先，避免挪动其锚点。
    if (
      list.some((item) => item.e.custom || item.e.fromSide) ||
      edges.some((e) => e.from === source.id && e.custom && (!SIDES.has(e.fromSide) || e.fromSide === side))
    ) continue;
    const users = sideUsers.get(`${source.id}\u0000${side}`) || [];
    if (users.length !== list.length || users.some((user) => !user.isSource || !list.includes(user.item))) continue;

    const sharedPort = portAt(source, side, 0.5);
    for (const item of list) item.e._p0 = sharedPort;
  }
}

// ---------------- 路由：直连（垂直出线，一条水平通道） ----------------

function routeDirectV(e, a, b, sa, sb, ctx) {
  const p0 = e._p0;
  const p1 = e._p1;
  const d0 = DIR[sa][1];
  const skip = new Set([a.id, b.id]);
  const nodes = ctx.nodes;

  const y0s = p0[1] + d0 * STUB; // 源端 stub 线（源节点外侧）
  const y1s = p1[1] + DIR[sb][1] * STUB; // 目标进入线（目标节点外侧）
  // 折点必须落在两个端口之间，不能因为外侧 stub 交叠而选到源节点背后。
  const lo = Math.min(p0[1], p1[1]);
  const hi = Math.max(p0[1], p1[1]);
  const prefer = clamp((y0s + y1s) / 2, lo, hi);
  const cy = findFreeH(
    prefer,
    lo,
    hi,
    Math.min(p0[0], p1[0]),
    Math.max(p0[0], p1[0]),
    nodes,
    skip,
    ctx.placed
  );
  if (hLineBlocked(cy, Math.min(p0[0], p1[0]), Math.max(p0[0], p1[0]), nodes, skip)) {
    // 节点间通道被占时走长边路由，让它从节点外侧绕行。
    return routeOuterColumn(p0, p1, a, b, sa, sb, ctx) || routeLong(e, a, b, sa, sb, ctx);
  }

  // 源端 → 通道
  const pts = [[p0[0], p0[1]]];
  let sx;
  if (Math.abs(p0[1] - cy) < 0.5) {
    sx = p0[0];
  } else if (!vLineBlocked(p0[0], p0[1], cy, nodes, skip)) {
    pts.push([p0[0], cy]);
    sx = p0[0];
  } else {
    const vx = vEscape(p0[0], y0s, cy, nodes, skip, y0s, p0[0]);
    if (vx !== null && Math.abs(vx - p0[0]) > 0.5) {
      pts.push([p0[0], y0s], [vx, y0s], [vx, cy]);
      sx = vx;
    } else {
      pts.push([p0[0], cy]);
      sx = p0[0];
    }
  }

  // 通道 → 目标端
  const tpts = [[p1[0], p1[1]]];
  let tx;
  if (Math.abs(p1[1] - cy) < 0.5) {
    tx = p1[0];
  } else if (!vLineBlocked(p1[0], cy, p1[1], nodes, skip)) {
    tpts.push([p1[0], cy]);
    tx = p1[0];
  } else {
    const vx = vEscape(p1[0], y1s, cy, nodes, skip, y1s, p1[0]);
    if (vx !== null && Math.abs(vx - p1[0]) > 0.5) {
      tpts.push([p1[0], y1s], [vx, y1s], [vx, cy]);
      tx = vx;
    } else {
      tpts.push([p1[0], cy]);
      tx = p1[0];
    }
  }

  addH(ctx.placed, cy, sx, tx);
  const points = collapse(pts.concat([[tx, cy]], tpts.reverse()));
  if (pathBlockedByNodes(points, nodes, skip)) {
    return routeOuterColumn(p0, p1, a, b, sa, sb, ctx) || points;
  }
  return points;
}

// ---------------- 路由：公用母线（同源 / 同目标的同向直连边） ----------------

/**
 * 一组方向相同（dir=+1 向下 / -1 向上）的 direct 边共用一条水平母线：
 * 端口 → 竖直短线 → 母线 → 竖直短线 → 目标端口。
 * 多条平行通道被合并成一条横线 + 若干竖直分支，大幅减少线的杂乱。
 * 任何一支竖直段被节点挡住则整体放弃（返回 false），由调用方逐边兜底。
 */
function routeBus(list, ctx, dir) {
  const nodes = ctx.nodes;
  const srcEdge =
    dir > 0
      ? Math.max(...list.map((it) => it.a.y + it.a.h))
      : Math.min(...list.map((it) => it.a.y));
  const dstEdge =
    dir > 0
      ? Math.min(...list.map((it) => it.b.y))
      : Math.max(...list.map((it) => it.b.y + it.b.h));
  if ((dstEdge - srcEdge) * dir < (STUB + 6) * 2) return false; // 间隙放不下母线

  const x1 = Math.min(...list.map((it) => Math.min(it.e._p0[0], it.e._p1[0])));
  const x2 = Math.max(...list.map((it) => Math.max(it.e._p0[0], it.e._p1[0])));
  const skip = new Set(list.flatMap((it) => [it.a.id, it.b.id]));

  // 母线贴着源侧：向下时在源下方，向上时在源上方
  const prefer = srcEdge + dir * STUB;
  const lo = dir > 0 ? srcEdge + 8 : dstEdge + STUB;
  const hi = dir > 0 ? dstEdge - STUB : srcEdge - 8;
  const busY = findFreeH(prefer, lo, hi, x1, x2, nodes, skip, ctx.placed);
  if (!Number.isFinite(busY)) return false;
  if ((busY - srcEdge) * dir < 8 || (dstEdge - busY) * dir < STUB) return false;

  // 先验证所有竖直分支无阻挡，再统一登记（避免半途失败留下脏通道）
  for (const it of list) {
    const p0 = it.e._p0;
    const p1 = it.e._p1;
    const branchSkip = new Set([it.a.id, it.b.id]);
    if (vLineBlocked(p0[0], p0[1], busY, nodes, branchSkip)) return false;
    if (vLineBlocked(p1[0], busY, p1[1], nodes, branchSkip)) return false;
  }

  addH(ctx.placed, busY, x1, x2);
  for (const it of list) {
    const p0 = it.e._p0;
    const p1 = it.e._p1;
    addV(ctx.placed, p0[0], p0[1], busY);
    addV(ctx.placed, p1[0], busY, p1[1]);
    it.e.points = collapse([p0, [p0[0], busY], [p1[0], busY], p1]);
  }
  return true;
}

/** 左右出线的同源/同目标边共用竖向母线。 */
function routeBusH(list, ctx, dir) {
  const nodes = ctx.nodes;
  const srcEdge =
    dir > 0
      ? Math.max(...list.map((it) => it.a.x + it.a.w))
      : Math.min(...list.map((it) => it.a.x));
  const dstEdge =
    dir > 0
      ? Math.min(...list.map((it) => it.b.x))
      : Math.max(...list.map((it) => it.b.x + it.b.w));
  if ((dstEdge - srcEdge) * dir < (STUB + 6) * 2) return false;

  const y1 = Math.min(...list.map((it) => Math.min(it.e._p0[1], it.e._p1[1])));
  const y2 = Math.max(...list.map((it) => Math.max(it.e._p0[1], it.e._p1[1])));
  const skip = new Set(list.flatMap((it) => [it.a.id, it.b.id]));
  const prefer = srcEdge + dir * STUB;
  const lo = dir > 0 ? srcEdge + 8 : dstEdge + STUB;
  const hi = dir > 0 ? dstEdge - STUB : srcEdge - 8;
  const busX = findFreeV(prefer, lo, hi, y1, y2, nodes, skip, ctx.placed);
  if (!Number.isFinite(busX)) return false;
  if ((busX - srcEdge) * dir < 8 || (dstEdge - busX) * dir < STUB) return false;

  for (const it of list) {
    const p0 = it.e._p0;
    const p1 = it.e._p1;
    const branchSkip = new Set([it.a.id, it.b.id]);
    if (hLineBlocked(p0[1], p0[0], busX, nodes, branchSkip)) return false;
    if (hLineBlocked(p1[1], busX, p1[0], nodes, branchSkip)) return false;
  }

  addV(ctx.placed, busX, y1, y2);
  for (const it of list) {
    const p0 = it.e._p0;
    const p1 = it.e._p1;
    addH(ctx.placed, p0[1], p0[0], busX);
    addH(ctx.placed, p1[1], busX, p1[0]);
    it.e.points = collapse([p0, [busX, p0[1]], [busX, p1[1]], p1]);
  }
  return true;
}

/** 同一调用者的横向多目标边共用节点簇外的水平干线。 */
function routeFanoutBus(list, ctx) {
  if (list.length < 2 || list.some((it) => it.e.fromSide || it.e.toSide || it.e.custom)) return false;
  const source = list[0].a;
  const sourceCx = source.x + source.w / 2;
  const targetCxs = list.map((it) => it.b.x + it.b.w / 2);
  const xDir = targetCxs.every((x) => x > sourceCx + 8) ? 1
    : targetCxs.every((x) => x < sourceCx - 8) ? -1 : 0;
  if (!xDir) return false;
  const minY = Math.min(source.y, ...list.map((it) => it.b.y));
  const maxY = Math.max(source.y + source.h, ...list.map((it) => it.b.y + it.b.h));

  let best = null;
  for (const yDir of [-1, 1]) {
    const sourceSide = yDir < 0 ? 'top' : 'bottom';
    const targetSide = yDir < 0 ? 'top' : 'bottom';
    const p0 = portAt(source, sourceSide, 0.5);
    const targetPorts = list.map((it) => portAt(it.b, targetSide, 0.5));
    const x1 = Math.min(p0[0], ...targetPorts.map((p) => p[0]));
    const x2 = Math.max(p0[0], ...targetPorts.map((p) => p[0]));
    const prefer = yDir < 0 ? minY - STUB : maxY + STUB;
    const lo = yDir < 0 ? prefer - 240 : prefer;
    const hi = yDir < 0 ? prefer : prefer + 240;
    const skipAll = new Set([source.id, ...list.map((it) => it.b.id)]);
    const busY = findFreeH(prefer, lo, hi, x1, x2, ctx.nodes, skipAll, ctx.placed);
    if (!Number.isFinite(busY) || hLineBlocked(busY, x1, x2, ctx.nodes, new Set())) continue;
    if (vLineBlocked(p0[0], p0[1], busY, ctx.nodes, new Set([source.id]))) continue;
    let clear = true;
    let length = x2 - x1 + Math.abs(p0[1] - busY);
    for (let i = 0; i < list.length; i++) {
      const p1 = targetPorts[i];
      if (vLineBlocked(p1[0], busY, p1[1], ctx.nodes, new Set([list[i].b.id]))) {
        clear = false;
        break;
      }
      length += Math.abs(p1[1] - busY);
    }
    if (clear && (!best || length < best.length)) {
      best = { busY, x1, x2, sourceSide, targetSide, p0, targetPorts, length };
    }
  }
  if (!best) return false;

  addV(ctx.placed, best.p0[0], best.p0[1], best.busY);
  addH(ctx.placed, best.busY, best.x1, best.x2);
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const p0 = best.p0;
    const p1 = best.targetPorts[i];
    it.sa = best.sourceSide;
    it.sb = best.targetSide;
    it.e._p0 = p0;
    it.e._p1 = p1;
    addV(ctx.placed, p1[0], best.busY, p1[1]);
    it.e.points = collapse([p0, [p0[0], best.busY], [p1[0], best.busY], p1]);
  }
  return true;
}

// ---------------- 路由：直连（水平出线，一条垂直通道） ----------------

function routeDirectH(e, a, b, sa, sb, ctx) {
  const p0 = e._p0;
  const p1 = e._p1;
  const d0 = DIR[sa][0];
  const skip = new Set([a.id, b.id]);
  const nodes = ctx.nodes;

  const x0s = p0[0] + d0 * STUB;
  const x1s = p1[0] + DIR[sb][0] * STUB;
  const lo = Math.min(x0s, x1s);
  const hi = Math.max(x0s, x1s);
  if (hi - lo < SPACING * 0.6) {
    // 两节点横向压叠：从中线穿过（少见，可手动修正）
    const mx = (p0[0] + p1[0]) / 2;
    return collapse([p0, [mx, p0[1]], [mx, p1[1]], p1]);
  }
  const cx = findFreeV(
    (p0[0] + p1[0]) / 2,
    lo,
    hi,
    Math.min(p0[1], p1[1]),
    Math.max(p0[1], p1[1]),
    nodes,
    skip,
    ctx.placed
  );
  const pts = [[p0[0], p0[1]]];
  let sy;
  if (!hLineBlocked(p0[0], p0[1], cx, nodes, skip)) {
    pts.push([cx, p0[1]]);
    sy = p0[1];
  } else {
    const vy = hEscape(p0[1], x0s, cx, nodes, skip, x0s, p0[1]);
    if (vy !== null && Math.abs(vy - p0[1]) > 0.5) {
      pts.push([x0s, p0[1]], [x0s, vy], [cx, vy]);
      sy = vy;
    } else {
      pts.push([cx, p0[1]]);
      sy = p0[1];
    }
  }

  const tpts = [[p1[0], p1[1]]];
  let ty;
  if (!hLineBlocked(cx, p1[1], p1[0], nodes, skip)) {
    tpts.push([cx, p1[1]]);
    ty = p1[1];
  } else {
    const vy = hEscape(p1[1], x1s, cx, nodes, skip, x1s, p1[1]);
    if (vy !== null && Math.abs(vy - p1[1]) > 0.5) {
      tpts.push([x1s, p1[1]], [x1s, vy], [cx, vy]);
      ty = vy;
    } else {
      tpts.push([cx, p1[1]]);
      ty = p1[1];
    }
  }

  addV(ctx.placed, cx, sy, ty);
  const points = collapse(pts.concat([[cx, ty]], tpts.reverse()));
  if (pathBlockedByNodes(points, nodes, skip)) {
    return routeOuterLane(p0, p1, a, b, sa, sb, ctx) || points;
  }
  return points;
}

// ---------------- 路由：混合出线（源垂直 / 目标水平，或反之） ----------------

function routeMixedVH(e, a, b, sa, sb, ctx) {
  const p0 = e._p0;
  const p1 = e._p1;
  const d0 = DIR[sa][1];
  const skip = new Set([a.id, b.id]);
  const nodes = ctx.nodes;
  const y0s = p0[1] + d0 * STUB;
  const xq = p1[0] + DIR[sb][0] * STUB; // 目标进入线（目标外侧）

  const lo = Math.min(y0s, p1[1]);
  const hi = Math.max(y0s, p1[1]);
  const my = findFreeH(
    (y0s + p1[1]) / 2,
    lo,
    hi,
    Math.min(p0[0], xq),
    Math.max(p0[0], xq),
    nodes,
    skip,
    ctx.placed
  );

  let vx = xq;
  if (vLineBlocked(xq, my, p1[1], nodes, skip)) {
    const esc = vEscape(xq, my, p1[1], nodes, skip);
    if (esc !== null) vx = esc;
  }
  addH(ctx.placed, my, p0[0], vx);
  return collapse([p0, [p0[0], my], [vx, my], [vx, p1[1]], p1]);
}

function routeMixedHV(e, a, b, sa, sb, ctx) {
  const p0 = e._p0;
  const p1 = e._p1;
  const d0 = DIR[sa][0];
  const skip = new Set([a.id, b.id]);
  const nodes = ctx.nodes;
  const x0s = p0[0] + d0 * STUB;
  const yq = p1[1] + DIR[sb][1] * STUB;

  const lo = Math.min(x0s, p1[0]);
  const hi = Math.max(x0s, p1[0]);
  const mx = findFreeV(
    (x0s + p1[0]) / 2,
    lo,
    hi,
    Math.min(p0[1], yq),
    Math.max(p0[1], yq),
    nodes,
    skip,
    ctx.placed
  );

  let vy = yq;
  if (hLineBlocked(p1[0], mx, yq, nodes, skip)) {
    const esc = hEscape(yq, mx, p1[0], nodes, skip);
    if (esc !== null) vy = esc;
  }
  addV(ctx.placed, mx, p0[1], vy);
  return collapse([p0, [mx, p0[1]], [mx, vy], [p1[0], vy], p1]);
}

// ---------------- 路由：长边（走廊优先，侧边车道兜底） ----------------

function chooseLaneSide(a, b, bounds) {
  const left = a.x + a.w / 2 - bounds.minX + (b.x + b.w / 2 - bounds.minX);
  const right = bounds.maxX - a.x - a.w / 2 + (bounds.maxX - b.x - b.w / 2);
  return left <= right ? 'left' : 'right';
}

function allocLane(ctx, side, yLo, yHi) {
  for (let k = 0; k < 60; k++) {
    const x =
      side === 'left'
        ? ctx.bounds.minX - LANE_BASE - k * SPACING
        : ctx.bounds.maxX + LANE_BASE + k * SPACING;
    const clash = ctx.lanes[side].some(
      (l) => Math.abs(l.x - x) < SPACING * 0.8 && l.y2 > yLo - 10 && l.y1 < yHi + 10
    );
    if (!clash) return k;
  }
  return 0;
}

function routeLong(e, a, b, sa, sb, ctx) {
  const p0 = e._p0;
  const p1 = e._p1;
  const d0 = DIR[sa][1];
  const d1 = DIR[sb][1];
  const skip = new Set([a.id, b.id]);
  const nodes = ctx.nodes;
  const c1n = p0[1] + d0 * STUB; // 源端通道（源节点外侧间隙）
  const c2n = p1[1] + d1 * STUB; // 目标端通道（目标节点外侧间隙）
  const r1 = d0 > 0 ? [c1n, c1n + 50] : [c1n - 50, c1n];
  const r2 = d1 > 0 ? [c2n, c2n + 50] : [c2n - 50, c2n];
  const midX = (p0[0] + p1[0]) / 2;

  // —— 尝试图内垂直走廊 ——
  const yTop = Math.min(c1n, c2n);
  const yBot = Math.max(c1n, c2n);
  const cands = [p0[0], p1[0], midX];
  for (const n of nodes) {
    if (skip.has(n.id)) continue;
    if (n.y + n.h < yTop - CLEAR || n.y > yBot + CLEAR) continue;
    cands.push(n.x - CLEAR - 0.5, n.x + n.w + CLEAR + 0.5);
  }
  cands.sort((u, v) => Math.abs(u - midX) - Math.abs(v - midX));
  let vx = null;
  for (const c of cands) {
    if (!vLineBlocked(c, yTop, yBot, nodes, skip)) {
      vx = c;
      break;
    }
  }
  if (vx !== null) {
    const c1 = findFreeH(c1n, r1[0], r1[1], Math.min(p0[0], vx), Math.max(p0[0], vx), nodes, skip, ctx.placed);
    const c2 = findFreeH(c2n, r2[0], r2[1], Math.min(vx, p1[0]), Math.max(vx, p1[0]), nodes, skip, ctx.placed);
    addH(ctx.placed, c1, p0[0], vx);
    addH(ctx.placed, c2, vx, p1[0]);
    addV(ctx.placed, vx, c1, c2);
    return collapse([p0, [p0[0], c1], [vx, c1], [vx, c2], [p1[0], c2], p1]);
  }

  // —— 侧边车道 ——
  const side = chooseLaneSide(a, b, ctx.bounds);
  const yLo = Math.min(c1n, c2n);
  const yHi = Math.max(c1n, c2n);
  const k = allocLane(ctx, side, yLo, yHi);
  const laneX =
    side === 'left'
      ? ctx.bounds.minX - LANE_BASE - k * SPACING
      : ctx.bounds.maxX + LANE_BASE + k * SPACING;
  ctx.lanes[side].push({ x: laneX, y1: yLo, y2: yHi });
  if (side === 'left') {
    if (ctx.laneLeftMin === null || laneX < ctx.laneLeftMin) ctx.laneLeftMin = laneX;
  } else if (ctx.laneRightMax === null || laneX > ctx.laneRightMax) {
    ctx.laneRightMax = laneX;
  }
  const c1 = findFreeH(c1n, r1[0], r1[1], Math.min(p0[0], laneX), Math.max(p0[0], laneX), nodes, skip, ctx.placed);
  const c2 = findFreeH(c2n, r2[0], r2[1], Math.min(laneX, p1[0]), Math.max(laneX, p1[0]), nodes, skip, ctx.placed);
  addH(ctx.placed, c1, p0[0], laneX);
  addH(ctx.placed, c2, laneX, p1[0]);
  return collapse([p0, [p0[0], c1], [laneX, c1], [laneX, c2], [p1[0], c2], p1]);
}

// ---------------- 路由：自环 ----------------

function routeSelf(e, a, ctx) {
  const k = ctx.selfLoops++;
  const fx = 0.72;
  const off = STUB + 8 + k * SPACING;
  const x = a.x + a.w * fx;
  const yb = a.y + a.h + STUB + 6;
  const yt = a.y - STUB - 6;
  const rx = a.x + a.w + off;
  e._p0 = [x, a.y + a.h];
  e._p1 = [x, a.y];
  return collapse([
    [x, a.y + a.h],
    [x, yb],
    [rx, yb],
    [rx, yt],
    [x, yt],
    [x, a.y],
  ]);
}

// ---------------- 手动布线：端点跟随节点 ----------------

function deriveSideStart(p, q) {
  return Math.abs(q[0] - p[0]) >= Math.abs(q[1] - p[1])
    ? q[0] >= p[0]
      ? 'right'
      : 'left'
    : q[1] >= p[1]
    ? 'bottom'
    : 'top';
}

function deriveSideEnd(q, p) {
  return Math.abs(q[0] - p[0]) >= Math.abs(q[1] - p[1])
    ? p[0] >= q[0]
      ? 'left'
      : 'right'
    : p[1] >= q[1]
    ? 'top'
    : 'bottom';
}

function sideFrac(n, side, p) {
  if (side === 'top' || side === 'bottom') return clamp((p[0] - n.x) / Math.max(1, n.w), 0.05, 0.95);
  return clamp((p[1] - n.y) / Math.max(1, n.h), 0.05, 0.95);
}

/** 自定义边：端点重新锚定到节点端口，第二/倒数第二点对齐保持严格正交 */
function retargetCustom(e, a, b) {
  const pts = e.points;
  const p0 = pts[0];
  const p1 = pts[pts.length - 1];
  const q0 = pts[1] || p0;
  const q1 = pts[pts.length - 2] || p1;
  const sa = deriveSideStart(p0, q0);
  const sb = deriveSideEnd(q1, p1);
  const np0 = portAt(a, sa, sideFrac(a, sa, p0));
  const np1 = portAt(b, sb, sideFrac(b, sb, p1));
  pts[0] = np0;
  pts[pts.length - 1] = np1;

  if (pts.length === 2) {
    // 只有两点时补一个肘弯，保证不出现斜线
    if (DIR[sa][1] !== 0) {
      pts.splice(1, 0, [np1[0], np0[1]]);
    } else {
      pts.splice(1, 0, [np0[0], np1[1]]);
    }
    return;
  }
  if (pts[1]) {
    if (DIR[sa][1] !== 0) pts[1][0] = np0[0];
    else pts[1][1] = np0[1];
  }
  if (pts.length >= 3) {
    const n1 = pts.length - 2;
    if (DIR[sb][1] !== 0) pts[n1][0] = np1[0];
    else pts[n1][1] = np1[1];
  }
}

// ---------------- 主入口 ----------------

/**
 * 对一组边做正交路由。
 * @param {Array} nodes [{id,x,y,w,h}]
 * @param {Array} edges [{from,to,...}]；custom 且带 points 的边只做端点重锚定
 * @param {object} opts
 *   - existing: {h:[{y,x1,x2}], v:[{x,y1,y2}]} 其他已布边的线段（作为避让约束，增量路由用）
 *   - bounds: {minX, maxX} 侧边车道参考边界（缺省用节点包络）
 * @returns {placed, lanes, laneLeftMin, laneRightMax}
 */
export function routeEdges(nodes, edges, opts = {}) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  let minX = Infinity;
  let maxX = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x + n.w > maxX) maxX = n.x + n.w;
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 100;
  }
  const ctx = {
    nodes,
    nodeMap,
    bounds: opts.bounds || { minX, maxX },
    placed: {
      h: (opts.existing?.h || []).map((s) => ({ k: s.y, ...s })),
      v: (opts.existing?.v || []).map((s) => ({ k: s.x, ...s })),
    },
    lanes: { left: [], right: [] },
    laneLeftMin: null,
    laneRightMax: null,
    selfLoops: 0,
  };
  // existing 需按 k 排序以便二分
  ctx.placed.h.sort((u, v) => u.k - v.k);
  ctx.placed.v.sort((u, v) => u.k - v.k);

  const autos = [];
  for (const e of edges) {
    const a = nodeMap.get(e.from);
    const b = nodeMap.get(e.to);
    if (!a || !b) continue;
    if (a === b) {
      e.points = routeSelf(e, a, ctx);
      e.back = true;
      continue;
    }
    if (e.custom && Array.isArray(e.points) && e.points.length >= 2) {
      retargetCustom(e, a, b);
      e.back = false;
      continue;
    }
    const c = classify(e, a, b);
    e.back = c.sa === 'top';
    autos.push({ e, a, b, ...c });
  }

  // ---- 共线合并：同一对节点、相同类型的调用边（不同调用行）只布一条折线 ----
  // 类型决定颜色（direct/macro/fnptr/manual 各不同色），跨类型不合并，避免遮盖错色
  const pairKey = (e) => e.from + '\u0000' + e.to + '\u0000' + (e.kind || 'direct');
  const pairFirst = new Map();
  const pairDups = [];
  for (const it of autos) {
    const k = pairKey(it.e);
    if (pairFirst.has(k)) pairDups.push(it);
    else pairFirst.set(k, it);
  }
  const items = [...pairFirst.values()];

  assignPorts(items, nodeMap);
  shareSourcePorts(items, edges);

  // 稳定排序：直连 → 混合 → 长边；同类型按端口 y 再 x
  const rank = { direct: 0, side: 0, mixed: 1, long: 2 };
  items.sort(
    (x, y) =>
      rank[x.type] - rank[y.type] ||
      (x.e._p0[1] + x.e._p1[1]) - (y.e._p0[1] + y.e._p1[1]) ||
      x.e._p0[0] - y.e._p0[0] ||
      (x.e.line || 0) - (y.e.line || 0)
  );

  // ---- 公用母线：同源（再同目标）、同类型且方向一致的直连边共享通道 ----
  // 上下连接共用水平母线，左右连接共用竖直母线。
  // 母线成员必须同类型同色，不同颜色的线不得互相借用通道
  const bused = new Set();
  // 先尝试完整的高扇出组合，避免简单母线先吃掉其中一部分后破坏整体汇流。
  const fanouts = new Map();
  for (const it of items) {
    const targetRegion = it.b.group ?? 'all';
    const key = it.e.from + '\u0000' + (it.e.kind || 'direct') + '\u0000' + targetRegion;
    if (!fanouts.has(key)) fanouts.set(key, []);
    fanouts.get(key).push(it);
  }
  for (const list of fanouts.values()) {
    if (routeFanoutBus(list, ctx)) for (const it of list) bused.add(it);
  }

  for (const keyFn of [(it) => it.e.from + '\u0000' + it.e.kind, (it) => it.e.to + '\u0000' + it.e.kind]) {
    for (const axis of ['vertical', 'horizontal']) {
      for (const dir of [1, -1]) {
      const groups = new Map();
      for (const it of items) {
        if (bused.has(it) || it.type !== 'direct') continue;
        const matches = axis === 'vertical'
          ? dir === 1 ? it.sa === 'bottom' && it.sb === 'top' : it.sa === 'top' && it.sb === 'bottom'
          : dir === 1 ? it.sa === 'right' && it.sb === 'left' : it.sa === 'left' && it.sb === 'right';
        if (!matches) continue;
        const k = keyFn(it);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(it);
      }
      for (const list of groups.values()) {
        if (list.length < 2) continue;
        const routed = axis === 'vertical' ? routeBus(list, ctx, dir) : routeBusH(list, ctx, dir);
        if (routed) for (const it of list) bused.add(it);
      }
      }
    }
  }

  for (const it of items) {
    if (bused.has(it)) continue;
    const { e, a, b, sa, sb, type } = it;
    const vertA = DIR[sa][1] !== 0;
    const vertB = DIR[sb][1] !== 0;
    try {
      if (vertA && vertB) {
        e.points =
          type === 'long' ? routeLong(e, a, b, sa, sb, ctx) : routeDirectV(e, a, b, sa, sb, ctx);
      } else if (!vertA && !vertB) {
        e.points = routeDirectH(e, a, b, sa, sb, ctx);
      } else if (vertA) {
        e.points = routeMixedVH(e, a, b, sa, sb, ctx);
      } else {
        e.points = routeMixedHV(e, a, b, sa, sb, ctx);
      }
    } catch {
      // 兜底：端口间 L 形（仍保持正交）
      e.points = collapse([e._p0, [e._p1[0], e._p0[1]], e._p1]);
    }
  }

  // 重复边直接复用首条折线（展示上完全重合 = 合并为一条线）
  for (const it of pairDups) {
    const f = pairFirst.get(pairKey(it.e));
    if (f && f.e.points) it.e.points = f.e.points.map((p) => [p[0], p[1]]);
  }

  return {
    placed: ctx.placed,
    lanes: ctx.lanes,
    laneLeftMin: ctx.laneLeftMin,
    laneRightMax: ctx.laneRightMax,
  };
}

/** 收集一组边当前折线里的水平/垂直线段（供增量路由做避让约束） */
export function collectSegments(edges) {
  const h = [];
  const v = [];
  for (const e of edges) {
    const pts = e.points || [];
    for (let i = 0; i < pts.length - 1; i++) {
      const x1 = pts[i][0];
      const y1 = pts[i][1];
      const x2 = pts[i + 1][0];
      const y2 = pts[i + 1][1];
      if (Math.abs(y1 - y2) < 0.5 && Math.abs(x1 - x2) > 0.5) {
        h.push({ y: y1, x1: Math.min(x1, x2), x2: Math.max(x1, x2) });
      } else if (Math.abs(x1 - x2) < 0.5 && Math.abs(y1 - y2) > 0.5) {
        v.push({ x: x1, y1: Math.min(y1, y2), y2: Math.max(y1, y2) });
      }
    }
  }
  return { h, v };
}

/** 生成带圆角的 SVG path d（折点用二次贝塞尔过渡） */
export function roundedPathD(pts, r = 0) {
  if (!pts || pts.length < 2) return '';
  const f = (x) => Math.round(x * 10) / 10;
  let d = `M ${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${f(pts[i][0])} ${f(pts[i][1])}`;
  }
  return d;
}
