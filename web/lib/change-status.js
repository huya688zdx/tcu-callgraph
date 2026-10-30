import { state, edgeKey, esc } from './state.js';
import { api } from './api.js';
import { hooks } from './hooks.js';
import { draw } from './render.js';
import { fullReroute } from './geometry.js';
import { pushHistory } from './history.js';

export const STATUS_LABELS = { existing: '未修改', modified: '修改', added: '新增', deleted: '删除' };
export const statusLabel = (value) => STATUS_LABELS[value] || '未修改';
export const statusKey = (edge) => edge.comparisonKey || edgeKey(edge);
let writes = Promise.resolve();

export function statusOptions(change, detected = null, isEdge = false) {
  return (detected ? `<option value="auto" ${change === 'auto' ? 'selected' : ''}>自动：${statusLabel(detected)}</option>` : '') +
    Object.entries(STATUS_LABELS).filter(([value]) => !isEdge || value !== 'modified')
      .map(([value, label]) => `<option value="${value}" ${change === value ? 'selected' : ''}>${label}</option>`).join('');
}

export function statusControl(target, isEdge = false) {
  const comparing = !!state.view?.comparison;
  const value = comparing && target.statusSource !== 'manual' ? 'auto' : target.change || 'existing';
  return `<label class="detail-meta">状态 <select data-change-status ${state.at > 0 || window.__EXPORT ? 'disabled' : ''}>
    ${statusOptions(value, comparing ? target.detectedChange || target.change || 'existing' : null, isEdge)}</select></label>
    ${comparing ? `<div class="detail-meta">${target.statusSource === 'manual' ? '手动调整' : '自动识别'} · 自动结果：${esc(statusLabel(target.detectedChange || target.change))}<br>调整用于本次比较，可恢复自动判断。</div>` : ''}`;
}

export async function setStatus(target, value, isEdge = false) {
  if (!state.view || state.at > 0) return { ok: false, error: '回看时不能修改状态' };
  const view = state.view;
  const comparing = !!view.comparison;
  const change = value === 'auto' ? null : value;
  const key = isEdge ? statusKey(target) : target.id;
  const patch = comparing ? { comparisonId: view.comparison.id, change,
    ...(isEdge ? { edgeId: key } : { nodeId: key }), projectId: view.projectId } : {
    ...(isEdge ? { edgeKey: edgeKey(target) } : { nodeId: key }),
    data: { change, ...(!isEdge ? { color: null } : {}) }, projectId: view.projectId,
  };
  const pending = writes.then(() => comparing ? api.comparisonStatus(patch) : api.overlay(patch));
  writes = pending.catch(() => {});
  const result = await pending;
  if (!result?.ok || state.view !== view) return result;
  const current = isEdge ? view.edges.find((e) => statusKey(e) === key) : view.nodes.find((n) => n.id === key);
  if (!current) return result;
  if (comparing) {
    Object.assign(current, { change: result.target.change, detectedChange: result.target.detectedChange, statusSource: result.target.statusSource });
    view.comparison = { ...view.comparison, ...result.comparison };
    hooks.syncComparison(view.comparison);
  } else { current.change = change || 'existing'; if (!isEdge) delete current.color; }
  if (isEdge) fullReroute();
  draw();
  pushHistory();
  if (!isEdge && state.selected === current.id) hooks.renderDetail(current.id);
  return result;
}

export function bindStatusControl(element, target, isEdge = false, refresh = null) {
  const select = element.querySelector('[data-change-status]');
  select?.addEventListener('change', async () => {
    select.disabled = true;
    try {
      const result = await setStatus(target, select.value, isEdge);
      if (!result?.ok) throw new Error(result?.error || '保存状态失败');
      refresh?.();
    } catch (error) { alert(error.message || String(error)); }
    finally { select.disabled = state.at > 0 || !!window.__EXPORT; }
  });
}
