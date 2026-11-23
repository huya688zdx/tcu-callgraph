/**
 * 定位：把某个函数 / 文件框 / 目录容器放到视野中央并高亮一下。
 * 如果它当前不在视图里，先用它（或它下面的函数）作为入口重新加载。
 *
 * 只依赖 state / camera / render / hooks，不依赖 panels 或 menu，
 * 避免「文件树 → 定位 → 文件树」的循环引用。
 */
import { state } from './state.js';
import { boxInViewport, focusBox } from './camera.js';
import { draw } from './render.js';
import { hooks } from './hooks.js';
import { renderLabelPanel } from './label-panel.js';
import { clearPairFlow } from './pair-flow.js';

const FLASH_MS = 1500;

function flash(box) {
  if (!box) return;
  state.flash = { box, until: performance.now() + FLASH_MS, dur: FLASH_MS };
  draw();
}

const findNode = (id) => (state.view ? state.view.nodes.find((n) => n.id === id) : null);

/** 定位到某个函数：选中、居中并闪一下。 */
export async function locateNode(id) {
  let n = findNode(id);
  if (!n) {
    await hooks.addFunction(id);
    n = findNode(id);
  }
  if (!n) return false;
  if (state.pairFlow) clearPairFlow({ paint: false });
  state.multiSelection = null;
  state.moveTarget = null;
  state.selected = id;
  state.selectedEdge = null;
  state.selectedLabel = null;
  hooks.renderDetail(id);
  renderLabelPanel();
  draw();
  focusBox(n);
  flash(n);
  return true;
}

/** 闪烁相邻节点，只有靠近视口边缘或超出视口时才平移。 */
export function peekNode(id) {
  const n = findNode(id);
  if (!n) return false;
  if (!boxInViewport(n, 60)) focusBox(n);
  flash(n);
  return true;
}

/**
 * 定位到文件框 / 目录容器
 * @param {'file'|'dir'} kind
 * @param {string} id 文件相对路径 或 目录路径（根目录是空串）
 * @param {string[]} fnIds 该文件/目录下的函数，用于它不在视图里时重新加载
 */
export async function locateBox(kind, id, fnIds = []) {
  const pick = (v) => (kind === 'file' ? v && v.groups : v && v.containers) || [];
  let box = pick(state.view).find((b) => b.id === id);

  if (!box) {
    const roots = fnIds.slice(0, 12); // 多入口加载，太多会把图撑爆
    if (!roots.length) return false;
    await hooks.loadView(roots, { fitOnLoad: false });
    box = pick(state.view).find((b) => b.id === id);
  }
  if (!box) return false;
  state.ctxBox = { kind, id };
  focusBox(box, 70, { keepZoom: false });
  flash(box);
  return true;
}
