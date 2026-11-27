/**
 * 画布绘制：容器 / 文件框 / 连线 / 节点
 * 只读 state，不修改数据（updateGroups 例外：文件框跟随节点）
 */
import { t } from '../i18n.js';
import { els, state, cam, THEME, hexToRgba, FONT, shortFile, edgeKey } from './state.js';
import { isDataEdge, edgeDirection, EDGE_DASH, dashSegments } from './edge-flow.js';
import { canvasPeriodBadge, periodBadgeBox, periodContainerStyle, PERIOD_COLORS, periodSubtitle } from './period-text.js';
import { edgePoints } from './geometry.js';
import { midAnchor } from '/core/labels.js';
import { drawEdgeLabels } from './edge-labels.js';
import { flowPulseColor, mergeFlowStreams } from './flow-geometry.js';
import { CALLER_COLOR, CALLEE_COLOR, BIDIR_COLOR, mixHex, classifySelectionRelations } from './relation-focus.js';

// 选中动画使用独立画布，箭头和虚线移动时保留主画布上的文字、标签与连线。
let animationFrame = 0;
let lastEffectPaint = 0;
let recentTimer = 0;
let collectingEffects = false;
let effects = [];
let rawFlowStreams = [];
let effectCamera = null;
let panOrigin = null;
let effectDirty = null;
const EFFECT_FRAME_MS = 32; // 约 30fps，流动平滑且核显占用极低
const RECENT_HIGHLIGHT_MS = 2600;
const RECENT_RIPPLE_MS = 850;
const RECENT_COLOR = '#0284C7';
const SELECTED_EDGE_COLOR = '#0284C7';
const effectCanvas = document.createElement('canvas');
effectCanvas.id = 'cvEffects';
effectCanvas.setAttribute('aria-hidden', 'true');
Object.assign(effectCanvas.style, {
  position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none',
});
effectCanvas.width = effectCanvas.height = 0;
const effectCtx = effectCanvas.getContext('2d');
const nodeNames = new WeakMap();
const reducedMotionMedia = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null;
const prefersReducedMotion = () => !!reducedMotionMedia?.matches;
reducedMotionMedia?.addEventListener?.('change', () => {
  if (state.view) draw({ geometryUnchanged: true });
});

function markDirtyPixels(x0, y0, x1, y1) {
  const ix0 = Math.max(0, Math.floor(x0)), iy0 = Math.max(0, Math.floor(y0));
  const ix1 = Math.min(effectCanvas.width, Math.ceil(x1)), iy1 = Math.min(effectCanvas.height, Math.ceil(y1));
  if (ix1 <= ix0 || iy1 <= iy0) return;
  if (!effectDirty) {
    effectDirty = { x0: ix0, y0: iy0, x1: ix1, y1: iy1 };
  } else {
    if (ix0 < effectDirty.x0) effectDirty.x0 = ix0;
    if (iy0 < effectDirty.y0) effectDirty.y0 = iy0;
    if (ix1 > effectDirty.x1) effectDirty.x1 = ix1;
    if (iy1 > effectDirty.y1) effectDirty.y1 = iy1;
  }
}

function viewport(width, height) {
  const pad = 36;
  return { left: (-cam.x - pad) / cam.k, right: (width - cam.x + pad) / cam.k,
    top: (-cam.y - pad) / cam.k, bottom: (height - cam.y + pad) / cam.k };
}

function boxVisible(box, area, width = box.w) {
  return box.x <= area.right && box.x + width >= area.left &&
    box.y <= area.bottom && box.y + box.h >= area.top;
}

function drawAlignmentGuides(ctx, guides, dpr) {
  if (!guides?.length) return;
  const pixels = Math.max(1, Math.round(dpr));
  const extension = 12 / cam.k;
  ctx.save();
  ctx.strokeStyle = '#2563EB';
  ctx.lineWidth = pixels / (cam.k * dpr);
  ctx.setLineDash([4 / cam.k, 4 / cam.k]);
  for (const { axis, at, from, to } of guides) {
    const screen = (at * cam.k + cam[axis]) * dpr;
    const aligned = ((Math.round(screen - pixels / 2) + pixels / 2) / dpr - cam[axis]) / cam.k;
    ctx.beginPath();
    if (axis === 'x') {
      ctx.moveTo(aligned, from - extension);
      ctx.lineTo(aligned, to + extension);
    } else {
      ctx.moveTo(from - extension, aligned);
      ctx.lineTo(to + extension, aligned);
    }
    ctx.stroke();
  }
  ctx.restore();
}

const groupPaintWidth = (box) => Math.max(box.w, 26 * String(box.label).length + 30);

function panCanvas(dx, dy, contentBounds) {
  const { cv } = els;
  const view = state.view;
  // 只有全部对象已画在当前画布内才可平移位图。底部状态文字在松手时恢复。
  if (!panOrigin && contentBounds && view?.nodes.length) {
    const b = contentBounds();
    if (b.x * cam.k + cam.x >= 8 && b.y * cam.k + cam.y >= 8 &&
        (b.x + b.w) * cam.k + cam.x <= cv.clientWidth - 8 &&
        (b.y + b.h) * cam.k + cam.y <= cv.clientHeight - 24 &&
        [...(view.groups || []), ...(view.containers || [])].every((g) =>
          (g.x + groupPaintWidth(g)) * cam.k + cam.x <= cv.clientWidth - 8)) {
      panOrigin = { x: cam.x, y: cam.y };
      cv.style.clipPath = 'inset(0 0 22px)';
    }
  }
  cam.x += dx;
  cam.y += dy;
  if (panOrigin) {
    const shift = `${cam.x - panOrigin.x}px ${cam.y - panOrigin.y}px`;
    cv.style.translate = effectCanvas.style.translate = shift;
  } else draw({ geometryUnchanged: true });
}

function finishPan() {
  if (panOrigin) draw({ geometryUnchanged: true });
}

function pathVisible(points, area) {
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    if (Math.min(x1, x2) <= area.right && Math.max(x1, x2) >= area.left &&
        Math.min(y1, y2) <= area.bottom && Math.max(y1, y2) >= area.top) return true;
  }
  return false;
}

function screenRect(box, padding, camera = cam, dpr = window.devicePixelRatio || 1) {
  const { cv } = els, { x: cx, y: cy, k } = camera;
  const x = Math.max(0, Math.floor((box.x * k + cx - padding) * dpr));
  const y = Math.max(0, Math.floor((box.y * k + cy - padding) * dpr));
  const right = Math.min(cv.width, Math.ceil(((box.x + box.w) * k + cx + padding) * dpr));
  const bottom = Math.min(cv.height, Math.ceil(((box.y + box.h) * k + cy + padding) * dpr));
  return right > x && bottom > y ? { x, y, right, bottom } : null;
}

export function pulseAdded(nodes, edges, { highlightMs = RECENT_HIGHLIGHT_MS, rippleMs = RECENT_RIPPLE_MS } = {}) {
  clearTimeout(recentTimer);
  const count = nodes.length + edges.length;
  const now = performance.now();
  const recent = count ? {
    nodes: new Set(nodes.map((n) => n.id)), edges: new Set(edges.map(edgeKey)),
    started: now, until: now + highlightMs, rippleUntil: now + rippleMs, rippleDur: rippleMs,
  } : null;
  state.recent = recent;
  if (recent) recentTimer = setTimeout(() => {
    if (state.recent !== recent) return;
    state.recent = null;
    if (!document.hidden) draw({ geometryUnchanged: true });
  }, highlightMs);
  draw();
}
function scheduleDraw() {
  if (animationFrame || document.hidden || (!effects.length && !state.flash)) return;
  animationFrame = requestAnimationFrame((now) => {
    animationFrame = 0;
    if (now - lastEffectPaint >= EFFECT_FRAME_MS) {
      drawEffects(now);
    }
    scheduleDraw();
  });
}

function recordBoxEffect(box, dash, width, radius = 8, color = THEME.node.selected) {
  if (screenRect(box, width * cam.k / 2 + 4)) effects.push({ kind: 'box', box, dash, width, radius, color });
}

function markEffectArea(box, padding) {
  const rect = screenRect(box, padding, effectCamera, effectCamera.dpr);
  if (rect) markDirtyPixels(rect.x, rect.y, rect.right, rect.bottom);
}

function markEffectOutline({ x, y, w, h }, radius, padding) {
  const r = Math.min(radius, w / 2, h / 2);
  markEffectArea({ x, y, w, h: r }, padding);
  markEffectArea({ x, y: y + h - r, w, h: r }, padding);
  markEffectArea({ x, y: y + r, w: 0, h: h - 2 * r }, padding);
  markEffectArea({ x: x + w, y: y + r, w: 0, h: h - 2 * r }, padding);
}

function releaseEffectCanvas() {
  if (!effectCanvas.width) return;
  effectCanvas.remove();
  effectCanvas.width = effectCanvas.height = 0;
  effectDirty = null;
}

function compositeEffects(ctx) {
  if (effectCanvas.width) ctx.drawImage(effectCanvas, 0, 0);
}

function drawEffects(now) {
  lastEffectPaint = now;
  if (state.flash && now >= state.flash.until) state.flash = null;
  if (now >= (state.recent?.rippleUntil ?? 0) && effects.some((effect) => effect.kind === 'ripple')) {
    effects = effects.filter((effect) => effect.kind !== 'ripple');
  }
  const hasActiveFlow = Boolean(state.pairFlow || state.aiOverlay?.action === 'play_flow');
  if (prefersReducedMotion() && !hasActiveFlow && effects.some((effect) => effect.kind === 'stream')) {
    effects = effects.filter((effect) => effect.kind !== 'stream');
  }
  if (!effects.length && !state.flash) { releaseEffectCanvas(); return; }
  const { cv } = els;
  if (effectCanvas.width !== cv.width || effectCanvas.height !== cv.height) {
    effectCanvas.width = cv.width;
    effectCanvas.height = cv.height;
    effectDirty = null;
  }
  if (!effectCanvas.isConnected) cv.after(effectCanvas);
  const ctx = effectCtx, c = effectCamera;
  // 每帧仅调用一次 clearRect 擦除上一帧的合并脏矩形，避免数百次 GPU clear 调用。
  if (effectDirty) {
    ctx.clearRect(effectDirty.x0, effectDirty.y0, effectDirty.x1 - effectDirty.x0, effectDirty.y1 - effectDirty.y0);
    effectDirty = null;
  }
  const W = cv.width / c.dpr, H = cv.height / c.dpr;
  ctx.save();
  ctx.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
  ctx.translate(c.x, c.y);
  ctx.scale(c.k, c.k);
  const flash = state.flash;
  if (flash) {
    const box = { x: flash.box.x - 2, y: flash.box.y - 2, w: flash.box.w + 4, h: flash.box.h + 4 };
    markEffectOutline(box, 16, 4);
    roundRect(ctx, box.x, box.y, box.w, box.h, 16);
    ctx.strokeStyle = hexToRgba(THEME.node.selected, 0.9 * Math.min(1, (flash.until - now) / flash.dur));
    ctx.lineWidth = 3 / c.k;
    ctx.stroke();
  }
  const streams = [];
  for (const effect of effects) {
    if (effect.kind === 'stream') {
      streams.push(effect);
      continue;
    }
    ctx.save();
    if (effect.kind === 'ripple') {
      const p = Math.min(1, Math.max(0, (now - effect.started) / effect.dur));
      const gap = (2 + p * 11) / c.k;
      const { x, y, w, h } = effect.box;
      const box = { x: x - gap, y: y - gap, w: w + gap * 2, h: h + gap * 2 };
      markEffectOutline(box, 10, 3);
      roundRect(ctx, box.x, box.y, box.w, box.h, 10);
      ctx.strokeStyle = hexToRgba(effect.color, (1 - p) * 0.75);
      ctx.lineWidth = 2 / c.k;
      ctx.stroke();
    } else if (effect.kind === 'box') {
      const b = effect.box;
      markEffectOutline(b, effect.radius, effect.width * c.k / 2 + 2);
      roundRect(ctx, b.x, b.y, b.w, b.h, effect.radius);
      ctx.strokeStyle = effect.color;
      ctx.lineWidth = effect.width;
      ctx.setLineDash(effect.dash);
      ctx.lineDashOffset = -now * 0.024 / c.k;
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();

  // 屏幕像素空间批量绘制线上数据流脉冲：
  // 1. 脉冲严格居中贴合在线上（仅双向读写边微偏 2.5px 分道）；
  // 2. 间距按屏幕像素固定（88px），缩小时屏幕线段变短，粒子数自动减少，绝不越缩越密；
  // 3. 同一颜色合并为单次 Path2D 批处理绘制，无逐粒子 save/rotate/scale，核显零压力。
  if (streams.length) {
    ctx.save();
    ctx.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
    const spacingPx = 88;
    const speedPx = 68;
    const travelPx = (now * 0.001 * speedPx) % spacingPx;
    let totalPulses = 0;
    const MAX_PULSES = hasActiveFlow ? 128 : 56;
    const minLenPx = hasActiveFlow ? 12 : 20;
    for (const stream of streams) {
      if (totalPulses >= MAX_PULSES) break;
      const tailPath = new Path2D();
      const orbPath = new Path2D();
      const headPath = new Path2D();
      let count = 0;
      for (const seg of stream.segments) {
        if (totalPulses >= MAX_PULSES) break;
        const lenPx = seg.size * c.k;
        if (lenPx < minLenPx) continue;
        const nOff = seg.offset || 0;
        const sx0 = seg.x * c.k + c.x - seg.dy * nOff;
        const sy0 = seg.y * c.k + c.y + seg.dx * nOff;
        const sx1 = sx0 + seg.dx * lenPx;
        const sy1 = sy0 + seg.dy * lenPx;
        if (Math.max(sx0, sx1) < -16 || Math.min(sx0, sx1) > W + 16 ||
            Math.max(sy0, sy1) < -16 || Math.min(sy0, sy1) > H + 16) continue;
        const phasePx = ((seg.phase * c.k) % spacingPx + spacingPx) % spacingPx;
        let dPx = (travelPx - phasePx + spacingPx) % spacingPx;
        const edgePad = Math.min(8, lenPx * 0.25);
        if (dPx < edgePad) dPx += spacingPx;
        for (; dPx <= lenPx - edgePad && totalPulses < MAX_PULSES; dPx += spacingPx) {
          const hx = sx0 + seg.dx * dPx;
          const hy = sy0 + seg.dy * dPx;
          if (hx < -12 || hx > W + 12 || hy < -12 || hy > H + 12) continue;
          const tailLen = Math.min(18, dPx - 4);
          if (tailLen > 3) {
            tailPath.moveTo(hx - seg.dx * tailLen, hy - seg.dy * tailLen);
            tailPath.lineTo(hx - seg.dx * 1.5, hy - seg.dy * 1.5);
          }
          orbPath.moveTo(hx + 5.6, hy);
          orbPath.arc(hx, hy, 5.6, 0, Math.PI * 2);
          // 紧贴连线中心的流线型箭头
          headPath.moveTo(hx + seg.dx * 5.2, hy + seg.dy * 5.2);
          headPath.lineTo(hx - seg.dx * 3.6 + seg.dy * 3.4, hy - seg.dy * 3.6 - seg.dx * 3.4);
          headPath.lineTo(hx - seg.dx * 1.3, hy - seg.dy * 1.3);
          headPath.lineTo(hx - seg.dx * 3.6 - seg.dy * 3.4, hy - seg.dy * 3.6 + seg.dx * 3.4);
          headPath.closePath();
          const pad = (tailLen + 12) * c.dpr;
          markDirtyPixels(hx * c.dpr - pad, hy * c.dpr - pad, hx * c.dpr + pad, hy * c.dpr + pad);
          count++;
          totalPulses++;
        }
      }
      if (count) {
        ctx.fillStyle = hexToRgba(stream.color, 0.26);
        ctx.fill(orbPath);
        ctx.strokeStyle = hexToRgba(stream.color, 0.20);
        ctx.lineWidth = 6.5;
        ctx.lineCap = 'round';
        ctx.stroke(tailPath);
        ctx.strokeStyle = stream.tailColor;
        ctx.lineWidth = 2.6;
        ctx.lineCap = 'round';
        ctx.stroke(tailPath);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.lineWidth = 2.2;
        ctx.lineJoin = 'round';
        ctx.stroke(headPath);
        ctx.fillStyle = stream.color;
        ctx.fill(headPath);
      }
    }
    ctx.restore();
  }
}

function syncCanvasSize() {
  const { cv } = els;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (cv.width === w && cv.height === h) return false;
  cv.width = w;
  cv.height = h;
  return true;
}

function resize() {
  syncCanvasSize();
  draw();
}

// 工具栏内容换行也会改变画布高度，窗口尺寸可能保持不变。
new ResizeObserver(() => { if (syncCanvasSize()) draw(); }).observe(els.cv);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    releaseEffectCanvas();
  } else if (state.view) draw({ geometryUnchanged: true });
});

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 文件框跟随节点：节点拖出框外时框自动扩大 */
function updateGroups() {
  const v = state.view;
  if (!v || !v.groups) return;
  const byGroup = new Map();
  for (const n of v.nodes) {
    if (!n.group) continue;
    if (!byGroup.has(n.group)) byGroup.set(n.group, []);
    byGroup.get(n.group).push(n);
  }
  for (const g of v.groups) {
    const list = byGroup.get(g.id);
    if (!list || !list.length) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of list) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.w > maxX) maxX = n.x + n.w;
      if (n.y + n.h > maxY) maxY = n.y + n.h;
    }
    g.x = minX - 14;
    g.y = minY - 34;
    g.w = maxX - minX + 28;
    g.h = maxY - minY + 48;
  }
}

/** 选中节点的邻接集合：每次 draw 算一遍，避免 drawNode 里对每个节点扫全表边（O(N×E) → O(N+E)） */
function neighborSet() {
  const v = state.view;
  const sel = state.selected;
  if (!v || !sel) return null;
  const set = new Set([sel]);
  for (const e of v.edges) {
    if (e.from === sel) set.add(e.to);
    else if (e.to === sel) set.add(e.from);
  }
  return set;
}

function draw({ geometryUnchanged = false } = {}) {
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  effects = [];
  rawFlowStreams = [];
  collectingEffects = false;
  const { ctx, cv } = els;
  if (panOrigin) {
    panOrigin = null;
    cv.style.clipPath = '';
    cv.style.translate = effectCanvas.style.translate = '';
  }
  if (!cv.width || !cv.height) { releaseEffectCanvas(); return; }
  const dpr = window.devicePixelRatio || 1;
  const W = cv.width / dpr;
  const H = cv.height / dpr;
  const now = performance.now();
  if (state.recent && now >= state.recent.until) state.recent = null;
  if (state.flash && now >= state.flash.until) state.flash = null;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const v = state.view;
  if (!geometryUnchanged) state.pairFlow?.refresh?.(v);
  const moving = state.moveTarget;
  if (moving && (moving.view !== v ||
      !(moving.kind === 'edge' ? v.edges : moving.kind === 'node' ? v.nodes : moving.kind === 'file' ? v.groups : v.containers)?.includes(moving.item) ||
      (moving.kind === 'edge' ? state.selectedEdge !== moving.item || state.selectedLabel
        : moving.kind === 'node' ? state.selected !== moving.item.id
        : state.selected || state.selectedEdge || state.ctxBox?.kind !== moving.kind || state.ctxBox?.id !== moving.item.id))) state.moveTarget = null;
  if (state.multiSelection && (state.multiSelection.view !== v ||
      (state.multiSelection.kind !== 'nodes' &&
        state.multiSelection.anchor !== (state.selectedLabel || state.selectedEdge || state.selected)))) {
    state.multiSelection = null;
  }
  document.dispatchEvent(new Event('cg:canvas-selection'));
  document.body.setAttribute(
    'data-draw',
    v ? `n${v.nodes.length},e${v.edges.length},k${Math.round(cam.k * 100)}` : 'null'
  );
  if (!v) {
    releaseEffectCanvas();
    ctx.fillStyle = '#B4B2A9';
    ctx.font = `13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('…', W / 2, H / 2);
    return;
  }

  ctx.save();
  ctx.translate(cam.x, cam.y);
  ctx.scale(cam.k, cam.k);

  if (!v.nodes.length) {
    releaseEffectCanvas();
    ctx.restore();
    ctx.fillStyle = '#B4B2A9';
    ctx.font = `13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(t('canvas.noFunctions'), W / 2, H / 2);
    return;
  }
  collectingEffects = true;
  const area = viewport(W, H);

  // 标题可以比文件框宽，视口判断要包含标题可能占到的范围。
  const groupVisible = (box) => boxVisible(box, area, groupPaintWidth(box));

  const labelSplit = state.selectedLabel?.lastIndexOf('#') ?? -1;
  const focusedKey = labelSplit > 0 ? state.selectedLabel.slice(0, labelSplit)
    : state.selectedEdge ? edgeKey(state.selectedEdge) : null;
  const focusedEdge = state.selectedEdge && edgeKey(state.selectedEdge) === focusedKey && v.edges.includes(state.selectedEdge)
    ? state.selectedEdge : focusedKey ? v.edges.find((e) => edgeKey(e) === focusedKey) : null;
  const trace = state.pairFlow?.result;
  const tracedColors = new Map((trace?.edgeIndices || []).map(index => [v.edges[index], state.pairFlow.colors.get(index)]));
  const tracedEdges = new Set(tracedColors.keys());
  const flowingEdges = new Set((trace?.flowEdgeIndices || []).map(index => v.edges[index]));
  const focusedEdges = new Set(tracedEdges.size ? tracedEdges : state.multiSelection?.trunk ? state.multiSelection.hits
    : state.multiSelection?.edges
    ? v.edges.filter((e) => state.multiSelection.edges.has(edgeKey(e))) : focusedEdge ? [focusedEdge] : []);
  const focusedNodes = focusedEdges.size ? new Set([...focusedEdges].flatMap((e) => [e.from, e.to])) : null;
  const trunkHits = state.trunkHits;
  const trunkNodes = trunkHits?.length > 1 && trunkHits.includes(focusedEdge)
    ? new Set(trunkHits.flatMap((e) => [e.from, e.to])) : null;
  const aiStep = state.presentation?.steps?.[state.presentation.activeIndex ?? 0] || null;
  const aiOverlayAction = state.aiOverlay?.action || '';
  const aiFlowActive = aiOverlayAction === 'play_flow';
  const aiActiveNodes = new Set([...(aiStep?.nodeIds || []), ...(state.aiOverlay?.nodeIds || [])]);
  const aiActiveEdges = new Set([...(aiStep?.edgeKeys || []), ...(state.aiOverlay?.edgeKeys || [])]);
  const aiHoverNodes = new Set(state.aiHover?.nodeIds || []);
  const aiHoverEdges = new Set(state.aiHover?.edgeKeys || []);
  const aiOrderMap = new Map();
  if (aiStep || aiOverlayAction === 'spotlight' || aiOverlayAction === 'walkthrough') {
    for (const id of [...(aiStep?.nodeIds || []), ...(state.aiOverlay?.nodeIds || [])]) {
      if (!aiOrderMap.has(id)) aiOrderMap.set(id, aiOrderMap.size + 1);
    }
  }
  const hasAiDim = Boolean((aiStep || aiOverlayAction === 'spotlight' || aiOverlayAction === 'walkthrough') && (aiActiveNodes.size || aiActiveEdges.size));
  const selectedNodes = state.multiSelection?.nodes || null;
  const relations = !focusedEdges.size && !selectedNodes?.size && state.selected
    ? classifySelectionRelations(v, state.selected) : null;
  let activeBoxes = relations?.activeBoxes || null;
  if (!activeBoxes && (focusedNodes?.size || selectedNodes?.size || (hasAiDim && aiActiveNodes.size))) {
    const activeIds = focusedNodes?.size ? focusedNodes : selectedNodes?.size ? selectedNodes : aiActiveNodes;
    activeBoxes = new Set();
    for (const n of v.nodes) {
      if (!activeIds.has(n.id) || !n.group) continue;
      activeBoxes.add(n.group);
      const parts = n.group.split('/');
      for (let i = 1; i < parts.length; i++) activeBoxes.add(parts.slice(0, i).join('/'));
    }
  }
  for (const c of v.containers || []) if (groupVisible(c)) drawContainer(ctx, c, !!(activeBoxes && !c.root && !activeBoxes.has(c.id)));
  for (const g of v.groups || []) if (groupVisible(g)) drawGroup(ctx, g, !!(activeBoxes && !activeBoxes.has(g.id)));

  const dim = Boolean(focusedEdges.size || state.selected || selectedNodes?.size);
  const hoverRel = relations ? state.hoverRelation : null;
  const matchesHover = (e, role) => {
    if (!hoverRel) return false;
    if (hoverRel.edgeKey) return edgeKey(e) === hoverRel.edgeKey;
    const peer = e.from === state.selected ? e.to : e.from;
    if (peer !== hoverRel.peerId) return false;
    return !hoverRel.dir || hoverRel.dir === role || role === 'both' || e.from === e.to;
  };
  const isAiEdge = (e, ek) => aiActiveEdges.has(ek) || aiActiveEdges.has(`${e.from}->${e.to}`) ||
    (aiFlowActive && !aiActiveEdges.size && aiActiveNodes.has(e.from) && aiActiveNodes.has(e.to));
  const related = [];
  const emphasized = [];
  const aiEdges = [];
  for (const e of v.edges) {
    if (focusedEdges.has(e) || !pathVisible(edgePoints(e), area)) continue;
    const ek = edgeKey(e);
    if (relations ? relations.edgeRoles.has(e)
      : !focusedEdges.size && (selectedNodes ? selectedNodes.has(e.from) || selectedNodes.has(e.to)
        : state.selected && (e.from === state.selected || e.to === state.selected))) {
      const role = relations?.edgeRoles.get(e);
      if (hoverRel && matchesHover(e, role)) emphasized.push(e);
      else related.push(e);
    } else if (isAiEdge(e, ek) || aiHoverEdges.has(ek)) {
      aiEdges.push(e);
    } else drawEdge(ctx, e, false, false, null, false, dim || hasAiDim);
  }
  const hasEmphasized = emphasized.length > 0;
  for (const e of related) {
    const role = relations?.edgeRoles.get(e);
    drawEdge(ctx, e, true, false, null, true, false, role ? { role, emphasized: false, subdued: hasEmphasized } : null);
  }
  for (const e of emphasized) {
    const role = relations?.edgeRoles.get(e);
    drawEdge(ctx, e, true, false, null, true, false, { role, emphasized: true, subdued: false });
  }
  for (const e of focusedEdges) {
    if (!pathVisible(edgePoints(e), area)) continue;
    const animated = tracedEdges.has(e) ? flowingEdges.has(e) : !state.multiSelection?.edges || state.multiSelection.trunk || e === focusedEdge;
    drawEdge(ctx, e, false, true, tracedColors.get(e), animated);
  }
  for (const e of aiEdges) {
    const ek = edgeKey(e);
    const hovered = aiHoverEdges.has(ek);
    const active = isAiEdge(e, ek);
    const anim = aiFlowActive || (Boolean(aiStep) && active);
    drawEdge(ctx, e, false, true, hovered || aiFlowActive || aiStep ? '#6366F1' : '#7C3AED', anim);
  }
  if (rawFlowStreams.length) {
    for (const stream of mergeFlowStreams(rawFlowStreams)) {
      effects.push({ kind: 'stream', ...stream });
    }
  }

  if (state.linkFrom && state.linkPos) {
    const a = state.linkFrom;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x + a.w / 2, a.y + a.h / 2);
    ctx.lineTo(state.linkPos.x, state.linkPos.y);
    ctx.strokeStyle = THEME.edge.manual;
    ctx.lineWidth = 2 / cam.k;
    ctx.setLineDash([6 / cam.k, 4 / cam.k]);
    ctx.stroke();
    ctx.restore();
  }

  if (state.dragEnd) {
    const pts = edgePoints(state.dragEnd.edge);
    const from = state.dragEnd.which === 'from' ? pts[pts.length - 1] : pts[0];
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.lineTo(state.dragEnd.pos.x, state.dragEnd.pos.y);
    ctx.strokeStyle = THEME.node.selected;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.restore();
  }

  const nb = neighborSet();
  const aiCtx = (aiActiveNodes.size || aiHoverNodes.size || hasAiDim)
    ? { activeNodes: aiActiveNodes, hoverNodes: aiHoverNodes, orderMap: aiOrderMap, dimOthers: hasAiDim && !dim && !selectedNodes?.size }
    : null;
  for (const n of v.nodes) {
    if (boxVisible(n, area)) drawNode(ctx, n, nb, focusedNodes, relations?.nodeRoles || null, trunkNodes?.has(n.id), aiCtx);
  }
  for (const [index, id] of (state.pairFlow?.ids || []).entries()) {
    const node = v.nodes.find(n => n.id === id);
    if (!node || !boxVisible(node, area)) continue;
    const gap = 5 / cam.k;
    recordBoxEffect({ x: node.x - gap, y: node.y - gap, w: node.w + gap * 2, h: node.h + gap * 2 },
      [6 / cam.k, 4 / cam.k], 2.5 / cam.k, 10, '#7C3AED');
    ctx.save(); ctx.fillStyle = '#7C3AED'; ctx.font = `bold ${12 / cam.k}px ${FONT}`;
    ctx.textAlign = 'left'; ctx.fillText(String(index + 1), node.x + 4 / cam.k, node.y - 9 / cam.k); ctx.restore();
  }

  // 连线标签画在节点之后：标签本身已经避开节点，压在最上层更不容易被线穿花
  const activeLabelEdges = tracedEdges.size ? tracedEdges
    : focusedEdges.size ? focusedEdges
    : relations?.edgeRoles.size ? new Set(relations.edgeRoles.keys())
    : selectedNodes?.size ? new Set([...related, ...emphasized])
    : null;
  drawEdgeLabels(ctx, v, { onAnimatedBox: recordBoxEffect, focusedEdges: activeLabelEdges,
    visible: (box) => boxVisible(box, area), reuse: geometryUnchanged });

  if (state.marquee?.view === v) {
    const { x0, y0, x1, y1 } = state.marquee;
    const rect = [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
    ctx.save();
    ctx.fillStyle = 'rgba(37, 99, 235, .14)';
    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 1 / cam.k;
    ctx.setLineDash([5 / cam.k, 3 / cam.k]);
    ctx.fillRect(...rect);
    ctx.strokeRect(...rect);
    ctx.restore();
  }

  // 文件和目录本体为实线，双击解锁后使用动态外圈并画出 8 个拖拽缩放手柄；节点按自身线型处理。
  const resizableBox = state.resizeBox?.box ||
    (state.moveTarget && !state.dragBox && !['edge', 'node'].includes(state.moveTarget.kind) ? state.moveTarget.item : null);
  if (state.moveTarget && !state.dragBox && !state.resizeBox && !['edge', 'node'].includes(state.moveTarget.kind)) {
    const b = state.moveTarget.item, gap = 4 / cam.k;
    recordBoxEffect({ x: b.x - gap, y: b.y - gap, w: b.w + gap * 2, h: b.h + gap * 2 },
      [5 / cam.k, 4 / cam.k], 1.5 / cam.k, state.moveTarget.kind === 'dir' ? 14 : 12);
  }
  if (state.resizeBox) {
    const b = state.resizeBox.box;
    ctx.save();
    ctx.strokeStyle = THEME.node.selected;
    ctx.lineWidth = 2 / cam.k;
    roundRect(ctx, b.x - 1, b.y - 1, b.w + 2, b.h + 2, state.resizeBox.kind === 'dir' ? 14 : 12);
    ctx.stroke();
    ctx.restore();
  }
  if (resizableBox && !state.view?.comparison && !state.at) {
    const hs = 7 / cam.k;
    const pts = [
      [resizableBox.x, resizableBox.y],
      [resizableBox.x + resizableBox.w / 2, resizableBox.y],
      [resizableBox.x + resizableBox.w, resizableBox.y],
      [resizableBox.x + resizableBox.w, resizableBox.y + resizableBox.h / 2],
      [resizableBox.x + resizableBox.w, resizableBox.y + resizableBox.h],
      [resizableBox.x + resizableBox.w / 2, resizableBox.y + resizableBox.h],
      [resizableBox.x, resizableBox.y + resizableBox.h],
      [resizableBox.x, resizableBox.y + resizableBox.h / 2],
    ];
    ctx.save();
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = THEME.node.selected;
    ctx.lineWidth = 1.5 / cam.k;
    for (const [hx, hy] of pts) {
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }
    ctx.restore();
  }

  if (state.dragBox && state.dragMoved) {
    const { box, guides } = state.dragBox;
    ctx.save();
    ctx.strokeStyle = THEME.node.selected;
    ctx.lineWidth = 2 / cam.k;
    roundRect(ctx, box.x - 2, box.y - 2, box.w + 4, box.h + 4, 14);
    ctx.stroke();
    ctx.restore();
    drawAlignmentGuides(ctx, guides.map(({ axis, at, peer }) => {
      const coord = axis === 'x' ? 'y' : 'x', size = axis === 'x' ? 'h' : 'w';
      return { axis, at, from: Math.min(box[coord], peer[coord]),
        to: Math.max(box[coord] + box[size], peer[coord] + peer[size]) };
    }), dpr);
  }
  if (state.dragNode) drawAlignmentGuides(ctx, state.dragNodeGuides, dpr);
  if (state.dragSeg) drawAlignmentGuides(ctx, state.dragSeg.guides, dpr);

  ctx.restore();

  ctx.fillStyle = '#B4B2A9';
  ctx.font = `11px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(`${v.nodes.length} / ${v.edges.length}  ·  ${Math.round(cam.k * 100)}%`, 12, H - 12);
  collectingEffects = false;
  effectCamera = { ...cam, dpr, area };
  drawEffects(now);
  scheduleDraw();
}

function drawContainer(ctx, c, dimmed = false) {
  ctx.save();
  if (dimmed) ctx.globalAlpha = 0.32;
  const style = periodContainerStyle(c.kind);
  roundRect(ctx, c.x, c.y, c.w, c.h, 14);
  ctx.fillStyle = style?.body || hexToRgba(THEME.container.fill, 0.16 + Math.min(0.1, c.depth * 0.04));
  ctx.fill();
  ctx.strokeStyle = style?.border || hexToRgba(THEME.container.stroke, 0.55 + Math.min(0.25, c.depth * 0.08));
  ctx.lineWidth = 1.4;
  if (style?.dashed) ctx.setLineDash([7, 5]);
  ctx.stroke();
  ctx.setLineDash([]);

  // 标题做成带底色的胶囊，避免在大容器上完全看不见层级名
  const fs = Math.min(22, Math.max(12, 11 / cam.k));
  ctx.font = `600 ${fs}px ${FONT}`;
  const label = String(c.label);
  const tw = ctx.measureText(label).width;
  const padX = fs * 0.5;
  const bh = fs * 1.4;
  const bx = c.x + 6;
  const by = c.y + 4;
  roundRect(ctx, bx, by, tw + padX * 2, bh, bh / 2);
  ctx.fillStyle = style?.fill || hexToRgba(THEME.container.stroke, 0.32);
  ctx.fill();
  ctx.strokeStyle = style?.border || hexToRgba(THEME.container.stroke, 0.55);
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = style?.ink || '#0C447C';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, bx + padX, by + bh / 2 + 0.5);
  ctx.restore();
}

function drawGroup(ctx, g, dimmed = false) {
  ctx.save();
  if (dimmed) ctx.globalAlpha = 0.32;
  roundRect(ctx, g.x, g.y, g.w, g.h, 12);
  ctx.fillStyle = hexToRgba(THEME.container.fill, 0.45);
  ctx.fill();
  ctx.strokeStyle = hexToRgba(THEME.container.stroke, 0.6);
  ctx.lineWidth = 1.2;
  ctx.stroke();

  const hh = 26;
  ctx.save();
  roundRect(ctx, g.x, g.y, g.w, g.h, 12);
  ctx.clip();
  ctx.fillStyle = hexToRgba(THEME.container.stroke, 0.5);
  ctx.fillRect(g.x, g.y, g.w, hh);
  ctx.restore();

  ctx.fillStyle = '#0C447C';
  ctx.font = `500 ${Math.min(26, Math.max(12, 11 / cam.k))}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const label = g.label;
  ctx.fillText(label, g.x + 12, g.y + hh / 2 + 1);
  ctx.restore();
}

/** 圆角正交折线（严格水平/垂直段，折点用二次贝塞尔过渡） */
function strokeRounded(ctx, pts, radius = 7) {
  if (!pts || pts.length < 2) return;
  const clean = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = clean[clean.length - 1];
    if (Math.hypot(pts[i][0] - prev[0], pts[i][1] - prev[1]) >= 0.01) clean.push(pts[i]);
  }
  if (clean.length < 2) return;
  ctx.moveTo(clean[0][0], clean[0][1]);
  if (radius <= 0 || clean.length === 2) {
    for (let i = 1; i < clean.length; i++) ctx.lineTo(clean[i][0], clean[i][1]);
    return;
  }
  for (let i = 1; i < clean.length - 1; i++) {
    const prev = clean[i - 1], cur = clean[i], next = clean[i + 1];
    const dx1 = prev[0] - cur[0], dy1 = prev[1] - cur[1], d1 = Math.hypot(dx1, dy1);
    const dx2 = next[0] - cur[0], dy2 = next[1] - cur[1], d2 = Math.hypot(dx2, dy2);
    if (d1 < 0.01 || d2 < 0.01) continue;
    const u1x = dx1 / d1, u1y = dy1 / d1, u2x = dx2 / d2, u2y = dy2 / d2;
    if (Math.abs(u1x * u2y - u1y * u2x) < 1e-4) {
      ctx.lineTo(cur[0], cur[1]);
      continue;
    }
    const rad = Math.min(radius, d1 * 0.45, d2 * 0.45);
    ctx.lineTo(cur[0] + u1x * rad, cur[1] + u1y * rad);
    ctx.quadraticCurveTo(cur[0], cur[1], cur[0] + u2x * rad, cur[1] + u2y * rad);
  }
  const last = clean[clean.length - 1];
  ctx.lineTo(last[0], last[1]);
}

function drawEdge(ctx, e, related, selected, traceColor = null, animated = true, dimmed = false, relationMeta = null) {
  const pts = edgePoints(e);
  if (!pts || pts.length < 2) return;

  // 背景淡化连线直接使用不透明的预混浅色：共线几十条也不会叠加变深，且彻底省掉全屏离屏画布拷贝。
  const hasRole = Boolean(related && relationMeta?.role);
  const roleColor = hasRole
    ? relationMeta.role === 'in' ? CALLER_COLOR : relationMeta.role === 'both' ? BIDIR_COLOR : CALLEE_COLOR
    : null;
  const baseColor = e.change === 'added'
    ? THEME.edge.added
    : isDataEdge(e)
    ? THEME.edge.var
    : e.kind === 'fnptr'
    ? (THEME.edge.fnptr || THEME.edge.call)
    : THEME.edge.call;
  const color = dimmed
    ? mixHex(THEME.bg, baseColor, e.change === 'added' ? 0.16 : 0.09)
    : baseColor;
  const invK = Math.max(1, 1 / cam.k);
  ctx.save();
  if (relationMeta?.subdued) ctx.globalAlpha = 0.42;
  const dashed = isDataEdge(e);
  const segments = dashed ? dashSegments(pts) : null;
  if (dashed) ctx.setLineDash(EDGE_DASH);
  else {
    ctx.beginPath();
    strokeRounded(ctx, pts);
  }
  const stroke = () => {
    if (!dashed) { ctx.stroke(); return; }
    // 宽高亮的圆头会填满 4px 间隔。各描边层沿同一世界坐标相位落笔。
    ctx.lineCap = 'butt';
    for (const { start, end, offset } of segments) {
      ctx.beginPath();
      ctx.lineDashOffset = offset;
      ctx.moveTo(...start);
      ctx.lineTo(...end);
      ctx.stroke();
    }
  };

  if (state.recent?.edges.has(edgeKey(e))) {
    ctx.strokeStyle = hexToRgba(RECENT_COLOR, 0.22);
    ctx.lineWidth = Math.max(4.5, 3 / cam.k);
    stroke();
  }
  if (traceColor || selected) {
    // 选中和路径追踪着色在外圈，保留线芯和箭头的变更状态。
    ctx.strokeStyle = traceColor || hexToRgba(SELECTED_EDGE_COLOR, 0.54);
    ctx.lineWidth = (traceColor ? 6 : 5.5) * Math.min(1, 1 / cam.k);
    ctx.globalAlpha = traceColor ? 0.9 : 1;
    stroke();
  } else if (hasRole) {
    ctx.strokeStyle = hexToRgba(roleColor, 0.58);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.min(18, (relationMeta.emphasized ? 6.8 : 5.6) * invK);
    stroke();
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = traceColor ? 3 * Math.min(1, 1 / cam.k) : selected ? 2.5
    : hasRole ? Math.min(10, (relationMeta.emphasized ? 3.4 : 2.6) * invK)
    : related ? 2.2 : 1.4;
  ctx.globalAlpha = relationMeta?.subdued ? 0.42 : 1;
  stroke();
  ctx.setLineDash([]);

  const direction = edgeDirection(e);
  const biOffset = direction === 'both' ? 2.5 : 0;
  const drawDirection = (a, b, reverse) => {
    const showPulse = collectingEffects && e.change !== 'deleted' && (
      (selected && animated && (traceColor || (THEME.edge.selPulse && !prefersReducedMotion()))) ||
      (hasRole && relationMeta.role !== 'neutral' && !relationMeta.subdued && THEME.edge.selPulse && !prefersReducedMotion())
    );
    if (showPulse) {
      const pulseColor = traceColor ? flowPulseColor(traceColor)
        : e.change === 'added' ? '#FF4D6D'
        : hasRole ? roleColor : '#0284C7';
      const tailColor = hexToRgba(pulseColor, hasRole ? 0.34 : 0.38);
      rawFlowStreams.push({
        pts: reverse ? pts.toReversed() : pts,
        color: pulseColor,
        tailColor,
        offset: biOffset,
      });
    }
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const s = hasRole ? Math.min(20, (relationMeta.emphasized ? 8.4 : 7.2) * invK) : selected ? 6.8 : 6;
    ctx.beginPath();
    ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b[0] - s * dx - s * 0.55 * dy, b[1] - s * dy + s * 0.55 * dx);
    ctx.lineTo(b[0] - s * dx + s * 0.55 * dy, b[1] - s * dy - s * 0.55 * dx);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  if (direction === 'forward' || direction === 'both') drawDirection(pts.at(-2), pts.at(-1), false);
  if (direction === 'reverse' || direction === 'both') drawDirection(pts[1], pts[0], true);

  if (selected && !state.multiSelection && !state.view?.comparison &&
      state.moveTarget?.kind === 'edge' && state.moveTarget.item === e) {
    // 所有非零线段都有控制点，直线和单拐角线也可直接调形。
    for (let i = 0; i < pts.length - 1; i++) {
      const length = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      if (length < 0.01) continue;
      const hs = Math.min(4.5 / cam.k, length / 6);
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.beginPath();
      ctx.rect(mx - hs, my - hs, hs * 2, hs * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = THEME.node.selected;
      ctx.lineWidth = 1.5 / cam.k;
      ctx.stroke();
    }

    // 两端圆形手柄（可拖到其他节点上重连）
    const length = pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
    const r = Math.min(5 / cam.k, length / 4);
    for (const p of [pts[0], pts[pts.length - 1]]) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = THEME.node.selected;
      ctx.lineWidth = 2 / cam.k;
      ctx.stroke();
    }
  }

  // 已删除的连线：在中央画一个黑色 X
  if (e.change === 'deleted') {
    const { x: mx, y: my } = midAnchor(pts);
    const xs = 5 / cam.k;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2 / cam.k;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(mx - xs, my - xs);
    ctx.lineTo(mx + xs, my + xs);
    ctx.moveTo(mx + xs, my - xs);
    ctx.lineTo(mx - xs, my + xs);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * @param {Set<string>|null} nb 选中节点的邻接集合（draw 时统一算好传进来；为空表示没有选中）
 */
function drawNode(ctx, n, nb = null, focusedNodes = null, nodeRoles = null, trunkEndpoint = false, aiCtx = null) {
  const { x, y, w, h } = n;
  const isVar = n.kind === 'var';
  const rx = isVar ? Math.min(16, h / 2) : 8;
  const allNodes = !!state.multiSelection?.nodes;
  const selected = allNodes ? state.multiSelection.nodes.has(n.id) : state.selected === n.id;
  const hover = state.hover === n.id;
  const dropTarget = (state.dragEnd && state.dragEnd.hover && state.dragEnd.hover.id === n.id) ||
    (state.linkFrom && state.linkFrom.id !== n.id && state.hover === n.id);
  const edgeRelated = focusedNodes?.has(n.id);
  const recentlyAdded = state.recent?.nodes.has(n.id);
  const role = !selected && nodeRoles?.get(n.id);
  const isHoverPeer = state.hoverRelation?.peerId === n.id;
  const aiActive = Boolean(aiCtx?.activeNodes?.has(n.id));
  const aiHovered = Boolean(aiCtx?.hoverNodes?.has(n.id));
  const aiDimmed = Boolean(aiCtx?.dimOthers && !selected && !edgeRelated && !aiActive && !aiHovered);
  const invK = Math.max(1, 1 / cam.k);
  const comparing = Boolean(state.view?.comparison);
  const taskEntry = n.isTaskEntry || n.taskEntry;
  const period = periodSubtitle(n, comparing);
  const periodImpact = comparing && (n.periodImpact || period.includes('→'));
  const macroImpact = comparing && (n.macroImpact || n.impactRole === 'macro_lsb_impact');
  const changed = comparing && n.change && n.change !== 'existing';
  const impacted = comparing && (macroImpact || periodImpact || n.impact ||
    n.impactRole === 'dataflow_impact' || n.impactRole === 'caller_impact');
  const accent = changed ? '#8A490E' : null;
  const dimmed =
    allNodes ? !selected : focusedNodes ? !edgeRelated : state.selected && !selected && !(nb ? nb.has(n.id) : isNeighbor(n.id));
  const alpha = dimmed ? (trunkEndpoint ? 0.65 : 0.22) : aiDimmed ? 0.26 : 1;

  ctx.save();
  if (trunkEndpoint) {
    const focused = state.trunkFocusNode === n.id;
    const gap = 4 / cam.k;
    roundRect(ctx, x - gap, y - gap, w + gap * 2, h + gap * 2, rx + gap);
    ctx.strokeStyle = focused ? '#0369A1' : edgeRelated ? '#197FAF' : '#358EAD';
    ctx.lineWidth = (focused ? 3 : edgeRelated ? 2 : 1.5) / cam.k;
    if (!edgeRelated) ctx.setLineDash([4 / cam.k, 3 / cam.k]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = alpha;

  const batchSelected = selected && state.multiSelection?.kind === 'nodes';
  if (selected && (!allNodes || batchSelected)) {
    const ringGap = Math.min(8, 3 * invK);
    roundRect(ctx, x - ringGap, y - ringGap, w + ringGap * 2, h + ringGap * 2, rx + 2);
    ctx.strokeStyle = batchSelected ? '#2563EB' : hexToRgba(THEME.node.selected, 0.24);
    ctx.lineWidth = Math.min(7, 2.8 * invK);
    if (batchSelected) ctx.setLineDash([5 * invK, 3 * invK]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (aiActive || aiHovered) {
    const aiGap = Math.min(8, 3.5 * invK);
    roundRect(ctx, x - aiGap, y - aiGap, w + aiGap * 2, h + aiGap * 2, rx + 3);
    ctx.strokeStyle = hexToRgba(aiHovered ? '#6366F1' : '#7C3AED', aiHovered ? 0.24 : 0.22);
    ctx.lineWidth = Math.min(8, 4.5 * invK);
    ctx.stroke();
  }

  roundRect(ctx, x, y, w, h, rx);
  // 变量节点和函数节点用同一套底色语义（既存/变更/追加/删除）。
  const rawFill = n.external
    ? THEME.node.external
    : THEME.fill[n.change] || THEME.fill.existing;
  const baseFill = !n.external && THEME.node.tintFill ? mixHex('#FFFFFF', rawFill, 0.42) : rawFill;
  ctx.fillStyle = dropTarget ? '#EAF3DE' : n.color || baseFill;
  ctx.fill();

  if (recentlyAdded) ctx.globalAlpha = 1;
  ctx.lineWidth = recentlyAdded ? 2.4
    : dropTarget ? 2.6
    : selected || edgeRelated ? Math.min(6, 2.6 * invK)
    : aiHovered ? Math.min(6, 2.6 * invK)
    : aiActive ? Math.min(5.5, 2.2 * invK)
    : role ? Math.min(5.5, (isHoverPeer ? 3.2 : 2.2) * invK)
    : accent ? Math.min(10, 2.3 * invK)
    : hover ? 1.6 : 1;
  ctx.strokeStyle = recentlyAdded
    ? RECENT_COLOR
    : dropTarget
    ? '#639922'
    : selected || edgeRelated
    ? THEME.node.selected
    : aiHovered
    ? '#6366F1'
    : aiActive
    ? '#7C3AED'
    : hover
    ? THEME.node.hover
    : role
    ? (role === 'in' ? CALLER_COLOR : role === 'both' ? BIDIR_COLOR : role === 'out' ? CALLEE_COLOR : THEME.node.selected)
    : accent
    ? accent
    : n.external
    ? THEME.node.externalBorder
    : isVar
    ? THEME.node.varBorder
    : THEME.node.border;
  // 函数框/变量框各自的虚实线型，样式面板可调；选中时的流动虚线只在虚线开启时有效
  const impactDash = impacted && !changed && !selected && !edgeRelated;
  ctx.setLineDash(impactDash ? [7 * invK, 4 * invK] :
    !accent && (isVar ? THEME.node.varDash : THEME.node.fnDash) ? [5, 3] : []);
  const animated = collectingEffects && selected && !state.dragNode && ((allNodes && n.id === state.selected) ||
    state.moveTarget?.kind === 'node' && state.moveTarget.item === n);
  const dash = ctx.getLineDash();
  if (animated && dash.length) recordBoxEffect(n, dash, ctx.lineWidth, rx, ctx.strokeStyle);
  else ctx.stroke();
  if (animated && !dash.length) {
    const gap = 4 / cam.k;
    recordBoxEffect({ x: x - gap, y: y - gap, w: w + gap * 2, h: h + gap * 2 },
      [5 / cam.k, 4 / cam.k], 1.5 / cam.k, rx + 2);
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = alpha;

  if (accent) {
    const thickness = Math.min(10, 3.4 * invK);
    ctx.fillStyle = accent;
    roundRect(ctx, x + 4, y + 6, thickness, h - 12, thickness / 2);
    ctx.fill();
  } else if (taskEntry && !isVar) {
    const thickness = Math.min(6, 2.6 * invK);
    ctx.fillStyle = '#0E7490';
    roundRect(ctx, x + 4, y + 7, thickness, h - 14, thickness / 2);
    ctx.fill();
  }

  if (n.note) {
    // 旧数据里还留着备注的节点：只保留一个小圆点做提示（备注面板已下线）
    ctx.beginPath();
    ctx.arc(x + 8, y + 8, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#EF9F27';
    ctx.fill();
  }

  const cx = x + w / 2;

  if (cam.k >= 0.2) {
    ctx.fillStyle = '#2C2C2A';
    ctx.font = `500 ${Math.max(12.5, 8 / cam.k)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 函数名统一带 ()，变量名不带，便于一眼区分
    const name = isVar ? n.name || n.id : `${n.displayName || n.name || n.id}()`;
    const maxW = w - 18;
    const font = ctx.font;
    let saved = nodeNames.get(n);
    if (!saved || saved.name !== name || saved.font !== font || saved.width !== maxW) {
      let label = name;
      if (ctx.measureText(label).width > maxW) {
        while (label.length > 1 && ctx.measureText(label + '…').width > maxW) label = label.slice(0, -1);
        label += '…';
      }
      saved = { name, font, width: maxW, label };
      nodeNames.set(n, saved);
    }
    const showSubtitle = cam.k >= 0.62 || (period && cam.k >= 0.4 && h * cam.k >= 18);
    ctx.fillText(saved.label, cx, y + (showSubtitle ? h / 2 - 8 : h / 2));

    if (showSubtitle) {
      ctx.font = period ? `600 ${Math.max(11, 7 / cam.k)}px ${FONT}` : `10.5px ${FONT}`;
      ctx.fillStyle = period ? '#124B71' : '#888780';
      const sub = n.external
        ? t('node.external')
        : n.manual
        ? (isVar ? n.typeText || t('node.manualVar') : t('node.manualFn'))
        : isVar
        ? n.typeText || t('node.variable')
        : `${shortFile(n.file)}:${n.line}`;
      ctx.fillText(period || sub, cx, y + h / 2 + 10, maxW);
    }
  }

  if (!comparing && cam.k >= 0.4) {
    const badge = canvasPeriodBadge(n);
    if (badge) {
      const size = Math.max(10.5, 7.5 / cam.k);
      ctx.font = `600 ${size}px ${FONT}`;
      const box = periodBadgeBox(n, ctx.measureText(badge.text).width, size, recentlyAdded);
      if (box) {
        const { fill, ink } = PERIOD_COLORS[badge.tier];
        roundRect(ctx, box.x, box.y, box.w, box.h, box.h / 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = ink;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badge.text, box.x + box.w / 2, y, box.w - 10);
      }
    }
  }
  if (recentlyAdded) {
    if (cam.k >= 0.35) {
      const bx = x + w - 28, by = y - 8, bw = 26, bh = 15;
      ctx.globalAlpha = 1;
      roundRect(ctx, bx, by, bw, bh, 7.5);
      ctx.fillStyle = RECENT_COLOR;
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `bold 9.5px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NEW', bx + bw / 2, by + bh / 2);
    }
    if (collectingEffects && performance.now() < state.recent.rippleUntil) {
      effects.push({ kind: 'ripple', box: n, started: state.recent.started, dur: state.recent.rippleDur || RECENT_RIPPLE_MS, color: RECENT_COLOR });
    }
  }
  if (aiCtx?.orderMap?.has(n.id) && cam.k >= 0.35) {
    const stepText = String(aiCtx.orderMap.get(n.id));
    const bh = 16, bw = Math.max(18, stepText.length * 7 + 10);
    const bx = x - 6, by = y - 6;
    ctx.globalAlpha = 1;
    roundRect(ctx, bx, by, bw, bh, bh / 2);
    ctx.fillStyle = '#6366F1';
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold 10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(stepText, bx + bw / 2, by + bh / 2);
  }
  ctx.restore();
}

function isNeighbor(id) {
  const v = state.view;
  if (!v || !state.selected) return false;
  if (id === state.selected) return true;
  return v.edges.some(
    (e) => (e.from === state.selected && e.to === id) || (e.to === state.selected && e.from === id)
  );
}
/** 将画布中指定世界坐标区域（文件框、目录层级或整图）离屏高清渲染为 JPEG DataURL，不干扰当前镜头。 */
function captureBoxImage(box, { padding = 28, maxDim = 1280, quality = 0.85 } = {}) {
  const v = state.view;
  if (!v || !box || !Number.isFinite(box.w) || !Number.isFinite(box.h) || box.w <= 0 || box.h <= 0) return null;
  const worldW = box.w + padding * 2;
  const worldH = box.h + padding * 2;
  const scale = Math.min(2, maxDim / Math.max(worldW, worldH));
  const outW = Math.max(64, Math.min(maxDim, Math.round(worldW * scale)));
  const outH = Math.max(64, Math.min(maxDim, Math.round(worldH * scale)));
  const off = document.createElement('canvas');
  off.width = outW;
  off.height = outH;
  const ctx = off.getContext('2d');
  if (!ctx) return null;

  const prevCam = { x: cam.x, y: cam.y, k: cam.k };
  const prevCollecting = collectingEffects;
  try {
    collectingEffects = false;
    cam.k = scale;
    cam.x = (padding - box.x) * scale;
    cam.y = (padding - box.y) * scale;

    ctx.fillStyle = THEME.bg || '#F7F6F2';
    ctx.fillRect(0, 0, outW, outH);
    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.k, cam.k);

    const area = {
      left: box.x - padding,
      right: box.x + box.w + padding,
      top: box.y - padding,
      bottom: box.y + box.h + padding,
    };
    const groupVisible = (b) => boxVisible(b, area, groupPaintWidth(b));
    for (const c of v.containers || []) if (groupVisible(c)) drawContainer(ctx, c, false);
    for (const g of v.groups || []) if (groupVisible(g)) drawGroup(ctx, g, false);
    for (const e of v.edges || []) {
      if (pathVisible(edgePoints(e), area)) drawEdge(ctx, e, false, false, null, false, false);
    }
    for (const n of v.nodes || []) {
      if (boxVisible(n, area)) drawNode(ctx, n, null, null, null, false);
    }
    drawEdgeLabels(ctx, v, { visible: (r) => boxVisible(r, area), reuse: true });
    ctx.restore();
    const dataUrl = off.toDataURL('image/jpeg', quality);
    return dataUrl.startsWith('data:image/') ? { dataUrl, width: outW, height: outH } : null;
  } catch {
    return null;
  } finally {
    cam.x = prevCam.x;
    cam.y = prevCam.y;
    cam.k = prevCam.k;
    collectingEffects = prevCollecting;
  }
}

export {
  resize,
  roundRect,
  updateGroups,
  draw,
  viewport,
  boxVisible,
  compositeEffects,
  captureBoxImage,
  panCanvas,
  finishPan,
  drawContainer,
  drawGroup,
  strokeRounded,
  drawEdge,
  drawNode,
  isNeighbor,
};
