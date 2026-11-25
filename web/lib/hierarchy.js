/** 层级框整体移动与手动调整大小：保留归属关系，扩展祖先容器，避免同级区域重叠。 */
const inside = (parent, child) => parent.box !== child.box && parent.kind === 'dir' &&
  (parent.box.root || child.box.id.startsWith(parent.box.id + '/'));
const overlap = (a, b) => a.x < b.x + b.w + 12 && b.x < a.x + a.w + 12 &&
  a.y < b.y + b.h + 12 && b.y < a.y + a.h + 12;
const gapOverlapArea = (a, b) => {
  const ox = Math.min(a.x + a.w, b.x + b.w) + 12 - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) + 12 - Math.max(a.y, b.y);
  return ox > 0 && oy > 0 ? ox * oy : 0;
};

const allBoxes = (view) => [
  ...(view?.groups || []).map((box) => ({ kind: 'file', box })),
  ...(view?.containers || []).map((box) => ({ kind: 'dir', box })),
];

export function beginHierarchyMove(view, selection) {
  const boxes = allBoxes(view);
  const moving = boxes.filter((b) => b.box === selection.box || inside(selection, b));
  const ancestors = boxes.filter((b) => b.box !== selection.box && inside(b, selection))
    .sort((a, b) => b.box.depth - a.box.depth);
  const files = new Set(moving.filter((b) => b.kind === 'file').map((b) => b.box.id));
  const nodes = view.nodes.filter((n) => files.has(n.group));
  const ids = new Set(nodes.map((n) => n.id));
  const internal = [], crossing = [], stationary = [];
  for (const edge of view.edges) {
    const from = ids.has(edge.from), to = ids.has(edge.to);
    (from && to ? internal : from || to ? crossing : stationary).push(edge);
  }
  const watched = [...moving, ...ancestors];
  const initialOverlap = new Map();
  for (const a of watched) {
    for (const b of boxes) {
      if (a.box === b.box || inside(a, b) || inside(b, a)) continue;
      const area = gapOverlapArea(a.box, b.box);
      if (area > 0) initialOverlap.set(`${a.kind}:${a.box.id}|${b.kind}:${b.box.id}`, area);
    }
  }
  const parentId = (id) => id.split('/').slice(0, -1).join('/');
  const peers = boxes.filter((b) => b.box !== selection.box && !b.box.root &&
    !inside(selection, b) && !inside(b, selection) && parentId(b.box.id) === parentId(selection.box.id));
  const ancestorChildren = ancestors.map((ancestor) => ({
    ancestor,
    children: boxes.filter((c) => inside(ancestor, c)).map((c) => c.box),
  }));
  const rects = watched.map(({ box }) => ({ item: box, x: box.x, y: box.y, w: box.w, h: box.h }));
  const positions = nodes.map((n) => ({ item: n, x: n.x, y: n.y }));
  const restoreList = [...rects, ...positions];
  const origin = rects.find((r) => r.item === selection.box);
  let minMoveX = Infinity, minMoveY = Infinity;
  for (const { box } of moving) {
    if (box.x < minMoveX) minMoveX = box.x;
    if (box.y < minMoveY) minMoveY = box.y;
  }
  if (!Number.isFinite(minMoveX)) minMoveX = 0;
  if (!Number.isFinite(minMoveY)) minMoveY = 0;
  // 留出祖先容器左侧/顶部内边距，避免拖拽贴近画布左上边界时整块被拦停。
  const topPadNeeded = ancestors.reduce((sum, a) => sum + (a.box.root ? 24 : 32), 0);
  const leftPadNeeded = ancestors.reduce((sum, a) => sum + (a.box.root ? 24 : 10), 0);
  minMoveX = Math.max(0, minMoveX - leftPadNeeded);
  minMoveY = Math.max(0, minMoveY - topPadNeeded);
  const paths = [...internal, ...crossing].map((edge) => ({
    edge,
    internal: ids.has(edge.from) && ids.has(edge.to),
    fromMoves: ids.has(edge.from),
    points: edge.points.map((p) => [...p]),
  }));
  return {
    ...selection, view, boxes, moving, ancestors, watched, peers, ancestorChildren, initialOverlap,
    nodes, ids, internal, crossing, stationary,
    origin, minMoveX, minMoveY,
    rects, positions, restoreList, paths,
    width: view.width, height: view.height, dx: 0, dy: 0, guides: [],
  };
}

function restoreRects(drag) {
  const list = drag.restoreList || [...drag.rects, ...(drag.positions || [])];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const item = r.item;
    item.x = r.x;
    item.y = r.y;
    if (r.w !== undefined) {
      item.w = r.w;
      item.h = r.h;
    }
  }
}

export function cancelHierarchyMove(drag) {
  restoreRects(drag);
  for (const { edge, points } of drag.paths) edge.points = points.map((p) => [...p]);
  drag.view.width = drag.width;
  drag.view.height = drag.height;
}

/** 拖拽大型层级框时的 O(1)/边 轻量正交预览：避免每帧全量 A* 重布线导致掉帧卡顿，松手再做全量精布线。 */
export function updateCrossingEdgePreview(drag) {
  const dx = drag.dx, dy = drag.dy;
  for (const entry of drag.paths) {
    if (entry.internal) continue;
    const src = entry.points;
    if (src.length < 2) continue;
    const pts = src.map((p) => [p[0], p[1]]);
    if (entry.fromMoves) {
      pts[0][0] += dx;
      pts[0][1] += dy;
      if (pts.length >= 3) {
        if (Math.abs(src[0][0] - src[1][0]) < 0.5) pts[1][0] += dx;
        else if (Math.abs(src[0][1] - src[1][1]) < 0.5) pts[1][1] += dy;
      }
    } else {
      const last = pts.length - 1;
      pts[last][0] += dx;
      pts[last][1] += dy;
      if (pts.length >= 3) {
        if (Math.abs(src[last][0] - src[last - 1][0]) < 0.5) pts[last - 1][0] += dx;
        else if (Math.abs(src[last][1] - src[last - 1][1]) < 0.5) pts[last - 1][1] += dy;
      }
    }
    entry.edge.points = pts;
  }
}

export function moveHierarchy(drag, dx, dy, tolerance = 0) {
  const origin = drag.origin || drag.rects.find((r) => r.item === drag.box);
  const peers = drag.peers || [];
  const clampedDx = Math.max(-drag.minMoveX, dx);
  const clampedDy = Math.max(-drag.minMoveY, dy);
  const snapped = { x: clampedDx, y: clampedDy }, guides = [];
  for (const [axis, size] of [['x', 'w'], ['y', 'h']]) {
    let best = tolerance, match = null;
    for (const peer of peers) for (const ratio of [0, 0.5, 1]) {
      const at = peer.box[axis] + peer.box[size] * ratio;
      const offset = at - origin[axis] - snapped[axis] - origin[size] * ratio;
      if (Math.abs(offset) < best) { best = Math.abs(offset); match = { axis, at, offset, peer: peer.box }; }
    }
    if (match) { snapped[axis] += match.offset; guides.push(match); }
  }
  snapped.x = Math.max(-drag.minMoveX, snapped.x);
  snapped.y = Math.max(-drag.minMoveY, snapped.y);

  const watched = drag.watched || [...drag.moving, ...drag.ancestors];
  const initialOverlap = drag.initialOverlap;
  const apply = (tx, ty) => {
    restoreRects(drag);
    for (const { box } of drag.moving) { box.x += tx; box.y += ty; }
    for (const n of drag.nodes) { n.x += tx; n.y += ty; }
    for (const { ancestor, children } of drag.ancestorChildren) {
      const b = ancestor.box;
      const pad = b.root ? 24 : 10;
      const topPad = b.root ? 24 : 32;
      let right = b.x + b.w, bottom = b.y + b.h, minX = b.x, minY = b.y;
      for (const c of children) {
        if (c.x + c.w + pad > right) right = c.x + c.w + pad;
        if (c.y + c.h + pad > bottom) bottom = c.y + c.h + pad;
        if (c.x - pad < minX) minX = c.x - pad;
        if (c.y - topPad < minY) minY = c.y - topPad;
      }
      b.x = minX;
      b.y = minY;
      b.w = right - b.x;
      b.h = bottom - b.y;
    }
    for (const a of watched) {
      if (a.box.x < 0 || a.box.y < 0) return false;
      for (const b of drag.boxes) {
        if (a.box === b.box || inside(a, b) || inside(b, a)) continue;
        if (!overlap(a.box, b.box)) continue;
        if (!initialOverlap) return false;
        const area = gapOverlapArea(a.box, b.box);
        const initial = initialOverlap.get(`${a.kind}:${a.box.id}|${b.kind}:${b.box.id}`) || 0;
        if (!(initial > 0 && area <= initial + 0.01)) return false;
      }
    }
    return true;
  };

  let accepted = null;
  for (const [tx, ty] of [[snapped.x, snapped.y], [clampedDx, clampedDy], [snapped.x, drag.dy], [drag.dx, snapped.y]]) {
    if (apply(tx, ty)) { accepted = [tx, ty]; break; }
  }
  // 鼠标跨过障碍时沿目标方向二分贴边滑动，不再卡死在旧坐标不跟手。
  if (!accepted) {
    let bestX = drag.dx, bestY = drag.dy;
    const slideAxis = (targetX, targetY) => {
      let lo = 0, hi = 1, hit = null;
      for (let step = 0; step < 6; step++) {
        const mid = (lo + hi) * 0.5;
        const mx = bestX + (targetX - bestX) * mid;
        const my = bestY + (targetY - bestY) * mid;
        if (apply(mx, my)) { lo = mid; hit = [mx, my]; }
        else hi = mid;
      }
      if (hit) [bestX, bestY] = hit;
    };
    slideAxis(clampedDx, clampedDy);
    if (bestX === drag.dx && bestY === drag.dy) {
      slideAxis(clampedDx, bestY);
      slideAxis(bestX, clampedDy);
    }
    apply(bestX, bestY);
    accepted = [bestX, bestY];
  }
  const changed = accepted[0] !== drag.dx || accepted[1] !== drag.dy;
  [drag.dx, drag.dy] = accepted;
  drag.guides = guides.filter((g) => (g.axis === 'x' ? drag.dx : drag.dy) === snapped[g.axis]);
  if (changed) {
    for (const entry of drag.paths) {
      if (entry.internal) {
        entry.edge.points = entry.points.map(([x, y]) => [x + drag.dx, y + drag.dy]);
      } else if (drag.crossing.length <= 6) {
        entry.edge.points = entry.points.map(([x, y]) => [x, y]);
      }
    }
    let maxW = drag.width, maxH = drag.height;
    for (const { box } of drag.boxes) {
      if (box.x + box.w > maxW) maxW = box.x + box.w;
      if (box.y + box.h > maxH) maxH = box.y + box.h;
    }
    drag.view.width = maxW;
    drag.view.height = maxH;
  }
  return changed;
}

/** 计算框内子元素的最小包围边界（含标准边距），确保手动缩小时不会裁掉内部节点或子框。 */
function minContentRect(view, target, boxes, { filePad = 8, fileTop = 32 } = {}) {
  if (target.kind === 'file') {
    const nodes = (view.nodes || []).filter((n) => n.group === target.box.id);
    if (!nodes.length) return null;
    return {
      minX: Math.min(...nodes.map((n) => n.x)) - filePad,
      minY: Math.min(...nodes.map((n) => n.y)) - fileTop,
      maxX: Math.max(...nodes.map((n) => n.x + n.w)) + filePad,
      maxY: Math.max(...nodes.map((n) => n.y + n.h)) + filePad,
    };
  }
  const children = boxes.filter((c) => inside(target, c)).map((c) => c.box);
  if (!children.length) return null;
  const pad = target.box.root ? 24 : 10;
  const topPad = target.box.root ? 24 : 32;
  return {
    minX: Math.min(...children.map((c) => c.x)) - pad,
    minY: Math.min(...children.map((c) => c.y)) - topPad,
    maxX: Math.max(...children.map((c) => c.x + c.w)) + pad,
    maxY: Math.max(...children.map((c) => c.y + c.h)) + pad,
  };
}

function syncViewBounds(view, boxes, { allowShrink = false, baseWidth = 480, baseHeight = 260 } = {}) {
  let maxX = allowShrink ? 480 : Math.max(480, baseWidth);
  let maxY = allowShrink ? 260 : Math.max(260, baseHeight);
  for (const { box } of boxes) {
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  for (const n of view.nodes || []) {
    maxX = Math.max(maxX, n.x + n.w + 24);
    maxY = Math.max(maxY, n.y + n.h + 24);
  }
  for (const e of view.edges || []) {
    for (const p of e.points || []) {
      maxX = Math.max(maxX, p[0] + 24);
      maxY = Math.max(maxY, p[1] + 24);
    }
  }
  view.width = Math.round(maxX);
  view.height = Math.round(maxY);
}

/** 开始拖拽文件框 / 目录容器的边或角来手动调整大小。 */
export function beginBoxResize(view, selection, edge) {
  const boxes = allBoxes(view);
  const ancestors = boxes.filter((b) => b.box !== selection.box && inside(b, selection))
    .sort((a, b) => b.box.depth - a.box.depth);
  const content = minContentRect(view, selection, boxes);
  const watched = [selection, ...ancestors];
  // 记录拖拽前已存在重叠的面积：允许重叠减小或保持，绝不允许把重叠拉得更大。
  const initialOverlap = new Map();
  for (const a of watched) {
    for (const b of boxes) {
      if (a.box === b.box || inside(a, b) || inside(b, a)) continue;
      const area = gapOverlapArea(a.box, b.box);
      if (area > 0) initialOverlap.set(`${a.kind}:${a.box.id}|${b.kind}:${b.box.id}`, area);
    }
  }
  return {
    ...selection,
    edge,
    view,
    boxes,
    ancestors,
    content,
    initialOverlap,
    rects: watched.map(({ box }) => ({ item: box, x: box.x, y: box.y, w: box.w, h: box.h })),
    lastRect: { x: selection.box.x, y: selection.box.y, w: selection.box.w, h: selection.box.h },
    width: view.width,
    height: view.height,
    changed: false,
  };
}

export function cancelBoxResize(drag) {
  restoreRects(drag);
  drag.view.width = drag.width;
  drag.view.height = drag.height;
}

export function resizeBox(drag, dx, dy) {
  const origin = drag.rects[0];
  const minW = drag.kind === 'dir' ? 160 : 120;
  const minH = drag.kind === 'dir' ? 90 : 70;
  const edge = drag.edge;
  const content = drag.content;

  let left = origin.x;
  let right = origin.x + origin.w;
  let top = origin.y;
  let bottom = origin.y + origin.h;

  if (edge.includes('w')) {
    const maxL = Math.min(right - minW, content ? Math.max(origin.x, content.minX) : right - minW);
    left = Math.max(0, Math.min(origin.x + dx, maxL));
  }
  if (edge.includes('e')) {
    right = Math.max(origin.x + origin.w + dx, content ? Math.max(left + minW, content.maxX) : left + minW);
  }
  if (edge.includes('n')) {
    const maxT = Math.min(bottom - minH, content ? Math.max(origin.y, content.minY) : bottom - minH);
    top = Math.max(0, Math.min(origin.y + dy, maxT));
  }
  if (edge.includes('s')) {
    bottom = Math.max(origin.y + origin.h + dy, content ? Math.max(top + minH, content.maxY) : top + minH);
  }

  const candidate = {
    x: Math.round(left * 10) / 10,
    y: Math.round(top * 10) / 10,
    w: Math.round((right - left) * 10) / 10,
    h: Math.round((bottom - top) * 10) / 10,
  };

  const apply = (rect) => {
    restoreRects(drag);
    Object.assign(drag.box, rect);
    // 由内向外逐层撑开祖先容器，保证多层目录的左边距与 32px 标题区都完整保留。
    for (const ancestor of drag.ancestors) {
      const b = ancestor.box;
      const children = drag.boxes.filter((c) => inside(ancestor, c)).map((c) => c.box);
      const pad = b.root ? 24 : 10;
      const topPad = b.root ? 24 : 32;
      const ar = Math.max(b.x + b.w, ...children.map((c) => c.x + c.w + pad));
      const ab = Math.max(b.y + b.h, ...children.map((c) => c.y + c.h + pad));
      if (drag.edge.includes('w')) {
        const minLeft = Math.min(...children.map((c) => c.x - pad));
        b.x = b.root ? Math.max(0, Math.min(b.x, minLeft)) : Math.min(b.x, minLeft);
      }
      if (drag.edge.includes('n')) {
        const minTop = Math.min(...children.map((c) => c.y - topPad));
        b.y = b.root ? Math.max(0, Math.min(b.y, minTop)) : Math.min(b.y, minTop);
      }
      b.w = ar - b.x;
      b.h = ab - b.y;
    }
    const rootBox = drag.boxes.find((b) => b.box.root)?.box;
    const watched = [drag, ...drag.ancestors];
    return watched.every((a) => {
      if (a.box.x < 0 || a.box.y < 0) return false;
      if (rootBox && a.box !== rootBox && (a.box.x < rootBox.x || a.box.y < rootBox.y)) return false;
      return drag.boxes.every((b) => {
        if (a.box === b.box || inside(a, b) || inside(b, a)) return true;
        const area = gapOverlapArea(a.box, b.box);
        if (area <= 0) return true;
        const initial = drag.initialOverlap.get(`${a.kind}:${a.box.id}|${b.kind}:${b.box.id}`) || 0;
        return initial > 0 && area <= initial + 0.01;
      });
    });
  };

  const prev = drag.lastRect;
  const attempts = [
    candidate,
    { x: candidate.x, y: prev.y, w: candidate.w, h: prev.h },
    { x: prev.x, y: candidate.y, w: prev.w, h: prev.h },
    prev,
  ];
  let accepted = prev;
  for (const rect of attempts) {
    if (apply(rect)) { accepted = rect; break; }
  }
  const movedNow = accepted.x !== prev.x || accepted.y !== prev.y || accepted.w !== prev.w || accepted.h !== prev.h;
  drag.lastRect = { ...accepted };
  if (accepted.x !== origin.x || accepted.y !== origin.y || accepted.w !== origin.w || accepted.h !== origin.h) {
    drag.changed = true;
  }
  if (movedNow) {
    syncViewBounds(drag.view, drag.boxes, { allowShrink: !!drag.box.root, baseWidth: drag.width, baseHeight: drag.height });
  }
  return movedNow;
}

/** 一键将文件框或目录容器收缩贴合内部内容，只收缩多余空白、绝不反向撑大。 */
export function shrinkBoxToFit(view, selection, { recursive = true } = {}) {
  const boxes = allBoxes(view);
  const targets = [];
  if (selection.kind === 'dir' && recursive) {
    const descFiles = boxes.filter((b) => b.kind === 'file' && inside(selection, b));
    const descDirs = boxes.filter((b) => b.kind === 'dir' && inside(selection, b))
      .sort((a, b) => (b.box.depth || 0) - (a.box.depth || 0));
    targets.push(...descFiles, ...descDirs, selection);
  } else {
    targets.push(selection);
  }
  let changed = false;
  for (const target of targets) {
    const content = minContentRect(view, target, boxes, { filePad: 8, fileTop: 32 });
    if (!content) continue;
    const minW = target.kind === 'dir' ? 160 : 120;
    const minH = target.kind === 'dir' ? 90 : 70;
    const b = target.box;
    const curRight = b.x + b.w;
    const curBottom = b.y + b.h;
    const nx = Math.max(b.x, Math.min(curRight - minW, Math.round(content.minX * 10) / 10));
    const ny = Math.max(b.y, Math.min(curBottom - minH, Math.round(content.minY * 10) / 10));
    const nRight = Math.min(curRight, Math.max(nx + minW, Math.round(content.maxX * 10) / 10));
    const nBottom = Math.min(curBottom, Math.max(ny + minH, Math.round(content.maxY * 10) / 10));
    const nw = Math.round((nRight - nx) * 10) / 10;
    const nh = Math.round((nBottom - ny) * 10) / 10;
    if (b.x !== nx || b.y !== ny || b.w !== nw || b.h !== nh) {
      b.x = nx;
      b.y = ny;
      b.w = nw;
      b.h = nh;
      changed = true;
    }
  }
  if (changed) {
    syncViewBounds(view, boxes, { allowShrink: !!selection.box.root, baseWidth: view.width, baseHeight: view.height });
  }
  return changed;
}
