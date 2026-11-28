/**
 * 连线标签：纯数据 + 纯几何，不碰 DOM。
 *
 * 为什么放在 core 而不是 web/lib：
 * - 服务端读库时要用同一套规则做校验（避免脏数据直接进画布 / 导出的 SVG）；
 * - 前端要用同一套规则算位置（标签必须贴着线、又不能压住函数框）；
 * - 两边共用一份，规则只有一处，纯函数也好写单测。
 *
 * 标签挂在连线上（overlay.edges[edgeKey].labels，旧数据是单条 label），
 * 连线没了标签自然就没了，不需要单独清理。
 */

/** 世界坐标下的字号与内边距：画布缩放时标签跟着一起缩，和函数框观感一致 */
export const LABEL_FONT = 12;
export const LABEL_PAD_X = 7;
export const LABEL_PAD_Y = 4;
/** 说明行（结合点等的第二行小字） */
export const LABEL_NOTE_FONT = 10;
export const LABEL_NOTE_MAX = 80;
/** 一条连线上的标签数上限：多标签是让一条线能同时挂任务/结合点/顺序，
 *  不是无限涂鸦位——超了直接拒绝，免得避让算法和画布被极端数据拖垮 */
export const LABELS_MAX = 8;
/** 标签中心离折线的最大距离（世界坐标）：允许手动挪一点，但不能离开线太远 */
export const LABEL_MAX_DIST = 64;
export const LABEL_MAX_TEXT = 40;

/** 日文「結合点」前缀，编号由系统分配，不允许手填 */
export const CONN_PREFIX = '結合点：';

/**
 * 四个预设：
 * - task: 黑框白底黑字（任务耗时等，文字自己填）
 * - conn: 红框白底红字（結合点，编号自动递增且同一画面内不重复）
 * - call: 无框黑字（コール順）
 * - free: 纯文字带框标签（自由填写，不附带注释）
 */
export const LABEL_PRESETS = {
  task: { border: '#2C2C2A', color: '#2C2C2A', text: 'TASK:2ms' },
  conn: { border: '#C0392B', color: '#C0392B' },
  call: { border: null, color: '#2C2C2A', text: 'コール順' },
  free: { border: '#4A5568', color: '#2C2C2A', text: '标签' },
};

const HEX = /^#[0-9a-f]{6}$/i;
const PRESETS = new Set(['task', 'conn', 'call', 'free', 'custom']);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 标签显示文字：结合点的文字永远由编号推导，避免文字和编号对不上 */
export function labelText(label) {
  if (!label) return '';
  if (label.preset === 'conn') return CONN_PREFIX + (Number(label.num) || 1);
  return String(label.text || '');
}

/**
 * 规整一条标签：脏数据一律降级成合法值，彻底不可用时返回 null（等于没有标签）。
 * 颜色只收 #RRGGBB —— 这些值会进 canvas 与导出的 SVG，不能放任意字符串过去。
 */
export function normalizeLabel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const preset = PRESETS.has(raw.preset) ? raw.preset : 'custom';
  // 编号优先取 num；只有文字（比如外部导入的「結合点：3」）时从末尾数字兜底
  let num = Number.isFinite(Number(raw.num)) ? Math.max(1, Math.trunc(Number(raw.num))) : NaN;
  if (!Number.isFinite(num)) {
    const m = /(\d+)\s*$/.exec(String(raw.text || ''));
    num = m ? Math.max(1, parseInt(m[1], 10)) : 1;
  }
  // 边框 / 文字色：字段「没给」时用预设的样式（MCP 只传 preset 也能得到红框红字），
  // 显式传 null 才表示「不要边框」——两者必须区分开，否则用户去掉边框后
  // 再读回来又会被补上。
  const presetDef = LABEL_PRESETS[preset] || null;
  const border =
    raw.border === undefined
      ? (presetDef && presetDef.border) || null
      : raw.border == null || raw.border === ''
      ? null
      : HEX.test(raw.border)
      ? raw.border
      : null;
  const color = HEX.test(raw.color || '') ? raw.color : (presetDef && presetDef.color) || '#2C2C2A';
  const dx = Number.isFinite(Number(raw.dx)) ? clamp(Number(raw.dx), -600, 600) : 0;
  const dy = Number.isFinite(Number(raw.dy)) ? clamp(Number(raw.dy), -600, 600) : 0;
  // 文字：给了但为空/全空白 = 删除这条标签（与旧语义一致）；
  // 完全没给（null/undefined）时 task/call 套预设默认文字，custom 没有默认
  const rawText =
    raw.text == null ? (presetDef && presetDef.text) || '' : String(raw.text);
  const text =
    preset === 'conn' ? CONN_PREFIX + num : rawText.replace(/[\r\n\t]/g, ' ').slice(0, LABEL_MAX_TEXT).trim();
  if (!text) return null;
  const label = { preset, text, border, color, dx: Math.round(dx), dy: Math.round(dy) };
  if (preset === 'conn') label.num = num;
  // 说明行：控制字符拍平、限长；コール順（call）和自由框（free）标签不附带注释说明。
  const note =
    preset !== 'call' && preset !== 'free' && typeof raw.note === 'string' && raw.note.trim()
      ? raw.note.replace(/[\r\n\t]/g, ' ').slice(0, LABEL_NOTE_MAX).trim()
      : '';
  if (note) label.note = note;
  // 稳定 id：多标签时代「选中/拖动/改编号」都指名道姓地操作某一条，
  // 没有就用位置补一个（a0/a1…），落库后就是持久标识
  if (typeof raw.id === 'string' && /^[a-z][a-z0-9]{0,7}$/i.test(raw.id)) label.id = raw.id;
  return label;
}

/**
 * 规整一组标签（一条连线可以挂多条）：接受数组 / 旧版单条对象 / null。
 * id 缺失的按位置补 a0/a1…；与已有 id 冲突时跳过补齐（保留传入的）。
 */
export function normalizeLabels(raw) {
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];
  for (const item of arr) {
    if (out.length >= LABELS_MAX) break;
    const label = normalizeLabel(item);
    if (label) out.push(label);
  }
  const used = new Set(out.map((l) => l.id).filter(Boolean));
  for (let i = 0; i < out.length; i++) {
    if (out[i].id) continue;
    let n = i;
    let id = 'a' + n;
    while (used.has(id)) id = 'a' + ++n;
    out[i].id = id;
    used.add(id);
  }
  return out;
}

function savedCallNumber(label) {
  if (label?.auto) return 0;
  const match = /^コール順(\d+)$/.exec(String(label?.text ?? '').trim());
  const number = Number(match?.[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export function numberedCallLabel(labels) {
  return labels.find(savedCallNumber);
}

function savedCallOrders(view, callerId) {
  const used = new Set();
  const byEdge = new Map();
  for (const edge of view?.edges || []) {
    if (edge.from !== callerId) continue;
    const raw = edge.labels ?? edge.label;
    const labels = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const label of labels) {
      const order = savedCallNumber(label);
      if (!order) continue;
      used.add(order);
      if (!byEdge.has(edge)) byEdge.set(edge, order);
    }
  }
  return { used, byEdge };
}

function firstFreeOrder(used, start = 1) {
  while (used.has(start)) start++;
  return start;
}

/** 当前画布按被调函数的首次调用分配编号，跳过同一调用方已保存的编号。 */
export function visibleCallOrderMap(view, callerId) {
  const map = new Map();
  if (!view?.edges || !callerId) return map;
  const visibleNodes = view.nodes?.length ? new Set(view.nodes.map((n) => n.id)) : null;
  const calls = view.edges
    .filter((e) => e.from === callerId && ['direct', 'macro', 'fnptr'].includes(e.kind) &&
      (!visibleNodes || visibleNodes.has(e.to)))
    .slice()
    .sort((a, b) => {
      const oa = (a.callNumbers?.length ? parseInt(a.callNumbers[0], 10) : 0) || a.orderGroup || a.line || 0;
      const ob = (b.callNumbers?.length ? parseInt(b.callNumbers[0], 10) : 0) || b.orderGroup || b.line || 0;
      return oa - ob || (a.line || 0) - (b.line || 0);
    });
  const { used, byEdge } = savedCallOrders(view, callerId);
  let next = 1;
  for (const edge of calls) {
    if (map.has(edge.to)) continue;
    const saved = byEdge.get(edge);
    const order = saved || firstFreeOrder(used, next);
    if (!saved) next = order + 1;
    map.set(edge.to, { order, edge });
  }
  return map;
}

/** 给单条边添加标签时，复用其可见编号，或在其余边已占编号之外取一个空号。 */
export function callOrderForEdge(view, edge) {
  const orders = visibleCallOrderMap(view, edge?.from);
  const entry = orders.get(edge?.to);
  if (entry && entry.edge === edge) return entry.order;
  const { used, byEdge } = savedCallOrders(view, edge?.from);
  if (byEdge.has(edge)) return byEdge.get(edge);
  for (const { order } of orders.values()) used.add(order);
  return firstFreeOrder(used);
}

export function displayEdgeLabels(edge, labels = [], viewOrCaller) {
  if (labels.some((l) => l.preset === 'call') || numberedCallLabel(labels)) return labels;
  if (!['direct', 'macro', 'fnptr'].includes(edge?.kind)) return labels;
  let orderNum = null;
  if (typeof viewOrCaller === 'string') {
    if (edge.from !== viewOrCaller || !edge.callNumbers?.length) return labels;
    orderNum = parseInt(edge.callNumbers[0], 10) || 1;
  } else if (viewOrCaller?.edges) {
    const orders = visibleCallOrderMap(viewOrCaller, edge.from);
    if (orders.size < 2) return labels;
    const entry = orders.get(edge.to);
    if (!entry || entry.edge !== edge) return labels;
    orderNum = entry.order;
  } else if (edge.callNumbers?.length) {
    orderNum = parseInt(edge.callNumbers[0], 10) || 1;
  }
  if (!orderNum) return labels;
  const label = normalizeLabel({ id: 'auto', preset: 'call', text: `${LABEL_PRESETS.call.text}${orderNum}` });
  return [...labels, { ...label, id: 'auto', auto: true, orderNum }];
}

/** 下一张结合点的编号：同一画面内取最小未占用值 */
export function nextConnNumber(labels = []) {
  const used = new Set();
  for (const l of labels) {
    if (!l || l.preset !== 'conn') continue;
    const n = Number(l.num);
    if (Number.isFinite(n) && n > 0) used.add(Math.trunc(n));
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** 结合点的空缺号 + 下一个号（固定排序模式下新增时供用户挑选） */
export function freeConnNumbers(labels = [], count = 4) {
  const used = new Set(
    labels
      .filter((l) => l && l.preset === 'conn' && Number.isFinite(Number(l.num)))
      .map((l) => Math.trunc(Number(l.num)))
  );
  const out = [];
  let n = 1;
  while (out.length < count) {
    if (!used.has(n)) out.push(n);
    n++;
    if (n > 999) break;
  }
  return out;
}

/**
 * 重排（紧凑化）：entries = [{key, id, num}]（当前画面里全部结合点），
 * 按编号升序重新编成 1..n，只返回编号发生变化的条目。
 */
export function compactConnEntries(entries = []) {
  const sorted = entries
    .filter((x) => Number.isFinite(Number(x.num)))
    .sort((a, b) => a.num - b.num);
  const out = [];
  sorted.forEach((x, i) => {
    if (x.num !== i + 1) out.push({ key: x.key, id: x.id, num: i + 1 });
  });
  return out;
}

/** 标签盒子尺寸；measure 由调用方注入（浏览器传 ctx.measureText，测试传桩） */
export function labelSize(text, measure) {
  const tw = measure ? measure(String(text || '')) : String(text || '').length * 7;
  return { w: Math.max(20, tw) + LABEL_PAD_X * 2, h: LABEL_FONT + LABEL_PAD_Y * 2 };
}

/**
 * 标签盒子尺寸（只显示单行主文字，不把注释绘制进标签框）。
 */
export function labelBoxSize(label, measure) {
  return labelSize(labelText(label), (t) => measure(t, LABEL_FONT));
}

/** 删除标记位于整条连线的弧长中点，浏览器和服务端 SVG 使用相同的图形。 */
export function deletedEdgeMarkSvg(points, color) {
  const center = midAnchor(points);
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) return '';
  const { x, y } = center;
  const stroke = HEX.test(color) ? color : '#2C2C2A';
  return `<path class="deleted-edge-mark" d="M${x - 5} ${y - 5}L${x + 5} ${y + 5}M${x + 5} ${y - 5}L${x - 5} ${y + 5}" fill="none" stroke="${stroke}" stroke-width="2.2"/>`;
}

/** 折线按弧长取中点，同时给出所在段的方向（用于确定「贴近线」的法线方向） */
export function midAnchor(pts = []) {
  if (!Array.isArray(pts) || pts.length < 2) return null;
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  }
  if (!total) return { x: pts[0][0], y: pts[0][1], ux: 1, uy: 0 };
  let half = total / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy);
    if (half <= len || i === pts.length - 2) {
      const t = len ? half / len : 0;
      return {
        x: pts[i][0] + dx * t,
        y: pts[i][1] + dy * t,
        ux: len ? dx / len : 1,
        uy: len ? dy / len : 0,
      };
    }
    half -= len;
  }
  const last = pts[pts.length - 1];
  return { x: last[0], y: last[1], ux: 1, uy: 0 };
}

/** 点到折线的最近点（含距离），手动拖动后用它把标签拉回线附近 */
export function nearestOnPolyline(p, pts = []) {
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = a[0] + dx * t;
    const y = a[1] + dy * t;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) {
      bestD = d;
      best = { x, y, d };
    }
  }
  return best || { x: p.x, y: p.y, d: 0 };
}

export function distToPolyline(p, pts = []) {
  return nearestOnPolyline(p, pts).d;
}

/** 两个矩形是否相交（pad 为额外间隙） */
export function rectsOverlap(a, b, pad = 0) {
  return (
    a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y
  );
}

/** 统计一个矩形压住了多少个障碍（节点 / 别的标签） */
function overlapCount(rect, boxes = [], pad = 0) {
  let n = 0;
  for (const b of boxes) if (rectsOverlap(rect, b, pad)) n++;
  return n;
}

const rectAt = (cx, cy, size) => ({
  x: cx - size.w / 2,
  y: cy - size.h / 2,
  w: size.w,
  h: size.h,
});

const NODE_PAD = 5;
const HEADER_PAD = 3;
const EDGE_HIT_PAD = 1.5;
const LABEL_GAP = 4;
const AUTO_MAX_DIST = 88;
const ESCAPE_MAX_DIST = 96;

function polylineLength(pts = []) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return total;
}

/** 视图中的文件框标题栏与目录容器标题胶囊（供标签避障）。 */
export function viewHeaderObstacles(view) {
  const headers = [];
  for (const g of view?.groups || []) {
    if (Number.isFinite(g?.x) && Number.isFinite(g?.y) && Number.isFinite(g?.w)) {
      headers.push({ x: g.x, y: g.y, w: g.w, h: 26 });
    }
  }
  for (const c of view?.containers || []) {
    if (!c?.label || !Number.isFinite(c?.x) || !Number.isFinite(c?.y)) continue;
    const w = Math.max(24, Math.min((c.w || 0) - 8, estimateTextWidth(c.label, 13) + 20));
    headers.push({ x: c.x + 4, y: c.y + 2, w, h: 22 });
  }
  return headers;
}

/** 优先布局含手动偏移的边及较短的受限连线，让紧空间连线先占好位置。 */
export function orderLabeledEdges(entries = []) {
  const hasManual = (labels) => (labels || []).some((l) => (l?.dx || 0) !== 0 || (l?.dy || 0) !== 0);
  return entries.slice().sort((a, b) =>
    Number(hasManual(b.labels)) - Number(hasManual(a.labels)) ||
    polylineLength(a.e?.points) - polylineLength(b.e?.points)
  );
}

function limitLabelCenter(center, pts, maxDist) {
  const near = nearestOnPolyline(center, pts);
  if (near.d <= maxDist) return center;
  const scale = maxDist / near.d;
  return {
    x: near.x + (center.x - near.x) * scale,
    y: near.y + (center.y - near.y) * scale,
  };
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return Math.max(0, w) * Math.max(0, h);
}

function boxEscapeCenters(center, box, size, pad) {
  const gap = pad + 1;
  return [
    { x: center.x, y: box.y - size.h / 2 - gap },
    { x: center.x, y: box.y + box.h + size.h / 2 + gap },
    { x: box.x - size.w / 2 - gap, y: center.y },
    { x: box.x + box.w + size.w / 2 + gap, y: center.y },
  ];
}

function rectIntersectsSegment(rect, a, b, pad = EDGE_HIT_PAD) {
  const rx0 = rect.x - pad;
  const rx1 = rect.x + rect.w + pad;
  const ry0 = rect.y - pad;
  const ry1 = rect.y + rect.h + pad;
  const [x1, y1] = a;
  const [x2, y2] = b;
  if (Math.max(x1, x2) < rx0 || Math.min(x1, x2) > rx1 || Math.max(y1, y2) < ry0 || Math.min(y1, y2) > ry1) {
    return false;
  }
  if (Math.abs(y1 - y2) < 0.5) return y1 >= ry0 && y1 <= ry1;
  if (Math.abs(x1 - x2) < 0.5) return x1 >= rx0 && x1 <= rx1;
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - rx0], [dx, rx1 - x1], [-dy, y1 - ry0], [dy, ry1 - y1]]) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1;
}

function pathEdgeHitCount(rect, paths, pad = EDGE_HIT_PAD) {
  let count = 0;
  for (const pts of paths || []) {
    if (!Array.isArray(pts)) continue;
    for (let i = 1; i < pts.length; i++) {
      if (rectIntersectsSegment(rect, pts[i - 1], pts[i], pad)) count++;
    }
  }
  return count;
}

/** 自动标签遍历独立线段。手动偏移以整条折线的中点为基准。 */
export function placeLabel({
  label, size, pts = [], nodes = [], headers = [], others = [], otherPaths = [],
  maxDist = LABEL_MAX_DIST, preferredSide = -1,
} = {}) {
  return findLabelRect({
    label, size, pts, nodes, headers, others, otherPaths, maxDist, preferredSide,
    paths: privateLabelPaths(pts, otherPaths),
    centerUnstyled: otherPaths.length === 0,
  });
}

function findLabelRect({
  label, size, pts, nodes, headers = [], others, otherPaths = [],
  maxDist, preferredSide, paths, centerUnstyled,
}) {
  const anchor = midAnchor(pts);
  if (!anchor || !size) return null;
  const dx = label?.dx || 0;
  const dy = label?.dy || 0;
  const manual = dx !== 0 || dy !== 0;
  const rectOnLine = !manual && centerUnstyled && !label?.preset;
  const manualCenter = manual && limitLabelCenter({ x: anchor.x + dx, y: anchor.y + dy }, pts, maxDist);
  if (manualCenter) {
    const rect = rectAt(manualCenter.x, manualCenter.y, size);
    if (!overlapCount(rect, nodes, NODE_PAD)) return rect;
    paths = privateLabelPaths(pts, []);
  }

  const totalArc = polylineLength(pts);
  const candidateLimit = manual ? maxDist : AUTO_MAX_DIST;
  const escapeLimit = manual ? maxDist : ESCAPE_MAX_DIST;
  let best = null;
  let bestScore = null;

  function evaluate(center, meta, path, limit, preferencePenalty) {
    const distance = distToPolyline(center, path);
    if (distance > limit + 1e-6) return { nodeHits: [], headerHits: [] };
    const rect = rectAt(center.x, center.y, size);
    const nodeHits = nodes.filter((node) => rectsOverlap(rect, node, NODE_PAD));
    let nodeArea = 0;
    let nodeTitleArea = 0;
    let nodeTitleGap = Infinity;
    for (const node of nodeHits) {
      nodeArea += overlapArea(rect, node);
      const title = { ...node, h: Math.min(22, node.h) };
      nodeTitleArea += overlapArea(rect, title);
      const gap = Math.max(title.y - rect.y - rect.h, rect.y - title.y - title.h, 0);
      nodeTitleGap = Math.min(nodeTitleGap, gap);
    }
    const headerHits = headers.filter((h) => rectsOverlap(rect, h, HEADER_PAD));
    let headerArea = 0;
    for (const h of headerHits) headerArea += overlapArea(rect, h);
    const otherEdgeHits = pathEdgeHitCount(rect, otherPaths, EDGE_HIT_PAD);
    const ownEdgeHits = meta.onLine ? 0 : pathEdgeHitCount(rect, [pts], EDGE_HIT_PAD);
    const surfaceClearance = Math.max(0, distance - (meta.halfPerp ?? 0));
    let overhang = 0;
    if (meta.host) {
      const { a, ux, uy, len, halfAlong } = meta.host;
      const proj = (center.x - a[0]) * ux + (center.y - a[1]) * uy;
      overhang = Math.max(0, halfAlong - proj) + Math.max(0, proj + halfAlong - len);
    }
    const alongCost = meta.manualTarget
      ? Math.hypot(center.x - meta.manualTarget.x, center.y - meta.manualTarget.y)
      : meta.onLine
      ? Math.hypot(center.x - anchor.x, center.y - anchor.y)
      : label?.preset === 'task'
      ? (meta.arcPos ?? 0) * 0.08
      : Math.abs((meta.arcPos ?? totalArc / 2) - totalArc / 2) * 0.08;
    // 按优先级逐项比较：节点、已有标签、文件/目录标题、交叉连线，其次是溢出短段与贴线距离。
    const score = [
      Number(nodeHits.length > 0),
      nodeArea,
      nodeTitleArea,
      nodeHits.length ? -nodeTitleGap : 0,
      overlapCount(rect, others, LABEL_GAP),
      Number(headerHits.length > 0),
      headerArea,
      otherEdgeHits,
      ownEdgeHits,
      Number(distance > maxDist + 1e-6),
      Number(overhang > 0.5),
      Math.round(overhang),
      surfaceClearance + alongCost + preferencePenalty,
    ];
    const firstDifference = bestScore && score.findIndex((value, i) => value !== bestScore[i]);
    if (!bestScore || (firstDifference >= 0 && score[firstDifference] < bestScore[firstDifference])) {
      best = rect;
      bestScore = score;
    }
    return { nodeHits, headerHits };
  }

  function probe(center, meta, path, preferencePenalty) {
    const { nodeHits, headerHits } = evaluate(center, meta, path, candidateLimit, preferencePenalty);
    for (const node of nodeHits) {
      for (const escaped of boxEscapeCenters(center, node, size, NODE_PAD)) {
        evaluate(escaped, { ...meta, onLine: false, host: null }, pts, escapeLimit, preferencePenalty + 2);
      }
    }
    for (const h of headerHits) {
      for (const escaped of boxEscapeCenters(center, h, size, HEADER_PAD)) {
        evaluate(escaped, { ...meta, onLine: false, host: null }, pts, escapeLimit, preferencePenalty + 2);
      }
    }
  }

  if (manualCenter) probe(manualCenter, { manualTarget: manualCenter }, pts, 0);
  if (rectOnLine) probe(anchor, { onLine: true }, pts, 0);

  for (const entry of paths) {
    const path = entry.seg;
    const [a, b] = path;
    const len = entry.len;
    if (len <= 0.5) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    const nx = -uy;
    const ny = ux;
    const halfPerp = Math.abs(nx) * size.w / 2 + Math.abs(ny) * size.h / 2;
    const halfAlong = Math.abs(ux) * size.w / 2 + Math.abs(uy) * size.h / 2;
    const startInset = entry.isStartPort && len >= 32 ? Math.min(14, len / 3) : Math.min(8, len / 2);
    const endInset = entry.isEndPort && len >= 32 ? Math.min(14, len / 3) : Math.min(8, len / 2);
    const maxPos = Math.max(startInset, len - endInset);
    const clampPos = (d) => clamp(d, startInset, maxPos);
    const distances = label?.preset === 'task'
      ? [clampPos(20), len / 2, len * 0.25, len * 0.75, startInset, maxPos]
      : [len / 2, len * 0.3, len * 0.7, len * 0.2, len * 0.8, len * 0.15, len * 0.85, startInset, maxPos];
    const along = (d) => ({ x: a[0] + ux * d, y: a[1] + uy * d });
    const baseOff = halfPerp + 6;
    const host = { a, ux, uy, len, halfAlong };
    for (const [rank, rawD] of [...new Set(distances.map(clampPos))].entries()) {
      const point = along(rawD);
      const arcPos = entry.arcStart + rawD;
      for (let step = 0; step < 4; step++) {
        const desiredOffset = baseOff + step * (size.h + 6);
        if (step > 0 && desiredOffset > candidateLimit) break;
        // 宽标签的最小净距可能已超限，仍测试距离上限及节点外沿。
        const offset = Math.min(desiredOffset, candidateLimit);
        for (const side of [preferredSide, -preferredSide]) {
          probe(
            { x: point.x + nx * offset * side, y: point.y + ny * offset * side },
            { manualTarget: manualCenter || null, halfPerp, arcPos, host },
            path,
            rank + (side === preferredSide ? 0 : 1)
          );
        }
      }
    }
  }
  return best;
}

/** 依次摆放同一条边上的标签，让后放的标签避开已有标签。 */
export function placeEdgeLabels({
  items = [], pts = [], nodes = [], headers = [], others = [], otherPaths = [], maxDist = LABEL_MAX_DIST,
} = {}) {
  const placed = [...others];
  const paths = privateLabelPaths(pts, otherPaths);
  return items.map(({ label, size }, i) => {
    if (!label || !size) return null;
    const rect = findLabelRect({
      label, size, pts, nodes, headers, others: placed, otherPaths, maxDist, paths,
      preferredSide: i % 2 === 0 ? -1 : 1,
      centerUnstyled: false,
    });
    if (rect) placed.push(rect);
    return rect;
  });
}

/** 从正交线段中扣除共用部分，保留沿原折线方向的所有独立线段及弧长元信息。 */
function privateLabelPaths(pts, otherPaths) {
  const paths = [];
  if (!Array.isArray(pts)) return paths;
  let arcCursor = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (a[0] !== b[0] && a[1] !== b[1]) {
      paths.push({
        seg: [a, b],
        len: segLen,
        arcStart: arcCursor,
        isStartPort: i === 1,
        isEndPort: i === pts.length - 1,
      });
      arcCursor += segLen;
      continue;
    }
    const axis = a[0] !== b[0] ? 0 : 1;
    const cross = 1 - axis;
    const forward = b[axis] > a[axis];
    const segStartVal = a[axis];
    let parts = [[Math.min(a[axis], b[axis]), Math.max(a[axis], b[axis])]];
    for (const other of otherPaths) {
      if (!parts.length) break;
      for (let j = 1; j < other.length && parts.length; j++) {
        const c = other[j - 1], d = other[j];
        if (Math.abs(c[cross] - d[cross]) > 0.5 || Math.abs(c[cross] - a[cross]) > 0.5) continue;
        const lo = Math.min(c[axis], d[axis]), hi = Math.max(c[axis], d[axis]);
        if (!parts.some(([start, end]) => Math.min(end, hi) - Math.max(start, lo) > 0.5)) continue;
        parts = parts.flatMap(([start, end]) => {
          const left = Math.max(start, lo), right = Math.min(end, hi);
          if (right - left <= 0.5) return [[start, end]];
          return [...(left > start ? [[start, left]] : []), ...(right < end ? [[right, end]] : [])];
        });
      }
    }
    if (!forward) parts.reverse();
    for (const [lo, hi] of parts) {
      const start = [...a], end = [...b];
      start[axis] = forward ? lo : hi;
      end[axis] = forward ? hi : lo;
      const len = hi - lo;
      if (len <= 0.5) continue;
      const localOffset = Math.abs(start[axis] - segStartVal);
      paths.push({
        seg: [start, end],
        len,
        arcStart: arcCursor + localOffset,
        isStartPort: i === 1 && localOffset <= 0.5,
        isEndPort: i === pts.length - 1 && Math.abs(end[axis] - b[axis]) <= 0.5,
      });
    }
    arcCursor += segLen;
  }
  return paths;
}

/**
 * 拖动中的约束：中心点离折线不超过 maxDist，且不能压住节点 / 别的标签。
 * 返回合法中心点；完全放不下时返回 null，由调用方保持原位（宁可不跟手也不重叠）。
 */
export function clampLabelCenter(
  center,
  { size, pts = [], nodes = [], others = [], maxDist = LABEL_MAX_DIST } = {}
) {
  if (!size) return null;
  const c = limitLabelCenter(center, pts, maxDist);
  const rect = rectAt(c.x, c.y, size);
  if (overlapCount(rect, nodes, NODE_PAD) || overlapCount(rect, others, LABEL_GAP)) return null;
  return c;
}

/**
 * 没有 canvas 时（服务端导出）的文字宽度估算：CJK 按一个字宽，其它按 0.58 字宽。
 * 只影响导出的排版精度，不影响画布（画布用 measureText）。
 */
export function estimateTextWidth(text, font = LABEL_FONT) {
  let w = 0;
  for (const ch of String(text || '')) {
    w += /[\u1100-\uFFFF]/.test(ch) ? font : font * 0.58;
  }
  return w;
}

const svgEsc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** 一个标签的 SVG 片段（服务端导出用；颜色已在 normalizeLabel 里限定为 #RRGGBB；不输出注释行） */
export function labelSvg(label, rect, background = '#F7F6F2') {
  const cx = (rect.x + rect.w / 2).toFixed(1);
  const mainCy = (rect.y + rect.h / 2 + 0.5).toFixed(1);
  const text = svgEsc(labelText(label));
  const parts = [];
  if (label.border) {
    parts.push(
      `<rect x="${rect.x.toFixed(1)}" y="${rect.y.toFixed(1)}" width="${rect.w.toFixed(1)}" height="${rect.h.toFixed(
        1
      )}" rx="4" fill="#FFFFFF" stroke="${svgEsc(label.border)}" stroke-width="1.5"/>`
    );
  }
  parts.push(
    `<text x="${cx}" y="${mainCy}" text-anchor="middle" dominant-baseline="middle" font-size="${LABEL_FONT}" font-weight="600" fill="${svgEsc(
      label.color
    )}"${label.border ? '' : ` paint-order="stroke" stroke="${svgEsc(background)}" stroke-width="3"`}>${text}</text>`
  );
  return parts.join('\n');
}
