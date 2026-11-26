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

const ancestorBoxes = (boxes, target) => boxes.filter((b) => inside(b, target))
  .sort((a, b) => Number(!!a.box.root) - Number(!!b.box.root) || b.box.id.length - a.box.id.length);
const overlapKey = (a, b) => `${a.kind}:${a.box.id}|${b.kind}:${b.box.id}`;
const unrelated = (a, b) => a.box !== b.box && !inside(a, b) && !inside(b, a);

function captureInitialOverlap(watched, boxes) {
  const initial = new Map();
  for (const a of watched) for (const b of boxes) {
    if (!unrelated(a, b)) continue;
    const area = gapOverlapArea(a.box, b.box);
    if (area > 0) initial.set(overlapKey(a, b), area);
  }
  return initial;
}

const snapshotRect = (item) => ({ item, x: item.x, y: item.y, w: item.w, h: item.h });

export function beginHierarchyMove(view, selection) {
  const boxes = allBoxes(view);
  const moving = boxes.filter((b) => b.box === selection.box || inside(selection, b));
  const ancestors = ancestorBoxes(boxes, selection);
  const files = new Set(moving.filter((b) => b.kind === 'file').map((b) => b.box.id));
  const nodes = view.nodes.filter((n) => files.has(n.group));
  const ids = new Set(nodes.map((n) => n.id));
  const internal = [], crossing = [], stationary = [];
  for (const edge of view.edges) {
    const from = ids.has(edge.from), to = ids.has(edge.to);
    (from && to ? internal : from || to ? crossing : stationary).push(edge);
  }
  const watched = [...moving, ...ancestors];
  const initialOverlap = captureInitialOverlap(watched, boxes);
  const parentId = (id) => id.split('/').slice(0, -1).join('/');
  const peers = boxes.filter((b) => b.box !== selection.box && !b.box.root &&
    !inside(selection, b) && !inside(b, selection) && parentId(b.box.id) === parentId(selection.box.id));
  const ancestorChildren = ancestors.map((ancestor) => ({
    ancestor,
    children: boxes.filter((c) => inside(ancestor, c)).map((c) => c.box),
  }));
  const rects = watched.map(({ box }) => snapshotRect(box));
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
        const initial = initialOverlap.get(overlapKey(a, b)) || 0;
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

const contentItems = (view, target, boxes) => target.kind === 'file'
  ? (view.nodes || []).filter((n) => n.group === target.box.id)
  : boxes.filter((c) => inside(target, c)).map((c) => c.box);

const contentPadding = (target) => ({
  pad: target.kind === 'file' ? 8 : target.box.root ? 24 : 10,
  top: target.box.root ? 24 : 32,
});

/** 计算框内节点或子框的包围边界，并留出标题区与内边距。 */
function minContentRect(target, items) {
  if (!items.length) return null;
  const { pad, top } = contentPadding(target);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of items) {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.w);
    maxY = Math.max(maxY, item.y + item.h);
  }
  return { minX: minX - pad, minY: minY - top, maxX: maxX + pad, maxY: maxY + pad };
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
  view.width = Math.ceil(maxX);
  view.height = Math.ceil(maxY);
}

export function beginNodeMove(view, node) {
  const boxes = allBoxes(view);
  const file = boxes.find((b) => b.kind === 'file' && b.box.id === node.group);
  const watched = file ? [file, ...ancestorBoxes(boxes, file)] : [];
  const initialOverlap = captureInitialOverlap(watched, boxes);
  const chain = watched.map((target) => ({
    ...target,
    items: contentItems(view, target, boxes),
    peers: boxes.filter((b) => unrelated(target, b)).map((b) => ({
      box: b.box,
      area: initialOverlap.get(overlapKey(target, b)) || 0,
    })),
  }));
  let minX = 0, minY = 0;
  for (const target of chain) {
    const { pad, top } = contentPadding(target);
    minX += pad;
    minY += top;
  }
  return {
    view, node, chain, boxes, initialOverlap,
    // 兼容标题区或内边距较窄的旧布局，拖拽不会进一步压缩这两处边距。
    minX: Math.max(0, Math.min(minX, node.x)),
    minY: Math.max(0, Math.min(minY, node.y)),
    rects: [...chain.map(({ box }) => snapshotRect(box)), snapshotRect(node)],
    width: view.width, height: view.height,
  };
}

export function cancelNodeMove(drag) {
  restoreRects(drag);
  drag.view.width = drag.width;
  drag.view.height = drag.height;
}

/** 先检查向外扩展的包络，落位后再收紧被节点腾出的边。 */
export function placeNodeInHierarchy(drag, x, y) {
  const { node, chain } = drag;
  if (x === node.x && y === node.y) return true;
  const before = chain.map(({ box }) => snapshotRect(box));
  const oldX = node.x, oldY = node.y;
  const oldContents = chain.map((target) => minContentRect(target, target.items));
  node.x = x;
  node.y = y;
  for (const target of chain) {
    const b = target.box;
    const content = minContentRect(target, target.items);
    const left = Math.max(0, Math.min(b.x, content.minX));
    const top = Math.max(0, Math.min(b.y, content.minY));
    const right = Math.max(b.x + b.w, content.maxX);
    const bottom = Math.max(b.y + b.h, content.maxY);
    Object.assign(b, { x: left, y: top, w: right - left, h: bottom - top });
    if (target.peers.some(({ box, area }) => {
      const next = gapOverlapArea(b, box);
      return next > 0 && (area === 0 || next > area + 0.01);
    })) {
      restoreRects({ rects: before });
      node.x = oldX;
      node.y = oldY;
      return false;
    }
  }
  chain.forEach((target, i) => {
    const content = minContentRect(target, target.items);
    const previous = oldContents[i];
    shrinkToContent(target, content, {
      left: content.minX > previous.minX, top: content.minY > previous.minY,
      right: content.maxX < previous.maxX, bottom: content.maxY < previous.maxY,
    });
  });
  return true;
}

export function syncNodeMoveBounds(drag) {
  syncViewBounds(drag.view, drag.boxes, {
    allowShrink: drag.chain.length > 0, baseWidth: drag.width, baseHeight: drag.height,
  });
}

/** 松手后从移动的文件框或目录逐层向外收紧。 */
export function autoShrinkContainerChain(view, boxId) {
  const boxes = allBoxes(view);
  const target = boxes.find((b) => b.box.id === boxId);
  let changed = false;
  if (target) {
    for (const entry of [target, ...ancestorBoxes(boxes, target)]) {
      changed = shrinkToContent(entry, minContentRect(entry, contentItems(view, entry, boxes))) || changed;
    }
  }
  syncViewBounds(view, boxes, { allowShrink: true });
  return changed;
}

/** 开始拖拽文件框 / 目录容器的边或角来手动调整大小。 */
export function beginBoxResize(view, selection, edge) {
  const boxes = allBoxes(view);
  const ancestors = ancestorBoxes(boxes, selection);
  const content = minContentRect(selection, contentItems(view, selection, boxes));
  const watched = [selection, ...ancestors];
  const initialOverlap = captureInitialOverlap(watched, boxes);
  return {
    ...selection,
    edge,
    view,
    boxes,
    ancestors,
    content,
    initialOverlap,
    rects: watched.map(({ box }) => snapshotRect(box)),
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
        const initial = drag.initialOverlap.get(overlapKey(a, b)) || 0;
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

function shrinkToContent({ kind, box: b }, content, { left = true, top = true, right = true, bottom = true } = {}) {
  if (!content) return false;
  const minW = kind === 'dir' ? 160 : 120;
  const minH = kind === 'dir' ? 90 : 70;
  const curRight = b.x + b.w, curBottom = b.y + b.h;
  const x = left ? Math.max(b.x, Math.min(curRight - minW, content.minX)) : b.x;
  const y = top ? Math.max(b.y, Math.min(curBottom - minH, content.minY)) : b.y;
  const nextRight = right ? Math.min(curRight, Math.max(x + minW, content.maxX)) : curRight;
  const nextBottom = bottom ? Math.min(curBottom, Math.max(y + minH, content.maxY)) : curBottom;
  if (x === b.x && y === b.y && nextRight === curRight && nextBottom === curBottom) return false;
  Object.assign(b, { x, y, w: nextRight - x, h: nextBottom - y });
  return true;
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
    changed = shrinkToContent(target, minContentRect(target, contentItems(view, target, boxes))) || changed;
  }
  if (changed) {
    syncViewBounds(view, boxes, { allowShrink: !!selection.box.root, baseWidth: view.width, baseHeight: view.height });
  }
  return changed;
}
