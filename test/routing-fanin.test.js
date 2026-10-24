import test from 'node:test';
import assert from 'node:assert/strict';
import { routeEdges, SPACING } from '../src/core/routing.js';

const EPS = 0.5;

/** 收集折线的正交段：竖直段 {c:x, lo, hi} 与水平段 {c:y, lo, hi} */
function orthoSegments(points) {
  const v = [];
  const h = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    if (Math.abs(x1 - x2) < EPS) v.push({ c: x1, lo: Math.min(y1, y2), hi: Math.max(y1, y2) });
    else if (Math.abs(y1 - y2) < EPS) h.push({ c: y1, lo: Math.min(x1, x2), hi: Math.max(x1, x2) });
  }
  return { v, h };
}

/** 断言 B（正交）：每条边每一段 |dx|<0.5 或 |dy|<0.5 */
function assertOrthogonal(points, label) {
  for (let i = 0; i < points.length - 1; i++) {
    const dx = Math.abs(points[i + 1][0] - points[i][0]);
    const dy = Math.abs(points[i + 1][1] - points[i][1]);
    assert.ok(
      dx < EPS || dy < EPS,
      `${label} 第 ${i} 段不是正交段: [${points[i]}] -> [${points[i + 1]}]`
    );
  }
}

/**
 * 断言 A（汇流）：存在一条直线（x=c 或 y=c），至少 minEdges 条边的折线各有一段
 * 长度 ≥ SPACING*2 的段落落在其上，且这些段的区间公共重叠 ≥ SPACING。
 * 命中时返回 {orient, c}，找不到时断言失败。
 */
function assertSharedTrunk(edges, minEdges) {
  for (const orient of ['v', 'h']) {
    const lines = new Map();
    edges.forEach((e, ei) => {
      for (const s of orthoSegments(e.points)[orient]) {
        if (s.hi - s.lo < SPACING * 2 - EPS) continue;
        const key = Math.round(s.c * 2) / 2;
        if (!lines.has(key)) lines.set(key, []);
        lines.get(key).push({ edge: ei, lo: s.lo, hi: s.hi });
      }
    });
    for (const [c, segs] of lines) {
      // 公共重叠窗口的左端必是某段的左端：逐段左端试窗口 [lo, lo+SPACING]
      for (const s of segs) {
        const covered = new Set();
        for (const t of segs) {
          if (t.lo <= s.lo + EPS && t.hi >= s.lo + SPACING - EPS) covered.add(t.edge);
        }
        if (covered.size >= minEdges) return { orient, c };
      }
    }
  }
  assert.fail(`应有至少 ${minEdges} 条边共线成干线（段长 ≥ ${SPACING * 2}、公共重叠 ≥ ${SPACING}）`);
}

/** 断言 C（不穿节点）：任何段的任何点不落在任何节点矩形内部（0.5 容差，贴边允许） */
function assertNoNodePenetration(edges, nodes) {
  for (const e of edges) {
    const label = `${e.from}->${e.to}`;
    for (let i = 0; i < e.points.length - 1; i++) {
      const [x1, y1] = e.points[i];
      const [x2, y2] = e.points[i + 1];
      const loX = Math.min(x1, x2);
      const hiX = Math.max(x1, x2);
      const loY = Math.min(y1, y2);
      const hiY = Math.max(y1, y2);
      for (const n of nodes) {
        const inXLo = n.x + EPS;
        const inXHi = n.x + n.w - EPS;
        const inYLo = n.y + EPS;
        const inYHi = n.y + n.h - EPS;
        let hit = false;
        if (Math.abs(y1 - y2) < EPS) {
          hit = y1 > inYLo && y1 < inYHi && hiX > inXLo && loX < inXHi;
        } else if (Math.abs(x1 - x2) < EPS) {
          hit = x1 > inXLo && x1 < inXHi && hiY > inYLo && loY < inYHi;
        }
        assert.ok(!hit, `${label} 第 ${i} 段穿入节点 ${n.id} 内部: ${JSON.stringify(e.points)}`);
      }
    }
  }
}

test('多源汇入同一目标：入边汇成目标侧干线，端口按源位置展开', () => {
  // 5 个源节点排成一列（x 各异），1 个目标在右侧；手工摆好节点再 routeEdges
  const nodes = [
    { id: 'src-1', x: 40, y: 40, w: 150, h: 60 },
    { id: 'src-2', x: 55, y: 150, w: 150, h: 60 },
    { id: 'src-3', x: 70, y: 260, w: 150, h: 60 },
    { id: 'src-4', x: 85, y: 370, w: 150, h: 60 },
    { id: 'src-5', x: 100, y: 480, w: 150, h: 60 },
    { id: 'target', x: 760, y: 560, w: 150, h: 60 },
  ];
  const edges = ['src-1', 'src-2', 'src-3', 'src-4', 'src-5'].map((from) => ({
    from,
    to: 'target',
    kind: 'direct',
  }));

  routeEdges(nodes, edges);
  const target = nodes[5];
  const maxSourceRight = Math.max(...nodes.slice(0, 5).map((n) => n.x + n.w));

  // 断言 A：至少 4 条边共线成干线
  const trunk = assertSharedTrunk(edges, 4);
  // 干线应落在源列与目标之间、平行于目标入侧、距目标边 SPACING 整数倍
  assert.equal(trunk.orient, 'v', '目标在右侧，汇流干线应为竖直');
  assert.ok(trunk.c > maxSourceRight && trunk.c < target.x, `干线 x=${trunk.c} 应贴近目标入侧`);
  assert.equal((target.x - trunk.c) % SPACING, 0, '干线距目标入侧边应为 SPACING 整数倍');

  // 断言 B：严格正交
  for (const e of edges) assertOrthogonal(e.points, `${e.from}->${e.to}`);

  // 断言 C：不穿节点
  assertNoNodePenetration(edges, nodes);

  // 每面一口制：多源汇入只并中段干线，箭头共用目标左面的同一个入口（不摊开多个口）
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const ends = edges.map((e) => ({ from: e.from, end: e.points.at(-1) }));
  assert.equal(new Set(ends.map((u) => u.end.join(','))).size, 1, '目标侧入口应合为一个（每面一口制）');
  for (const { from, end } of ends) {
    assert.equal(end[0], nodeById.get('target').x, `${from} 的箭头应从目标左侧接入`);
  }
});

test('fan-out 与 fan-in 共存：同一目标的多入口汇流不破坏既有源出口合并', () => {
  // s1 横向扇出 t1/t2/t3（走既有 fan-out 干线）；s2、s3 与 s1 共同指向 t1（t1 侧 fan-in 汇流）
  const nodes = [
    { id: 's1', x: 40, y: 200, w: 150, h: 60 },
    { id: 's2', x: 40, y: 400, w: 150, h: 60 },
    { id: 's3', x: 40, y: 510, w: 150, h: 60 },
    { id: 't1', x: 460, y: 200, w: 140, h: 60 },
    { id: 't2', x: 620, y: 200, w: 140, h: 60 },
    { id: 't3', x: 780, y: 200, w: 140, h: 60 },
  ];
  const edges = [
    { from: 's1', to: 't1', kind: 'direct' },
    { from: 's1', to: 't2', kind: 'direct' },
    { from: 's1', to: 't3', kind: 'direct' },
    { from: 's2', to: 't1', kind: 'direct' },
    { from: 's3', to: 't1', kind: 'direct' },
  ];

  routeEdges(nodes, edges);

  // fan-out 侧正常：s1 的三条边共用同一源出口
  const starts = edges.slice(0, 3).map((e) => e.points[0]);
  assert.deepEqual(starts[1], starts[0], 's1 的扇出边应共用源出口');
  assert.deepEqual(starts[2], starts[0], 's1 的扇出边应共用源出口');

  // fan-in 侧正常：s2->t1 与 s3->t1 汇成目标侧干线
  assertSharedTrunk(edges.slice(3), 2);

  for (const e of edges) assertOrthogonal(e.points, `${e.from}->${e.to}`);
  assertNoNodePenetration(edges, nodes);
});
