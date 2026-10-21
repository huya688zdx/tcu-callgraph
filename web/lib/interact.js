/**
 * 画布交互：命中测试、拖拽移动、连线、折线手柄、滚轮缩放
 * 事件在模块加载时一次性绑定
 */
import { t } from '../i18n.js';
import { els, state, cam, FONT, esc, edgeKey, modifiedEdges, modifiedNodes } from './state.js';
import {
  collidesWith,
  moveNodeNoOverlap,
  rerouteScope,
  fullReroute,
  edgePoints,
  distToSegment,
} from './geometry.js';
import { draw } from './render.js';
import { stopCamAnim, focusBox } from './camera.js';
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
import { hooks } from './hooks.js';
import { nearestSide } from '/core/routing.js';
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
  state.dragEnd = null;
  state.dragSeg = null;
  state.dragStart = null;
  state.panning = false;
  state.dragMoved = false;
  dragCache = null;
  els.cv.classList.remove('panning', 'linking');
  els.cv.style.cursor = '';
}

/** pointercancel / lostpointercapture：直接丢弃这次手势，不提交任何变更 */
function cancelDrag() {
  const active = state.dragNode || state.dragEnd || state.dragSeg || state.panning || state.linkFrom;
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

  const n = hitTest(e);
  if (n) {
    selectNode(n.id);
    if (n.kind === 'var') {
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
    draw();
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
  hideMenu();
  stopCamAnim();
  resetDragState(); // 兜底：上一次手势若没收到 pointerup/pointercancel，这里先清干净

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
    // 点层级/文件标题 = 切换右侧变量面板的范围
    state.ctxBox = { kind: title.kind === 'file' ? 'file' : 'dir', id: title.box.id };
    state.selected = null;
    renderDetail(null); // 收起节点详情 / 调用关系
    renderVars();
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
    // 拖拽期间每帧都要重布这些边：相关边与其他边线段只在这里算一次
    const related = state.view.edges.filter((ed) => ed.from === n.id || ed.to === n.id);
    const others = state.view.edges.filter((ed) => ed.from !== n.id && ed.to !== n.id);
    dragCache = { related, segments: collectSegments(others) };
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
    // 相连的边实时避障重布：用 pointerdown 时缓存的边集合与避让线段，不再每帧扫全表
    if (dragCache) {
      routeEdges(state.view.nodes, dragCache.related, { existing: dragCache.segments });
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
  // 先把本次手势的拖拽态取成快照，再统一清理：后面的分支只依赖快照，
  // 这样「清理」和「收尾」只有一处，pointercancel 也能复用同一套复位逻辑
  const dragEnd = state.dragEnd;
  const dragSeg = state.dragSeg;
  const dragNode = state.dragNode;
  const moved = state.dragMoved;
  const linkFrom = state.linkFrom;
  const panning = state.panning;
  const panMoved = state.panMoved;
  resetDragState();

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
      modifiedEdges.add(edgeKey(edge));
      rerouteScope([edge]);
      saveLayout();
      pushHistory();
    }
    draw();
    return;
  }

  if (dragSeg) {
    modifiedEdges.add(edgeKey(dragSeg.edge));
    saveLayout();
    pushHistory();
    draw();
    return;
  }

  if (dragNode) {
    if (moved) {
      justDragged = true;
      setTimeout(() => (justDragged = false), 260);
      modifiedNodes.add(dragNode.id);
      fullReroute(); // 松手后全量避障重布
      for (const ed of state.view.edges) {
        if (ed.custom) modifiedEdges.add(edgeKey(ed)); // 自定义边折线已随重锚定更新
      }
      saveLayout();
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

// 系统手势 / 切窗口 / 指针捕获被抢走：浏览器发 pointercancel 或 lostpointercapture 而不会发 pointerup。
// 不处理的话 state.dragNode 等会永久留着，回页面后鼠标一动节点就跟着跑。
els.cv.addEventListener('pointercancel', cancelDrag);
els.cv.addEventListener('lostpointercapture', cancelDrag);

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
export { worldPos, hitTest, hitTitle, hitEdge, hitSegment, hitEnd, moveSeg };
