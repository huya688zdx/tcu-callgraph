/**
 * 撤回 / 重做 + 手工关系存档
 */
import { state, nodeById, edgeKey } from './state.js';
import { api } from './api.js';
import { draw } from './render.js';
import { rerouteScope } from './geometry.js';
const history = { stack: [], idx: -1, limit: 60, frozen: false };
let labelWrites = Promise.resolve();

/** 手工关系按入口集合和分组方式存档。 */
const layoutRootKey = () => state.roots.join('+') || state.root || '';

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
      // 语义字段必须一起快照：否则 undo 后变量节点会变回函数（kind 丢失）、
      // 变更分类颜色全部回落成「既存」
      kind: n.kind,
      change: n.change,
      typeText: n.typeText,
      tag: n.tag,
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
      change: e.change,
      // 连线标签挂在边上：撤销时连标签一起回退，画布才不会和存档打架
      //（一线多条，整组快照）
      labels: e.labels || null,
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
  // 标签是「改了就落库」的，
  // 所以撤销时必须把标签差异也写回服务端，否则画布回退了、库里还是新值，
  // 刷新一下又变回来——看起来像撤销没生效。
  const before = new Map(v.edges.map((e) => [edgeKey(e), JSON.stringify(e.labels || null)]));
  v.nodes = s.nodes;
  v.edges = s.edges.map((e) => ({ ...e }));
  if (s.groups) v.groups = s.groups;
  state.selected = null;
  state.selectedEdge = null;
  state.selectedLabel = null;
  state.hover = null;
  draw();
  persistLabelDiff(before);
  saveLayout();
  updateHistoryButtons();
}

/** 把快照恢复后与恢复前的标签差异逐边写回；失败只打日志，不打断撤销流程 */
function persistLabelDiff(before) {
  const v = state.view;
  if (!v) return;
  const changed = v.edges.filter((e) => {
    const key = edgeKey(e);
    return before.has(key) && before.get(key) !== JSON.stringify(e.labels || null);
  });
  if (!changed.length) return;
  const projectId = v.projectId;
  const changes = changed.map((e) => ({ edgeKey: edgeKey(e), data: { labels: structuredClone(e.labels || null) }, projectId }));
  labelWrites = labelWrites.then(async () => {
    for (const patch of changes) {
      try {
        const r = await api.overlay(patch);
        // 回看模式（state.at > 0）会拦写操作，这不是错误，安静跳过
        if (r && r.ok === false && r.error !== 'review-mode') console.warn('[撤销] 标签写回被拒：', r.error);
      } catch (err) {
        console.warn('[撤销] 标签写回失败：', err);
      }
    }
  });
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

async function saveLayout() {
  await api.layout({
    root: layoutRootKey(),
    manual: collectManual(),
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
    root: layoutRootKey(),
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
