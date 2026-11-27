/**
 * 视图书签：把「入口集合 + 上下深度 + 分组 + 勾选的变量」存成名字。
 *
 * TCU 这种图每次找入口要点好几下文件树，存成「换挡链路」「ADC 采集」这种书签，
 * 下次一键跳回。书签按工程隔离，换工程看不到别的工程的书签。
 */
import { t } from '../i18n.js';
import { api } from './api.js';
import { isBookmarkDirty, state } from './state.js';
import { hooks } from './hooks.js';
import { openModal, closeModal, wireModals, esc } from './modal.js';

const btn = document.getElementById('bookmarkBtn');
const listEl = document.getElementById('bookmarkList');
const nameInput = document.getElementById('bookmarkName');
const saveBtn = document.getElementById('bookmarkSave');
const summaryEl = document.getElementById('bookmarkSummary');
const feedbackEl = document.getElementById('bookmarkFeedback');
const modal = document.getElementById('bookmarkModal');
let writing = false;
let refreshPending = false;
let renderSeq = 0;

const modeLabel = (group) => t(group ? 'bookmark.grouped' : 'bookmark.flat');

export function bookmarkMetadata(active, incoming, renamed) {
  if (incoming.revision < active.revision) return active;
  // 只跨过已知基线上的一次纯改名；跳号意味着可能漏掉了作用域更新。
  const revision = renamed && incoming.revision === active.revision + 1 ? incoming.revision : active.revision;
  return { ...active, name: incoming.name, revision };
}

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
  refreshPending = false;
  const seq = ++renderSeq;
  const projectId = state.view?.projectId;
  const isCurrent = () => seq === renderSeq && state.view?.projectId === projectId;
  if (summaryEl) {
    const nodes = state.view?.nodes || [];
    const vars = nodes.filter((node) => node.kind === 'var').length;
    const baseText = t('bookmark.summary', {
      functions: nodes.length - vars,
      vars,
      mode: modeLabel(state.group),
    });
    const bm = state.activeBookmark;
    const dirty = isBookmarkDirty();
    summaryEl.replaceChildren();
    const info = document.createElement('span');
    info.textContent = bm
      ? `${baseText} · 当前：${bm.name}${dirty ? '（有未保存改动 ●）' : ''}`
      : `${baseText} · ${t('bookmark.unnamed')}`;
    summaryEl.append(info);
    if (bm) {
      const actions = document.createElement('span');
      actions.className = 'bm-summary-actions';
      if (dirty && state.roots.length && !state.at && !state.view?.comparison) {
        const updateCurrentBtn = document.createElement('button');
        updateCurrentBtn.type = 'button';
        updateCurrentBtn.className = 'primary';
        updateCurrentBtn.textContent = '更新当前书签';
        updateCurrentBtn.addEventListener('click', () => {
          void saveUpdateByBookmark({ ...bm }, updateCurrentBtn);
        });
        actions.append(updateCurrentBtn);
      }
      const detachBtn = document.createElement('button');
      detachBtn.type = 'button';
      detachBtn.textContent = t('bookmark.detach');
      detachBtn.addEventListener('click', () => {
        const prev = state.activeBookmark;
        state.activeBookmark = null;
        hooks.syncBookmarkBadge?.();
        window.dispatchEvent(new CustomEvent('cg:bookmark-changed', { detail: { bookmark: null, prev } }));
        void render();
      });
      actions.append(detachBtn);
      summaryEl.append(actions);
    }
  }
  let rows;
  try {
    const result = await api.bookmarks();
    if (result?.ok === false) throw new Error(result.error);
    rows = result.list || [];
  } catch {
    if (isCurrent()) listEl.innerHTML = `<div class="empty">${esc(t('bookmark.loadFailed'))}</div>`;
    return;
  }
  if (!isCurrent()) return;
  if (writing || listEl.querySelector('.bm-rename-input')) {
    refreshPending = true;
    return;
  }
  if (!rows.length) {
    listEl.innerHTML = `<div class="empty">${t('bookmark.empty')}</div>`;
    return;
  }
  const renameLabel = esc(t('project.rename'));
  listEl.innerHTML = rows
    .map(
      (b) => {
        const active = state.activeBookmark?.id === b.id;
        const dirty = active && isBookmarkDirty();
        return `
    <div class="bm${active ? ' is-active' : ''}">
      <div class="bm-content">
        <div class="nm">${esc(b.name)}${active ? ` <span class="bm-active-tag">${esc(t('bookmark.activeTag'))}${dirty ? ' ●' : ''}</span>` : ''}</div>
        <div class="meta">${esc(meta(b))}</div>
      </div>
      <div class="bm-actions">
        <button type="button" class="bm-open">${esc(t('bookmark.open'))}</button>
        <button type="button" class="bm-update">${esc(t('bookmark.update'))}</button>
        <button type="button" class="bm-rename icon-btn" title="${renameLabel}" aria-label="${renameLabel}">✎</button>
        <button type="button" class="bm-delete">${esc(t('bookmark.delete'))}</button>
      </div>
    </div>`;
      }
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
        if (modal?.classList.contains('show')) closeModal();
      } catch (err) {
        feedback(`${t('bookmark.openFailed')}：${err.message || err}`, true);
      } finally {
        open.disabled = false;
      }
    });
    update.addEventListener('click', () => saveUpdateByBookmark(b, update));
    rename.addEventListener('click', () => editName(row, b, rename));
    remove.addEventListener('click', () => write(remove, 'bookmark.deleteFailed', async () => {
      const result = await api.deleteBookmark(b.id);
      if (!result?.ok) throw new Error(result?.error);
      if (state.activeBookmark?.id === b.id) {
        const prev = state.activeBookmark;
        state.activeBookmark = null;
        hooks.syncBookmarkBadge?.();
        window.dispatchEvent(new CustomEvent('cg:bookmark-changed', { detail: { bookmark: null, prev } }));
      }
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
    if (refreshPending) reloadBookmarks();
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
    try {
      const saved = await write(saveButton, 'bookmark.failed', async () => {
        const result = await api.renameBookmark(bookmark.id, nextName);
        if (!result?.ok) throw new Error(result?.error);
        if (state.activeBookmark?.id === bookmark.id && result.bookmark) {
          const prev = state.activeBookmark;
          state.activeBookmark = bookmarkMetadata(prev, result.bookmark, true);
          hooks.syncBookmarkBadge?.();
          window.dispatchEvent(new CustomEvent('cg:bookmark-changed', { detail: { bookmark: state.activeBookmark, prev } }));
        }
        return t('bookmark.updated');
      });
      if (saved) {
        row.removeEventListener('keydown', onKey);
        name.textContent = nextName;
      }
    } finally {
      input.readOnly = false;
      cancelButton.disabled = false;
      if (input.isConnected) input.focus();
      if (refreshPending) reloadBookmarks();
    }
  });
  input.focus();
  input.select();
}

async function write(button, errorKey, action) {
  if (writing) return false;
  writing = true;
  button.disabled = true;
  const projectId = state.view?.projectId;
  feedback('');
  try {
    const message = await action();
    if (message === undefined) return false;
    if (projectId === state.view?.projectId && modal?.classList.contains('show')) {
      feedback(message);
      refreshPending = true;
    }
    return true;
  } catch (err) {
    if (projectId === state.view?.projectId) feedback([t(errorKey), err.message].filter(Boolean).join('：'), true);
    return false;
  } finally {
    button.disabled = false;
    writing = false;
    if (refreshPending) reloadBookmarks();
  }
}

async function saveUpdateByBookmark(bookmark, button) {
  if (!state.roots.length) return feedback(t('bookmark.noRoot'), true);
  return write(button, 'bookmark.failed', async () => {
    const reply = await hooks.requestBookmarkSave(api.updateBookmark, {
      id: bookmark.id,
      expectedRevision: state.activeBookmark?.id === bookmark.id ? state.activeBookmark.revision : bookmark.revision,
    });
    if (!reply?.isCurrent()) return;
    const { result, fingerprint } = reply;
    if (result?.conflict) {
      refreshPending = true;
      throw new Error(t('bookmark.conflict'));
    }
    if (!result?.ok || !result.bookmark) throw new Error(result?.error || t('bookmark.failed'));
    const bm = result.bookmark;
    const prev = state.activeBookmark;
    state.activeBookmark = {
      id: bm.id,
      name: bm.name,
      revision: bm.revision || 1,
      baseFingerprint: fingerprint,
    };
    state.bookmarkDrafts.delete(String(bm.id));
    hooks.syncBookmarkBadge?.();
    if (prev?.id !== bm.id || prev?.name !== bm.name) {
      window.dispatchEvent(new CustomEvent('cg:bookmark-changed', { detail: { bookmark: state.activeBookmark, prev } }));
    }
    return t('bookmark.updated');
  });
}

function save(name, button) {
  if (!name) return feedback(t('bookmark.needName'), true);
  if (!state.roots.length) return feedback(t('bookmark.noRoot'), true);
  return write(button, 'bookmark.failed', async () => {
    const reply = await hooks.requestBookmarkSave(api.saveBookmark, { name });
    if (!reply?.isCurrent()) return;
    const { result, fingerprint } = reply;
    if (!result?.ok) throw new Error(result?.error);
    if (result.bookmark) {
      const bm = result.bookmark;
      const prev = state.activeBookmark;
      state.activeBookmark = {
        id: bm.id,
        name: bm.name,
        revision: bm.revision || 1,
        baseFingerprint: fingerprint,
      };
      state.bookmarkDrafts.delete('__unnamed__');
      state.bookmarkDrafts.delete(String(bm.id));
      hooks.syncBookmarkBadge?.();
      window.dispatchEvent(new CustomEvent('cg:bookmark-changed', { detail: { bookmark: state.activeBookmark, prev } }));
    }
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
modal?.addEventListener('cg:modal-closed', () => {
  renderSeq++;
  listEl.replaceChildren();
});
document.addEventListener('callgraph:langchange', reloadBookmarks);
window.addEventListener('cg:bookmark-changed', reloadBookmarks);

export function reloadBookmarks() {
  if (!modal?.classList.contains('show')) return;
  if (writing || listEl.querySelector('.bm-rename-input')) refreshPending = true;
  else void render();
}
