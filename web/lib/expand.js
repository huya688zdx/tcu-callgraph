/** 从画布或文件树里的函数发起局部层级查找。 */
import { t } from '../i18n.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { openModal, closeModal } from './modal.js';

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
    const view = await hooks.expandFunction(current.root, direction.value, Number(depth.value));
    if (seq !== sequence) return;
    if (!view) throw new Error(t('expand.failed'));
    if (view.truncated) message.textContent = t('expand.truncated');
    else closeModal();
  } catch (err) {
    if (seq === sequence) message.textContent = err.message || t('expand.failed');
  } finally {
    if (seq === sequence) apply.disabled = false;
  }
});
