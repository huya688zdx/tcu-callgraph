/**
 * 连线标签的纯几何 / 数据规整
 * 这些规则服务端（读库校验）和前端（画布定位）共用，所以单独测
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONN_PREFIX,
  LABEL_MAX_DIST,
  LABEL_PRESETS,
  compactConnEntries,
  freeConnNumbers,
  normalizeLabels,
  placeEdgeLabels,
  clampLabelCenter,
  labelSize,
  labelText,
  midAnchor,
  nearestOnPolyline,
  nextConnNumber,
  normalizeLabel,
  placeLabel,
  rectsOverlap,
} from '../src/core/labels.js';

/** 固定的文字测量桩：等宽字体，结果可预测 */
const measure = (s) => String(s).length * 7;

test('normalizeLabel：结合点的文字由编号推导，不接受手填', () => {
  const l = normalizeLabel({ preset: 'conn', num: 3, text: '乱写' });
  assert.equal(l.preset, 'conn');
  assert.equal(l.num, 3);
  assert.equal(l.text, CONN_PREFIX + '3');
  assert.equal(labelText(l), CONN_PREFIX + '3');
});

test('normalizeLabel：非法颜色降级、空文字等于没有标签', () => {
  const l = normalizeLabel({ preset: 'task', text: 'TASK:2ms', border: 'red;}', color: 'javascript:1' });
  assert.equal(l.border, null);
  assert.equal(l.color, '#2C2C2A');
  assert.equal(normalizeLabel({ preset: 'task', text: '   ' }), null);
  assert.equal(normalizeLabel(null), null);
  assert.equal(normalizeLabel('x'), null);
});

test('normalizeLabel：无边框预设保留 null 边框，偏移取整并夹紧', () => {
  const l = normalizeLabel({ preset: 'call', text: 'コール順', border: null, dx: 9999, dy: -3.4 });
  assert.equal(l.border, null);
  assert.equal(l.dx, 600);
  assert.equal(l.dy, -3);
});

test('nextConnNumber：同一画面内取最小未占用编号', () => {
  const used = [
    { preset: 'conn', num: 1 },
    { preset: 'conn', num: 3 },
    { preset: 'task', text: 'TASK:2ms' },
  ];
  assert.equal(nextConnNumber(used), 2);
  assert.equal(nextConnNumber([]), 1);
  assert.equal(nextConnNumber([{ preset: 'conn', num: 1 }, { preset: 'conn', num: 2 }]), 3);
});

test('midAnchor：正交折线按弧长取中点', () => {
  const pts = [
    [0, 0],
    [100, 0],
    [100, 100],
  ];
  const a = midAnchor(pts);
  assert.equal(Math.round(a.x), 100);
  assert.equal(Math.round(a.y), 0);
  // 中点正好落在折点上：方向取相邻两段之一，但必须是单位轴向
  assert.equal(Math.abs(a.ux) + Math.abs(a.uy), 1);
  assert.equal(midAnchor([[0, 0]]), null);
});

test('placeLabel：没有障碍时贴在线的中央', () => {
  const pts = [
    [0, 100],
    [200, 100],
  ];
  const size = labelSize('TASK:2ms', measure);
  const rect = placeLabel({ label: { dx: 0, dy: 0 }, size, pts, nodes: [], others: [] });
  assert.equal(Math.round(rect.x + rect.w / 2), 100);
  assert.equal(Math.round(rect.y + rect.h / 2), 100);
});

test('placeLabel：线中央被函数框占住时自动让开，且不离开线太远', () => {
  const pts = [
    [0, 100],
    [200, 100],
  ];
  const size = labelSize('TASK:2ms', measure);
  const nodes = [{ id: 'n', x: 60, y: 88, w: 80, h: 24 }];
  const rect = placeLabel({ label: { dx: 0, dy: 0 }, size, pts, nodes, others: [] });
  assert.equal(rectsOverlap(rect, nodes[0], 0), false, '标签不能压住函数框');
  const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  assert.ok(nearestOnPolyline(center, pts).d <= LABEL_MAX_DIST + 0.001, '标签不能离开连线太远');
});

test('placeLabel：标签之间互相避让', () => {
  const pts = [
    [0, 100],
    [200, 100],
  ];
  const size = labelSize('TASK:2ms', measure);
  const first = placeLabel({ label: { dx: 0, dy: 0 }, size, pts, nodes: [], others: [] });
  const second = placeLabel({ label: { dx: 0, dy: 0 }, size, pts, nodes: [], others: [first] });
  assert.equal(rectsOverlap(first, second, 0), false);
});

test('placeLabel：手动偏移优先，但超出范围仍被拉回', () => {
  const pts = [
    [0, 100],
    [200, 100],
  ];
  const size = labelSize('コール順', measure);
  const near = placeLabel({ label: { dx: 20, dy: 10 }, size, pts, nodes: [], others: [] });
  assert.equal(Math.round(near.x + near.w / 2), 120);
  assert.equal(Math.round(near.y + near.h / 2), 110);

  const far = placeLabel({ label: { dx: 0, dy: 400 }, size, pts, nodes: [], others: [] });
  const c = { x: far.x + far.w / 2, y: far.y + far.h / 2 };
  assert.ok(nearestOnPolyline(c, pts).d <= LABEL_MAX_DIST + 0.001);
});

test('clampLabelCenter：拖太远会被拉回，压住节点则拒绝移动', () => {
  const pts = [
    [0, 100],
    [200, 100],
  ];
  const size = labelSize('TASK:2ms', measure);
  const c = clampLabelCenter({ x: 100, y: 300 }, { size, pts });
  assert.ok(c && nearestOnPolyline(c, pts).d <= LABEL_MAX_DIST + 0.001);

  const nodes = [{ id: 'n', x: 40, y: 60, w: 120, h: 80 }];
  assert.equal(clampLabelCenter({ x: 100, y: 100 }, { size, pts, nodes }), null);
});

test('normalizeLabel：只给 preset 时套用预设样式，显式 null 才是「不要边框」', () => {
  // MCP / 脚本通常只传 preset：不套预设的话结合点会变成黑字无框，跟界面里不一样
  const conn = normalizeLabel({ preset: 'conn' });
  assert.equal(conn.border, LABEL_PRESETS.conn.border);
  assert.equal(conn.color, LABEL_PRESETS.conn.color);
  assert.equal(conn.num, 1);

  const task = normalizeLabel({ preset: 'task', text: 'TASK:2ms' });
  assert.equal(task.border, LABEL_PRESETS.task.border);

  // 用户手动去掉边框 → 存 null → 读回来必须还是 null，不能被预设补回去
  const noBorder = normalizeLabel({ preset: 'task', text: 'x', border: null });
  assert.equal(noBorder.border, null);
});

test('normalizeLabel：custom 预设没有默认样式，颜色退回默认黑', () => {
  const l = normalizeLabel({ preset: 'custom', text: '随便写' });
  assert.equal(l.preset, 'custom');
  assert.equal(l.border, null);
  assert.equal(l.color, '#2C2C2A');
});

// ---------------------------------------------------------------------------
// 多标签模型（labels 数组 / note / id / 编号模式 / 两侧排布）
// ---------------------------------------------------------------------------

test('normalizeLabels：数组与旧版单条都收，id 缺失按位置补齐', () => {
  const arr = normalizeLabels([{ preset: 'conn' }, { preset: 'task', text: 'TASK:2ms' }]);
  assert.equal(arr.length, 2);
  assert.equal(arr[0].id, 'a0');
  assert.equal(arr[1].id, 'a1');

  // 旧版单条 → 单元素数组
  const single = normalizeLabels({ preset: 'call', text: 'コール順' });
  assert.equal(single.length, 1);
  assert.equal(single[0].id, 'a0');

  // 脏条目被丢掉，好条目保留；null / 空数组安全
  assert.equal(normalizeLabels([{ preset: 'task', text: '  ' }, null, { preset: 'call' }]).length, 1);
  assert.deepEqual(normalizeLabels(null), []);
});

test('normalizeLabel：note 限长并拍平控制字符，结合点编号改字随 num 走', () => {
  const l = normalizeLabel({ preset: 'conn', num: 3, note: '换挡\n请求\t入口' + 'x'.repeat(100) });
  assert.equal(l.text, CONN_PREFIX + 3);
  assert.ok(!/[\r\n\t]/.test(l.note));
  assert.ok(l.note.length <= 80);
});

test('freeConnNumbers：空缺号 + 下一号（固定排序模式的候选）', () => {
  const used = [
    { preset: 'conn', num: 2 },
    { preset: 'conn', num: 3 },
    { preset: 'conn', num: 5 },
    { preset: 'task', text: 'x' },
  ];
  assert.deepEqual(freeConnNumbers(used, 4), [1, 4, 6, 7]);
});

test('compactConnEntries：升序紧凑成 1..n，只返回变化项（重排模式）', () => {
  const entries = [
    { key: 'a->b:1', id: 'x', num: 2 },
    { key: 'a->c:2', id: 'y', num: 3 },
    { key: 'a->d:3', id: 'z', num: 5 },
  ];
  assert.deepEqual(compactConnEntries(entries), [
    { key: 'a->b:1', id: 'x', num: 1 },
    { key: 'a->c:2', id: 'y', num: 2 },
    { key: 'a->d:3', id: 'z', num: 3 },
  ]);
  // 已经连续的不动
  assert.deepEqual(
    compactConnEntries([
      { key: 'k', id: 'x', num: 1 },
      { key: 'k2', id: 'y', num: 2 },
    ]),
    []
  );
});

test('placeEdgeLabels：多条标签交替放线的两侧，默认不压中线', () => {
  const pts = [
    [0, 0],
    [200, 0],
  ];
  const items = [
    { label: { preset: 'task', text: 'TASK:2ms', dx: 0, dy: 0 }, size: { w: 60, h: 20 } },
    { label: { preset: 'conn', num: 1, dx: 0, dy: 0 }, size: { w: 60, h: 20 } },
  ];
  const [r1, r2] = placeEdgeLabels({ items, pts, nodes: [] });
  assert.ok(r1 && r2);
  // 线在 y=0：第一条整体在上方（rect 底边不越线），第二条在下方（rect 顶边不越线）
  assert.ok(r1.y + r1.h <= 1, `第一条应在线上方，got y=${r1.y}`);
  assert.ok(r2.y >= -1, `第二条应在线下方，got y=${r2.y}`);
  // 两条不能叠住
  assert.ok(!rectsOverlap(r1, r2, 0));
});

test('placeEdgeLabels：避开共用干线，将自动标签放到独立分支（含反向汇入）', () => {
  const own = [[0, 0], [400, 0], [400, 80], [480, 80]];
  const peer = [[0, 0], [400, 0], [400, -80], [480, -80]];
  for (const reverse of [false, true]) {
    const pts = reverse ? own.toReversed() : own;
    const other = reverse ? peer.toReversed() : peer;
    const [rect] = placeEdgeLabels({
      items: [{ label: { preset: 'call', text: 'コール順1', dx: 0, dy: 0 }, size: { w: 60, h: 20 } }],
      pts, otherPaths: [other], nodes: [],
    });
    assert.ok(rect);
    const near = nearestOnPolyline({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, pts);
    assert.ok(near.y > 0 && near.x >= 400, '标签应附着在独立分支，而不是共用的水平干线');
    assert.ok(near.d <= LABEL_MAX_DIST);
  }
});

test('placeEdgeLabels：没有独立线段时不自动挤入公共线，已有手动位置保留', () => {
  const pts = [[0, 0], [300, 0]];
  const size = { w: 60, h: 20 };
  const rects = placeEdgeLabels({
    items: [
      { label: { preset: 'call', text: '自动', dx: 0, dy: 0 }, size },
      { label: { preset: 'task', text: '手动', dx: 30, dy: 20 }, size },
    ], pts, otherPaths: [pts], nodes: [],
  });
  assert.equal(rects[0], null);
  assert.equal(rects[1].x + rects[1].w / 2, 180);
  assert.equal(rects[1].y + rects[1].h / 2, 20);
});
