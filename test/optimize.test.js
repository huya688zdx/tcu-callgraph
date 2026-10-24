import test from 'node:test';
import assert from 'node:assert/strict';
import { routeEdges } from '../src/core/routing.js';
import { routeLengthAndCrossings } from '../src/core/layout.js';
import { optimizeCrossings } from '../src/core/optimize.js';

// faceHints：优化器的面提示进 classify（优先级低于用户钉面、高于几何判定）
test('faceHints 改写出线面：提示 bottom 则从底面出线', () => {
  const nodes = [
    { id: 'S', x: 100, y: 200, w: 120, h: 44 },
    { id: 'T', x: 420, y: 200, w: 120, h: 44 },
  ];
  const edges = [{ from: 'S', to: 'T', kind: 'direct' }];
  routeEdges(nodes, edges, { faceHints: new Map([[edges[0], { from: 'bottom' }]]) });
  assert.equal(edges[0].points[0][1], nodes[0].y + nodes[0].h, '起点应在源底边');
  // 无提示时按几何走右面——对照证明提示确实改写了默认行为
  const edges2 = [{ from: 'S', to: 'T', kind: 'direct' }];
  routeEdges(nodes, edges2);
  assert.equal(edges2[0].points[0][0], nodes[0].x + nodes[0].w, '无提示时从右面出线');
});

// 三行置换（a1→b2, a2→b3, a3→b1）天然 1 交叉；优化器实测驱动把它压到 0
function permFixture(withGroups) {
  const mk = (id, x, y, group) => ({ id, x, y, w: 130, h: 44, ...(withGroups ? { group } : {}) });
  const nodes = [
    mk('a1', 100, 80, 'L'), mk('a2', 100, 200, 'L'), mk('a3', 100, 320, 'L'),
    mk('b1', 480, 80, 'R'), mk('b2', 480, 200, 'R'), mk('b3', 480, 320, 'R'),
  ];
  const edges = [
    { from: 'a1', to: 'b2', kind: 'direct' },
    { from: 'a2', to: 'b3', kind: 'direct' },
    { from: 'a3', to: 'b1', kind: 'direct' },
  ];
  return { nodes, edges };
}

const groupBoxesOf = () =>
  new Map([
    ['L', { id: 'L', x: 88, y: 60, w: 154, h: 324 }],
    ['R', { id: 'R', x: 468, y: 60, w: 154, h: 324 }],
  ]);

test('交叉优化器：置换交叉 1→0，节点不重叠', () => {
  const { nodes, edges } = permFixture(false);
  routeEdges(nodes, edges);
  const before = routeLengthAndCrossings(edges).crossings;
  assert.ok(before >= 1, '夹具应先产生交叉');

  const r = optimizeCrossings(nodes, edges, {});
  assert.equal(r.crossings, 0, '优化后应为 0 交叉');
  assert.ok(r.gained >= 1);
  assert.equal(routeLengthAndCrossings(edges).crossings, 0, 'edges 里应已是最终布线');

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(!(dx > 0.5 && dy > 0.5), `节点 ${a.id} 与 ${b.id} 重叠`);
    }
  }
});

test('交叉优化器（组模式）：组内移动降交叉，任何节点不出本组框', () => {
  const { nodes, edges } = permFixture(true);
  const boxes = groupBoxesOf();
  routeEdges(nodes, edges);
  const before = routeLengthAndCrossings(edges).crossings;
  assert.ok(before >= 1);

  const r = optimizeCrossings(nodes, edges, { groupBoxes: boxes });
  assert.equal(r.crossings, 0, '组内约束下仍应能压到 0');
  for (const n of nodes) {
    const gb = boxes.get(n.group);
    assert.ok(
      n.x >= gb.x - 0.5 && n.y >= gb.y - 0.5 && n.x + n.w <= gb.x + gb.w + 0.5 && n.y + n.h <= gb.y + gb.h + 0.5,
      `节点 ${n.id} 越出了本组框`
    );
  }
});

test('用户钉过的面不被优化器覆盖', () => {
  const { nodes, edges } = permFixture(false);
  const pinned = edges[0];
  pinned.fromSide = 'left'; // 钉在左面（几何默认是右面）
  routeEdges(nodes, edges);

  const r = optimizeCrossings(nodes, edges, {});
  assert.equal(pinned.fromSide, 'left', '钉面字段不得被改写');
  const a = nodes.find((n) => n.id === pinned.from);
  assert.equal(pinned.points[0][0], a.x, '钉面边仍从左面出线');
  assert.ok(r.crossings <= routeLengthAndCrossings(edges).crossings + 0);
});

test('交叉已为 0 时直接返回，不做任何搜索', () => {
  const nodes = [
    { id: 'a', x: 100, y: 100, w: 120, h: 44 },
    { id: 'b', x: 400, y: 100, w: 120, h: 44 },
  ];
  const edges = [{ from: 'a', to: 'b', kind: 'direct' }];
  const r = optimizeCrossings(nodes, edges, {});
  assert.equal(r.crossings, 0);
  assert.equal(r.evals, 1, '只做初始评估');
});
