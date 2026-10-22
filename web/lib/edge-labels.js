/**
 * 连线标签：浏览器侧的胶水层（测量 / 命中 / 绘制 / 落库）
 *
 * 依赖方向刻意保持单向：
 *   render.js → edge-labels.js → state.js / api.js / core/labels.js
 * 所以这里不 import draw()，需要重绘由调用方负责，避免和 render 形成环。
 *
 * 标签存在连线标注里（overlay.edges[edgeKey].label），
 * 因此连线被删 / 被过滤掉时标签自然一起消失，不需要单独清理。
 */
import { els, state, edgeKey, FONT } from './state.js';
import { api } from './api.js';
import {
  LABEL_FONT,
  LABEL_MAX_DIST,
  LABEL_PRESETS,
  CONN_PREFIX,
  labelText,
  labelSize,
  normalizeLabel,
  placeLabel,
  clampLabelCenter,
  midAnchor,
  nextConnNumber,
} from '/core/labels.js';

const FONT_SPEC = `600 ${LABEL_FONT}px ${FONT}`;

/** 文字宽度：用画布测量，和真正绘制时的字体保持一致 */
function measure(text) {
  const ctx = els.ctx;
  ctx.save();
  ctx.font = FONT_SPEC;
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
  return labelSize(labelText(label), measure);
}

/** 连线的「线中央」锚点（拖动时把指针位移换算成相对锚点的偏移） */
export function labelAnchor(edge) {
  return midAnchor(edge?.points || []);
}

/**
 * 算出当前视图里所有标签的矩形，顺带写回 edge._lb 供命中测试复用。
 * 顺序遍历 + 已放置矩形参与避让，保证标签之间不叠在一起。
 */
export function labelLayout(view = state.view) {
  if (!view) return [];
  const placed = [];
  const out = [];
  for (const e of view.edges) {
    e._lb = null;
    if (!e.label) continue;
    const label = normalizeLabel(e.label);
    if (!label) continue;
    const size = labelSizeOf(label);
    const rect = placeLabel({
      label,
      size,
      pts: e.points || [],
      nodes: view.nodes,
      others: placed,
      maxDist: LABEL_MAX_DIST,
    });
    if (!rect) continue;
    e._lb = rect;
    placed.push(rect);
    out.push({ edge: e, label, rect });
  }
  return out;
}

/** 命中最上层标签（标签画在节点之上，所以倒序找） */
export function hitLabel(p, view = state.view) {
  if (!view) return null;
  const need = view.edges.some((e) => e.label && !e._lb);
  if (need) labelLayout(view);
  for (let i = view.edges.length - 1; i >= 0; i--) {
    const e = view.edges[i];
    const r = e._lb;
    if (!r) continue;
    if (p.x >= r.x - 2 && p.x <= r.x + r.w + 2 && p.y >= r.y - 2 && p.y <= r.y + r.h + 2) {
      return { edge: e, rect: r };
    }
  }
  return null;
}

/** 画布上绘制全部标签（由 render.js 在节点之后调用，保证标签在最上层） */
export function drawEdgeLabels(ctx, view = state.view) {
  const items = labelLayout(view);
  if (!items.length) return;
  for (const { edge, label, rect } of items) {
    const selected = state.selectedLabel === edgeKey(edge);
    ctx.save();
    ctx.font = FONT_SPEC;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;

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
      ctx.strokeStyle = 'rgba(247, 246, 242, 0.95)';
      ctx.strokeText(labelText(label), cx, cy + 0.5);
    }

    ctx.fillStyle = label.color || '#2C2C2A';
    ctx.fillText(labelText(label), cx, cy + 0.5);

    if (selected) {
      roundRectPath(ctx, rect.x - 2.5, rect.y - 2.5, rect.w + 5, rect.h + 5, 6);
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = '#185FA5';
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** 按预设造一条新标签；结合点的编号取当前画面里最小未占用值 */
export function makeLabel(preset, edge) {
  if (preset === 'conn') {
    const used = (state.view?.edges || [])
      .filter((e) => e !== edge && e.label)
      .map((e) => normalizeLabel(e.label))
      .filter(Boolean);
    return normalizeLabel({
      preset: 'conn',
      num: nextConnNumber(used),
      border: LABEL_PRESETS.conn.border,
      color: LABEL_PRESETS.conn.color,
    });
  }
  if (preset === 'call') {
    return normalizeLabel({
      preset: 'call',
      text: LABEL_PRESETS.call.text,
      border: null,
      color: LABEL_PRESETS.call.color,
    });
  }
  return normalizeLabel({
    preset: 'task',
    text: LABEL_PRESETS.task.text,
    border: LABEL_PRESETS.task.border,
    color: LABEL_PRESETS.task.color,
  });
}

/** 换预设：保留手动位置；结合点重新分配编号（原来的编号不重复用） */
export function switchPreset(edge, preset) {
  const prev = normalizeLabel(edge.label) || {};
  const next = makeLabel(preset, edge);
  if (!next) return null;
  next.dx = prev.dx || 0;
  next.dy = prev.dy || 0;
  // 同类型切换（比如只是改颜色后再点回来）保留用户填的文字
  if (preset === 'task' && prev.preset === 'task' && prev.text) next.text = prev.text;
  if (preset === 'conn' && prev.preset === 'conn' && prev.num) {
    next.num = prev.num;
    next.text = CONN_PREFIX + prev.num;
  }
  return next;
}

/**
 * 立即把标签挂到连线上（规整后写回 edge.label），不发请求。
 * 面板 / 拖动先调它 + draw()，再调 persistLabel()，避免等一次往返才看到效果。
 */
export function applyLabel(edge, label) {
  const clean = label ? normalizeLabel(label) : null;
  edge.label = clean;
  edge._lb = null;
  return clean;
}

/** 落库：label 为 null 时服务端会删掉这个键 */
export async function persistLabel(edge) {
  await api.overlay({ edgeKey: edgeKey(edge), data: { label: edge.label || null } });
  return edge.label || null;
}

/** 一步到位：先生效再落库 */
export async function saveLabel(edge, label = edge.label) {
  applyLabel(edge, label);
  return persistLabel(edge);
}

/**
 * 拖动标签：把目标中心点夹在「线附近 + 不压节点」的合法范围里。
 * 返回是否真的移动了（放不下就不动，宁可跟手差一点也不要叠在函数框上）。
 */
export function dragLabelTo(edge, center) {
  const label = normalizeLabel(edge.label);
  if (!label) return false;
  const anchor = labelAnchor(edge);
  if (!anchor) return false;
  const view = state.view;
  const others = [];
  for (const e of view.edges) {
    if (e !== edge && e._lb) others.push(e._lb);
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
  edge.label = label;
  edge._lb = null;
  return true;
}
