/**
 * 手工节点弹窗：右键文件框或文件树中的文件，向该文件添加源码中不存在的函数或变量，
 * 立即放入当前画布并持久化，随后可直接手动连线。
 */
import { t } from '../i18n.js';
import { state } from './state.js';
import { api } from './api.js';
import { hooks } from './hooks.js';
import { openModal, closeModal, confirmDialog } from './modal.js';
import { loadStats, loadTree, resetVars, renderVars } from './panels.js';

let wired = false;
let currentFile = '';
let currentKind = 'fn';
let submitting = false;

function refs() {
  return {
    modal: document.getElementById('manualNodeModal'),
    file: document.getElementById('manualNodeFile'),
    kindFn: document.getElementById('manualKindFn'),
    kindVar: document.getElementById('manualKindVar'),
    name: document.getElementById('manualNodeName'),
    typeRow: document.getElementById('manualNodeTypeRow'),
    typeText: document.getElementById('manualNodeType'),
    change: document.getElementById('manualNodeChange'),
    error: document.getElementById('manualNodeError'),
    submit: document.getElementById('manualNodeSubmit'),
    cancel: document.getElementById('manualNodeCancel'),
    form: document.getElementById('manualNodeForm'),
  };
}

function setKind(kind) {
  currentKind = kind === 'var' ? 'var' : 'fn';
  const ui = refs();
  ui.kindFn?.setAttribute('aria-pressed', String(currentKind === 'fn'));
  ui.kindVar?.setAttribute('aria-pressed', String(currentKind === 'var'));
  if (ui.typeRow) ui.typeRow.hidden = currentKind !== 'var';
  if (ui.name) {
    ui.name.placeholder = currentKind === 'var'
      ? t('manual.varPlaceholder')
      : t('manual.fnPlaceholder');
  }
}

function setError(msg) {
  const { error } = refs();
  if (!error) return;
  error.textContent = msg || '';
  error.hidden = !msg;
}

function wireDialog() {
  if (wired) return;
  const ui = refs();
  if (!ui.modal || !ui.form) return;
  wired = true;
  ui.kindFn?.addEventListener('click', () => { setKind('fn'); ui.name?.focus(); });
  ui.kindVar?.addEventListener('click', () => { setKind('var'); ui.name?.focus(); });
  ui.cancel?.addEventListener('click', () => closeModal());
  ui.name?.addEventListener('input', () => setError(''));
  ui.form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (submitting || !currentFile) return;
    const name = ui.name.value.trim();
    if (!name) {
      setError(t('manual.nameRequired'));
      ui.name.focus();
      return;
    }
    if (name.includes('::')) {
      setError(t('manual.invalidName'));
      ui.name.focus();
      return;
    }
    submitting = true;
    ui.submit.disabled = true;
    setError('');
    try {
      const res = await api.addManualNode({
        file: currentFile,
        kind: currentKind,
        name,
        typeText: currentKind === 'var' ? ui.typeText.value.trim() : '',
        change: ui.change.value || 'existing',
      });
      if (!res?.ok || !res.node) {
        setError(res?.error || t('manual.addFailed'));
        return;
      }
      closeModal();
      const created = res.node;
      resetVars();
      await Promise.all([loadTree(), loadStats()]);
      if (created.kind === 'var') {
        await hooks.addFunction?.([], { restoreHidden: false, varIds: [created.id] });
      } else {
        await hooks.addFunction?.(created.id, { restoreHidden: false });
      }
      renderVars();
    } catch (err) {
      setError(String(err?.message || err || t('manual.addFailed')));
    } finally {
      submitting = false;
      ui.submit.disabled = false;
    }
  });
}

export function openManualNodeDialog({ file, kind = 'fn' } = {}) {
  if (!file || state.at || state.view?.comparison) return;
  wireDialog();
  const ui = refs();
  if (!ui.modal) return;
  currentFile = String(file);
  if (ui.file) ui.file.textContent = currentFile;
  if (ui.name) ui.name.value = '';
  if (ui.typeText) ui.typeText.value = '';
  if (ui.change) ui.change.value = 'existing';
  setError('');
  setKind(kind);
  openModal('manualNodeModal');
  requestAnimationFrame(() => ui.name?.focus());
}

export async function removeManualNodePermanently(node) {
  if (!node?.id || state.at || state.view?.comparison) return false;
  const label = node.name || node.id;
  const ok = await confirmDialog({
    title: t('manual.deleteTitle'),
    message: t('manual.deleteConfirm', { name: label }),
    okText: t('manual.deleteBtn'),
    danger: true,
  });
  if (!ok) return false;
  const res = await api.deleteManualNode({ id: node.id });
  if (!res?.ok) return false;
  state.roots = state.roots.filter((id) => id !== node.id);
  state.expansions = state.expansions.filter((s) => s.root !== node.id);
  state.vars.delete(node.id);
  state.hiddenVars.delete(node.id);
  if (state.selected === node.id) state.selected = null;
  resetVars();
  await Promise.all([loadTree(), loadStats()]);
  await hooks.reloadKeepCam?.();
  return true;
}
