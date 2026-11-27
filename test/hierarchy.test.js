import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { beginHierarchyMove, moveHierarchy, cancelHierarchyMove, beginNodeMove, cancelNodeMove,
  syncNodeMoveBounds } from '../web/lib/hierarchy.js';

// 浏览器从 /core/ 请求共享路由模块，Node 测试直接读取同一份源码。
register('data:text/javascript,' + encodeURIComponent(`
  export function resolve(specifier, context, next) {
    if (specifier.startsWith('/core/')) {
      return next(new URL(specifier.slice(1), ${JSON.stringify(new URL('../src/', import.meta.url).href)}).href, context);
    }
    return next(specifier, context);
  }
`), import.meta.url);
globalThis.document = { getElementById: () => ({ getContext: () => null }) };
const { moveNodeNoOverlap, moveEdgeSegment } = await import('../web/lib/geometry.js');
delete globalThis.document;

const fixture = () => ({ width: 700, height: 340,
  containers: [{ id: '', root: true, depth: 1, x: 0, y: 0, w: 700, h: 340 },
    { id: 'a', depth: 2, x: 40, y: 60, w: 300, h: 200 }],
  groups: [{ id: 'a/core.c', depth: 3, x: 60, y: 100, w: 250, h: 140 },
    { id: 'b.c', depth: 2, x: 500, y: 80, w: 160, h: 120 }],
  nodes: [{ id: 'f', group: 'a/core.c', x: 80, y: 140, w: 80, h: 40 },
    { id: 'g', group: 'a/core.c', x: 200, y: 140, w: 80, h: 40 },
    { id: 'h', group: 'b.c', x: 520, y: 120, w: 100, h: 40 }],
  edges: [{ from: 'f', to: 'g', points: [[160, 160], [200, 160]] }],
});

test('目录与文件框整体移动，内部节点和折线跟随，外层扩展且可取消', () => {
  const view = fixture(), before = structuredClone(view);
  const drag = beginHierarchyMove(view, { kind: 'dir', box: view.containers[1] });
  assert.equal(moveHierarchy(drag, 100, 180), true);
  assert.deepEqual([view.nodes[0].x, view.nodes[0].y], [180, 320]);
  assert.deepEqual(view.edges[0].points, [[260, 340], [300, 340]]);
  assert.deepEqual(view.nodes[2], before.nodes[2], '其他文件中的节点不移动');
  assert.ok(view.containers[0].h >= 454, '外层容器扩展以包住移动后的目录');
  const file = beginHierarchyMove(view, { kind: 'file', box: view.groups[0] });
  assert.equal(moveHierarchy(file, 20, 30), true);
  assert.deepEqual([view.nodes[0].x, view.nodes[0].y], [200, 350]);
  cancelHierarchyMove(drag);
  assert.deepEqual(view, before);
});

test('层级移动不能与其他同级框重叠', () => {
  const view = fixture(), before = structuredClone(view);
  const drag = beginHierarchyMove(view, { kind: 'dir', box: view.containers[1] });
  assert.equal(moveHierarchy(drag, 440, 0), false);
  assert.deepEqual(view, before);
});

test('同级框位于 ELK 根容器边距边界时仍允许拖动另一文件框', () => {
  const view = {
    width: 400,
    height: 220,
    containers: [{ id: '', root: true, depth: 1, x: 0, y: 0, w: 400, h: 220 }],
    groups: [
      { id: 'edge.c', depth: 2, x: 24, y: 32, w: 120, h: 100 },
      { id: 'main.c', depth: 2, x: 200, y: 60, w: 140, h: 110 },
    ],
    nodes: [
      { id: 'e', group: 'edge.c', x: 34, y: 64, w: 90, h: 40 },
      { id: 'm', group: 'main.c', x: 210, y: 92, w: 90, h: 40 },
    ],
    edges: [],
  };
  const drag = beginHierarchyMove(view, { kind: 'file', box: view.groups[1] });
  assert.equal(moveHierarchy(drag, -30, 0), true);
  assert.deepEqual([view.groups[1].x, view.nodes[1].x], [170, 180]);
  assert.deepEqual([view.containers[0].x, view.containers[0].y], [0, 0]);
});

test('节点向外拖动会撑开文件框和祖先，取消后恢复节点、容器及画布尺寸', () => {
  const view = fixture(), before = structuredClone(view);
  const [root, dir] = view.containers;
  const [file] = view.groups;
  const node = view.nodes[1];
  const drag = beginNodeMove(view, node);
  assert.equal(moveNodeNoOverlap(drag, 220, 370), true);
  syncNodeMoveBounds(drag);

  assert.equal(file.y + file.h, 418);
  assert.equal(dir.y + dir.h, 428);
  assert.equal(root.y + root.h, 452);
  assert.equal(view.height, 452);
  assert.deepEqual(view.groups[1], before.groups[1]);
  assert.deepEqual(view.nodes[0], before.nodes[0]);
  cancelNodeMove(drag);
  assert.deepEqual(view, before);
});

test('祖先向右扩展被同级文件框阻挡时，节点贴边并继续向下移动', () => {
  const view = fixture();
  const node = view.nodes[1], dir = view.containers[1], peer = view.groups[1];
  const drag = beginNodeMove(view, node);
  assert.equal(moveNodeNoOverlap(drag, 445, 175), true);
  assert.equal(node.y, 175);
  assert.ok(node.x <= 390 && node.x > 389.95);
  assert.ok(dir.x + dir.w + 12 <= peer.x);
  assert.deepEqual(drag.guides, []);
});

test('容器上方和左方扩展停在画布边界，各层保留内边距', () => {
  const view = fixture();
  const node = view.nodes[0], file = view.groups[0], [root, dir] = view.containers;
  const drag = beginNodeMove(view, node);
  assert.equal(moveNodeNoOverlap(drag, -400, -400), true);
  assert.deepEqual([node.x, node.y], [42, 88]);
  assert.deepEqual([file.x, file.y, dir.x, dir.y, root.x, root.y], [34, 56, 24, 24, 0, 0]);
});

test('与同级框的旧重叠允许保持和减小，继续扩大重叠会被拦截', () => {
  const view = fixture();
  view.groups[1].x = 300;
  view.nodes[2].x = 320;
  const node = view.nodes[1];
  const drag = beginNodeMove(view, node);
  assert.ok(drag.initialOverlap.size > 0);

  assert.equal(moveNodeNoOverlap(drag, 195, 142), true);
  assert.ok(view.groups[0].x + view.groups[0].w < 310);
  assert.equal(moveNodeNoOverlap(drag, 236, 169), true);
  assert.ok(view.groups[0].x + view.groups[0].w <= 310.001);
  assert.equal(node.y, 169);
});

test('节点吸附到同文件节点的底边和可见节点的右边，关闭吸附后清空辅助线', () => {
  const node = { id: 'm', group: 'a.c', x: 100, y: 140, w: 48, h: 30 };
  const sibling = { id: 's', group: 'a.c', x: 290, y: 128, w: 72, h: 60 };
  const visible = { id: 'v', group: 'b.c', x: 150, y: 260, w: 72, h: 40 };
  const hidden = { id: 'h', group: 'c.c', x: 177, y: 400, w: 48, h: 30 };
  const view = { nodes: [node, sibling, visible, hidden], edges: [], width: 600, height: 500 };
  const drag = beginNodeMove(view, node);
  const options = { tolerance: 8, visible: (n) => n === visible };
  assert.equal(moveNodeNoOverlap(drag, 177, 161, options), true);
  assert.deepEqual([node.x, node.y], [174, 158]);
  assert.deepEqual(drag.guides, [
    { axis: 'x', at: 222, from: 158, to: 300 },
    { axis: 'y', at: 188, from: 174, to: 362 },
  ]);
  // 交互层在 Shift 按下时传入零容差。
  assert.equal(moveNodeNoOverlap(drag, 177, 161, { ...options, tolerance: 0 }), true);
  assert.deepEqual([node.x, node.y, drag.guides], [177, 161, []]);
});

test('等距优先吸附相连节点，其次是同文件节点，停在磁吸范围内时持续对齐', () => {
  const node = { id: 'm', group: 'a', x: 60, y: 145, w: 40, h: 30 };
  const visible = { id: 'v', group: 'b', x: 100, y: 97, w: 40, h: 30 };
  const sibling = { id: 's', group: 'a', x: 155, y: 103, w: 40, h: 30 };
  const endpoint = { id: 'e', group: 'b', x: 210, y: 97, w: 40, h: 30 };
  const drag = beginNodeMove({ nodes: [node, visible, sibling, endpoint], edges: [] }, node);
  const options = { tolerance: 6, connected: new Set(['e']), visible: (n) => n === visible };
  moveNodeNoOverlap(drag, 30, 100, options);
  assert.equal(node.y, 97);
  assert.deepEqual(drag.guides, [{ axis: 'y', at: 97, from: 30, to: 250 }]);
  assert.equal(moveNodeNoOverlap(drag, 30, 99, options), false);
  assert.equal(node.y, 97);
  moveNodeNoOverlap(drag, 30, 100, { ...options, connected: new Set() });
  assert.equal(node.y, 103);
  assert.equal(drag.guides[0].to, 195);
});

test('吸附到节点或容器内的非法位置时，保留原始落点，不画被拒绝的辅助线', () => {
  const node = { id: 'm', x: 30, y: 160, w: 40, h: 30 };
  const peer = { id: 'p', x: 150, y: 119, w: 40, h: 30 };
  const wall = { id: 'w', x: 70, y: 66, w: 30, h: 50 };
  const drag = beginNodeMove({ nodes: [node, peer, wall], edges: [] }, node);
  moveNodeNoOverlap(drag, 30, 123, { tolerance: 6, visible: (n) => n === peer });
  assert.deepEqual([node.x, node.y, drag.guides], [30, 123, []]);

  const view = fixture();
  const right = view.nodes[1];
  // x=394 是附近可见节点的左边，但会使目录右侧超过 12px 的安全间距。
  view.nodes.push({ id: 'guide', x: 394, y: 350, w: 80, h: 40 });
  const layout = beginNodeMove(view, right);
  moveNodeNoOverlap(layout, 389, 175, { tolerance: 6 });
  assert.equal(right.x, 389);
  assert.equal(layout.guides.some((g) => g.axis === 'x'), false);
});

function edgeFixture() {
  const nodes = [
    { id: 'from', x: 0, y: 70, w: 60, h: 40 },
    { id: 'to', x: 300, y: 110, w: 60, h: 40 },
  ];
  const edge = { from: 'from', to: 'to', points: [[60, 90], [96, 90], [96, 108], [270, 108], [270, 130], [300, 130]] };
  return { view: { nodes, edges: [edge] }, seg: { edge, index: 2, orient: 'h' } };
}

test('水平折线可吸附到端点中心、平行走廊和两端口中点，Shift 关闭吸附', () => {
  const { view, seg } = edgeFixture();
  view.edges.push({ from: 'from', to: 'branch', points: [[160, 146], [370, 146]] });
  assert.equal(moveEdgeSegment(view, seg, 160, 94, 8), true);
  assert.deepEqual(seg.edge.points.slice(1, 4), [[96, 90], [96, 90], [270, 90]]);
  assert.deepEqual(seg.guides, [{ axis: 'y', at: 90, from: 0, to: 270 }]);
  assert.equal(moveEdgeSegment(view, seg, 160, 143, 8), true);
  assert.deepEqual(seg.guides, [{ axis: 'y', at: 146, from: 96, to: 370 }]);
  assert.equal(moveEdgeSegment(view, seg, 160, 114, 8), true);
  assert.deepEqual(seg.guides, [{ axis: 'y', at: 110, from: 60, to: 300 }]);
  assert.equal(moveEdgeSegment(view, seg, 160, 114, 0), true);
  assert.equal(seg.edge.points[seg.index][1], 114);
  assert.deepEqual(seg.guides, []);
});

test('竖直折线跳过被节点挡住的吸附位置，改试下一个走廊或原始落点', () => {
  const { view, seg } = edgeFixture();
  for (const n of view.nodes) [n.x, n.y, n.w, n.h] = [n.y, n.x, n.h, n.w];
  seg.edge.points = seg.edge.points.map(([x, y]) => [y, x]);
  seg.orient = 'v';
  view.nodes.push({ id: 'obstacle', x: 79, y: 175, w: 9, h: 25 });
  view.edges.push({ from: 'branch', to: 'to', points: [[98, 165], [98, 265]] });
  assert.equal(moveEdgeSegment(view, seg, 93, 160, 8), true);
  assert.deepEqual(seg.guides, [{ axis: 'x', at: 98, from: 96, to: 270 }]);
  assert.equal(moveEdgeSegment(view, seg, 90, 160, 0), false);
  assert.equal(seg.edge.points[seg.index][0], 98);
  assert.deepEqual(seg.guides, []);
});

test('直线拖动保留端口，无法移动时不会留下占位点', () => {
  const { view, seg } = edgeFixture();
  seg.edge.points = [[60, 90], [300, 90]];
  view.nodes[1].y = 70;
  seg.index = 0;
  view.nodes.push({ id: 'obstacle', x: 150, y: 110, w: 30, h: 25 });
  assert.equal(moveEdgeSegment(view, seg, 150, 114), false);
  assert.deepEqual(seg.edge.points, [[60, 90], [300, 90]]);
  assert.equal(moveEdgeSegment(view, seg, 150, 99), true);
  assert.deepEqual(seg.edge.points, [[60, 90], [120, 90], [120, 99], [240, 99], [240, 90], [300, 90]]);
});

test('线段只吸附到共享调用方或被调用方且未被无关边占用的走廊', () => {
  for (const other of [
    { from: 'x', to: 'y' },
    { from: 'to', to: 'x' },
    { from: 'from', to: 'x', change: 'added' },
  ]) {
    const { view, seg } = edgeFixture();
    view.edges.push({ from: 'from', to: 'sibling', points: [[400, 145], [440, 145]] });
    view.edges.push({ ...other, points: [[160, 146], [260, 146]] });
    assert.equal(moveEdgeSegment(view, seg, 175, 143, 8), true);
    assert.equal(seg.edge.points[seg.index][1], 143);
    assert.deepEqual(seg.guides, []);
  }

  const { view, seg } = edgeFixture();
  view.edges.push({ from: 'from', to: 'branch', points: [[160, 146], [370, 146]] });
  view.edges.push({ from: 'x', to: 'y', points: [[185, 146], [260, 146]] });
  moveEdgeSegment(view, seg, 170, 143, 8);
  assert.equal(seg.edge.points[seg.index][1], 143, '同一走廊另有无关调用，不能默认吸附');
  moveEdgeSegment(view, seg, 170, 146, 0);
  assert.equal(seg.edge.points[seg.index][1], 146, '仍允许手动放到指定坐标');
});
