/**
 * 撤回 / 重做 + 手动布局存档
 */
import { state, nodeById, edgeKey, modifiedEdges, modifiedNodes } from './state.js';
import { api } from './api.js';
import { draw } from './render.js';
import { rerouteScope } from './geometry.js';
const history = { stack: [], idx: -1, limit: 60, frozen: false };

/**
 * 布局存档的 key：服务端存取都按「入口集合 + 模式」
 * （src/server.js:451 用 layoutKey(roots.join('+'), mode) 读、:778 用同一个 key 写）。
 * 所以写入必须用 roots 拼接；单入口时与 root 等价，多入口时用 root 会写到另一个槽位，
 * 下次进同一视图读不到刚存的坐标。
 */
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
      dfVar: n.dfVar,
      dfPeer: n.dfPeer,
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
      df: e.df,
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
  // 标签是「改了就落库」的（不像坐标要等 savePositionsOnly），
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
  // 只落盘节点坐标。不能走 saveLayout(true)：那会把每条边都写成 {custom:true, points}，
  // 服务端从此不再自动布线（见下面 savePositionsOnly 的注释）
  savePositionsOnly();
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
  (async () => {
    for (const e of changed) {
      try {
        const r = await api.overlay({ edgeKey: edgeKey(e), data: { labels: e.labels || null } });
        // 回看模式（state.at > 0）会拦写操作，这不是错误，安静跳过
        if (r && r.ok === false && r.error !== 'review-mode') console.warn('[撤销] 标签写回被拒：', r.error);
      } catch (err) {
        console.warn('[撤销] 标签写回失败：', err);
      }
    }
  })();
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
    // 注意：full=true 会让这个条件恒真，把所有边都固化成「手工折线」并永久写进存档。
    // 需要整图落盘时用 savePositionsOnly()，不要用 full。
    if (Array.isArray(e.points) && e.points.length >= 2 && (full || e.custom)) {
      rec.custom = true;
      rec.points = e.points.map((p) => [Math.round(p[0]), Math.round(p[1])]);
    }
    if (e.fromSide) rec.fromSide = e.fromSide;
    if (e.toSide) rec.toSide = e.toSide;
    if (Object.keys(rec).length) edges[k] = rec;
  }

  await api.layout({
    root: layoutRootKey(),
    nodes,
    manual: collectManual(),
    edges,
    mode: state.group ? 'group' : 'flat',
  });
}

/**
 * 只落盘节点坐标（固定布局用）
 * 不走 saveLayout(full)：那会把每条连线都标成「手工折线」，之后再也不自动重布线
 */
export async function savePositionsOnly() {
  const v = state.view;
  if (!v) return;
  const nodes = {};
  for (const n of v.nodes) nodes[n.id] = { x: Math.round(n.x), y: Math.round(n.y) };
  await api.layout({
    root: layoutRootKey(),
    nodes,
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
