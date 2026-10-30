/** 从画布或文件树里的函数发起局部层级查找。 */
import { t } from '../i18n.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { api } from './api.js';
import { openModal, closeModal, esc } from './modal.js';

const pickList = document.getElementById('addFunctionsList');
const pickApply = document.getElementById('addFunctionsApply');
const pickAll = document.getElementById('addFunctionsAll');
const pickMessage = document.getElementById('addFunctionsMessage');
let previewSequence = 0;
let previewView = null;

function syncPickCount() {
  const inputs = [...pickList.querySelectorAll('input')];
  const count = inputs.filter((input) => input.checked).length;
  pickAll.checked = !!inputs.length && count === inputs.length;
  pickAll.indeterminate = count > 0 && count < inputs.length;
  pickAll.disabled = !inputs.length;
  pickApply.disabled = !count;
  pickApply.textContent = count ? `确认添加 ${count} 个函数` : '确认添加';
}

/** 仅预览候选范围；确认时用零层范围加入勾选函数，避免未勾选分支再次展开。 */
export async function previewAddition(fn, depths = state.addDepths) {
  if (!pickList || !state.view || window.__EXPORT) return;
  const seq = ++previewSequence;
  previewView = state.view;
  const { up, down } = depths;
  document.getElementById('addFunctionsTarget').textContent = fn.name || fn.id.split('::').pop();
  document.getElementById('addFunctionsScope').textContent = `查找调用者 ${up} 层 / 被调用函数 ${down} 层。`;
  pickList.replaceChildren();
  syncPickCount();
  pickMessage.textContent = '正在查找，画布尚未改动…';
  openModal('addFunctionsModal');
  try {
    const view = await api.view({ root: fn.id, up, down, group: false, at: state.at });
    if (seq !== previewSequence) return;
    if (!Array.isArray(view.nodes)) throw new Error(view.error || '查找失败，请重试');
    if (state.view !== previewView || view.projectId !== previewView.projectId) throw new Error('画布已变化，请重新预览');
    const shown = new Set(previewView.nodes.map((node) => node.id));
    const names = new Map(view.nodes.map((node) => [node.id, node.name]));
    const candidates = view.nodes.filter((node) => node.kind !== 'var' && !shown.has(node.id));
    pickList.innerHTML = candidates.map((node) => {
      const calls = node.id === fn.id ? '目标函数' : view.edges.filter((edge) => edge.from === node.id || edge.to === node.id)
        .map((edge) => `${names.get(edge.from) || edge.from} → ${names.get(edge.to) || edge.to}`).join('；');
      return `<label class="function-pick"><input type="checkbox" data-function-id="${esc(node.id)}" checked>
        <span><b>${esc(node.name)}</b><small>${esc(node.file || '')}:${node.line || ''}</small>${calls ? `<small>${esc(calls)}</small>` : ''}</span></label>`;
    }).join('');
    pickMessage.textContent = candidates.length ? (view.truncated ? '查找已达上限，可减少层数后重试' : '取消不会改动画布') : '这些函数均已在画布中';
    syncPickCount();
  } catch (error) { if (seq === previewSequence) pickMessage.textContent = error.message; }
}

pickList?.addEventListener('change', syncPickCount);
pickAll?.addEventListener('change', () => {
  pickList.querySelectorAll('input').forEach((input) => { input.checked = pickAll.checked; });
  syncPickCount();
});
pickApply?.addEventListener('click', async () => {
  if (pickApply.disabled) return;
  if (state.view !== previewView) { pickMessage.textContent = '画布已变化，请重新预览'; return; }
  const ids = [...pickList.querySelectorAll('input:checked')].map((input) => input.dataset.functionId);
  pickApply.disabled = true;
  pickMessage.textContent = '正在加入…';
  try {
    const view = await hooks.addFunction(ids);
    if (!view || !ids.every((id) => view.nodes.some((node) => node.id === id))) throw new Error('加入失败，请重试');
    closeModal();
  } catch (error) { pickMessage.textContent = error.message; syncPickCount(); }
});
document.getElementById('addFunctionsCancel')?.addEventListener('click', closeModal);

const form = document.getElementById('expandForm');
const direction = document.getElementById('expandDirection');
const depth = document.getElementById('expandDepth');
const message = document.getElementById('expandMessage');
const apply = document.getElementById('expandApply');
let target = null;
let sequence = 0;

export function showExpansion(fn) {
  if (!form || !state.view) return;
  sequence++;
  target = { root: fn.id, projectId: state.view.projectId, comparisonId: state.view.comparison?.id };
  document.getElementById('expandFunction').textContent = fn.name || fn.label || fn.id;
  direction.value = 'up';
  depth.value = '1';
  message.textContent = '';
  apply.disabled = false;
  openModal('expandModal');
  depth.focus();
  depth.select();
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (apply.disabled || !target || !form.reportValidity()) return;
  const seq = sequence;
  const current = target;
  if (current.projectId !== state.view?.projectId || current.comparisonId !== state.view?.comparison?.id) {
    message.textContent = t('expand.projectChanged');
    return;
  }
  apply.disabled = true;
  message.textContent = t('expand.loading');
  try {
    await previewAddition({ id: current.root, name: document.getElementById('expandFunction').textContent },
      { up: direction.value === 'up' ? Number(depth.value) : 0, down: direction.value === 'down' ? Number(depth.value) : 0 });
    if (seq !== sequence) return;
  } catch (err) {
    if (seq === sequence) message.textContent = err.message || t('expand.failed');
  } finally {
    if (seq === sequence) apply.disabled = false;
  }
});
