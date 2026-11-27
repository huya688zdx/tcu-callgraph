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
  callOrderForEdge,
  compactConnEntries,
  displayEdgeLabels,
  freeConnNumbers,
  estimateTextWidth,
  labelBoxSize,
  labelSvg,
  normalizeLabels,
  placeEdgeLabels,
  viewHeaderObstacles,
  clampLabelCenter,
  labelSize,
  labelText,
  midAnchor,
  nearestOnPolyline,
  nextConnNumber,
  normalizeLabel,
  placeLabel,
  rectsOverlap,
  visibleCallOrderMap,
} from '../src/core/labels.js';
import { layoutExportEdgeLabels } from '../src/core/export-svg.js';

/** 固定的文字测量桩：等宽字体，结果可预测 */
const measure = (s) => String(s).length * 7;

test('コール順：保留同一调用方的已有编号，自动编号跳过占号', () => {
  const call = (from, to, line, annotations = {}) => ({ from, to, line, kind: 'direct', ...annotations });
  const saved = call('A', 'D', 40, { labels: [{ preset: 'call', text: 'コール順1' }] });
  const first = call('A', 'B', 10);
  const second = call('A', 'C', 20);
  const repeated = call('A', 'B', 30, { label: { preset: 'call', text: 'コール順3' } });
  const otherCaller = call('Z', 'B', 10, { labels: [{ preset: 'call', text: 'コール順2' }] });
  const view = { edges: [saved, otherCaller, repeated, second, first] };
  const orders = visibleCallOrderMap(view, 'A');
  assert.deepEqual([...orders].map(([id, { order }]) => [id, order]), [['B', 2], ['C', 4], ['D', 1]]);
  assert.equal(displayEdgeLabels(first, [], view)[0].text, 'コール順2');
  assert.equal(displayEdgeLabels(second, [], view)[0].text, 'コール順4');
  assert.deepEqual(displayEdgeLabels(repeated, [repeated.label], view), [repeated.label]);
  assert.equal(callOrderForEdge(view, repeated), 3);
  assert.equal(callOrderForEdge(view, call('A', 'B', 50)), 5);
});

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

test('placeEdgeLabels：短竖线上的 TASK 和コール順避开上下两个函数框', () => {
  for (const gap of [12, 18, 24]) {
    const nodes = [
      { x: 0, y: 0, w: 120, h: 44 },
      { x: 0, y: 44 + gap, w: 120, h: 44 },
    ];
    const pts = [[60, 44], [60, 44 + gap]];
    const labels = [{ preset: 'task', text: 'TASK:10ms' }, { preset: 'call', text: 'コール順1' }];
    const rects = placeEdgeLabels({
      items: labels.map((label) => ({ label, size: labelBoxSize(label, estimateTextWidth) })),
      pts,
      nodes,
    });
    for (const rect of rects) {
      assert.ok(rect);
      for (const node of nodes) assert.ok(!rectsOverlap(rect, node, 5));
      const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      assert.ok(nearestOnPolyline(center, pts).d <= 96);
    }
    assert.ok(!rectsOverlap(rects[0], rects[1], 4));
  }
});

test('placeEdgeLabels：最长独立线段被邻居挡住时选用较短的独立线段', () => {
  const longest = [[100, 0], [340, 0]];
  const pts = [[0, 0], ...longest, [340, 220]];
  const nodes = [{ x: -20, y: -110, w: 430, h: 200 }];
  const items = [{ label: { preset: 'call', text: 'コール順1' }, size: { w: 60, h: 20 } }];
  const [blocked] = placeEdgeLabels({ items, pts: longest, nodes });
  assert.ok(rectsOverlap(blocked, nodes[0]));
  assert.ok(blocked.y >= 22, '不得压住邻居节点的标题带');

  const [rect] = placeEdgeLabels({ items, pts, nodes, otherPaths: [[[0, 0], [100, 0]]] });
  assert.ok(rect);
  assert.ok(!rectsOverlap(rect, nodes[0], 5));
  const near = nearestOnPolyline({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, pts);
  assert.equal(near.x, 340);
  assert.ok(near.y > 90);
});

test('SVG 标签布局：同边的 TASK、コール順和結合点互相避让，并避开短竖线两端的函数框', () => {
  const nodes = [
    { id: 'A', x: 0, y: 0, w: 120, h: 44 },
    { id: 'B', x: 0, y: 56, w: 120, h: 44 },
  ];
  const labels = normalizeLabels([
    { preset: 'task', text: 'TASK:10ms' },
    { preset: 'call', text: 'コール順1' },
    { preset: 'conn', num: 1 },
  ]);
  const placed = layoutExportEdgeLabels({
    nodes,
    edges: [{ from: 'A', to: 'B', points: [[60, 44], [60, 56]], labels }],
  });
  assert.deepEqual(placed.map(({ label }) => label.preset), ['task', 'call', 'conn']);
  for (const [index, { rect }] of placed.entries()) {
    for (const node of nodes) assert.ok(!rectsOverlap(rect, node, 5));
    for (const earlier of placed.slice(0, index)) assert.ok(!rectsOverlap(rect, earlier.rect, 4));
  }
});

test('free 自由框标签：套用默认边框并剥离 note，支持自定义颜色与无框', () => {
  const def = normalizeLabel({ preset: 'free' });
  assert.equal(def.preset, 'free');
  assert.equal(def.text, LABEL_PRESETS.free.text);
  assert.equal(def.border, LABEL_PRESETS.free.border);
  assert.equal(def.color, LABEL_PRESETS.free.color);
  assert.equal(def.note, undefined);

  const styled = normalizeLabel({
    preset: 'free',
    text: '重要支路',
    note: '不应附带注释',
    border: '#185FA5',
    color: '#185FA5',
  });
  assert.equal(styled.text, '重要支路');
  assert.equal(styled.border, '#185FA5');
  assert.equal(styled.color, '#185FA5');
  assert.equal(styled.note, undefined);

  const noBorder = normalizeLabel({ preset: 'free', text: '无框自由', border: null });
  assert.equal(noBorder.border, null);
});

test('标签不显示注释内容：labelBoxSize 与 labelSvg 仅包含主文字', () => {
  const plain = { preset: 'task', text: 'TASK:10ms', border: '#2C2C2A', color: '#2C2C2A' };
  const withNote = { ...plain, note: '非常长的注释说明不应该显示在标签上' };
  const sizePlain = labelBoxSize(plain, measure);
  const sizeNote = labelBoxSize(withNote, measure);
  assert.deepEqual(sizeNote, sizePlain);
  const svg = labelSvg(withNote, { x: 10, y: 20, w: sizeNote.w, h: sizeNote.h });
  assert.ok(svg.includes('TASK:10ms'));
  assert.ok(!svg.includes('非常长的注释说明'));
});

test('placeEdgeLabels：避开文件框标题栏与目录标题胶囊', () => {
  const groups = [{ id: 'a.c', label: 'a.c', x: 0, y: 0, w: 200, h: 120 }];
  const containers = [{ id: 'app', label: 'app', x: -10, y: -32, w: 240, h: 170 }];
  const headers = viewHeaderObstacles({ groups, containers });
  const pts = [[120, 12], [280, 12], [280, 120]];
  const [rect] = placeEdgeLabels({
    items: [{ label: { preset: 'free', text: '跨文件调用' }, size: { w: 74, h: 20 } }],
    pts,
    nodes: [],
    headers,
  });
  assert.ok(rect);
  for (const h of headers) assert.ok(!rectsOverlap(rect, h, 3), `标签压住标题框 ${JSON.stringify(h)}`);

  const exported = layoutExportEdgeLabels({
    nodes: [],
    groups,
    containers,
    edges: [{ from: 'a', to: 'b', points: pts, labels: [{ preset: 'free', text: '跨文件调用' }] }],
  });
  assert.equal(exported.length, 1);
  for (const h of headers) assert.ok(!rectsOverlap(exported[0].rect, h, 3));
});

test('placeEdgeLabels：优先选择宽敞竖直段，避免挂在过短水平端口引线上', () => {
  const pts = [[0, 100], [16, 100], [16, 260], [180, 260]];
  const [rect] = placeEdgeLabels({
    items: [{ label: { preset: 'call', text: 'コール順1' }, size: { w: 60, h: 20 } }],
    pts,
    nodes: [],
  });
  assert.ok(rect);
  const near = nearestOnPolyline({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, pts);
  assert.equal(Math.round(near.x), 16);
  assert.ok(near.y > 110 && near.y < 250, `应避开 16px 短引线而选在竖直段，got y=${near.y}`);
});

test('placeEdgeLabels：避开附近平行边，优先翻转到无遮挡一侧', () => {
  const pts = [[0, 100], [200, 100]];
  const parallelAbove = [[0, 82], [200, 82]];
  const [rect] = placeEdgeLabels({
    items: [{ label: { preset: 'free', text: '主链路' }, size: { w: 60, h: 20 } }],
    pts,
    nodes: [],
    otherPaths: [parallelAbove],
  });
  assert.ok(rect);
  assert.ok(rect.y >= 100, `上方有平行边时应翻转到下方，got y=${rect.y}`);
});
