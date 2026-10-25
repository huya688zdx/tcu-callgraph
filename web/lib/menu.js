/**
 * 右键菜单：变更分类标记、连线状态、选中
 */
import { state, edgeKey, THEME } from './state.js';
import { hideMenu, showMenu, showMenuSections } from './ctxmenu.js';
import { api } from './api.js';
import { draw } from './render.js';
import { pushHistory } from './history.js';
import { fullReroute } from './geometry.js';
import { renderDetail, renderVars, revealInTree } from './panels.js';
import { renderLabelPanel } from './label-panel.js';
import { analyseDataflow } from './df.js';
import { findCallOrder } from './call-order.js';
// ---------------- 右键菜单：标记变更分类 / 连线状态 ----------------

// 色块用 getter 在菜单打开时现读 THEME：样式面板改色后菜单立即跟上
const CHANGE_ITEMS = [
  { value: 'existing', label: 'change.existing', get color() { return THEME.fill.existing; } },
  { value: 'modified', label: 'change.modified', get color() { return THEME.fill.modified; } },
  { value: 'added', label: 'change.added', get color() { return THEME.fill.added; } },
  { value: 'deleted', label: 'change.deleted', get color() { return THEME.fill.deleted; } },
];

const EDGE_ITEMS = [
  { value: 'existing', label: 'edgeState.existing', get color() { return THEME.edge.call; } },
  { value: 'added', label: 'edgeState.added', get color() { return THEME.edge.added; } },
  { value: 'deleted', label: 'edgeState.deleted', get color() { return THEME.edge.call; } },
];

/** 函数节点的右键菜单：数据流分析 + 变更分类 */
export function showNodeMenu(x, y, n) {
  const comparing = Boolean(state.view?.comparison);
  const sections = [
    {
      id: 'locate',
      label: 'menu.locate',
      items: [{ value: 'tree:fn', label: 'locate.treeFn' }],
    },
    {
      id: 'df',
      items: [
        { value: 'df', label: 'menu.dataflow' },
        ...(!comparing ? [{ value: 'callOrder', label: 'callOrder.find' }] : []),
      ],
    },
    ...(!comparing ? [{ id: 'change', label: 'menu.change', items: CHANGE_ITEMS }] : []),
  ];
  showMenuSections(x, y, n.name, sections, (v) => {
    if (v === 'tree:fn') return revealInTree('fn', n.id);
    if (v === 'df') return analyseDataflow(n.id);
    if (v === 'callOrder') return findCallOrder(n.id);
    return setNodeChange(n, v);
  });
}

async function setNodeChange(n, change) {
  if (state.view?.comparison) return;
  n.change = change;
  draw();
  await api.overlay({ nodeId: n.id, data: { change } });
  pushHistory();
}

async function setEdgeChange(edge, change) {
  if (state.view?.comparison) return;
  edge.change = change;
  fullReroute(); // 颜色变化后立即分开原先共用的线路。
  draw();
  await api.overlay({ edgeKey: edgeKey(edge), data: { change } });
  pushHistory();
}

function selectNode(id) {
  state.multiSelection = null;
  state.moveTarget = null;
  state.selected = id;
  // 选中节点就不再是「选连线 / 选标签」状态，右侧面板跟着切换。
  // selectedEdge 不清的话，点完连线再点节点，标签面板会一直挂着旧连线
  state.selectedEdge = null;
  state.selectedLabel = null;
  if (id) {
    const n = state.view ? state.view.nodes.find((x) => x.id === id) : null;
    if (n && n.group) state.ctxBox = { kind: 'file', id: n.group };
  } else {
    state.ctxBox = null;
  }
  draw();
  renderDetail(id);
  renderVars(); // 变量面板跟着当前点选的框走
  renderLabelPanel();
}

export {
  CHANGE_ITEMS,
  EDGE_ITEMS,
  hideMenu,
  showMenu,
  showMenuSections,
  selectNode,
  setNodeChange,
  setEdgeChange,
};
