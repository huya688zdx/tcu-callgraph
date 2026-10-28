/**
 * 连线标签：浏览器侧的胶水层（测量 / 命中 / 绘制 / 落库）
 *
 * 依赖方向刻意保持单向：
 *   render.js → edge-labels.js → state.js / api.js / core/labels.js
 * 所以这里不 import draw()，需要重绘由调用方负责，避免和 render 形成环。
 *
 * 一条连线可以挂多条标签（overlay.edges[edgeKey].labels 数组，旧数据单条 label
 * 由服务端读出来时归成数组）。选中/拖动/删除都指名道姓地操作某一条（label.id），
 * state.selectedLabel 的编码是 `${edgeKey}#${id}`。
 * 连线被删 / 被过滤掉时标签自然一起消失，不需要单独清理。
 */
import { els, state, edgeKey, FONT, THEME, hexToRgba } from './state.js';
import { api } from './api.js';
import { t } from '../i18n.js';
import {
  LABEL_FONT,
  LABEL_NOTE_FONT,
  LABEL_PAD_Y,
  LABEL_MAX_DIST,
  LABEL_PRESETS,
  CONN_PREFIX,
  labelText,
  normalizeLabel,
  normalizeLabels,
  labelBoxSize,
  placeEdgeLabels,
  clampLabelCenter,
  midAnchor,
  nextConnNumber,
  freeConnNumbers,
} from '/core/labels.js';

const FONT_SPEC = (size) => `600 ${size}px ${FONT}`;
const NOTE_SPEC = `400 ${LABEL_NOTE_FONT}px ${FONT}`;

/** 文字宽度：用画布测量，和真正绘制时的字体保持一致 */
function measure(text, font = LABEL_FONT) {
  const ctx = els.ctx;
  ctx.save();
  ctx.font = FONT_SPEC(font);
  const w = ctx.measureText(String(text || '')).width;
  ctx.restore();
  return w;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function labelSizeOf(label) {
  return labelBoxSize(label, measure);
}

/** 连线的「线中央」锚点（拖动时把指针位移换算成相对锚点的偏移） */
export function labelAnchor(edge) {
  return midAnchor(edge?.points || []);
}

/** 这条线当前的整组标签（视图数据里服务端已归一，这里再兜一层） */
export function edgeLabels(edge) {
  if (!edge) return [];
  if (!edge.labels) edge.labels = normalizeLabels(edge.label);
  else if (!Array.isArray(edge.labels)) edge.labels = normalizeLabels(edge.labels);
  return edge.labels;
}

/**
 * 算出当前视图里所有标签的矩形，写回 edge._lbs 供命中测试复用。
 * 同一条线的多条标签由 placeEdgeLabels 交替放线的两侧并互相避让；
 * 不同线之间先放的矩形参与后者的避让。
 */
export function labelLayout(view = state.view) {
  if (!view) return [];
  const placed = [];
  const out = [];
  for (const e of view.edges) {
    e._lbs = null;
    const labels = edgeLabels(e);
    if (!labels.length) continue;
    const items = labels.map((label) => ({ label, size: labelSizeOf(label) }));
    const rects = placeEdgeLabels({
      items,
      pts: e.points || [],
      nodes: view.nodes,
      others: placed,
      otherPaths: view.edges.filter((other) => other !== e).map((other) => other.points || []),
      maxDist: LABEL_MAX_DIST,
    });
    const own = [];
    labels.forEach((label, i) => {
      if (!rects[i]) return;
      e._lbs = own;
      own.push({ id: label.id, rect: rects[i] });
      placed.push(rects[i]);
      out.push({ edge: e, label, rect: rects[i] });
    });
    if (!own.length) e._lbs = null;
  }
  return out;
}

/** 命中最上层的标签（标签画在节点之上，所以倒序找）；返回具体命中了哪一条 */
export function hitLabel(p, view = state.view) {
  if (!view) return null;
  if (view.edges.some((e) => e.labels?.length && !e._lbs)) labelLayout(view);
  for (let i = view.edges.length - 1; i >= 0; i--) {
    const e = view.edges[i];
    if (!e._lbs) continue;
    for (let j = e._lbs.length - 1; j >= 0; j--) {
      const { id, rect: r } = e._lbs[j];
      if (p.x >= r.x - 2 && p.x <= r.x + r.w + 2 && p.y >= r.y - 2 && p.y <= r.y + r.h + 2) {
        const label = edgeLabels(e).find((l) => l.id === id) || null;
        return label ? { edge: e, label, rect: r } : null;
      }
    }
  }
  return null;
}

/** 画布上绘制全部标签（由 render.js 在节点之后调用，保证标签在最上层） */
export function drawEdgeLabels(ctx, view = state.view, onAnimatedBox = null, focusedEdges = null) {
  const items = labelLayout(view);
  if (!items.length) return;
  for (const { edge, label, rect } of items) {
    const key = `${edgeKey(edge)}#${label.id}`;
    const selected = state.multiSelection?.labels ? state.multiSelection.labels.has(key) : state.selectedLabel === key;
    ctx.save();
    if (focusedEdges?.size && !focusedEdges.has(edge)) ctx.globalAlpha = 0.22;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = rect.x + rect.w / 2;
    const mainCy = label.note
      ? rect.y + 4 + LABEL_FONT / 2
      : rect.y + rect.h / 2;

    if (label.border) {
      roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 4);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.97)';
      ctx.fill();
      ctx.strokeStyle = label.border;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      // 无边框预设：只给文字垫一圈画布底色，保证压在线条上也看得清，但不画框
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = hexToRgba(THEME.bg, 0.95);
      ctx.font = FONT_SPEC(LABEL_FONT);
      ctx.strokeText(labelText(label), cx, mainCy + 0.5);
    }

    ctx.font = FONT_SPEC(LABEL_FONT);
    ctx.fillStyle = label.color || '#2C2C2A';
    ctx.fillText(labelText(label), cx, mainCy + 0.5);
    if (label.note) {
      ctx.font = NOTE_SPEC;
      ctx.fillStyle = '#6B6963';
      // 说明行中心：主行（PAD+FONT/2）之下，与 labelBoxSize 的两行布局一致
      ctx.fillText(label.note, cx, rect.y + LABEL_PAD_Y * 2 + LABEL_FONT + LABEL_NOTE_FONT / 2);
    }

    if (selected) {
      const box = { x: rect.x - 2.5, y: rect.y - 2.5, w: rect.w + 5, h: rect.h + 5 };
      if (onAnimatedBox && state.multiSelection?.kind === 'label') {
        onAnimatedBox(box, [4, 3], 1.4, 6, '#185FA5');
      } else {
        roundRectPath(ctx, box.x, box.y, box.w, box.h, 6);
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = '#185FA5';
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

/** 给新标签分配一个组内不冲突的 id */
function freshId(labels) {
  const used = new Set(labels.map((l) => l.id).filter(Boolean));
  let n = labels.length;
  let id = 'a' + n;
  while (used.has(id)) id = 'a' + ++n;
  return id;
}

/**
 * 按预设造一条新标签。
 * 结合点编号：给了 num 用 num（固定排序模式下面板让用户挑），
 * 没给则取当前画面最小未占用值（重排模式 / AI 自动路径）。
 */
export function makeLabel(preset, edge, { num } = {}) {
  const labels = edgeLabels(edge);
  const id = freshId(labels);
  if (preset === 'conn') {
    const used = (state.view?.edges || []).flatMap((e) => edgeLabels(e));
    const n = Number.isFinite(Number(num)) && Number(num) > 0
      ? Math.trunc(Number(num))
      : nextConnNumber(used.filter((l) => l !== null));
    return normalizeLabel({
      id,
      preset: 'conn',
      num: n,
      border: LABEL_PRESETS.conn.border,
      color: LABEL_PRESETS.conn.color,
    });
  }
  if (preset === 'call') {
    return normalizeLabel({
      id,
      preset: 'call',
      text: LABEL_PRESETS.call.text,
      border: null,
      color: LABEL_PRESETS.call.color,
    });
  }
  return normalizeLabel({
    id,
    preset: 'task',
    text: LABEL_PRESETS.task.text,
    border: LABEL_PRESETS.task.border,
    color: LABEL_PRESETS.task.color,
  });
}

/** 固定排序模式下新增结合点可选的编号：空缺号 + 下一个号 */
export function connChoices(view = state.view, edge = null) {
  const used = (view?.edges || [])
    .filter((e) => e !== edge)
    .flatMap((e) => edgeLabels(e))
    .filter(Boolean);
  return freeConnNumbers(used, 6);
}

/** 换预设：保留手动位置与说明；结合点重新分配编号（原编号不重复用） */
export function switchPreset(label, preset, edge) {
  if (!label) return null;
  const next = makeLabel(preset, edge);
  if (!next) return null;
  next.id = label.id; // 就地换型：id 不变，选中状态与面板定位都不丢
  next.dx = label.dx || 0;
  next.dy = label.dy || 0;
  if (label.note) next.note = label.note;
  // 同预设来回切保留用户填的文字
  if (preset === 'task' && label.preset === 'task' && label.text) next.text = label.text;
  if (preset === 'call' && label.preset === 'call' && label.text) next.text = label.text;
  if (preset === 'conn' && label.preset === 'conn' && label.num) {
    next.num = label.num;
    next.text = CONN_PREFIX + label.num;
  }
  return next;
}

/**
 * 立即把整组标签挂到连线上（规整后写回 edge.labels），不发请求。
 * 面板 / 拖动先调它 + draw()，再调 persistLabels()，避免等一次往返才看到效果。
 */
export function applyLabels(edge, labels) {
  edge.labels = normalizeLabels(labels);
  edge.label = edge.labels[0] || null;
  edge._lbs = null;
  return edge.labels;
}

/** 落库：labels 为 null / 空组时服务端会删掉这个键（整组清除） */
export async function persistLabels(edge, projectId = state.view?.projectId) {
  if (!projectId) throw new Error('工程已切换，请刷新后重试');
  const result = await api.overlay({ edgeKey: edgeKey(edge), data: { labels: edge.labels || null }, projectId });
  if (!result?.ok) throw new Error(result?.error === 'review-mode' ? t('timeline.blocked') : result?.error || '保存标签失败');
  return edge.labels || null;
}

/** 一步到位：先生效再落库 */
export async function saveLabels(edge, labels = edge.labels) {
  applyLabels(edge, labels);
  return persistLabels(edge);
}

/** 当前画面里全部结合点（重排与编号选择都要用） */
export function connEntries(view = state.view) {
  const out = [];
  for (const e of view?.edges || []) {
    for (const l of edgeLabels(e)) {
      if (l.preset === 'conn') out.push({ key: edgeKey(e), edge: e, id: l.id, num: l.num });
    }
  }
  return out;
}

/**
 * 删除一个结合点后按当前模式收尾：
 * renumber → 剩余结合点升序紧凑成 1..n（返回重排差异项，由调用方提交 /api/labels/renumber）
 * fixed → 什么都不动（编号保留，空位留给以后手动挑）
 */
export async function afterConnDelete(view = state.view) {
  const cfg = await api.labelConfig().catch(() => ({ mode: 'fixed' }));
  if (cfg.mode !== 'renumber') return [];
  const entries = connEntries(view)
    .map(({ key, id, num }) => ({ key, id, num }))
    .sort((a, b) => a.num - b.num);
  const changes = entries
    .map((x, i) => (x.num !== i + 1 ? { key: x.key, id: x.id, num: i + 1 } : null))
    .filter(Boolean);
  return changes;
}

/**
 * 拖动标签：把目标中心点夹在「线附近 + 不压节点」的合法范围里。
 * 返回是否真的移动了（放不下就不动，宁可跟手差一点也不要叠在函数框上）。
 */
export function dragLabelTo(edge, label, center) {
  if (!label) return false;
  const anchor = labelAnchor(edge);
  if (!anchor) return false;
  const view = state.view;
  const others = [];
  for (const e of view.edges) {
    if (e === edge || !e._lbs) continue;
    for (const { rect } of e._lbs) others.push(rect);
  }
  for (const { id, rect } of edge._lbs || []) {
    if (id !== label.id) others.push(rect);
  }
  const c = clampLabelCenter(center, {
    size: labelSizeOf(label),
    pts: edge.points || [],
    nodes: view.nodes,
    others,
    maxDist: LABEL_MAX_DIST,
  });
  if (!c) return false;
  label.dx = Math.round(c.x - anchor.x);
  label.dy = Math.round(c.y - anchor.y);
  edge._lbs = null;
  return true;
}
