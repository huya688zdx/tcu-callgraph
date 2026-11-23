/**
 * 画布绘制：容器 / 文件框 / 连线 / 节点
 * 只读 state，不修改数据（updateGroups 例外：文件框跟随节点）
 */
import { t } from '../i18n.js';
import { els, state, cam, THEME, hexToRgba, FONT, shortFile, edgeKey } from './state.js';
import { edgePoints } from './geometry.js';
import { drawEdgeLabels } from './edge-labels.js';
import { flowPulseColor, flowPath, flowPointAt } from './flow-geometry.js';
import { routeBounds } from '/core/routing.js';

// 静态画面只在交互后重建，持续动画帧复用位图，不重复测字和计算标签避让。
let animationFrame = 0;
let recentLayers = null;
let collectingEffects = false;
let effects = [];
let effectCamera = null;
let damage = null;
let lastAnimationPaint = 0;
// 动画按实时时间推进，限制空闲时的合成频率。
const ANIMATION_INTERVAL = 32;
const scene = document.createElement('canvas');
const sceneCtx = scene.getContext('2d');
const nodeNames = new WeakMap();

function sizeScene(canvas) {
  if (scene.width === canvas.width && scene.height === canvas.height) return;
  scene.width = canvas.width;
  scene.height = canvas.height;
}

function releaseScene() {
  if (scene.width || scene.height) scene.width = scene.height = 0;
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

function pathVisible(points, area) {
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    if (Math.min(x1, x2) <= area.right && Math.max(x1, x2) >= area.left &&
        Math.min(y1, y2) <= area.bottom && Math.max(y1, y2) >= area.top) return true;
  }
  return false;
}

function addDamage(box, padding = 16) {
  const { cv } = els, dpr = window.devicePixelRatio || 1;
  const x = Math.max(0, Math.floor((box.x * cam.k + cam.x - padding) * dpr));
  const y = Math.max(0, Math.floor((box.y * cam.k + cam.y - padding) * dpr));
  const right = Math.min(cv.width, Math.ceil(((box.x + box.w) * cam.k + cam.x + padding) * dpr));
  const bottom = Math.min(cv.height, Math.ceil(((box.y + box.h) * cam.k + cam.y + padding) * dpr));
  if (right <= x || bottom <= y) return;
  if (!damage) damage = { x, y, right, bottom };
  else {
    damage.x = Math.min(damage.x, x);
    damage.y = Math.min(damage.y, y);
    damage.right = Math.max(damage.right, right);
    damage.bottom = Math.max(damage.bottom, bottom);
  }
}

function addPathDamage(points, padding) {
  const { minX, minY, maxX, maxY } = routeBounds(points);
  addDamage({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, padding);
}

export function pulseAdded(nodes, edges) {
  state.recent = nodes.length || edges.length ? {
    nodes: new Set(nodes.map((n) => n.id)), edges: new Set(edges.map(edgeKey)),
    started: performance.now(), until: performance.now() + 6000,
  } : null;
  draw();
}
function scheduleDraw() {
  if (animationFrame || !damage || document.hidden) return;
  animationFrame = requestAnimationFrame((now) => {
    animationFrame = 0;
    if (recentLayers && (!state.recent || now >= state.recent.until)) { draw({ geometryUnchanged: true }); return; }
    if (now - lastAnimationPaint >= ANIMATION_INTERVAL || (state.flash && now >= state.flash.until)) {
      drawCachedFrame(now);
      lastAnimationPaint = now;
    }
    if (effects.length || recentLayers || state.flash) scheduleDraw();
  });
}

function drawCachedFrame(now, region = damage) {
  const { ctx } = els;
  const { x, y, right, bottom } = region;
  const w = right - x, h = bottom - y;
  const blit = (canvas) => ctx.drawImage(canvas, x, y, w, h, x, y, w, h);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(x, y, w, h);
  if (recentLayers) {
    blit(recentLayers.background.canvas);
    ctx.globalAlpha = (0.45 + 0.35 * Math.sin((now - state.recent.started) / 220)) *
      Math.min(1, (state.recent.until - now) / 700);
    blit(recentLayers.glow.canvas);
    ctx.globalAlpha = 1;
  }
  blit(scene);
  ctx.restore();
  drawEffects(now);
}

// 金色光晕夹在分组背景与文字、箭头之间。只在画面变化时生成，呼吸动画只改变透明度。
function prepareRecentLayers(view, area) {
  const { ctx, cv } = els;
  const edges = view.edges.filter((e) => state.recent.edges.has(edgeKey(e)) && pathVisible(edgePoints(e), area));
  const nodes = view.nodes.filter((n) => state.recent.nodes.has(n.id) && boxVisible(n, area));
  if (!edges.length && !nodes.length) { recentLayers = null; return; }
  const layer = () => {
    const canvas = document.createElement('canvas');
    canvas.width = cv.width; canvas.height = cv.height;
    return canvas.getContext('2d');
  };
  if (!recentLayers || recentLayers.glow.canvas.width !== cv.width || recentLayers.glow.canvas.height !== cv.height) {
    recentLayers = { background: layer(), glow: layer() };
  }
  const { background, glow } = recentLayers;
  background.clearRect(0, 0, cv.width, cv.height);
  background.drawImage(cv, 0, 0);
  glow.clearRect(0, 0, cv.width, cv.height);
  glow.save();
  glow.setTransform(ctx.getTransform());
  glow.strokeStyle = glow.shadowColor = '#E69A16';
  glow.lineWidth = 7 / cam.k;
  glow.shadowBlur = 10;
  for (const e of edges) {
    addPathDamage(e.points, 36);
    glow.setLineDash(edgeDashed(e) ? [7, 4] : []);
    glow.beginPath(); strokeRounded(glow, e.points); glow.stroke();
  }
  const gap = 5 / cam.k;
  glow.lineWidth = 3 / cam.k;
  glow.shadowBlur = 12;
  glow.setLineDash([]);
  for (const n of nodes) {
    addDamage(n, 36);
    roundRect(glow, n.x - gap, n.y - gap, n.w + gap * 2, n.h + gap * 2, 10);
    glow.stroke();
  }
  glow.restore();
  ctx.save();
  ctx.resetTransform();
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.restore();
}

function recordBoxEffect(box, dash, width, radius = 8, color = THEME.node.selected) {
  addDamage(box, width * cam.k / 2 + 4);
  effects.push({ kind: 'box', box: { x: box.x, y: box.y, w: box.w, h: box.h }, dash, width, radius, color });
}

function drawEffects(now) {
  const { ctx } = els, c = effectCamera;
  ctx.save();
  ctx.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
  ctx.translate(c.x, c.y);
  ctx.scale(c.k, c.k);
  const flash = state.flash;
  if (flash && now >= flash.until) state.flash = null;
  else if (flash) {
    roundRect(ctx, flash.box.x - 2, flash.box.y - 2, flash.box.w + 4, flash.box.h + 4, 16);
    ctx.strokeStyle = hexToRgba(THEME.node.selected, 0.9 * Math.min(1, (flash.until - now) / flash.dur));
    ctx.lineWidth = 3 / c.k;
    ctx.stroke();
  }
  for (const effect of effects) {
    ctx.save();
    if (effect.kind === 'box') {
      const b = effect.box;
      roundRect(ctx, b.x, b.y, b.w, b.h, effect.radius);
      ctx.strokeStyle = effect.color;
      ctx.lineWidth = effect.width;
      ctx.setLineDash(effect.dash);
      ctx.lineDashOffset = -now * 0.024 / c.k;
      ctx.stroke();
    } else {
      ctx.fillStyle = effect.color || flowPulseColor(THEME.node.selected);
      const path = effect.path;
      if (!path.length) { ctx.restore(); continue; }
      const scale = Math.min(1, 1 / c.k);
      const spacing = Math.min(Math.max(90, 20 / c.k), path.length);
      // 所有连线每秒前进 80 个画布单位，长线只增加标记数量。
      for (let distance = (now * 0.08) % spacing; distance < path.length; distance += spacing) {
        const [x, y, dx, dy] = flowPointAt(path, distance);
        if (x < c.area.left || x > c.area.right || y < c.area.top || y > c.area.bottom) continue;
        ctx.save();
        // 固定放在前进方向右侧，相向重合时各走一侧。
        ctx.translate(x - dy * 5 * scale, y + dx * 5 * scale);
        ctx.rotate(Math.atan2(dy, dx));
        ctx.scale(scale, scale);
        ctx.beginPath();
        ctx.moveTo(5, 0);
        ctx.lineTo(-3, -3);
        ctx.lineTo(-1, 0);
        ctx.lineTo(-3, 3);
        ctx.closePath();
        ctx.strokeStyle = '#1F2937'; ctx.lineWidth = 2; ctx.stroke();
        ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.restore();
  }
  ctx.restore();
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
  damage = null;
  effects = [];
  collectingEffects = false;
  const { ctx, cv } = els;
  if (!cv.width || !cv.height) { recentLayers = null; releaseScene(); return; }
  const dpr = window.devicePixelRatio || 1;
  const W = cv.width / dpr;
  const H = cv.height / dpr;
  const now = performance.now();
  if (state.recent && now >= state.recent.until) state.recent = null;
  if (state.flash && now >= state.flash.until) state.flash = null;
  if (!state.recent || !state.view?.nodes.length) recentLayers = null;

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
      state.multiSelection.anchor !== (state.selectedLabel || state.selectedEdge || state.selected))) {
    state.multiSelection = null;
  }
  document.body.setAttribute(
    'data-draw',
    v ? `n${v.nodes.length},e${v.edges.length},k${Math.round(cam.k * 100)}` : 'null'
  );
  if (!v) {
    releaseScene();
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
    releaseScene();
    ctx.restore();
    ctx.fillStyle = '#B4B2A9';
    ctx.font = `13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('未在该路径下找到 C 函数', W / 2, H / 2);
    return;
  }
  collectingEffects = true;
  const area = viewport(W, H);

  // 标题可以比文件框宽，视口判断要包含标题可能占到的范围。
  const groupVisible = (box) => boxVisible(box, area, Math.max(box.w, 26 * String(box.label).length + 30));
  for (const c of v.containers || []) if (groupVisible(c)) drawContainer(ctx, c);
  for (const g of v.groups || []) if (groupVisible(g)) drawGroup(ctx, g);

  if (state.recent) prepareRecentLayers(v, area);

  const labelSplit = state.selectedLabel?.lastIndexOf('#') ?? -1;
  const focusedKey = labelSplit > 0 ? state.selectedLabel.slice(0, labelSplit)
    : state.selectedEdge ? edgeKey(state.selectedEdge) : null;
  const focusedEdge = state.selectedEdge && edgeKey(state.selectedEdge) === focusedKey && v.edges.includes(state.selectedEdge)
    ? state.selectedEdge : focusedKey ? v.edges.find((e) => edgeKey(e) === focusedKey) : null;
  const trace = state.pairFlow?.result;
  const tracedColors = new Map((trace?.edgeIndices || []).map(index => [v.edges[index], state.pairFlow.colors.get(index)]));
  const tracedEdges = new Set(tracedColors.keys());
  const flowingEdges = new Set((trace?.flowEdgeIndices || []).map(index => v.edges[index]));
  const focusedEdges = new Set(tracedEdges.size ? tracedEdges : state.multiSelection?.edges
    ? v.edges.filter((e) => state.multiSelection.edges.has(edgeKey(e))) : focusedEdge ? [focusedEdge] : []);
  const focusedNodes = focusedEdges.size ? new Set([...focusedEdges].flatMap((e) => [e.from, e.to])) : null;
  const selectedNodes = state.multiSelection?.nodes || null;
  const dim = focusedEdges.size || state.selected || selectedNodes?.size;
  const related = [];
  if (dim) {
    sizeScene(cv);
    sceneCtx.clearRect(0, 0, cv.width, cv.height);
    sceneCtx.save();
    sceneCtx.setTransform(ctx.getTransform());
  }
  for (const e of v.edges) {
    if (focusedEdges.has(e) || !pathVisible(edgePoints(e), area)) continue;
    if (!focusedEdges.size && (selectedNodes ? selectedNodes.has(e.from) || selectedNodes.has(e.to)
      : state.selected && (e.from === state.selected || e.to === state.selected))) related.push(e);
    else drawEdge(dim ? sceneCtx : ctx, e, false, false);
  }
  // 背景连线画完再整体淡化一次。数十条调用共线时，透明度不会叠加成一条黑线。
  if (dim) {
    sceneCtx.restore();
    ctx.save();
    ctx.resetTransform();
    ctx.globalAlpha = focusedEdges.size ? 0.22 : 0.26;
    ctx.drawImage(scene, 0, 0);
    ctx.restore();
  }
  for (const e of related) drawEdge(ctx, e, true, false);
  for (const e of focusedEdges) {
    if (!pathVisible(edgePoints(e), area)) continue;
    const animated = tracedEdges.has(e) ? flowingEdges.has(e) : !state.multiSelection?.edges || e === focusedEdge;
    drawEdge(ctx, e, false, true, tracedColors.get(e), animated);
  }

  if (state.linkFrom && state.linkPos) {
    const a = state.linkFrom;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x + a.w / 2, a.y + a.h);
    ctx.lineTo(state.linkPos.x, state.linkPos.y);
    ctx.strokeStyle = THEME.edge.manual;
    ctx.lineWidth = 1.8;
    ctx.setLineDash([5, 4]);
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
  for (const n of v.nodes) if (boxVisible(n, area)) drawNode(ctx, n, nb, focusedNodes);
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
  drawEdgeLabels(ctx, v, { onAnimatedBox: recordBoxEffect, focusedEdges: tracedEdges,
    visible: (box) => boxVisible(box, area), reuse: geometryUnchanged });

  // 文件和目录本体为实线，双击解锁后使用动态外圈；节点按自身线型处理。
  if (state.moveTarget && !state.dragBox && !['edge', 'node'].includes(state.moveTarget.kind)) {
    const b = state.moveTarget.item, gap = 4 / cam.k;
    recordBoxEffect({ x: b.x - gap, y: b.y - gap, w: b.w + gap * 2, h: b.h + gap * 2 },
      [5 / cam.k, 4 / cam.k], 1.5 / cam.k, state.moveTarget.kind === 'dir' ? 14 : 12);
  }

  if (state.dragBox && state.dragMoved) {
    const { box, guides } = state.dragBox;
    ctx.save();
    ctx.strokeStyle = THEME.node.selected;
    ctx.lineWidth = 2 / cam.k;
    roundRect(ctx, box.x - 2, box.y - 2, box.w + 4, box.h + 4, 14);
    ctx.stroke();
    ctx.lineWidth = 1 / cam.k;
    ctx.setLineDash([4 / cam.k, 4 / cam.k]);
    for (const g of guides) {
      ctx.beginPath();
      if (g.axis === 'x') {
        ctx.moveTo(g.at, Math.min(box.y, g.peer.y) - 12);
        ctx.lineTo(g.at, Math.max(box.y + box.h, g.peer.y + g.peer.h) + 12);
      } else {
        ctx.moveTo(Math.min(box.x, g.peer.x) - 12, g.at);
        ctx.lineTo(Math.max(box.x + box.w, g.peer.x + g.peer.w) + 12, g.at);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.restore();

  ctx.fillStyle = '#B4B2A9';
  ctx.font = `11px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(`${v.nodes.length} / ${v.edges.length}  ·  ${Math.round(cam.k * 100)}%`, 12, H - 12);
  collectingEffects = false;
  if (state.flash) addDamage(state.flash.box);
  if (recentLayers || damage) {
    sizeScene(cv);
    sceneCtx.clearRect(0, 0, scene.width, scene.height);
    sceneCtx.drawImage(cv, 0, 0);
    effectCamera = { ...cam, dpr, area };
    if (recentLayers) drawCachedFrame(now, { x: 0, y: 0, right: cv.width, bottom: cv.height });
    else drawEffects(now);
    lastAnimationPaint = now;
  } else if (!dim) releaseScene();
  if (recentLayers || state.flash || effects.length) scheduleDraw();
}

function drawContainer(ctx, c) {
  ctx.save();
  roundRect(ctx, c.x, c.y, c.w, c.h, 14);
  ctx.fillStyle = hexToRgba(THEME.container.fill, 0.16 + Math.min(0.1, c.depth * 0.04));
  ctx.fill();
  ctx.strokeStyle = hexToRgba(THEME.container.stroke, 0.55 + Math.min(0.25, c.depth * 0.08));
  ctx.lineWidth = 1.4;
  // 层级框用实线（函数才是虚线）
  ctx.stroke();

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
  ctx.fillStyle = hexToRgba(THEME.container.stroke, 0.32);
  ctx.fill();
  ctx.strokeStyle = hexToRgba(THEME.container.stroke, 0.55);
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#0C447C';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, bx + padX, by + bh / 2 + 0.5);
  ctx.restore();
}

function drawGroup(ctx, g) {
  ctx.save();
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
function strokeRounded(ctx, pts) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
}

/** 该连线是否画成虚线（变量访问默认虚线；虚实可在样式面板按类型调整） */
const edgeDashed = (e) => (e.kind === 'var' ? THEME.edge.varDash : THEME.edge.callDash);

function drawEdge(ctx, e, related, selected, traceColor = null, animated = true) {
  const pts = edgePoints(e);
  if (!pts || pts.length < 2) return;

  // 连线只按黑 / 红区分状态；选中只加粗，删除另在中央画 X。
  const color = traceColor ? traceColor : e.change === 'added'
    ? THEME.edge.added
    : e.kind === 'var'
    ? THEME.edge.var
    : THEME.edge.call;
  ctx.save();
  ctx.beginPath();
  strokeRounded(ctx, pts);

  if (traceColor) {
    ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 6 * Math.min(1, 1 / cam.k); ctx.globalAlpha = 0.9; ctx.stroke();
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = traceColor ? 3 * Math.min(1, 1 / cam.k) : selected ? 2.6 : related ? 2.4 : 1.4;
  ctx.globalAlpha = 1;
  // 变量访问=虚线，函数调用=实线
  if (edgeDashed(e)) ctx.setLineDash([7, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  if (collectingEffects && selected && animated && (traceColor || THEME.edge.selPulse)) {
    const path = flowPath(pts);
    if (path.length) {
      addPathDamage(pts);
      effects.push({ kind: 'edge', path, color: flowPulseColor(color) });
    }
  }

  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  let dx = b[0] - a[0];
  let dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const s = 6;
  ctx.beginPath();
  ctx.moveTo(b[0], b[1]);
  ctx.lineTo(b[0] - s * dx - s * 0.55 * dy, b[1] - s * dy + s * 0.55 * dx);
  ctx.lineTo(b[0] - s * dx + s * 0.55 * dy, b[1] - s * dy - s * 0.55 * dx);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

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
    const mi = Math.max(1, Math.floor(pts.length / 2));
    const p0 = pts[mi - 1];
    const p1 = pts[Math.min(pts.length - 1, mi)];
    const mx = (p0[0] + p1[0]) / 2;
    const my = (p0[1] + p1[1]) / 2;
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
function drawNode(ctx, n, nb = null, focusedNodes = null) {
  const { x, y, w, h } = n;
  const isVar = n.kind === 'var';
  const allNodes = !!state.multiSelection?.nodes;
  const selected = allNodes ? state.multiSelection.nodes.has(n.id) : state.selected === n.id;
  const hover = state.hover === n.id;
  const dropTarget = state.dragEnd && state.dragEnd.hover && state.dragEnd.hover.id === n.id;
  const edgeRelated = focusedNodes?.has(n.id);
  const dimmed =
    allNodes ? !selected : focusedNodes ? !edgeRelated : state.selected && !selected && !(nb ? nb.has(n.id) : isNeighbor(n.id));

  ctx.save();
  ctx.globalAlpha = dimmed ? 0.3 : 1;

  roundRect(ctx, x, y, w, h, 8);
  // 变量节点和函数节点用同一套底色语义（既存/变更/追加/删除）。
  const baseFill = n.external
    ? THEME.node.external
    : THEME.fill[n.change] || THEME.fill.existing;
  ctx.fillStyle = dropTarget ? '#EAF3DE' : n.color || baseFill;
  ctx.fill();

  ctx.lineWidth = dropTarget ? 2.6 : selected || edgeRelated ? 2.4 : hover ? 1.6 : 1;
  ctx.strokeStyle = dropTarget
    ? '#639922'
    : selected || edgeRelated
    ? THEME.node.selected
    : hover
    ? THEME.node.hover
    : n.external
    ? THEME.node.externalBorder
    : isVar
    ? THEME.node.varBorder
    : THEME.node.border;
  // 函数框/变量框各自的虚实线型，样式面板可调；选中时的流动虚线只在虚线开启时有效
  ctx.setLineDash((isVar ? THEME.node.varDash : THEME.node.fnDash) ? [5, 3] : []);
  const animated = collectingEffects && selected && !state.dragNode && ((allNodes && n.id === state.selected) ||
    state.moveTarget?.kind === 'node' && state.moveTarget.item === n);
  const dash = ctx.getLineDash();
  if (animated && dash.length) recordBoxEffect(n, dash, ctx.lineWidth, 8, ctx.strokeStyle);
  else ctx.stroke();
  if (animated && !dash.length) {
    const gap = 4 / cam.k;
    recordBoxEffect({ x: x - gap, y: y - gap, w: w + gap * 2, h: h + gap * 2 },
      [5 / cam.k, 4 / cam.k], 1.5 / cam.k, 10);
  }
  ctx.setLineDash([]);

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
    ctx.fillText(saved.label, cx, y + (cam.k >= 0.62 ? h / 2 - 8 : h / 2));

    if (cam.k >= 0.62) {
      ctx.font = `10.5px ${FONT}`;
      ctx.fillStyle = '#888780';
      const sub = n.external
        ? t('node.external')
        : isVar
        ? n.typeText || t('node.variable')
        : `${shortFile(n.file)}:${n.line}`;
      ctx.fillText(sub, cx, y + h / 2 + 10);
    }
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
export {
  resize,
  roundRect,
  updateGroups,
  draw,
  drawContainer,
  drawGroup,
  strokeRounded,
  drawEdge,
  drawNode,
  isNeighbor,
};
