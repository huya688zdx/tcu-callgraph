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
 * 三个预设：
 * - task: 黑框白底黑字（任务耗时等，文字自己填）
 * - conn: 红框白底红字（結合点，编号自动递增且同一画面内不重复）
 * - call: 无框黑字（コール順）
 */
export const LABEL_PRESETS = {
  task: { border: '#2C2C2A', color: '#2C2C2A', text: 'TASK:2ms' },
  conn: { border: '#C0392B', color: '#C0392B' },
  call: { border: null, color: '#2C2C2A', text: 'コール順' },
};

const HEX = /^#[0-9a-f]{6}$/i;
const PRESETS = new Set(['task', 'conn', 'call', 'custom']);

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
  // 说明行：控制字符拍平、限长，任何预设都可以带（结合点挂解释说明是主场景）
  const note =
    typeof raw.note === 'string' && raw.note.trim()
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
 * 带说明行的标签盒子：主行 LABEL_FONT，说明行 LABEL_NOTE_FONT，
 * note 由调用方注入宽度测量（measure(text, font)），没有时退回主行尺寸。
 */
export function labelBoxSize(label, measure) {
  const main = labelSize(labelText(label), (t) => measure(t, LABEL_FONT));
  if (!label || !label.note) return main;
  const nw = measure(label.note, LABEL_NOTE_FONT);
  return {
    w: Math.max(main.w, nw + LABEL_PAD_X * 2),
    h: main.h + LABEL_NOTE_FONT + LABEL_PAD_Y,
  };
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

/**
 * 给标签找位置：优先「线中央 + 用户偏移」，压住节点/别的标签时沿法线与切线逐圈外扩。
 * 返回左上角矩形；全部候选都不干净时退化为重叠最少的那一个（有总比没有强）。
 */
export function placeLabel({ label, size, pts = [], nodes = [], others = [], maxDist = LABEL_MAX_DIST } = {}) {
  const anchor = midAnchor(pts);
  if (!anchor || !size) return null;
  const dx = label?.dx || 0;
  const dy = label?.dy || 0;
  const base = { x: anchor.x + dx, y: anchor.y + dy };
  // 偏移可能是按旧几何存的（节点挪过 / 连线重布过）：先拉回线附近再找位置
  const nearBase = nearestOnPolyline(base, pts);
  let origin = base;
  if (nearBase.d > maxDist) {
    const len = nearBase.d || 1;
    origin = {
      x: nearBase.x + ((base.x - nearBase.x) / len) * maxDist,
      y: nearBase.y + ((base.y - nearBase.y) / len) * maxDist,
    };
  }
  const nx = -anchor.uy;
  const ny = anchor.ux;
  const stepV = size.h + 8;
  const stepU = size.w / 2 + 10;

  const cands = [origin];
  for (let i = 1; i <= 3; i++) {
    cands.push({ x: origin.x + nx * stepV * i, y: origin.y + ny * stepV * i });
    cands.push({ x: origin.x - nx * stepV * i, y: origin.y - ny * stepV * i });
  }
  for (let j = 1; j <= 3; j++) {
    for (const k of [-1, 1]) {
      const ux = anchor.ux * stepU * j * k;
      const uy = anchor.uy * stepU * j * k;
      cands.push({ x: origin.x + ux, y: origin.y + uy });
      cands.push({ x: origin.x + ux + nx * stepV, y: origin.y + uy + ny * stepV });
      cands.push({ x: origin.x + ux - nx * stepV, y: origin.y + uy - ny * stepV });
    }
  }

  let best = null;
  let bestScore = Infinity;
  for (const c of cands) {
    const rect = rectAt(c.x, c.y, size);
    const d = distToPolyline(c, pts);
    if (d > maxDist) continue;
    const hitNodes = overlapCount(rect, nodes, 4);
    const hitLabels = overlapCount(rect, others, 3);
    if (!hitNodes && !hitLabels) return rect;
    // 压住函数框比压住别的标签更糟：权重差一个量级
    const score =
      hitNodes * 1000 + hitLabels * 100 + d + Math.hypot(c.x - origin.x, c.y - origin.y) * 0.05;
    if (score < bestScore) {
      bestScore = score;
      best = rect;
    }
  }
  return best || rectAt(origin.x, origin.y, size);
}

/**
 * 一条连线的成组摆放：多条标签默认交替放线的两侧（第 1 条上侧、第 2 条下侧……），
 * 手动拖过的（dx/dy 非零）保持用户位置。逐条避让，先放的矩形参与后者的避让。
 * items = [{label, size}]；返回同序矩形数组（null = 这条放不下）。
 */
export function placeEdgeLabels({ items = [], pts = [], nodes = [], maxDist = LABEL_MAX_DIST } = {}) {
  const anchor = midAnchor(pts);
  if (!anchor) return items.map(() => null);
  const nx = -anchor.uy;
  const ny = anchor.ux;
  const placed = [];
  const out = [];
  items.forEach(({ label, size }, i) => {
    if (!label || !size) {
      out.push(null);
      return;
    }
    const manual = (label.dx || 0) !== 0 || (label.dy || 0) !== 0;
    let probe = label;
    if (!manual) {
      // 两侧交替：沿法线偏出半个标签高 + 间隙，默认不压在线上
      const side = i % 2 === 0 ? -1 : 1;
      const off = Math.round((size.h / 2 + 5) * side);
      probe = { ...label, dx: Math.round(nx * off), dy: Math.round(ny * off) };
    }
    const rect = placeLabel({ label: probe, size, pts, nodes, others: placed, maxDist });
    out.push(rect);
    if (rect) placed.push(rect);
  });
  return out;
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
  const near = nearestOnPolyline(center, pts);
  let c = { x: center.x, y: center.y };
  if (near.d > maxDist) {
    const len = near.d || 1;
    c = {
      x: near.x + ((center.x - near.x) / len) * maxDist,
      y: near.y + ((center.y - near.y) / len) * maxDist,
    };
  }
  const rect = rectAt(c.x, c.y, size);
  if (overlapCount(rect, nodes, 4) || overlapCount(rect, others, 3)) return null;
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

/** 一个标签的 SVG 片段（服务端导出用；颜色已在 normalizeLabel 里限定为 #RRGGBB） */
export function labelSvg(label, rect) {
  const cx = (rect.x + rect.w / 2).toFixed(1);
  // 有说明行时主行上移，说明行垫在下面（尺寸由 labelBoxSize 算好，这里只管对位）
  const mainCy = (label.note
    ? rect.y + LABEL_PAD_Y + LABEL_FONT / 2
    : rect.y + rect.h / 2 + 0.5
  ).toFixed(1);
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
    )}"${label.border ? '' : ' paint-order="stroke" stroke="#F7F6F2" stroke-width="3"'}>${text}</text>`
  );
  if (label.note) {
    const noteCy = (rect.y + LABEL_PAD_Y * 2 + LABEL_FONT + LABEL_NOTE_FONT / 2).toFixed(1);
    parts.push(
      `<text x="${cx}" y="${noteCy}" text-anchor="middle" dominant-baseline="middle" font-size="${LABEL_NOTE_FONT}" fill="#6B6963">${svgEsc(
        label.note
      )}</text>`
    );
  }
  return parts.join('\n');
}
