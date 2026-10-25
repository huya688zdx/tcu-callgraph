/**
 * 画布交互：命中测试、拖拽移动、连线、折线手柄、滚轮平移与缩放
 * 事件在模块加载时一次性绑定
 */
import { t } from '../i18n.js';
import { els, state, cam, FONT, esc, edgeKey, THEME } from './state.js';
import {
  collidesWith,
  moveNodeNoOverlap,
  rerouteScope,
  fullReroute,
  edgePoints,
  distToSegment,
} from './geometry.js';
import { draw } from './render.js';
import { stopCamAnim, focusBox, panCam } from './camera.js';
import { pathBlockedByNodes, routeEdges, collectSegments } from '/core/routing.js';
import {
  selectNode,
  showNodeMenu,
  setNodeChange,
  setEdgeChange,
  CHANGE_ITEMS,
  EDGE_ITEMS,
} from './menu.js';
import { showMenu, showMenuSections, hideMenu } from './ctxmenu.js';
import { saveLayout, pushHistory, addManualEdge } from './history.js';
import { renderDetail, renderVars, revealInTree } from './panels.js';
import { hitLabel, dragLabelTo, labelAnchor, saveLabels, edgeLabels } from './edge-labels.js';
import { renderLabelPanel } from './label-panel.js';
import { hooks } from './hooks.js';
import { nearestSide } from '/core/routing.js';
import { beginHierarchyMove, moveHierarchy, cancelHierarchyMove } from './hierarchy.js';
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
 * 命中文件框 / 目录容器的标题：单击居中查看，拖动整体移动。
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

function moveSeg(seg, x, y) {
  const pts = seg.edge.points;
  const i = seg.index;
  const axis = seg.orient === 'h' ? 1 : 0;
  const oldA = pts[i][axis];
  const oldB = pts[i + 1][axis];
  if (seg.orient === 'h') {
    pts[i][1] = y;
    pts[i + 1][1] = y;
  } else {
    pts[i][0] = x;
    pts[i + 1][0] = x;
  }
  if (pathBlockedByNodes(pts, state.view.nodes, new Set([seg.edge.from, seg.edge.to]))) {
    pts[i][axis] = oldA;
    pts[i + 1][axis] = oldB;
  }
}

let justDragged = false;

/**
 * 拖拽节点时的重路由缓存。
 * liveReroute 每帧都要 filter 一遍全表边、再 collectSegments 一遍其余边，
 * 但这两个集合在一帧内是不变的，所以在 pointerdown 时算一次：
 *   related  = 与该节点相连的边（每帧只重布这些）
 *   segments = 其余边的线段（作为避让约束）
 * 等价于 geometry.js 的 liveReroute(nodeId)，只是把 O(E) 的准备工作挪到了拖拽开始。
 */
let dragCache = null;

/** 清掉所有拖拽态（不动连线预览）；pointerup 先取快照再调用 */
function resetDragState() {
  state.dragNode = null;
  state.dragBox = null;
  state.dragEnd = null;
  state.dragSeg = null;
  state.dragLabel = null;
  state.dragStart = null;
  state.panning = false;
  state.dragMoved = false;
  dragCache = null;
  els.cv.classList.remove('panning', 'linking');
  els.cv.style.cursor = '';
}

/** pointercancel / lostpointercapture：直接丢弃这次手势，不提交任何变更 */
function cancelDrag() {
  const active =
    state.dragBox || state.dragNode || state.dragEnd || state.dragSeg || state.dragLabel || state.panning || state.linkFrom;
  if (state.dragBox) cancelHierarchyMove(state.dragBox);
  resetDragState();
  state.linkFrom = null;
  state.linkPos = null;
  state.panMoved = false;
  if (active) draw();
}

/**
 * 命中文件框 / 目录容器本体（不含函数节点）
 * 右键它们时要能「定位到当前文件 / 当前目录」——越靠里越优先
 */
function hitBox(e) {
  const v = state.view;
  if (!v) return null;
  const p = worldPos(e);
  for (const g of v.groups || []) {
    if (p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + g.h) {
      return { kind: 'file', box: g };
    }
  }
  const conts = (v.containers || []).slice().sort((a, b) => b.depth - a.depth);
  for (const c of conts) {
    if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) {
      return { kind: 'dir', box: c };
    }
  }
  return null;
}

els.cv.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!state.view) return;
  if (state.multiSelection) { state.multiSelection = null; draw(); }

  const n = hitTest(e);
  if (n) {
    selectNode(n.id);
    if (n.kind === 'var') {
      if (state.view?.comparison) return;
      // 变量节点外观与函数一致，也允许标记变更分类（没有数据流/定位项）
      showMenu(e.clientX, e.clientY, n.name || n.id, CHANGE_ITEMS, n.change || 'existing', (v) =>
        setNodeChange(n, v)
      );
      return;
    }
    showNodeMenu(e.clientX, e.clientY, n);
    return;
  }

  const edge = hitEdge(e);
  if (edge) {
    state.selected = null;
    state.selectedEdge = edge;
    state.selectedLabel = null;
    draw();
    renderDetail(null);
    renderLabelPanel();
    if (state.view?.comparison) return;
    showMenu(e.clientX, e.clientY, t('menu.edge'), EDGE_ITEMS, edge.change || 'existing', (v) =>
      setEdgeChange(edge, v)
    );
    return;
  }

  // 文件框 / 目录容器：定位到当前文件或当前目录
  const box = hitBox(e);
  if (box) {
    state.ctxBox = { kind: box.kind, id: box.box.id };
    renderVars();
    const title = String(box.box.label || box.box.id || '');
    showMenuSections(
      e.clientX,
      e.clientY,
      title,
      [
        {
          id: 'locate',
          label: 'menu.locate',
          items: [
            {
              value: 'locate',
              label: box.kind === 'file' ? 'locate.treeFile' : 'locate.treeDir',
            },
          ],
        },
      ],
      () => revealInTree(box.kind, box.box.id)
    );
    return;
  }
  hideMenu();
});

els.cv.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (state.multiSelection) { state.multiSelection = null; draw(); }
  hideMenu();
  stopCamAnim();
  resetDragState(); // 兜底：上一次手势若没收到 pointerup/pointercancel，这里先清干净
  const comparing = Boolean(state.view?.comparison);

  // 标签先判：选中连线后中点的段手柄正好压在标签上，先给标签才拖得动
  const lb = hitLabel(worldPos(e));
  if (lb && !comparing) {
    const anchor = labelAnchor(lb.edge);
    state.selected = null;
    state.selectedEdge = lb.edge;
    state.selectedLabel = `${edgeKey(lb.edge)}#${lb.label.id}`;
    state.dragLabel = {
      edge: lb.edge,
      label: lb.label,
      start: worldPos(e),
      dx: lb.rect.x + lb.rect.w / 2 - anchor.x,
      dy: lb.rect.y + lb.rect.h / 2 - anchor.y,
      moved: false,
    };
    els.cv.setPointerCapture(e.pointerId);
    draw();
    renderDetail(null);
    renderLabelPanel();
    return;
  }

  const end = hitEnd(e);
  if (end && !comparing) {
    state.dragEnd = { edge: state.selectedEdge, which: end, pos: worldPos(e), hover: null };
    els.cv.setPointerCapture(e.pointerId);
    return;
  }

  const seg = hitSegment(e);
  if (seg && !comparing) {
    seg.edge.custom = true; // 从此该边折线由用户接管
    state.dragSeg = seg;
    els.cv.style.cursor = seg.orient === 'h' ? 'row-resize' : 'col-resize';
    els.cv.setPointerCapture(e.pointerId);
    return;
  }

  // 标题先记录手势，松手后再区分单击与整体拖动。
  const title = hitTitle(e);
  if (title) {
    pushHistory();
    state.dragBox = beginHierarchyMove(state.view, title);
    state.dragBox.crossing = state.view.edges.filter((ed) =>
      state.dragBox.ids.has(ed.from) !== state.dragBox.ids.has(ed.to));
    state.dragStart = { x: e.clientX, y: e.clientY };
    state.flash = null;
    els.tooltip.style.opacity = '0';
    els.cv.style.cursor = 'grabbing';
    els.cv.setPointerCapture(e.pointerId);
    // 点层级/文件标题 = 切换右侧变量面板的范围
    state.ctxBox = { kind: title.kind === 'file' ? 'file' : 'dir', id: title.box.id };
    state.selected = null;
    state.selectedEdge = null;
    state.selectedLabel = null;
    renderDetail(null); // 收起节点详情 / 调用关系
    renderVars();
    draw();
    return;
  }

  const n = hitTest(e);

  if (n && e.shiftKey && !comparing) {
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
    // 拖拽期间每帧都要重布这些边：相关边与其他边线段只在这里算一次
    const related = state.view.edges.filter((ed) => ed.from === n.id || ed.to === n.id);
    const others = state.view.edges.filter((ed) => ed.from !== n.id && ed.to !== n.id);
    dragCache = { related, segments: collectSegments(others), paths: related.map((ed) => ed.points.map((p) => p.slice())) };
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
  if (state.dragBox) {
    const drag = state.dragBox;
    if (drag.view !== state.view) { cancelDrag(); return; }
    const dx = e.clientX - state.dragStart.x, dy = e.clientY - state.dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) state.dragMoved = true;
    if (state.dragMoved) {
      moveHierarchy(drag, dx / cam.k, dy / cam.k, e.shiftKey ? 0 : 8 / cam.k);
      routeEdges(state.view.nodes, drag.crossing, {
        existing: collectSegments(state.view.edges.filter((ed) => !drag.crossing.includes(ed))), preservePaths: true,
      });
      draw();
    }
    return;
  }
  if (state.dragLabel) {
    const { edge, label, start, dx, dy } = state.dragLabel;
    const anchor = labelAnchor(edge);
    if (anchor) {
      const p = worldPos(e);
      // 偏移是相对「线中央锚点」存的：节点挪动后标签会跟着线走
      const center = { x: anchor.x + dx + (p.x - start.x), y: anchor.y + dy + (p.y - start.y) };
      if (dragLabelTo(edge, label, center)) {
        state.dragLabel.moved = true;
        draw();
      }
    }
    return;
  }

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
    // 从本次按下时的 ELK 路径调整端部，避免逐帧重新选面和改走廊。
    if (dragCache) {
      dragCache.related.forEach((ed, i) => { ed.points = dragCache.paths[i].map((p) => p.slice()); });
      routeEdges(state.view.nodes, dragCache.related, { existing: dragCache.segments, preservePaths: true });
    }
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
  const title = next ? null : hitTitle(e);
  let cursor = title ? 'grab' : '';

  // 光标反馈：选中边的端点 / 线段手柄
  if (state.selectedEdge) {
    if (hitEnd(e)) cursor = 'crosshair';
    else {
      const seg = hitSegment(e);
      if (seg) cursor = seg.orient === 'h' ? 'row-resize' : 'col-resize';
    }
  }
  els.cv.style.cursor = cursor;

  // 标签可以拖：悬停时给个抓手光标，比默认箭头好认
  if (hitLabel(worldPos(e))) els.cv.style.cursor = 'move';

  if (n || title) {
    const rect = els.cv.getBoundingClientRect();
    els.tooltip.style.opacity = '1';
    els.tooltip.style.left = e.clientX - rect.left + 14 + 'px';
    els.tooltip.style.top = e.clientY - rect.top + 14 + 'px';
    els.tooltip.innerHTML = n
      ? `<b>${esc(n.name)}</b><br><span style="opacity:.7">${esc(n.file)}:${n.line}</span>${state.view?.comparison ? '' : '<br><span style="opacity:.5;font-size:11px">Shift+拖拽 可连到其他函数</span>'}`
      : `<b>${esc(title.box.label || title.box.id)}</b><br>拖动标题整体移动 · 单击居中查看<br><span style="opacity:.7">自动吸附对齐 · Shift 关闭吸附 · Esc 取消</span>`;
  } else {
    els.tooltip.style.opacity = '0';
  }
});

els.cv.addEventListener('pointerup', (e) => {
  // 先把本次手势的拖拽态取成快照，再统一清理：后面的分支只依赖快照，
  // 这样「清理」和「收尾」只有一处，pointercancel 也能复用同一套复位逻辑
  const dragEnd = state.dragEnd;
  const dragSeg = state.dragSeg;
  const dragNode = state.dragNode;
  const dragBox = state.dragBox;
  const dragLabel = state.dragLabel;
  const moved = state.dragMoved;
  const linkFrom = state.linkFrom;
  const panning = state.panning;
  const panMoved = state.panMoved;
  resetDragState();

  if (dragBox) {
    if (moved) {
      justDragged = true;
      setTimeout(() => (justDragged = false), 260);
      fullReroute(dragBox.ids);
      pushHistory();
    } else {
      focusBox(dragBox.box);
      state.flash = { box: dragBox.box, until: performance.now() + 1300, dur: 1300 };
    }
    draw();
    return;
  }

  if (dragLabel) {
    // 位置已经在拖动过程中写进 label.dx/dy，松手才落库，避免每帧一次请求
    if (dragLabel.moved && edgeLabels(dragLabel.edge).some((l) => l.id === dragLabel.label.id)) {
      saveLabels(dragLabel.edge).then(() => pushHistory());
    }
    draw();
    return;
  }

  if (dragEnd) {
    const { edge, which, hover, pos } = dragEnd;
    if (hover) {
      if (which === 'from') {
        edge.from = hover.id;
        edge.fromSide = nearestSide(hover, pos);
      } else {
        edge.to = hover.id;
        edge.toSide = nearestSide(hover, pos);
      }
      edge.custom = false; // 重连后恢复自动布线
      rerouteScope([edge]);
      saveLayout();
      pushHistory();
    }
    draw();
    return;
  }

  if (dragSeg) {
    pushHistory();
    draw();
    return;
  }

  if (dragNode) {
    if (moved) {
      justDragged = true;
      setTimeout(() => (justDragged = false), 260);
      fullReroute(new Set([dragNode.id])); // 只处理相连或被新位置挡住的线
      pushHistory();
    } else {
      selectNode(dragNode.id);
    }
    draw();
    return;
  }

  if (linkFrom) {
    const target = hitTest(e);
    if (target && target.id !== linkFrom.id) addManualEdge(linkFrom.id, target.id);
    draw();
    return;
  }

  if (panning) {
    if (!panMoved) {
      const edge = hitEdge(e);
      if (edge) {
        state.selectedEdge = edge;
        state.selected = null;
        state.selectedLabel = null;
        draw();
        renderDetail(null);
        renderLabelPanel();
      } else {
        state.selectedEdge = null;
        state.selectedLabel = null;
        selectNode(null); // 内部会收起节点详情并刷新标签面板
      }
    }
    return;
  }
});

// 系统手势 / 切窗口 / 指针捕获被抢走：浏览器发 pointercancel 或 lostpointercapture 而不会发 pointerup。
// 不处理的话 state.dragNode 等会永久留着，回页面后鼠标一动节点就跟着跑。
els.cv.addEventListener('pointercancel', cancelDrag);
els.cv.addEventListener('lostpointercapture', cancelDrag);

// 按原始样式分组，不把选中时临时覆盖的蓝色算作组件颜色。
const nodeSelectionType = (n) => JSON.stringify([
  n.kind === 'var' ? 'var' : 'function', !!n.external,
  (n.color || (n.external ? THEME.node.external : THEME.fill[n.change] || THEME.fill.existing)).toLowerCase(),
]);
const edgeSelectionType = (e) => JSON.stringify([
  e.kind, e.kind === 'var' ? 'dashed' : 'solid',
  e.change === 'added' ? THEME.edge.added : e.kind === 'var' ? THEME.edge.var : THEME.edge.call,
  e.change === 'deleted',
]);
const labelSelectionType = (l) => JSON.stringify([
  l.preset, (l.border || '').toLowerCase(), (l.color || '#2C2C2A').toLowerCase(),
]);

document.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    if (!state.view || document.querySelector('.modal.show') || state.dragBox || state.dragNode || state.dragLabel || state.dragSeg || state.dragEnd) return;
    const anchor = state.selectedLabel || state.selectedEdge || state.selected;
    if (!anchor) return;
    const node = state.view.nodes.find((n) => n.id === state.selected);
    const kind = state.selectedLabel ? 'label' : state.selectedEdge ? 'edge' : node ? (node.kind === 'var' ? 'var' : 'function') : null;
    if (kind) {
      const selection = { kind, anchor, view: state.view };
      if (kind === 'function' || kind === 'var') {
        const type = nodeSelectionType(node);
        selection.nodes = new Set(state.view.nodes.filter((n) => nodeSelectionType(n) === type).map((n) => n.id));
      } else if (kind === 'edge') {
        const type = edgeSelectionType(state.selectedEdge);
        selection.edges = new Set(state.view.edges.filter((ed) => edgeSelectionType(ed) === type).map(edgeKey));
      } else {
        const id = state.selectedLabel.slice(state.selectedLabel.lastIndexOf('#') + 1);
        const label = edgeLabels(state.selectedEdge).find((l) => l.id === id);
        if (!label) return;
        const type = labelSelectionType(label);
        selection.labels = new Set();
        selection.edges = new Set();
        for (const ed of state.view.edges) for (const l of edgeLabels(ed)) {
          if (labelSelectionType(l) !== type) continue;
          selection.labels.add(`${edgeKey(ed)}#${l.id}`);
          selection.edges.add(edgeKey(ed));
        }
      }
      state.multiSelection = selection;
      draw();
    }
    return;
  }
  if (e.key === 'Escape' && state.dragBox) {
    e.preventDefault();
    e.stopImmediatePropagation();
    cancelDrag();
  } else if (state.multiSelection && !document.querySelector('.modal.show')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      selectNode(null);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      // 全选只用于查看；避免旧的单选删除逻辑误删其中一个组件。
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
}, true);

els.cv.addEventListener('dblclick', (e) => {
  if (justDragged) return;
  const n = hitTest(e);
  if (n) {
    // 变量没有下游可下钻，双击只做选中，避免跳到一个空视图
    if (n.kind === 'var') {
      selectNode(n.id);
      return;
    }
    hooks.loadView(n.id);
    return;
  }
  // 双击手动布线的边：恢复自动布线
  const edge = hitEdge(e);
  if (edge && edge.custom) {
    edge.custom = false;
    rerouteScope([edge]);
    draw();
  }
});

els.cv.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (state.dragBox) return;
    const rect = els.cv.getBoundingClientRect();
    if (!e.ctrlKey) {
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (e.shiftKey ? rect.width : rect.height) : 1;
      if (e.shiftKey) panCam(-(e.deltaY || e.deltaX) * unit, 0);
      else panCam(-e.deltaX * unit, -e.deltaY * unit);
      return;
    }
    stopCamAnim();
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
export { worldPos, hitTest, hitTitle, hitEdge, hitSegment, hitEnd, moveSeg };
