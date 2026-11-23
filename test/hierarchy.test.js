import test from 'node:test';
import assert from 'node:assert/strict';
import { beginHierarchyMove, moveHierarchy, cancelHierarchyMove } from '../web/lib/hierarchy.js';

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
