import { t, applyI18n } from './i18n.js';
import { routeEdges, collectSegments, nearestSide, roundedPathD } from '/core/routing.js';

window.addEventListener('error', (e) => {
  console.error('PAGE_ERROR', e.message, `${e.filename}:${e.lineno}:${e.colno}`);
  document.body.setAttribute('data-err', `${e.message} @${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const m = (e.reason && (e.reason.stack || e.reason.message)) || String(e.reason);
  console.error('PAGE_REJECT', m);
  document.body.setAttribute('data-err', 'REJECT: ' + m);
});

const els = {
  cv: document.getElementById('cv'),
  ctx: document.getElementById('cv').getContext('2d'),
  search: document.getElementById('search'),
  depth: document.getElementById('depth'),
  updepth: document.getElementById('updepth'),
  fit: document.getElementById('fit'),
  resetLayout: document.getElementById('resetLayout'),
  groupMode: document.getElementById('groupMode'),
  stats: document.getElementById('stats'),
  results: document.getElementById('results'),
  detail: document.getElementById('detail'),
  edges: document.getElementById('edges'),
  rootName: document.getElementById('rootName'),
  tooltip: document.getElementById('tooltip'),
  restoreDeleted: document.getElementById('restoreDeleted'),
};

const state = {
  view: null,
  root: null,
  selected: null,
  hover: null,
  down: 3,
  up: 0,
  group: true,
  selectedEdge: null,
  dragSeg: null,
  dragEnd: null,
  dragNode: null,
  dragStart: null,
  dragMoved: false,
  panning: false,
  linkFrom: null,
  linkPos: null,
  /** 点击标题后的短暂高亮：{ box, until, dur } */
  flash: null,
};

const cam = { x: 0, y: 0, k: 1 };

/** 最近的删除记录栈，Ctrl+Z 可以逐次恢复 */
const deleteStack = [];

const COLORS = {
  direct: '#9A9890',
  macro: '#D85A30',
  fnptr: '#7F77DD',
  manual: '#639922',
  unknown: '#C9C7BE',
};

const FONT = '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

const shortFile = (f) => {
  if (!f) return '';
  const parts = String(f).split(/[\\/]/);
  return parts.slice(-2).join('/');
};

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const nodeById = (id) => (state.view ? state.view.nodes.find((n) => n.id === id) : null);

// ---------------- 画布 ----------------

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

/** 节点只能在所属文件框内移动，避免跑出框外导致结构散架 */
function clampToGroup(n) {
  const v = state.view;
  if (!v || !v.groups || !n.group) return;
  const g = v.groups.find((x) => x.id === n.group);
  if (!g) return;
  const pad = 8;
  const left = g.x + pad;
  const right = g.x + g.w - n.w - pad;
  const top = g.y + 32;
  const bottom = g.y + g.h - n.h - pad;
  if (right >= left) n.x = Math.max(left, Math.min(right, n.x));
  if (bottom >= top) n.y = Math.max(top, Math.min(bottom, n.y));
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
  ctx.lineWidth = 1.2;
  ctx.setLineDash([5, 4]);
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

  const color = COLORS[e.kind] || COLORS.direct;
  ctx.save();
  ctx.beginPath();
  strokeRounded(ctx, pts);

  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 2.6 : related ? 2.4 : e.kind === 'manual' ? 1.8 : 1.3;
  ctx.globalAlpha = state.selected && !related && !selected ? 0.26 : 1;
  if (e.kind === 'macro' || e.kind === 'fnptr') ctx.setLineDash([5, 3]);
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

  ctx.restore();
}

function drawNode(ctx, n) {
  const { x, y, w, h } = n;
  const selected = state.selected === n.id;
  const hover = state.hover === n.id;
  const dropTarget = state.dragEnd && state.dragEnd.hover && state.dragEnd.hover.id === n.id;
  const dimmed = state.selected && !selected && !isNeighbor(n.id);

  ctx.save();
  ctx.globalAlpha = dimmed ? 0.3 : 1;

  roundRect(ctx, x, y, w, h, 8);
  ctx.fillStyle = dropTarget ? '#EAF3DE' : n.color || (n.external ? '#FAFAF7' : '#FFFFFF');
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
    : '#B5D4F4';
  if (n.external) ctx.setLineDash([4, 3]);
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

    let label = n.name || n.id;
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
      const sub = n.external ? t('node.external') : `${shortFile(n.file)}:${n.line}`;
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

function fit() {
  const v = state.view;
  if (!v) return;
  const W = els.cv.clientWidth;
  const H = els.cv.clientHeight;
  const k = Math.min(W / v.width, H / v.height, 1.8) * 0.93;
  cam.k = Math.max(0.08, k);
  cam.x = (W - v.width * cam.k) / 2;
  cam.y = (H - v.height * cam.k) / 2;
  draw();
}

// ---------------- 视角动画 ----------------

const camAnim = { on: false, t0: 0, dur: 420, from: null, to: null };

function stopCamAnim() {
  camAnim.on = false;
}

function stepCam(now) {
  if (!camAnim.on) return;
  const t = Math.min(1, (now - camAnim.t0) / camAnim.dur);
  const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
  const f = camAnim.from;
  const to = camAnim.to;
  cam.x = f.x + (to.x - f.x) * e;
  cam.y = f.y + (to.y - f.y) * e;
  cam.k = f.k + (to.k - f.k) * e;
  draw();
  if (t < 1) requestAnimationFrame(stepCam);
  else camAnim.on = false;
}

function animateCam(to, dur = 420) {
  camAnim.on = true;
  camAnim.t0 = performance.now();
  camAnim.dur = dur;
  camAnim.from = { x: cam.x, y: cam.y, k: cam.k };
  camAnim.to = to;
  requestAnimationFrame(stepCam);
}

/** 把文件框 / 目录容器整体居中并适配到视野 */
function focusBox(box, pad = 90) {
  const W = els.cv.clientWidth;
  const H = els.cv.clientHeight;
  if (!W || !H || !box.w || !box.h) return;
  const k = Math.max(0.08, Math.min(W / (box.w + pad * 2), H / (box.h + pad * 2), 1.6));
  animateCam({
    x: W / 2 - (box.x + box.w / 2) * k,
    y: H / 2 - (box.y + box.h / 2) * k,
    k,
  });
}

// ---------------- 数据 ----------------

async function loadView(rootId) {
  const q = new URLSearchParams({
    down: state.down,
    up: state.up,
    group: state.group ? '1' : '0',
  });
  if (rootId) q.set('root', rootId);
  const res = await fetch('/api/view?' + q);
  const data = await res.json();
  state.view = data;
  state.root = data.root;
  state.selected = null;
  state.selectedEdge = null;
  modifiedNodes.clear(); // 新视图的节点都是自动布局位置，尚未被拖动
  if (data.edges && data.edges.some((e) => !e.points || e.points.length < 2)) {
    fullReroute(); // 兜底：服务端数据缺折线时本地补算
  }
  const rootNode = data.nodes.find((n) => n.id === data.root);
  els.rootName.textContent = rootNode ? `· ${rootNode.name}` : '';
  fit();
  renderDetail(null);
  history.stack = [];
  history.idx = -1;
  pushHistory();
}
async function loadStats() {
  const d = await (await fetch('/api/stats')).json();
  const s = d.stats;
  const row = (label, val) => `<div class="stat-row"><span>${label}</span><span>${val}</span></div>`;
  els.stats.innerHTML = [
    row(t('stat.files'), s.files),
    row(t('stat.functions'), s.functions),
    row(t('stat.edges'), s.edges),
    // 只有存在重复调用（同一对函数被调多次）时才显示，用来解释与边数的差额
    ...(s.calls && s.calls !== s.edges ? [row(t('stat.calls'), s.calls)] : []),
    row(t('stat.macros'), s.macros),
    row(t('stat.macroEdges'), s.macroEdges),
    row(t('stat.fnptrEdges'), s.fnptrEdges),
    row(t('stat.cycles'), s.cycles),
    row(t('stat.maxFanOut'), s.maxFanOut),
  ].join('') +
    (s.files > 1500
      ? '<div class="stat-row" style="color:#993C1D"><span>提示</span><span>文件较多，首次解析稍慢</span></div>'
      : '');

  // 有删除记录时才让「恢复删除」可点，并在按钮上显示数量
  const del = d.deleted || { nodes: 0, edges: 0 };
  const delTotal = (del.nodes || 0) + (del.edges || 0);
  if (els.restoreDeleted) {
    els.restoreDeleted.disabled = delTotal === 0;
    els.restoreDeleted.textContent = delTotal
      ? `${t('btn.restoreDeleted')} (${delTotal})`
      : t('btn.restoreDeleted');
  }
}

// ---------------- 文件树 ----------------

let treeData = null;

async function loadTree() {
  try {
    treeData = await (await fetch('/api/tree')).json();
    renderTree();
  } catch {
    document.getElementById('tree').innerHTML = '<div class="empty">加载失败</div>';
  }
}

function renderTree() {
  const el = document.getElementById('tree');
  if (!el) return;
  el.innerHTML = '';
  if (!treeData) return;
  const frag = document.createDocumentFragment();
  for (const child of treeData.children || []) frag.appendChild(buildTreeNode(child, 0));
  el.appendChild(frag);
}

function buildTreeNode(node, depth) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'tn ' + node.type;
  row.style.paddingLeft = depth * 12 + 'px';

  const hasKids =
    (node.children && node.children.length) || (node.functions && node.functions.length);
  const tw = document.createElement('span');
  tw.className = 'tw';
  tw.textContent = hasKids ? '▸' : '';
  row.appendChild(tw);

  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = node.name;
  nm.title = node.path;
  row.appendChild(nm);
  wrap.appendChild(row);

  const kids = document.createElement('div');
  const openByDefault = node.type === 'dir';
  kids.style.display = openByDefault ? 'block' : 'none';
  if (openByDefault && hasKids) tw.textContent = '▾';
  if (node.children) for (const c of node.children) kids.appendChild(buildTreeNode(c, depth + 1));
  if (node.functions) {
    for (const f of node.functions) {
      const fr = document.createElement('div');
      fr.className = 'tn fn';
      fr.style.paddingLeft = (depth + 1) * 12 + 'px';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.id = f.id;
      const lab = document.createElement('span');
      lab.className = 'nm';
      lab.textContent = f.name;
      lab.title = `${node.path}:${f.line}`;
      fr.appendChild(cb);
      fr.appendChild(lab);
      kids.appendChild(fr);
    }
  }
  wrap.appendChild(kids);

  row.addEventListener('click', (ev) => {
    if (ev.target.tagName === 'INPUT' || !hasKids) return;
    const open = kids.style.display !== 'none';
    kids.style.display = open ? 'none' : 'block';
    tw.textContent = open ? '▸' : '▾';
  });

  kids.addEventListener('change', (ev) => {
    if (ev.target.tagName !== 'INPUT') return;
    const id = ev.target.dataset.id;
    if (!ev.target.checked) return;
    document.querySelectorAll('#tree input[type=checkbox]').forEach((c) => {
      if (c !== ev.target) c.checked = false;
    });
    loadView(id);
  });

  return wrap;
}

let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 140);
});

async function runSearch() {
  const q = els.search.value.trim();
  if (!q) {
    els.results.innerHTML = `<li class="empty">${t('empty.search')}</li>`;
    return;
  }
  const list = await (await fetch('/api/search?q=' + encodeURIComponent(q))).json();
  if (!list.length) {
    els.results.innerHTML = `<li class="empty">${t('empty.noMatch')}</li>`;
    return;
  }
  els.results.innerHTML = list
    .map(
      (f) => `<li data-id="${esc(f.id)}">
        <div class="fn">${esc(f.name)}</div>
        <div class="meta">${esc(shortFile(f.file))}:${f.line} · ↑${f.inCount} ↓${f.outCount}</div>
      </li>`
    )
    .join('');
}

els.results.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  loadView(li.dataset.id);
});

els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = els.results.querySelector('li[data-id]');
    if (first) loadView(first.dataset.id);
  }
});

// ---------------- 详情 ----------------

async function renderDetail(id) {
  if (!id) {
    els.detail.innerHTML = `<div class="empty">${t('empty.detail')}</div>`;
    els.edges.innerHTML = `<div class="empty">${t('empty.edges')}</div>`;
    return;
  }
  const d = await (await fetch('/api/node?id=' + encodeURIComponent(id))).json();
  if (d.error) return;
  const n = d.node;
  const ov = d.overlay || {};
  const colorList = ['', '#FCEBEB', '#FAEEDA', '#EAF3DE', '#E6F1FB', '#EEEDFE', '#FBEAF0'];

  els.detail.innerHTML = `
    <div class="detail-title">${esc(n.name)}</div>
    <div class="detail-meta">${esc(n.file)}:${n.line}${n.isStatic ? ' · ' + t('node.static') : ''}${n.external ? ' · ' + t('node.externalTag') : ''}</div>
    <div class="field">
      <label>${t('detail.note')}</label>
      <textarea id="note" rows="3" placeholder="${t('detail.notePlaceholder')}">${esc(ov.note || '')}</textarea>
    </div>
    <div class="field">
      <label>${t('detail.color')}</label>
      <div class="swatches" id="swatches">
        ${colorList
          .map(
            (c) =>
              `<div class="sw ${(ov.color || '') === c ? 'on' : ''}" data-color="${c}" style="background:${c || '#fff'};border-color:${c ? 'transparent' : '#D3D1C7'}"></div>`
          )
          .join('')}
      </div>
    </div>
    <div class="field">
      <label>${t('detail.tag')}</label>
      <input id="tag" type="text" placeholder="${t('detail.tagPlaceholder')}" value="${esc(ov.tag || '')}">
    </div>
    <button class="primary" id="saveNote" style="width:100%">${t('detail.save')}</button>
  `;

  let pickedColor = ov.color || '';
  els.detail.querySelector('#swatches').addEventListener('click', (e) => {
    const sw = e.target.closest('.sw');
    if (!sw) return;
    pickedColor = sw.dataset.color;
    els.detail.querySelectorAll('.sw').forEach((s) => s.classList.toggle('on', s === sw));
  });

  els.detail.querySelector('#saveNote').addEventListener('click', async () => {
    const note = els.detail.querySelector('#note').value;
    const tag = els.detail.querySelector('#tag').value;
    await fetch('/api/overlay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: id, data: { note, tag, color: pickedColor } }),
    });
    const target = nodeById(id);
    if (target) {
      target.note = note;
      target.tag = tag;
      target.color = pickedColor;
    }
    draw();
    pushHistory();
    const btn = els.detail.querySelector('#saveNote');
    btn.textContent = t('detail.saved');
    setTimeout(() => (btn.textContent = t('detail.save')), 1200);
  });

  const inE = d.inEdges || [];
  const outE = d.outEdges || [];
  const item = (e, dir) => {
    const other = dir === 'in' ? e.from : e.to;
    const nm = e.callee || other.split('::')[1] || other;
    let chip = '';
    if (e.kind === 'macro') chip = `<span class="chip macro">宏${e.via ? ':' + esc(e.via) : ''}</span>`;
    else if (e.kind === 'fnptr') chip = `<span class="chip fnptr">指针${e.via ? ':' + esc(e.via) : ''}</span>`;
    else if (e.kind === 'manual') chip = `<span class="chip manual">手动</span>`;
    const cond = e.cond ? `<span class="chip">${esc(e.cond)}</span>` : '';
    return `<div class="edge-item">${dir === 'in' ? '←' : '→'} <b>${esc(dir === 'in' ? other.split('::').pop() : nm)}</b> <span style="color:#B4B2A9">:${e.line}</span> ${chip}${cond}</div>`;
  };

  els.edges.innerHTML =
    (inE.length
      ? `<div style="font-size:11.5px;color:#888780;margin-bottom:4px">${t('edge.calledBy')} (${inE.length})</div>` +
        inE.map((e) => item(e, 'in')).join('')
      : '') +
      (outE.length
        ? `<div style="font-size:11.5px;color:#888780;margin:8px 0 4px">${t('edge.calls')} (${outE.length})</div>` +
          outE.map((e) => item(e, 'out')).join('')
        : '') || `<div class="empty">${t('empty.noEdges')}</div>`;
}

// ---------------- 交互 ----------------

function worldPos(e) {
  const rect = els.cv.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left - cam.x) / cam.k,
    y: (e.clientY - rect.top - cam.y) / cam.k,
  };
}

function hitTest(e) {
  if (!state.view) return null;
  const p = worldPos(e);
  const nodes = state.view.nodes;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h) return n;
  }
  return null;
}

/**
 * 命中文件框 / 目录容器的标题：点击标题把该区域整体居中放大。
 * 文件框有标题栏（整条可点），目录容器只有左上角一行文字，按实际文字宽度判定，
 * 避免大容器的标题命中区挡住内部的文件框
 */
function hitTitle(e) {
  const v = state.view;
  if (!v) return null;
  const p = worldPos(e);

  for (const g of v.groups || []) {
    if (p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + 26) {
      return { box: g, kind: 'file' };
    }
  }

  // 深层的先判，避免被外层容器的大标题区吞掉
  const conts = (v.containers || []).slice().sort((a, b) => b.depth - a.depth);
  for (const c of conts) {
    const fs = Math.min(22, Math.max(12, 11 / cam.k));
    els.ctx.font = `600 ${fs}px ${FONT}`;
    const tw = els.ctx.measureText(String(c.label)).width;
    const padX = fs * 0.5;
    const bh = fs * 1.4;
    // 与 drawContainer 里标题胶囊的几何保持一致
    if (p.x >= c.x + 2 && p.x <= c.x + 10 + tw + padX * 2 && p.y >= c.y + 2 && p.y <= c.y + 8 + bh) {
      return { box: c, kind: 'dir' };
    }
  }
  return null;
}

/** 节点是否与其它节点相撞（留一点视觉间隙，避免边框贴死） */
function collidesWith(n, pad = 6) {
  const v = state.view;
  if (!v) return false;
  for (const o of v.nodes) {
    if (o.id === n.id) continue;
    if (
      n.x < o.x + o.w + pad &&
      n.x + n.w + pad > o.x &&
      n.y < o.y + o.h + pad &&
      n.y + n.h + pad > o.y
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 拖动落位：整体移动被挡住时退化为单轴滑动（贴着别的节点滑过去），
 * 两个方向都过不去就停在原位 —— 保证拖动过程中节点之间永不重叠
 */
function moveNodeNoOverlap(n, tx, ty) {
  const ox = n.x;
  const oy = n.y;

  n.x = tx;
  n.y = ty;
  clampToGroup(n);
  if (!collidesWith(n)) return;

  n.x = tx;
  n.y = oy;
  clampToGroup(n);
  if (!collidesWith(n)) return;

  n.x = ox;
  n.y = ty;
  clampToGroup(n);
  if (!collidesWith(n)) return;

  n.x = ox;
  n.y = oy;
}

/** 边的折线由共享路由器维护（严格正交）；此处只做读取 */
function edgePoints(e) {
  return (e && e.points) || [];
}

/** 对一组边做增量重路由（其余边的线段作为避让约束） */
function rerouteScope(subset) {
  const v = state.view;
  if (!v || !subset.length) return;
  const others = v.edges.filter((e) => !subset.includes(e));
  routeEdges(v.nodes, subset, { existing: collectSegments(others) });
}

/** 节点拖动过程中：只实时重路由与该节点相连的边 */
function liveReroute(nodeId) {
  const v = state.view;
  if (!v) return;
  rerouteScope(v.edges.filter((e) => e.from === nodeId || e.to === nodeId));
}

/** 全量重路由（拖拽结束等时机），并扩展画布尺寸 */
function fullReroute() {
  const v = state.view;
  if (!v) return;
  routeEdges(v.nodes, v.edges, { bounds: { minX: 40, maxX: Math.max(v.width, 600) } });
  let maxX = 0;
  let maxY = 0;
  for (const n of v.nodes) {
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  for (const e of v.edges) {
    for (const p of e.points || []) {
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  v.width = Math.max(v.width, maxX + 40);
  v.height = Math.max(v.height, maxY + 40);
}

function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a[0], p.y - a[1]);
  let t = ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy));
}

function hitEdge(e) {
  if (!state.view) return null;
  const p = worldPos(e);
  let best = null;
  let bestD = 9 / cam.k;
  for (const edge of state.view.edges) {
    const pts = edgePoints(edge);
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distToSegment(p, pts[i], pts[i + 1]);
      if (d < bestD) {
        bestD = d;
        best = edge;
      }
    }
  }
  return best;
}

/** 命中选中边的中间线段手柄（水平段/垂直段，拖动可调整走向） */
function hitSegment(e) {
  if (!state.selectedEdge) return null;
  const p = worldPos(e);
  const pts = edgePoints(state.selectedEdge);
  const r = 8 / cam.k;
  for (let i = 1; i <= pts.length - 3; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    if (Math.hypot(p.x - mx, p.y - my) <= r) {
      const orient = Math.abs(pts[i + 1][0] - pts[i][0]) < 0.5 ? 'v' : 'h';
      return { edge: state.selectedEdge, index: i, orient };
    }
  }
  return null;
}

function hitEnd(e) {
  if (!state.selectedEdge) return null;
  const p = worldPos(e);
  const pts = edgePoints(state.selectedEdge);
  const r = 10 / cam.k;
  if (Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) <= r) return 'from';
  const last = pts[pts.length - 1];
  if (Math.hypot(p.x - last[0], p.y - last[1]) <= r) return 'to';
  return null;
}

const edgeKey = (e) => `${e.from}->${e.to}:${e.line}`;
const modifiedEdges = new Set();
/** 被用户拖动过的节点：只有这些节点的坐标需要持久化 */
const modifiedNodes = new Set();

/** 拖动线段：水平段只改 y、垂直段只改 x —— 正交性由构造保证 */
function moveSeg(seg, x, y) {
  const pts = seg.edge.points;
  const i = seg.index;
  if (seg.orient === 'h') {
    pts[i][1] = y;
    pts[i + 1][1] = y;
  } else {
    pts[i][0] = x;
    pts[i + 1][0] = x;
  }
}

let justDragged = false;

els.cv.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  stopCamAnim();

  const end = hitEnd(e);
  if (end) {
    state.dragEnd = { edge: state.selectedEdge, which: end, pos: worldPos(e), hover: null };
    els.cv.setPointerCapture(e.pointerId);
    return;
  }

  const seg = hitSegment(e);
  if (seg) {
    seg.edge.custom = true; // 从此该边折线由用户接管
    state.dragSeg = seg;
    els.cv.style.cursor = seg.orient === 'h' ? 'row-resize' : 'col-resize';
    els.cv.setPointerCapture(e.pointerId);
    return;
  }

  // 点标题：把该文件框 / 目录容器整体居中放大
  const title = hitTitle(e);
  if (title) {
    focusBox(title.box);
    state.flash = { box: title.box, until: performance.now() + 1300, dur: 1300 };
    draw();
    return;
  }

  const n = hitTest(e);

  if (n && e.shiftKey) {
    state.linkFrom = n;
    state.linkPos = worldPos(e);
    els.cv.classList.add('linking');
    els.cv.setPointerCapture(e.pointerId);
    return;
  }

  if (n) {
    state.dragNode = n;
    state.dragStart = { x: e.clientX, y: e.clientY, nx: n.x, ny: n.y };
    state.dragMoved = false;
    els.cv.setPointerCapture(e.pointerId);
    return;
  }

  state.panning = true;
  state.panMoved = false;
  state.last = { x: e.clientX, y: e.clientY };
  els.cv.classList.add('panning');
  els.cv.setPointerCapture(e.pointerId);
});

els.cv.addEventListener('pointermove', (e) => {
  if (state.dragEnd) {
    state.dragEnd.pos = worldPos(e);
    const n = hitTest(e);
    const other = state.dragEnd.which === 'from' ? state.dragEnd.edge.to : state.dragEnd.edge.from;
    state.dragEnd.hover = n && n.id !== other ? n : null;
    draw();
    return;
  }

  if (state.dragSeg) {
    const p = worldPos(e);
    moveSeg(state.dragSeg, p.x, p.y);
    draw();
    return;
  }

  if (state.dragNode) {
    const rawDx = (e.clientX - state.dragStart.x) / cam.k;
    const rawDy = (e.clientY - state.dragStart.y) / cam.k;
    moveNodeNoOverlap(state.dragNode, state.dragStart.nx + rawDx, state.dragStart.ny + rawDy);
    if (Math.abs(rawDx) + Math.abs(rawDy) > 3) state.dragMoved = true;
    liveReroute(state.dragNode.id); // 相连的边实时避障重布
    draw();
    return;
  }

  if (state.linkFrom) {
    state.linkPos = worldPos(e);
    draw();
    return;
  }

  if (state.panning) {
    const dx = e.clientX - state.last.x;
    const dy = e.clientY - state.last.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) state.panMoved = true;
    cam.x += dx;
    cam.y += dy;
    state.last = { x: e.clientX, y: e.clientY };
    draw();
    return;
  }

  const n = hitTest(e);
  const next = n ? n.id : null;
  if (next !== state.hover) {
    state.hover = next;
    els.cv.classList.toggle('over-node', !!next);
    draw();
  }
  // 标题上显示可点击
  els.cv.style.cursor = next ? '' : hitTitle(e) ? 'pointer' : '';

  // 光标反馈：选中边的端点 / 线段手柄
  if (state.selectedEdge) {
    let cursor = '';
    if (hitEnd(e)) cursor = 'crosshair';
    else {
      const seg = hitSegment(e);
      if (seg) cursor = seg.orient === 'h' ? 'row-resize' : 'col-resize';
    }
    els.cv.style.cursor = cursor;
  } else if (els.cv.style.cursor) {
    els.cv.style.cursor = '';
  }

  if (n) {
    const rect = els.cv.getBoundingClientRect();
    els.tooltip.style.opacity = '1';
    els.tooltip.style.left = e.clientX - rect.left + 14 + 'px';
    els.tooltip.style.top = e.clientY - rect.top + 14 + 'px';
    els.tooltip.innerHTML = `<b>${esc(n.name)}</b><br><span style="opacity:.7">${esc(n.file)}:${n.line}</span><br><span style="opacity:.5;font-size:11px">Shift+拖拽 可连到其他函数</span>`;
  } else {
    els.tooltip.style.opacity = '0';
  }
});

els.cv.addEventListener('pointerup', (e) => {
  els.cv.classList.remove('panning', 'linking');
  els.cv.style.cursor = '';

  if (state.dragEnd) {
    const { edge, which, hover, pos } = state.dragEnd;
    state.dragEnd = null;
    if (hover) {
      if (which === 'from') {
        edge.from = hover.id;
        edge.fromSide = nearestSide(hover, pos);
      } else {
        edge.to = hover.id;
        edge.toSide = nearestSide(hover, pos);
      }
      edge.custom = false; // 重连后恢复自动布线
      modifiedEdges.add(edgeKey(edge));
      rerouteScope([edge]);
      saveLayout();
      pushHistory();
    }
    draw();
    return;
  }

  if (state.dragSeg) {
    modifiedEdges.add(edgeKey(state.dragSeg.edge));
    state.dragSeg = null;
    saveLayout();
    pushHistory();
    draw();
    return;
  }

  if (state.dragNode) {
    const n = state.dragNode;
    const moved = state.dragMoved;
    state.dragNode = null;
    state.dragMoved = false;
    if (moved) {
      justDragged = true;
      setTimeout(() => (justDragged = false), 260);
      modifiedNodes.add(n.id);
      fullReroute(); // 松手后全量避障重布
      for (const ed of state.view.edges) {
        if (ed.custom) modifiedEdges.add(edgeKey(ed)); // 自定义边折线已随重锚定更新
      }
      saveLayout();
      pushHistory();
    } else {
      selectNode(n.id);
    }
    draw();
    return;
  }

  if (state.linkFrom) {
    const from = state.linkFrom;
    const target = hitTest(e);
    state.linkFrom = null;
    state.linkPos = null;
    if (target && target.id !== from.id) addManualEdge(from.id, target.id);
    draw();
    return;
  }

  if (state.panning) {
    state.panning = false;
    if (!state.panMoved) {
      const edge = hitEdge(e);
      if (edge) {
        state.selectedEdge = edge;
        state.selected = null;
        draw();
        renderDetail(null);
      } else {
        state.selectedEdge = null;
        selectNode(null);
      }
    }
    return;
  }
});

els.cv.addEventListener('dblclick', (e) => {
  if (justDragged) return;
  const n = hitTest(e);
  if (n) {
    loadView(n.id);
    return;
  }
  // 双击手动布线的边：恢复自动布线
  const edge = hitEdge(e);
  if (edge && edge.custom) {
    edge.custom = false;
    modifiedEdges.add(edgeKey(edge));
    rerouteScope([edge]);
    saveLayout();
    draw();
  }
});

els.cv.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    stopCamAnim();
    const rect = els.cv.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wx = (sx - cam.x) / cam.k;
    const wy = (sy - cam.y) / cam.k;
    cam.k = Math.min(4, Math.max(0.06, cam.k * Math.exp(-e.deltaY * 0.0014)));
    cam.x = sx - wx * cam.k;
    cam.y = sy - wy * cam.k;
    draw();
  },
  { passive: false }
);

function selectNode(id) {
  state.selected = id;
  draw();
  renderDetail(id);
}

// ---------------- 删除函数 / 连线 ----------------

async function postDelete(body) {
  await fetch('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 重新拉取视图但保留当前视角，避免删除后画面突然跳走 */
async function reloadKeepCam() {
  const before = { x: cam.x, y: cam.y, k: cam.k };
  await loadView(state.root);
  cam.x = before.x;
  cam.y = before.y;
  cam.k = before.k;
  draw();
}

async function deleteSelection() {
  const v = state.view;
  if (!v) return;
  let body = null;

  if (state.selectedEdge) {
    body = { edges: [edgeKey(state.selectedEdge)] };
  } else if (state.selected) {
    body = { nodes: [state.selected] };
  } else {
    return;
  }

  // 删掉的正是当前入口时，回退到自动选择入口，避免停在一个空视图上
  if (body.nodes && body.nodes.includes(state.root)) state.root = null;

  await postDelete(body);
  deleteStack.push({ ...body, at: Date.now() });
  if (deleteStack.length > 30) deleteStack.shift();

  state.selected = null;
  state.selectedEdge = null;
  state.hover = null;
  await reloadKeepCam();
  renderDetail(null);
  pushHistory();
  loadStats();
}

async function restoreLastDelete() {
  const rec = deleteStack.pop();
  if (!rec) return false;
  await postDelete({ nodes: rec.nodes || [], edges: rec.edges || [], restore: true });
  await reloadKeepCam();
  pushHistory();
  loadStats(); // 同步「恢复删除 (N)」上的计数
  return true;
}

// ---------------- 撤回 / 重做 ----------------

const history = { stack: [], idx: -1, limit: 60, frozen: false };

function snapshotView() {
  const v = state.view;
  if (!v) return null;
  return JSON.stringify({
    nodes: v.nodes.map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      group: n.group,
      name: n.name,
      file: n.file,
      line: n.line,
      color: n.color,
      note: n.note,
      external: n.external,
    })),
    edges: v.edges.map((e) => ({
      from: e.from,
      to: e.to,
      callee: e.callee,
      kind: e.kind,
      line: e.line,
      via: e.via,
      cond: e.cond,
      manual: e.manual,
      fromSide: e.fromSide,
      toSide: e.toSide,
      custom: e.custom,
      points: e.points,
    })),
    groups: v.groups || null,
  });
}

function pushHistory() {
  if (history.frozen || !state.view) return;
  const snap = snapshotView();
  if (!snap) return;
  if (history.idx >= 0 && history.stack[history.idx] === snap) return;
  history.stack = history.stack.slice(0, history.idx + 1);
  history.stack.push(snap);
  if (history.stack.length > history.limit) history.stack.shift();
  history.idx = history.stack.length - 1;
  updateHistoryButtons();
}

function applySnapshot(str) {
  const s = JSON.parse(str);
  const v = state.view;
  if (!v) return;
  v.nodes = s.nodes;
  v.edges = s.edges.map((e) => ({ ...e }));
  if (s.groups) v.groups = s.groups;
  state.selected = null;
  state.selectedEdge = null;
  state.hover = null;
  draw();
  saveLayout(true);
  updateHistoryButtons();
}

function undo() {
  if (history.idx <= 0) return;
  history.idx--;
  history.frozen = true;
  applySnapshot(history.stack[history.idx]);
  history.frozen = false;
}

function redo() {
  if (history.idx >= history.stack.length - 1) return;
  history.idx++;
  history.frozen = true;
  applySnapshot(history.stack[history.idx]);
  history.frozen = false;
}

function updateHistoryButtons() {
  const u = document.getElementById('undoBtn');
  const r = document.getElementById('redoBtn');
  if (u) u.disabled = history.idx <= 0;
  if (r) r.disabled = history.idx >= history.stack.length - 1;
}

document.getElementById('undoBtn')?.addEventListener('click', undo);
document.getElementById('redoBtn')?.addEventListener('click', redo);

window.addEventListener('keydown', (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) {
      redo();
    } else if (deleteStack.length && Date.now() - deleteStack[deleteStack.length - 1].at < 20000) {
      // 优先恢复刚删掉的函数 / 连线（20 秒内有效，可逐次回退）
      restoreLastDelete();
    } else {
      undo();
    }
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selected || state.selectedEdge) {
      e.preventDefault();
      deleteSelection();
    }
  }
});

async function saveLayout(full = false) {
  // 只持久化真正被拖动过的节点：未拖动的节点每次都由自动布局重新计算，
  // 否则切换入口/调整深度后旧坐标会套用到新布局上，导致节点跑到文件框外
  const nodes = {};
  for (const n of state.view.nodes) {
    if (!full && !modifiedNodes.has(n.id)) continue;
    nodes[n.id] = { x: Math.round(n.x), y: Math.round(n.y) };
  }

  const edges = {};
  for (const e of state.view.edges) {
    const k = edgeKey(e);
    if (!full && !modifiedEdges.has(k)) continue;
    const rec = {};
    if (Array.isArray(e.points) && e.points.length >= 2 && (full || e.custom)) {
      rec.custom = true;
      rec.points = e.points.map((p) => [Math.round(p[0]), Math.round(p[1])]);
    }
    if (e.fromSide) rec.fromSide = e.fromSide;
    if (e.toSide) rec.toSide = e.toSide;
    if (Object.keys(rec).length) edges[k] = rec;
  }

  await fetch('/api/layout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      root: state.root,
      nodes,
      manual: collectManual(),
      edges,
      mode: state.group ? 'group' : 'flat',
    }),
  });
}

function collectManual() {
  return state.view.edges.filter((e) => e.manual).map((e) => ({ from: e.from, to: e.to }));
}

async function addManualEdge(from, to) {
  const a = nodeById(from);
  const b = nodeById(to);
  if (!a || !b) return;
  const e = {
    from,
    to,
    callee: b.name,
    kind: 'manual',
    line: 0,
    via: '手动',
    manual: true,
  };
  state.view.edges.push(e);
  rerouteScope([e]); // 由共享路由器布线
  draw();
  await fetch('/api/layout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      manual: collectManual(),
      mode: state.group ? 'group' : 'flat',
    }),
  });
  pushHistory();
}

window.addEventListener('keydown', (e) => {
  if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
  if (e.key === 'f' || e.key === 'F') fit();
});

els.depth.addEventListener('change', () => {
  state.down = Number(els.depth.value);
  loadView(state.root);
});
els.updepth.addEventListener('change', () => {
  state.up = Number(els.updepth.value);
  loadView(state.root);
});

els.groupMode.addEventListener('change', () => {
  state.group = els.groupMode.checked;
  state.selectedEdge = null;
  loadView(state.root);
});
els.fit.addEventListener('click', fit);

els.resetLayout.addEventListener('click', async () => {
  await fetch('/api/layout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clear: true,
      root: state.root,
      mode: state.group ? 'group' : 'flat',
    }),
  });
  modifiedEdges.clear();
  modifiedNodes.clear();
  loadView(state.root);
});

// 一次性恢复所有被删除的函数与连线
els.restoreDeleted.addEventListener('click', async () => {
  await fetch('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clear: true }),
  });
  deleteStack.length = 0;
  await reloadKeepCam();
  await loadStats();
});

// ---------------- 导出 ----------------

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function buildSVG() {
  const v = state.view;
  updateGroups(); // 分组框跟随当前节点位置
  const pad = 24;

  // 实际内容范围（含手动布线 / 侧边车道）
  let minX = 0;
  let minY = 0;
  let maxX = v.width;
  let maxY = v.height;
  for (const n of v.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  for (const e of v.edges) {
    for (const p of e.points || []) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  const ox = -pad - Math.min(0, minX);
  const oy = -pad - Math.min(0, minY);
  const W = maxX - minX + pad * 2;
  const H = maxY - minY + pad * 2;

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${ox} ${oy} ${W} ${H}" font-family="Segoe UI, Microsoft YaHei, sans-serif">`
  );
  out.push(`<rect x="${ox}" y="${oy}" width="${W}" height="${H}" fill="#F7F6F2"/>`);
  out.push('<defs>');
  for (const [k, c] of Object.entries(COLORS)) {
    out.push(
      `<marker id="mk-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/></marker>`
    );
  }
  out.push('</defs>');

  if (v.groups) {
    for (const g of v.groups) {
      out.push(
        `<rect x="${g.x.toFixed(1)}" y="${g.y.toFixed(1)}" width="${g.w.toFixed(1)}" height="${g.h.toFixed(1)}" rx="12" fill="rgba(230,241,251,0.45)" stroke="#B5D4F4" stroke-width="1.2"/>`
      );
      out.push(
        `<path d="M ${g.x.toFixed(1)} ${(g.y + 26).toFixed(1)} H ${(g.x + g.w).toFixed(1)}" stroke="none"/>`
      );
      out.push(
        `<text x="${(g.x + 12).toFixed(1)}" y="${(g.y + 14).toFixed(1)}" font-size="13" font-weight="500" fill="#0C447C">${esc(g.label)}</text>`
      );
    }
  }

  for (const e of v.edges) {
    const d = roundedPathD(e.points, 7);
    const c = COLORS[e.kind] || COLORS.direct;
    const dash = e.kind === 'macro' || e.kind === 'fnptr' ? ' stroke-dasharray="5 3"' : '';
    out.push(
      `<path d="${d}" fill="none" stroke="${c}" stroke-width="1.3"${dash} marker-end="url(#mk-${e.kind in COLORS ? e.kind : 'direct'})" data-from="${esc(e.from)}" data-to="${esc(e.to)}"/>`
    );
  }

  for (const n of v.nodes) {
    out.push(`<g data-id="${esc(n.id)}">`);
    out.push(
      `<rect x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" width="${n.w}" height="${n.h}" rx="8" fill="${n.color || '#fff'}" stroke="#B5D4F4" stroke-width="1"/>`
    );
    out.push(
      `<text x="${(n.x + n.w / 2).toFixed(1)}" y="${(n.y + n.h / 2 - 7).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="12.5" font-weight="500" fill="#2C2C2A">${esc(n.name)}</text>`
    );
    out.push(
      `<text x="${(n.x + n.w / 2).toFixed(1)}" y="${(n.y + n.h / 2 + 10).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="10.5" fill="#888780">${esc(n.external ? t('node.external') : shortFile(n.file) + ':' + n.line)}</text>`
    );
    out.push('</g>');
  }

  out.push('</svg>');
  return out.join('\n');
}

document.getElementById('exportSvg').addEventListener('click', () => {
  if (!state.view) return;
  download('callgraph.svg', new Blob([buildSVG()], { type: 'image/svg+xml' }));
});

document.getElementById('exportPng').addEventListener('click', () => {
  els.cv.toBlob((b) => download('callgraph.png', b));
});

document.getElementById('exportHtml').addEventListener('click', () => {
  if (!state.root) return;
  window.location.href = `/api/export/html?root=${encodeURIComponent(state.root)}&up=${state.up}&down=${state.down}`;
});

document.getElementById('exportXlsx').addEventListener('click', () => {
  window.location.href = '/api/export/xlsx';
});

// ---------------- 启动 ----------------

applyI18n();
window.addEventListener('resize', resize);
resize();
loadStats();
loadTree();
loadView(new URLSearchParams(location.search).get('root'));

// 只读调试接口：供自动化测试读取当前视图状态（不提供任何写操作）
window.__cg = {
  get view() {
    return state.view;
  },
  get cam() {
    return { x: cam.x, y: cam.y, k: cam.k };
  },
  get root() {
    return state.root;
  },
  /** 当前高亮的框 id（点击标题后短暂存在） */
  get flash() {
    return state.flash ? state.flash.box.id : null;
  },
  /** 当前选中项 */
  get selected() {
    return {
      node: state.selected,
      edge: state.selectedEdge ? edgeKey(state.selectedEdge) : null,
    };
  },
  /** 当前视图内是否存在节点互相重叠 */
  overlaps(pad = 0) {
    const v = state.view;
    if (!v) return [];
    const hits = [];
    for (let i = 0; i < v.nodes.length; i++) {
      for (let j = i + 1; j < v.nodes.length; j++) {
        const a = v.nodes[i];
        const b = v.nodes[j];
        if (
          a.x < b.x + b.w + pad &&
          a.x + a.w + pad > b.x &&
          a.y < b.y + b.h + pad &&
          a.y + a.h + pad > b.y
        ) {
          hits.push([a.id, b.id]);
        }
      }
    }
    return hits;
  },
};
