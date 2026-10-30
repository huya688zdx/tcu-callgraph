/**
 * 右键菜单：变更分类标记、连线状态、选中
 */
import { state, edgeKey, THEME } from './state.js';
import { hideMenu, showMenu, showMenuSections } from './ctxmenu.js';
import { draw } from './render.js';
import { renderDetail, renderVars, revealInTree } from './panels.js';
import { renderLabelPanel } from './label-panel.js';
import { analyseDataflow } from './df.js';
import { findCallOrder } from './call-order.js';
import { showExpansion } from './expand.js';
import { setNodeName } from './node-name.js';
import { setStatus } from './change-status.js';
// ---------------- 右键菜单：标记变更分类 / 连线状态 ----------------

// 色块用 getter 在菜单打开时现读 THEME：样式面板改色后菜单立即跟上
const CHANGE_ITEMS = [
  { value: 'existing', label: 'status.existing', get color() { return THEME.fill.existing; } },
  { value: 'modified', label: 'status.modified', get color() { return THEME.fill.modified; } },
  { value: 'added', label: 'status.added', get color() { return THEME.fill.added; } },
  { value: 'deleted', label: 'status.deleted', get color() { return THEME.fill.deleted; } },
];
export const COMPARISON_ITEMS = [{ value: 'auto', label: 'status.auto' }, ...CHANGE_ITEMS];

const EDGE_ITEMS = [
  { value: 'existing', label: 'edgeState.existing', get color() { return THEME.edge.call; } },
  { value: 'added', label: 'edgeState.added', get color() { return THEME.edge.added; } },
  { value: 'deleted', label: 'edgeState.deleted', get color() { return THEME.edge.call; } },
];

/** 函数节点的右键菜单：数据流分析 + 变更分类 */
export function showNodeMenu(x, y, n) {
  const comparing = Boolean(state.view?.comparison);
  const sections = [
    ...(n.headerSymbol ? [{ id: 'name', label: 'name.title', items: [
      { value: 'name:default', label: 'name.default', active: !n.nameModeOverride },
      { value: 'name:alias', label: 'name.alias', active: n.nameModeOverride === 'alias' },
      { value: 'name:target', label: 'name.target', active: n.nameModeOverride === 'target' },
    ] }] : []),
    {
      id: 'locate',
      label: 'menu.locate',
      items: [{ value: 'tree:fn', label: 'locate.treeFn' }],
    },
    {
      id: 'df',
      items: [
        { value: 'expand', label: 'expand.menu' },
        { value: 'df', label: 'menu.dataflow' },
        ...(!comparing ? [{ value: 'callOrder', label: 'callOrder.find' }] : []),
      ],
    },
    { id: 'change', label: 'status.title', items: (comparing ? COMPARISON_ITEMS : CHANGE_ITEMS).map((it) => ({ ...it,
      active: it.value === (comparing && n.statusSource !== 'manual' ? 'auto' : n.change || 'existing') })) },
  ];
  showMenuSections(x, y, n.name, sections, (v) => {
    if (v.startsWith('name:')) return setNodeName(n, v.slice(5));
    if (v === 'expand') return showExpansion(n);
    if (v === 'tree:fn') return revealInTree('fn', n.id);
    if (v === 'df') return analyseDataflow(n.id);
    if (v === 'callOrder') return findCallOrder(n.id);
    return setNodeChange(n, v);
  });
}

async function setNodeChange(n, change) {
  return setStatus(n, change);
}

async function setEdgeChange(edge, change) {
  const result = await setStatus(edge, change, true);
  if (result?.ok) renderLabelPanel();
  return result;
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
