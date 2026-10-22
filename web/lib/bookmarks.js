/**
 * 视图书签：把「入口集合 + 上下深度 + 分组/固定模式 + 勾选的变量」存成名字。
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

const meta = (b) => {
  const base = t('bookmark.meta').replace('{n}', b.roots.length).replace('{down}', b.down);
  return `${base} · ${b.group ? '分组' : '平铺'}${b.fixed ? ' · 固定' : ''}`;
};

/** 按钮上短暂显示一句提示，不弹 toast（这个界面没有 toast 系统） */
function flash(msg, ok = true) {
  if (!saveBtn) return;
  saveBtn.textContent = msg;
  saveBtn.disabled = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => {
    saveBtn.textContent = t('bookmark.save');
  }, 1600);
  if (!ok) saveBtn.style.background = '#A32D2D';
  else saveBtn.style.background = '';
}

async function render() {
  if (!listEl) return;
  let rows = [];
  try {
    rows = (await api.bookmarks()).list || [];
  } catch {
    rows = [];
  }
  if (!rows.length) {
    listEl.innerHTML = `<div class="empty">${t('bookmark.empty')}</div>`;
    return;
  }
  listEl.innerHTML = rows
    .map(
      (b) => `
    <div class="bm" data-id="${b.id}">
      <div style="flex:1;min-width:0">
        <div class="nm">${esc(b.name)}</div>
        <div class="meta">${esc(meta(b))}</div>
      </div>
      <button class="del" data-del="${b.id}" title="删除书签">&times;</button>
    </div>`
    )
    .join('');

  listEl.querySelectorAll('.bm').forEach((row) => {
    row.addEventListener('click', async () => {
      const b = rows.find((x) => x.id === Number(row.dataset.id));
      if (!b) return;
      closeModal();
      await hooks.applyBookmark(b);
    });
  });

  listEl.querySelectorAll('[data-del]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = Number(el.dataset.del);
      const r = await api.deleteBookmark(id);
      if (r && r.ok) await render();
    });
  });
}

async function save() {
  const name = (nameInput?.value || '').trim();
  if (!name) return flash(t('bookmark.needName'), false);
  if (!state.roots.length) return flash(t('bookmark.noRoot'), false);

  const r = await api.saveBookmark({
    name,
    roots: state.roots,
    up: state.up,
    down: state.down,
    group: state.group,
    fixed: state.fixed,
    vars: [...state.vars],
  });
  if (!r || !r.ok) return flash(`${t('bookmark.failed')}：${r?.error || ''}`, false);

  if (nameInput) nameInput.value = '';
  flash(r.overwritten ? t('bookmark.overwritten') : t('bookmark.saved'));
  await render();
}

btn?.addEventListener('click', () => {
  openModal('bookmarkModal');
  render();
  nameInput?.focus();
});
saveBtn?.addEventListener('click', save);
nameInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') save();
});

wireModals();

export { render as renderBookmarks };
