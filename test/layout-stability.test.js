import test from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../src/core/layout.js';

// —— 存档坐标作重心初值（seeded barycenter，加节点不跳变）——
//
// fixture：12 节点 3 层 DAG，每层 4 个，层间带状交叉连接（自然次序下画线两两交叉）。
// 节点带 label，宽度走默认规则（textWidth(label)+28+16，下限 minWidth=120）。
// 新图追加 2 个新节点（new1/new2 无入边、落在第 1 层，出边指向第 2 层），模拟「加节点」。
//
// 边表里额外挂一条 a1 指向自身的 custom 边：layout() 见到 custom 边会跳过
// 「左右流向候选对比」与「小图单点微调」两个既有阶段（layout.js 里对 e.custom
// 的守卫），从而观察到纯粹的「分层 → 重心排序 → 坐标分配」管线。
// 本任务改的是重心初始次序（layoutBase 的 seed），断言需要对准这一层；
// 自环在回边检测里被判为回边——不进 Kahn 分层、不进重心、不占层间通道，
// 对图结构零影响，只是收窄 layout() 的候选范围。
const SELF_LOOP = { from: 'a1', to: 'a1', kind: 'direct', custom: true, points: [[0, 0], [8, 8]] };

// 每次返回全新 fixture（防御式习惯，见 test/layout.test.js 开头说明）
function oldFixture() {
  const nodes = [
    { id: 'a1', label: 'fn_a1_handler' },
    { id: 'a2', label: 'fn_a2_handler' },
    { id: 'a3', label: 'fn_a3_handler' },
    { id: 'a4', label: 'fn_a4_handler' },
    { id: 'b1', label: 'fn_b1_handler' },
    { id: 'b2', label: 'fn_b2_handler' },
    { id: 'b3', label: 'fn_b3_handler' },
    { id: 'b4', label: 'fn_b4_handler' },
    { id: 'c1', label: 'fn_c1_handler' },
    { id: 'c2', label: 'fn_c2_handler' },
    { id: 'c3', label: 'fn_c3_handler' },
    { id: 'c4', label: 'fn_c4_handler' },
  ];
  const pairs = [];
  for (let i = 0; i < 4; i++) {
    // 带状交叉：ai→bi 与 ai→b(i+1)，相邻层各自成带、彼此交叉
    pairs.push([`a${i + 1}`, `b${i + 1}`], [`a${i + 1}`, `b${((i + 1) % 4) + 1}`]);
    pairs.push([`b${i + 1}`, `c${i + 1}`], [`b${i + 1}`, `c${((i + 1) % 4) + 1}`]);
  }
  const edges = pairs.map(([from, to]) => ({ from, to, kind: 'direct' }));
  return { nodes, edges: [...edges, { ...SELF_LOOP, points: SELF_LOOP.points.map((p) => [...p]) }] };
}

function newFixture() {
  const { nodes, edges } = oldFixture();
  return {
    nodes: [...nodes, { id: 'new1', label: 'fn_new1_handler' }, { id: 'new2', label: 'fn_new2_handler' }],
    edges: [...edges, { from: 'new1', to: 'b2', kind: 'direct' }, { from: 'new2', to: 'b4', kind: 'direct' }],
  };
}

// 分层按构造已知：a* 在第 1 层、b* 第 2 层、c* 第 3 层
// （新节点没有入边，Kahn 分层同样落在第 1 层；断言 A 只看原 12 节点）
const OLD_LAYERS = [
  ['a1', 'a2', 'a3', 'a4'],
  ['b1', 'b2', 'b3', 'b4'],
  ['c1', 'c2', 'c3', 'c4'],
];

// 层内按 x 升序的 id 序列（placeLayer 保证同层节点 x 至少差一个 gap，不会并列）
function xOrder(res, ids) {
  const byId = new Map(res.nodes.map((n) => [n.id, n]));
  return ids
    .slice()
    .sort((x, y) => byId.get(x).x - byId.get(y).x || x.localeCompare(y))
    .join(',');
}

test('存档坐标作重心初值：加节点后旧节点层内 x 相对次序不跳变', () => {
  const f1 = oldFixture();
  const pos1 = layout(f1.nodes, f1.edges);
  assert.equal(pos1.nodes.length, 12);

  // 同视图上次布局的存档坐标作为 seed 传入
  const seed = {};
  for (const n of pos1.nodes) seed[n.id] = { x: n.x, y: n.y };

  const f2 = newFixture();
  const pos2 = layout(f2.nodes, f2.edges, { seed });
  assert.equal(pos2.nodes.length, 14);

  // 断言 A：对原 12 节点，pos2 中每层内按 x 升序的 id 序列与 pos1 完全一致
  OLD_LAYERS.forEach((ids, li) => {
    const seq1 = xOrder(pos1, ids);
    const seq2 = xOrder(pos2, ids);
    assert.equal(seq2, seq1, `第 ${li + 1} 层加节点后层内 x 次序不应跳变：pos1=${seq1}，pos2=${seq2}`);
  });

  // 断言 B：pos2 节点两两不重叠（与 layout.js 的 overlapNodes 同款判据：
  // 两轴重叠深度都 > 0.5 才算相交，容差 0.5）
  for (let i = 0; i < pos2.nodes.length; i++) {
    for (let j = i + 1; j < pos2.nodes.length; j++) {
      const a = pos2.nodes[i];
      const b = pos2.nodes[j];
      const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(
        !(dx > 0.5 && dy > 0.5),
        `节点 ${a.id} 与 ${b.id} 在 pos2 中重叠（x 重叠 ${dx.toFixed(1)}，y 重叠 ${dy.toFixed(1)}）`
      );
    }
  }

  // 对照（按任务要求只注释说明、不断言）：同一张新图不带 seed 直接 layout，
  // 层内 x 次序允许不同——本 fixture 下实测三层全部跳变：
  // a 层 a1,a2,a4,a3 → a1,a3,a4,a2；b 层 b2,b1,b3,b4 → b1,b2,b4,b3；
  // c 层 c2,c3,c1,c4 → c2,c1,c3,c4。
  // 即「加节点 → 旧节点全图重排」的跳变真实存在，seed 把它压了回去。
});
