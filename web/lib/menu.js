/**
 * 右键菜单：变更分类标记、连线状态、选中
 */
import { state, edgeKey, CHANGE_FILL, EDGE_COLOR } from './state.js';
import { hideMenu, showMenu, showMenuSections } from './ctxmenu.js';
import { api } from './api.js';
import { draw } from './render.js';
import { pushHistory } from './history.js';
import { renderDetail } from './panels.js';
import { df, expandDataflow, clearDataflow } from './df.js';
// ---------------- 右键菜单：标记变更分类 / 连线状态 ----------------

const CHANGE_ITEMS = [
  { value: 'existing', label: 'change.existing', color: CHANGE_FILL.existing },
  { value: 'modified', label: 'change.modified', color: CHANGE_FILL.modified },
  { value: 'added', label: 'change.added', color: CHANGE_FILL.added },
  { value: 'deleted', label: 'change.deleted', color: CHANGE_FILL.deleted },
];

const EDGE_ITEMS = [
  { value: 'existing', label: 'edgeState.existing', color: EDGE_COLOR.existing },
  { value: 'added', label: 'edgeState.added', color: EDGE_COLOR.added },
  { value: 'deleted', label: 'edgeState.deleted', color: EDGE_COLOR.existing },
];

/** 函数节点的右键菜单：数据流分析 + 变更分类 */
export function showNodeMenu(x, y, n) {
  const sections = [
    {
      id: 'df',
      label: 'menu.dataflow',
      items: [
        { value: 'df:out', label: 'df.out', active: df.active && df.root === n.id && df.dir === 'out' },
        { value: 'df:in', label: 'df.in', active: df.active && df.root === n.id && df.dir === 'in' },
        ...(df.active ? [{ value: 'df:clear', label: 'df.clear' }] : []),
      ],
    },
    { id: 'change', label: 'menu.change', items: CHANGE_ITEMS },
  ];
  showMenuSections(x, y, n.name, sections, (v) => {
    if (v === 'df:out') return expandDataflow(n.id, 'out');
    if (v === 'df:in') return expandDataflow(n.id, 'in');
    if (v === 'df:clear') return clearDataflow();
    return setNodeChange(n, v);
  });
}

async function setNodeChange(n, change) {
  n.change = change;
  draw();
  await api.overlay({ nodeId: n.id, data: { change } });
  pushHistory();
}

async function setEdgeChange(edge, change) {
  edge.change = change;
  draw();
  await api.overlay({ edgeKey: edgeKey(edge), data: { change } });
  pushHistory();
}

function selectNode(id) {
  state.selected = id;
  draw();
  renderDetail(id);
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
