import test from 'node:test';
import assert from 'node:assert/strict';
import { layout, routeLengthAndCrossings, proxyCrossings, greedySwapOrder } from '../src/core/layout.js';

// 蝶形交错：重心法会在 [x,y]/[c,d] 两个次序间乒乓，贪心交换应把 L2 换开消掉交叉
//   层0: a b   层1: c d   层2: x y
//   边: a→c, b→d, c→y, d→x  （c→y 与 d→x 交错）
test('贪心交换消除蝶形交错的层间交叉', () => {
  const nodes = ['a', 'b', 'c', 'd', 'x', 'y'].map((id) => ({ id, label: id }));
  const edges = [
    { from: 'a', to: 'c', kind: 'direct' },
    { from: 'b', to: 'd', kind: 'direct' },
    { from: 'c', to: 'y', kind: 'direct' },
    { from: 'd', to: 'x', kind: 'direct' },
  ];
  const laid = layout(nodes, edges);
  const m = routeLengthAndCrossings(laid.edges);
  assert.equal(m.crossings, 0, `蝶形 fixture 不应残留交叉，实际 ${m.crossings}`);
});

// 多层链上的成串交错：交换后交叉应不高于按输入原样布（贪心不劣化）
test('贪心交换不引入新交叉（三层随机序）', () => {
  const mk = () => {
    const nodes = [];
    const edges = [];
    for (let l = 0; l < 3; l++) {
      for (let i = 0; i < 5; i++) nodes.push({ id: `n${l}_${i}`, label: `n${l}_${i}` });
    }
    for (let i = 0; i < 5; i++) {
      edges.push({ from: `n0_${i}`, to: `n1_${(i * 3) % 5}`, kind: 'direct' });
      edges.push({ from: `n1_${(i * 3) % 5}`, to: `n2_${(i * 2) % 5}`, kind: 'direct' });
    }
    return { nodes, edges };
  };
  const g = mk();
  const laid = layout(g.nodes, g.edges);
  const m = routeLengthAndCrossings(laid.edges);
  assert.ok(m.crossings <= 4, `三层交错 fixture 交叉应收敛到 4 以内，实际 ${m.crossings}`);
});

// 规格口径的直接断言：蝶形交错 3 层 fixture（交换可消交叉），
// 贪心交换后代理交叉数应为 0 或显著低于构造时的初值
test('贪心交换把蝶形交错的代理交叉数降到 0（或显著低于初值）', () => {
  // 层0/层1 之间 a→y、b→x 反序，层1/层2 之间 x→q、y→p 反序：
  // 两个相邻层对各 1 个代理交叉，换开层1 的一对节点即可全消
  const layers = [
    ['a', 'b'],
    ['x', 'y'],
    ['p', 'q'],
  ];
  const es = [
    { from: 'a', to: 'y' },
    { from: 'b', to: 'x' },
    { from: 'x', to: 'q' },
    { from: 'y', to: 'p' },
  ];
  const before = proxyCrossings(layers, es);
  assert.ok(before > 0, `构造的蝶形应有代理交叉，实际 ${before}`);
  greedySwapOrder(layers, es);
  const after = proxyCrossings(layers, es);
  assert.ok(
    after === 0 || after <= before / 2,
    `贪心交换后代理交叉应显著下降：初值 ${before} → 交换后 ${after}`
  );
});

// 反序度更高的蝶形：3 组连线全反序，确保多对交换协同（一遍扫不净的靠来回多遍收敛）
test('贪心交换消除 3 组全反序蝶形的代理交叉', () => {
  const layers = [
    ['a', 'b', 'c'],
    ['z', 'y', 'x'],
    ['p', 'q', 'r'],
  ];
  const es = [
    { from: 'a', to: 'x' },
    { from: 'b', to: 'y' },
    { from: 'c', to: 'z' },
    { from: 'z', to: 'r' },
    { from: 'y', to: 'q' },
    { from: 'x', to: 'p' },
  ];
  const before = proxyCrossings(layers, es);
  assert.ok(before >= 3, `全反序蝶形初值应不少于 3，实际 ${before}`);
  greedySwapOrder(layers, es);
  const after = proxyCrossings(layers, es);
  assert.ok(
    after === 0 || after <= before / 2,
    `贪心交换后代理交叉应显著下降：初值 ${before} → 交换后 ${after}`
  );
});
