/**
 * 撤回 / 重做 + 手动布局存档
 */
import { state, nodeById, edgeKey, modifiedEdges, modifiedNodes } from './state.js';
import { api } from './api.js';
import { draw } from './render.js';
import { rerouteScope } from './geometry.js';
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

  await api.layout({
    root: state.root,
    nodes,
    manual: collectManual(),
    edges,
    mode: state.group ? 'group' : 'flat',
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
  await api.layout({
    manual: collectManual(),
    mode: state.group ? 'group' : 'flat',
  });
  pushHistory();
}
export {
  history,
  snapshotView,
  pushHistory,
  applySnapshot,
  undo,
  redo,
  updateHistoryButtons,
  saveLayout,
  collectManual,
  addManualEdge,
};
