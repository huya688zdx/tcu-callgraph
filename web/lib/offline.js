/** 离线查看器：绘图、节点/层级拖动和折线路由直接使用 GUI 模块。 */
import { state, cam, els } from './state.js';
import { api } from './api.js';
import { hooks } from './hooks.js';
import { resize } from './render.js';
import { fit, focusBox } from './camera.js';
import { loadVars, renderVars, renderDetail } from './panels.js';
import { pushHistory, undo, redo } from './history.js';
import './interact.js';

const saved = window.__EXPORT.snapshot;
state.view = saved.view;
state.root = saved.view.root;
state.roots = saved.view.roots || [state.root];
state.selected = saved.selected;
state.ctxBox = saved.ctxBox;
state.vars = new Set(saved.vars);
state.hiddenVars = new Set(saved.hiddenVars);
Object.assign(cam, saved.cam);

// 面板查询从导出时的完整数据读取，不用图中的局部边反推调用与变量数据。
api.node = async (id) => saved.details[id] || { error: '该节点未包含在快照中' };
api.vars = async () => ({ list: saved.variables });
// 拖线、撤销仅更新当前离线页面，不访问原工程。
api.overlay = api.layout = async () => ({ ok: true });
hooks.renderDetail = renderDetail;
hooks.loadView = async (id) => {
  const n = state.view.nodes.find((n) => n.id === id);
  if (n) { state.selected = id; await renderDetail(id); focusBox(n); }
};

// 快照不能扫描源码或增删未导出的节点；保留完整清单与入图状态供查看。
const disableVars = () => {
  for (const input of els.vars.querySelectorAll('input[type="checkbox"]')) {
    input.disabled = true;
    input.title = '导出时的入图状态；增删变量请在 GUI 中操作后重新导出';
  }
};
new MutationObserver(disableVars).observe(els.vars, { childList: true, subtree: true });
els.cv.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
window.addEventListener('resize', resize);
document.getElementById('offlineFit').addEventListener('click', fit);
document.addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    renderDetail(state.selected); renderVars();
  } else if (e.key.toLowerCase() === 'f') fit();
});

await loadVars();
await renderDetail(state.selected);
// 画布尺寸不同时只补偿中心差，保留导出时的缩放和浏览位置。
cam.x += (els.cv.clientWidth - saved.width) / 2;
cam.y += (els.cv.clientHeight - saved.height) / 2;
resize();
pushHistory();
window.__cg = { get view() { return state.view; }, cam };
