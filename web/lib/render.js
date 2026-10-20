/**
 * 画布绘制：容器 / 文件框 / 连线 / 节点
 * 只读 state，不修改数据（updateGroups 例外：文件框跟随节点）
 */
import { t } from '../i18n.js';
import { els, state, cam, COLORS, CHANGE_FILL, EDGE_COLOR, FONT, shortFile } from './state.js';
import { edgePoints } from './geometry.js';
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = els.cv.clientWidth;
  const h = els.cv.clientHeight;
  els.cv.width = Math.round(w * dpr);
  els.cv.height = Math.round(h * dpr);
  draw();
}

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

function draw() {
  const { ctx, cv } = els;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.width / dpr;
  const H = cv.height / dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const v = state.view;
  document.body.setAttribute(
    'data-draw',
    v ? `n${v.nodes.length},e${v.edges.length},k${Math.round(cam.k * 100)}` : 'null'
  );
  if (!v) {
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
    ctx.restore();
    ctx.fillStyle = '#B4B2A9';
    ctx.font = `13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('未在该路径下找到 C 函数', W / 2, H / 2);
    return;
  }

  if (v.containers) for (const c of v.containers) drawContainer(ctx, c);

  if (v.groups) {
    for (const g of v.groups) drawGroup(ctx, g);
  }

  for (const e of v.edges) {
    const related = state.selected && (e.from === state.selected || e.to === state.selected);
    drawEdge(ctx, e, related, state.selectedEdge === e);
  }

  if (state.linkFrom && state.linkPos) {
    const a = state.linkFrom;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x + a.w / 2, a.y + a.h);
    ctx.lineTo(state.linkPos.x, state.linkPos.y);
    ctx.strokeStyle = COLORS.manual;
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
    ctx.strokeStyle = '#185FA5';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.restore();
  }

  for (const n of v.nodes) drawNode(ctx, n);

  // 点击标题后的短暂高亮：框住刚点中的那个层级，避免「点了没反应」的错觉
  if (state.flash) {
    const f = state.flash;
    const left = f.until - performance.now();
    if (left <= 0) {
      state.flash = null;
    } else {
      const a = Math.min(1, left / f.dur);
      ctx.save();
      roundRect(ctx, f.box.x - 2, f.box.y - 2, f.box.w + 4, f.box.h + 4, 16);
      ctx.strokeStyle = `rgba(24, 95, 165, ${0.9 * a})`;
      ctx.lineWidth = 3 / cam.k;
      ctx.stroke();
      ctx.restore();
      requestAnimationFrame(() => draw());
    }
  }

  ctx.restore();

  ctx.fillStyle = '#B4B2A9';
  ctx.font = `11px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(`${v.nodes.length} / ${v.edges.length}  ·  ${Math.round(cam.k * 100)}%`, 12, H - 12);
}

function drawContainer(ctx, c) {
  ctx.save();
  roundRect(ctx, c.x, c.y, c.w, c.h, 14);
  ctx.fillStyle = `rgba(230, 241, 251, ${0.16 + Math.min(0.1, c.depth * 0.04)})`;
  ctx.fill();
  ctx.strokeStyle = `rgba(107, 163, 224, ${0.55 + Math.min(0.25, c.depth * 0.08)})`;
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
  ctx.fillStyle = 'rgba(133, 183, 235, 0.32)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(107, 163, 224, 0.55)';
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
  ctx.fillStyle = 'rgba(230, 241, 251, 0.45)';
  ctx.fill();
  ctx.strokeStyle = '#B5D4F4';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  const hh = 26;
  ctx.save();
  roundRect(ctx, g.x, g.y, g.w, g.h, 12);
  ctx.clip();
  ctx.fillStyle = 'rgba(181, 212, 244, 0.5)';
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

function drawEdge(ctx, e, related, selected) {
  const pts = edgePoints(e);
  if (!pts || pts.length < 2) return;

  // 数据流叠加层：写=琥珀、读=青，与调用边的黑白灰区分开
  const isDf = e.kind === 'df-write' || e.kind === 'df-read';
  const dfColor = e.kind === 'df-write' ? '#C2410C' : '#0E7490';
  // 原有=黑、新增=红；删除沿用原色，另在中央画 X
  const color = isDf ? dfColor : EDGE_COLOR[e.change] || EDGE_COLOR.existing;
  ctx.save();
  ctx.beginPath();
  strokeRounded(ctx, pts);

  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 2.6 : related ? 2.4 : 1.4;
  const dfFocus = state.dfFocus;
  const dimByDf = dfFocus && !isDf && !dfFocus.has(e.from) && !dfFocus.has(e.to);
  ctx.globalAlpha = dimByDf ? 0.22 : state.selected && !related && !selected ? 0.26 : 1;
  // 变量访问=虚线，数据流=点线，函数调用=实线
  if (e.kind === 'var') ctx.setLineDash([7, 4]);
  else if (isDf) {
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = selected ? 2.8 : related ? 2.4 : 2;
  }
  ctx.stroke();
  ctx.setLineDash([]);

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

  // 数据流边在中间标注变量名，避免多条线分不清走的是哪个状态
  if (isDf && cam.k >= 0.45 && e.via) {
    const mi = Math.max(1, Math.floor(pts.length / 2));
    const p0 = pts[mi - 1];
    const p1 = pts[Math.min(pts.length - 1, mi)];
    const mx = (p0[0] + p1[0]) / 2;
    const my = (p0[1] + p1[1]) / 2;
    ctx.font = `10px ${FONT}`;
    const tw = ctx.measureText(e.via).width;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillRect(mx - tw / 2 - 3, my - 7, tw + 6, 14);
    ctx.fillStyle = dfColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(e.via, mx, my);
  }

  if (selected) {
    // 中间线段手柄（拖动可调整该段的走向，保持正交）
    const hs = 4.5 / cam.k;
    for (let i = 1; i <= pts.length - 3; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.beginPath();
      ctx.rect(mx - hs, my - hs, hs * 2, hs * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#185FA5';
      ctx.lineWidth = 1.5 / cam.k;
      ctx.stroke();
    }

    // 两端圆形手柄（可拖到其他节点上重连）
    const r = 5 / cam.k;
    for (const p of [pts[0], pts[pts.length - 1]]) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#185FA5';
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
    ctx.strokeStyle = '#2C2C2A';
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

function drawNode(ctx, n) {
  const { x, y, w, h } = n;
  const isVar = n.kind === 'var';
  const selected = state.selected === n.id;
  const hover = state.hover === n.id;
  const dropTarget = state.dragEnd && state.dragEnd.hover && state.dragEnd.hover.id === n.id;
  const dimByDf = state.dfFocus && !state.dfFocus.has(n.id);
  const dimmed = dimByDf || (state.selected && !selected && !isNeighbor(n.id));

  ctx.save();
  ctx.globalAlpha = dimmed ? 0.3 : 1;

  roundRect(ctx, x, y, w, h, 8);
  // 函数框按变更分类上色；变量框统一白底
  const baseFill = isVar
    ? n.external
      ? '#FAFAF7'
      : n.dfVar
      ? '#FFF7ED'
      : '#FFFFFF'
    : n.dfPeer
    ? '#FDF6EC'
    : CHANGE_FILL[n.change] || CHANGE_FILL.existing;
  ctx.fillStyle = dropTarget ? '#EAF3DE' : n.color || baseFill;
  ctx.fill();

  ctx.lineWidth = dropTarget ? 2.6 : selected ? 2.2 : hover ? 1.6 : 1;
  ctx.strokeStyle = dropTarget
    ? '#639922'
    : selected
    ? '#185FA5'
    : hover
    ? '#378ADD'
    : n.external
    ? '#D3D1C7'
    : isVar
    ? '#5A5A55'
    : '#3A3A36';
  // 函数用虚线框，变量用实线框
  if (!isVar) ctx.setLineDash([5, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  if (n.note) {
    ctx.beginPath();
    ctx.arc(x + 8, y + 8, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#EF9F27';
    ctx.fill();
  }

  const cx = x + w / 2;

  if (cam.k >= 0.32) {
    ctx.fillStyle = '#2C2C2A';
    ctx.font = `500 12.5px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 函数名统一带 ()，变量名不带，便于一眼区分
    let label = isVar ? n.name || n.id : `${n.name || n.id}()`;
    const maxW = w - 18;
    if (ctx.measureText(label).width > maxW) {
      while (label.length > 4 && ctx.measureText(label + '…').width > maxW) {
        label = label.slice(0, -1);
      }
      label += '…';
    }
    ctx.fillText(label, cx, y + (cam.k >= 0.62 ? h / 2 - 8 : h / 2));

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
