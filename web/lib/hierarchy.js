/** 层级框整体移动：保留归属关系，扩展祖先容器，避免同级区域重叠。 */
const inside = (parent, child) => parent.box !== child.box && parent.kind === 'dir' &&
  (parent.box.root || child.box.id.startsWith(parent.box.id + '/'));
const overlap = (a, b) => a.x < b.x + b.w + 12 && b.x < a.x + a.w + 12 &&
  a.y < b.y + b.h + 12 && b.y < a.y + a.h + 12;

export function beginHierarchyMove(view, selection) {
  const boxes = [...(view.groups || []).map((box) => ({ kind: 'file', box })),
    ...(view.containers || []).map((box) => ({ kind: 'dir', box }))];
  const moving = boxes.filter((b) => b.box === selection.box || inside(selection, b));
  const ancestors = boxes.filter((b) => b.box !== selection.box && inside(b, selection))
    .sort((a, b) => b.box.depth - a.box.depth);
  const files = new Set(moving.filter((b) => b.kind === 'file').map((b) => b.box.id));
  const nodes = view.nodes.filter((n) => files.has(n.group));
  return { ...selection, view, boxes, moving, ancestors, nodes, ids: new Set(nodes.map((n) => n.id)),
    rects: [...moving, ...ancestors].map(({ box }) => ({ item: box, x: box.x, y: box.y, w: box.w, h: box.h })),
    positions: nodes.map((n) => ({ item: n, x: n.x, y: n.y })),
    paths: view.edges.map((edge) => ({ edge, points: edge.points.map((p) => [...p]) })),
    width: view.width, height: view.height, dx: 0, dy: 0, guides: [],
  };
}

function restoreRects(drag) {
  for (const { item, ...rect } of [...drag.rects, ...drag.positions]) Object.assign(item, rect);
}

export function cancelHierarchyMove(drag) {
  restoreRects(drag);
  for (const { edge, points } of drag.paths) edge.points = points.map((p) => [...p]);
  drag.view.width = drag.width;
  drag.view.height = drag.height;
}

export function moveHierarchy(drag, dx, dy, tolerance = 0) {
  const origin = drag.rects.find((r) => r.item === drag.box);
  const parentId = (id) => id.split('/').slice(0, -1).join('/');
  const peers = drag.boxes.filter((b) => b.box !== drag.box && !b.box.root &&
    !inside(drag, b) && !inside(b, drag) && parentId(b.box.id) === parentId(drag.box.id));
  const snapped = { x: dx, y: dy }, guides = [];
  for (const [axis, size] of [['x', 'w'], ['y', 'h']]) {
    let best = tolerance, match = null;
    for (const peer of peers) for (const ratio of [0, 0.5, 1]) {
      const at = peer.box[axis] + peer.box[size] * ratio;
      const offset = at - origin[axis] - snapped[axis] - origin[size] * ratio;
      if (Math.abs(offset) < best) { best = Math.abs(offset); match = { axis, at, offset, peer: peer.box }; }
    }
    if (match) { snapped[axis] += match.offset; guides.push(match); }
  }

  const apply = (tx, ty) => {
    restoreRects(drag);
    for (const { box } of drag.moving) { box.x += tx; box.y += ty; }
    for (const n of drag.nodes) { n.x += tx; n.y += ty; }
    for (const ancestor of drag.ancestors) {
      const b = ancestor.box, children = drag.boxes.filter((c) => inside(ancestor, c)).map((c) => c.box);
      const pad = b.root ? 40 : 14;
      const right = Math.max(b.x + b.w, ...children.map((c) => c.x + c.w + pad));
      const bottom = Math.max(b.y + b.h, ...children.map((c) => c.y + c.h + pad));
      b.x = Math.min(b.x, ...children.map((c) => c.x - pad));
      b.y = Math.min(b.y, ...children.map((c) => c.y - 40));
      b.w = right - b.x;
      b.h = bottom - b.y;
    }
    return [...drag.moving, ...drag.ancestors].every((a) => a.box.x >= 0 && a.box.y >= 0 &&
      drag.boxes.every((b) => a.box === b.box || inside(a, b) || inside(b, a) || !overlap(a.box, b.box)));
  };
  let accepted = [drag.dx, drag.dy];
  // 碰撞时沿可行的单轴滑动，不推走其他层级。
  for (const [tx, ty] of [[snapped.x, snapped.y], [dx, dy], [snapped.x, drag.dy], [drag.dx, snapped.y], [drag.dx, drag.dy]]) {
    if (apply(tx, ty)) { accepted = [tx, ty]; break; }
  }
  const changed = accepted[0] !== drag.dx || accepted[1] !== drag.dy;
  [drag.dx, drag.dy] = accepted;
  drag.guides = guides.filter((g) => (g.axis === 'x' ? drag.dx : drag.dy) === snapped[g.axis]);
  for (const { edge, points } of drag.paths) {
    const internal = drag.ids.has(edge.from) && drag.ids.has(edge.to);
    edge.points = points.map(([x, y]) => internal ? [x + drag.dx, y + drag.dy] : [x, y]);
  }
  if (changed) {
    drag.view.width = Math.max(drag.width, ...drag.boxes.map(({ box }) => box.x + box.w));
    drag.view.height = Math.max(drag.height, ...drag.boxes.map(({ box }) => box.y + box.h));
  }
  return changed;
}
