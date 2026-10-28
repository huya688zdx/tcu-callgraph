import { state, esc } from './state.js';
import { api } from './api.js';
import { draw } from './render.js';

let sequence = 0;
let panel;
function renderPanel() {
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'pairFlowBar';
    panel.className = 'pair-flow-bar';
    panel.setAttribute('role', 'status');
    document.getElementById('cv').parentElement.appendChild(panel);
    panel.addEventListener('click', e => { if (e.target.closest('[data-pair-clear]')) clearPairFlow(); });
  }
  const pair = state.pairFlow;
  panel.hidden = !pair;
  if (!pair) { panel.textContent = ''; return; }
  const labels = new Map([...(pair.result?.nodes || []), ...state.view.nodes].map(n => [n.id, n.name || n.id]));
  const names = pair.ids.map(id => esc(labels.get(id) || id));
  let message = pair.ids.length === 1 ? `已选 ${names[0]}，Ctrl 点击另一个函数或变量` : `${names.join(' ↔ ')} · 正在分析…`;
  let details = '';
  if (pair.error) message = esc(pair.error);
  else if (pair.result) {
    const r = pair.result;
    message = `${names.join(' ↔ ')} · ${r.paths.length ? `${r.paths.length} 条最短数据流路径` : '未找到数据流路径'}`;
    details = `<div class="pair-flow-hint">按变量读写关系显示潜在流向，点击顺序不改变流向。${r.truncated ? '已达查询上限，结果可能不完整。' : ''}${r.partial ? '部分文件未能分析，结果可能不完整。' : ''}</div>`;
    if (r.paths.length) details += `<details><summary>查看路径</summary>${r.paths.map(p => `<div class="pair-flow-path">${p.nodes.map(id => esc(labels.get(id) || id)).join(' → ')}${p.versions ? ` <small>${p.versions.map(v => v === 'before' ? '修改前' : '修改后').join(' / ')}</small>` : ''}</div>`).join('')}</details>`;
  }
  panel.innerHTML = `<div class="pair-flow-heading"><span>${message}</span><button type="button" data-pair-clear>清除 <kbd>Esc</kbd></button></div>${details}`;
}

export function clearPairFlow() {
  sequence++;
  state.pairFlow = null;
  if (panel) { panel.hidden = true; panel.textContent = ''; }
  draw();
}

export async function pickPairFlow(id) {
  const view = state.view;
  if (!view?.nodes.some(n => n.id === id)) return;
  const prior = state.pairFlow;
  if (prior?.ids.length === 1 && prior.ids[0] === id) { clearPairFlow(); return; }
  const ids = prior?.ids.length === 1 ? [...prior.ids, id] : [id];
  const pair = { ids, result: null, error: '' };
  const seq = ++sequence;
  state.pairFlow = pair;
  state.selected = null; state.selectedEdge = null; state.selectedLabel = null;
  state.moveTarget = null; state.multiSelection = null;
  renderPanel(); draw();
  if (ids.length !== 2) return;
  try {
    if (window.__EXPORT) throw new Error('离线快照无法重新分析数据流，请在应用中查询');
    const result = await api.pairDataflow(...ids);
    if (seq !== sequence || view !== state.view) return;
    if (!result?.ok) throw new Error(result?.error || '数据流分析失败');
    pair.result = result;
  } catch (error) {
    if (seq !== sequence || view !== state.view) return;
    pair.error = error.message;
  }
  renderPanel(); draw();
}
