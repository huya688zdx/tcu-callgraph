/**
 * 视图书签：把「入口集合 + 上下深度 + 分组 + 勾选的变量」存成名字。
 *
 * TCU 这种图每次找入口要点好几下文件树，存成「换挡链路」「ADC 采集」这种书签，
 * 下次一键跳回。书签按工程隔离，换工程看不到别的工程的书签。
 */
import { t } from '../i18n.js';
import { api } from './api.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { openModal, closeModal, wireModals, esc } from './modal.js';

const btn = document.getElementById('bookmarkBtn');
const listEl = document.getElementById('bookmarkList');
const nameInput = document.getElementById('bookmarkName');
const saveBtn = document.getElementById('bookmarkSave');
const summaryEl = document.getElementById('bookmarkSummary');
const feedbackEl = document.getElementById('bookmarkFeedback');
let writing = false;

const modeLabel = (group) => t(group ? 'bookmark.grouped' : 'bookmark.flat');

function meta(b) {
  const roots = (b.roots || []).filter(Boolean);
  const names = roots.map((id) => id.split('::').at(-1));
  const range = new Set([...roots, ...(b.expansions || []).map((scope) => scope.root)]).size;
  return [
    names.length ? t('bookmark.entries', { names: names.join(', ') }) : t('bookmark.noEntries'),
    t('bookmark.range', { n: range }),
    b.vars?.length ? t('bookmark.vars', { n: b.vars.length }) : '',
    modeLabel(b.group),
  ].filter(Boolean).join(' · ');
}

function feedback(message, error = false) {
  if (!feedbackEl) return;
  feedbackEl.textContent = message;
  feedbackEl.classList.toggle('error', error);
}

async function render() {
  if (!listEl) return;
  if (summaryEl) {
    const nodes = state.view?.nodes || [];
    const vars = nodes.filter((node) => node.kind === 'var').length;
    summaryEl.textContent = t('bookmark.summary', {
      functions: nodes.length - vars,
      vars,
      mode: modeLabel(state.group),
    });
  }
  let rows;
  try {
    rows = (await api.bookmarks()).list || [];
  } catch {
    listEl.innerHTML = `<div class="empty">${esc(t('bookmark.loadFailed'))}</div>`;
    return;
  }
  if (!rows.length) {
    listEl.innerHTML = `<div class="empty">${t('bookmark.empty')}</div>`;
    return;
  }
  const renameLabel = esc(t('project.rename'));
  listEl.innerHTML = rows
    .map(
      (b) => `
    <div class="bm">
      <div class="bm-content">
        <div class="nm">${esc(b.name)}</div>
        <div class="meta">${esc(meta(b))}</div>
      </div>
      <div class="bm-actions">
        <button type="button" class="bm-open">${esc(t('bookmark.open'))}</button>
        <button type="button" class="bm-update">${esc(t('bookmark.update'))}</button>
        <button type="button" class="bm-rename icon-btn" title="${renameLabel}" aria-label="${renameLabel}">✎</button>
        <button type="button" class="bm-delete">${esc(t('bookmark.delete'))}</button>
      </div>
    </div>`
    )
    .join('');

  listEl.querySelectorAll('.bm').forEach((row, index) => {
    const b = rows[index];
    const open = row.querySelector('.bm-open');
    const update = row.querySelector('.bm-update');
    const rename = row.querySelector('.bm-rename');
    const remove = row.querySelector('.bm-delete');
    rename.disabled = state.at > 0 || !!state.view?.comparison;
    row.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if ((button && button !== open) || open.disabled || row.querySelector('.bm-rename-input')) return;
      open.disabled = true;
      try {
        await hooks.applyBookmark(b);
        if (document.getElementById('bookmarkModal')?.classList.contains('show')) closeModal();
      } catch (err) {
        feedback(`${t('bookmark.openFailed')}：${err.message || err}`, true);
      } finally {
        open.disabled = false;
      }
    });
    update.addEventListener('click', () => save(b.name, update));
    rename.addEventListener('click', () => editName(row, b, rename));
    remove.addEventListener('click', () => write(remove, 'bookmark.deleteFailed', async () => {
      const result = await api.deleteBookmark(b.id);
      if (!result?.ok) throw new Error(result?.error);
      return t('bookmark.deleted');
    }));
  });
}

function editName(row, bookmark, renameButton) {
  if (writing) return;
  listEl.querySelector('.bm-rename-cancel')?.click();
  feedback('');

  const name = row.querySelector('.nm');
  const actions = row.querySelector('.bm-actions');
  const buttons = [...actions.children];
  name.innerHTML = `<input class="bm-rename-input" type="text" maxlength="80"
    aria-label="${esc(t('project.rename'))}" style="box-sizing: border-box; width: 100%; font: inherit">`;
  actions.innerHTML = `
    <button type="button" class="bm-rename-save primary">${esc(t('common.save'))}</button>
    <button type="button" class="bm-rename-cancel">${esc(t('common.cancel'))}</button>`;
  const input = name.querySelector('input');
  const saveButton = actions.querySelector('.bm-rename-save');
  const cancelButton = actions.querySelector('.bm-rename-cancel');
  input.value = bookmark.name;

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!event.isComposing) cancelButton.click();
    } else if (event.key === 'Enter' && event.target === input && !event.isComposing) {
      event.preventDefault();
      saveButton.click();
    }
  };
  row.addEventListener('keydown', onKey);
  cancelButton.addEventListener('click', () => {
    row.removeEventListener('keydown', onKey);
    name.textContent = bookmark.name;
    actions.replaceChildren(...buttons);
    feedback('');
    renameButton.focus();
  });
  saveButton.addEventListener('click', async () => {
    if (writing) return;
    const nextName = input.value.trim();
    if (!nextName) {
      feedback(t('bookmark.needName'), true);
      input.focus();
      return;
    }
    input.readOnly = true;
    cancelButton.disabled = true;
    await write(saveButton, 'bookmark.failed', async () => {
      const result = await api.renameBookmark(bookmark.id, nextName);
      if (!result?.ok) throw new Error(result?.error);
      return t('bookmark.updated');
    });
    input.readOnly = false;
    cancelButton.disabled = false;
    if (input.isConnected) input.focus();
  });
  input.focus();
  input.select();
}

async function write(button, errorKey, action) {
  if (writing) return;
  writing = true;
  button.disabled = true;
  feedback('');
  try {
    feedback(await action());
    await render();
  } catch (err) {
    feedback([t(errorKey), err.message].filter(Boolean).join('：'), true);
  } finally {
    button.disabled = false;
    writing = false;
  }
}

function save(name, button) {
  if (!name) return feedback(t('bookmark.needName'), true);
  if (!state.roots.length) return feedback(t('bookmark.noRoot'), true);
  return write(button, 'bookmark.failed', async () => {
    const result = await api.saveBookmark({
      name,
      roots: state.roots,
      expansions: state.expansions,
      up: state.up,
      down: state.down,
      group: state.group,
      groupMode: state.groupMode,
      vars: [...state.vars],
    });
    if (!result?.ok) throw new Error(result?.error);
    if (button !== saveBtn) return t('bookmark.updated');
    if (nameInput.value.trim() === name) nameInput.value = '';
    return t(result.overwritten ? 'bookmark.overwritten' : 'bookmark.saved');
  });
}

const saveCurrent = () => save(nameInput.value.trim(), saveBtn);

btn?.addEventListener('click', () => {
  openModal('bookmarkModal');
  feedback('');
  render();
  nameInput?.focus();
});
saveBtn?.addEventListener('click', saveCurrent);
nameInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) saveCurrent();
});

wireModals();
document.addEventListener('callgraph:langchange', () => {
  if (document.getElementById('bookmarkModal')?.classList.contains('show')) render();
});

export { render as renderBookmarks };
