/**
 * 工程切换：最近打开的工程列表 + 手动输入路径
 * 切换后由 hooks.reloadAll 整体重载，服务端会重新解析目标工程
 */
import { t } from '../i18n.js';
import { api } from './api.js';
import { hooks } from './hooks.js';
import { state } from './state.js';
import { draw } from './render.js';
import { loadTree, syncTreeSelection } from './panels.js';
import { openModal, closeModal, wireModals, esc, confirmDialog } from './modal.js';

const btn = document.getElementById('projectBtn');
const listEl = document.getElementById('projectList');
const pathInput = document.getElementById('projectPath');
const openBtn = document.getElementById('projectOpen');

const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `今天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
};

/** 行内操作的小图标（与文字按钮相比更省宽度），颜色跟随按钮 currentColor */
const ICON = (paths) =>
  `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  rename: ICON('<path d="M11.1 2.7a1.6 1.6 0 0 1 2.3 2.3L5.6 12.8l-3.1.9.9-3.1z"/>'),
  folder: ICON(
    '<path d="M1.8 13.2V4.2a1 1 0 0 1 1-1h3.5l1.5 1.8h5.4a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"/>'
  ),
  remove: ICON('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  save: ICON('<path d="M3 8.5l3.2 3.2L13 5"/>'),
  cancel: ICON('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
};

/** 顶栏按钮显示当前工程名，让用户始终知道自己在看哪个工程 */
export async function syncProjectLabel() {
  try {
    const p = await api.project();
    if (btn) {
      btn.textContent = p.name + (p.changed ? ' *' : '');
      btn.title = `${p.path}${p.changed ? `\n${t('project.changed')}` : ''}`;
    }
  } catch {
    /* 工程信息拿不到不影响主流程 */
  }
}

async function switchTo(body) {
  if (listEl) listEl.innerHTML = `<div class="empty">${t('project.switching')}</div>`;
  let r;
  try {
    r = await api.switchProject(body);
  } catch (err) {
    r = { ok: false, error: String(err.message || err) };
  }
  if (!r || !r.ok) {
    if (listEl) {
      listEl.innerHTML = `<div class="empty">${t('project.failed')}：${esc(r?.error || '未知错误')}</div>`;
    }
    return;
  }
  closeModal();
  await hooks.reloadAll();
  await syncProjectLabel();
}

async function render() {
  if (!listEl) return;
  listEl.innerHTML = `<div class="empty">${t('project.empty')}</div>`;
  let rows = [];
  try {
    rows = await api.projects();
  } catch {
    return;
  }
  if (!rows.length) return;
  listEl.innerHTML = rows
    .map(
      (p) => `
    <div class="proj${p.current ? ' current' : ''}" data-id="${p.id}" title="${esc(p.path)}">
      <div style="flex:1;min-width:0">
        <div class="nm">${esc(p.name)}${
          p.current ? ` <span class="badge">${t('project.current')}</span>` : ''
        }</div>
        <div class="pt">${esc(p.path)}</div>
      </div>
      <div class="proj-tools"><div class="tm">${fmtTime(p.openedAt)}</div>
        <div class="proj-actions">
          <button class="icon-btn" data-action="rename" title="重命名" aria-label="重命名">${ICONS.rename}</button>
          <button class="icon-btn" data-action="folder" title="打开工程所在文件夹" aria-label="所在文件夹">${ICONS.folder}</button>
          <button class="icon-btn danger" data-action="remove" title="从最近列表移除，保留源码与存档；重新打开原路径即可恢复" aria-label="移出列表">${ICONS.remove}</button>
        </div>
      </div>
    </div>`
    )
    .join('');
  listEl.querySelectorAll('.proj').forEach((row) => {
    const project = rows.find((p) => p.id === Number(row.dataset.id));
    row.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) {
        if (!event.target.closest('input') && !row.querySelector('.proj-rename')) switchTo({ id: project.id });
        return;
      }
      try {
        if (button.dataset.action === 'rename') return rename(row, project);
        if (button.dataset.action === 'folder') {
          if (!window.callgraph?.openProjectFolder) return hint('请在桌面版中打开工程所在文件夹');
          await window.callgraph.openProjectFolder(project.id);
        } else if (button.dataset.action === 'remove') {
          const ok = await confirmDialog({
            title: '移出最近列表',
            message: `确定将工程“${project.name}”移出最近列表吗？\n${project.path}\n源码和存档都会保留，重新打开原路径即可恢复。`,
            danger: true,
          });
          if (!ok) return;
          button.disabled = true;
          const result = await api.removeProject(project.id);
          if (!result.ok) throw new Error(result.error);
          await render();
          hint('已移出最近列表，源码和存档保留；打开原路径即可恢复');
        }
      } catch (error) { hint(error.message); button.disabled = false; }
    });
  });
}

/** 在列表内编辑，避免 Electron 不支持浏览器 prompt，也避免误触工程切换。 */
function rename(row, project) {
  if (row.querySelector('.proj-rename')) return;
  const name = row.querySelector('.nm');
  const original = name.innerHTML;
  row.classList.add('renaming'); // 编辑期间收起右侧操作图标，少一层干扰
  name.innerHTML = `<div class="proj-rename"><input aria-label="工程名称" maxlength="80" value="${esc(project.name)}"><button class="icon-btn ok" data-save title="保存" aria-label="保存">${ICONS.save}</button><button class="icon-btn" data-cancel title="取消" aria-label="取消">${ICONS.cancel}</button></div>`;
  const input = name.querySelector('input'), save = name.querySelector('[data-save]');
  const cancel = () => {
    if (save.disabled) return;
    row.classList.remove('renaming');
    name.innerHTML = original;
  };
  const commit = async () => {
    if (save.disabled) return;
    save.disabled = true;
    try {
      const result = await api.renameProject(project.id, input.value);
      if (!result.ok) throw new Error(result.error);
      if (state.view?.projectId === project.id) {
        const root = state.view.containers?.find((c) => c.root);
        if (root) root.label = result.project.name;
        draw();
        await syncProjectLabel();
        await loadTree(); syncTreeSelection(state.roots);
      }
      await render();
    } catch (error) { hint(error.message); save.disabled = false; input.focus(); }
  };
  save.addEventListener('click', (event) => { event.stopPropagation(); commit(); });
  name.querySelector('[data-cancel]').addEventListener('click', (event) => { event.stopPropagation(); cancel(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Escape') { event.stopPropagation(); cancel(); }
  });
  input.focus(); input.select();
}

/** 失效标注：源码删了函数之后，标注还留在库里，必须给用户一个清理入口 */
async function renderOrphans() {
  const box = document.getElementById('orphanBox');
  if (!box) return;
  let o;
  try {
    o = await api.orphans();
  } catch {
    box.classList.remove('show');
    return;
  }
  if (!o || !o.total) {
    box.classList.remove('show');
    box.innerHTML = '';
    return;
  }

  const sample = [
    ...o.annotations.map((a) => a.id),
    ...o.deleted.map((d) => d.id),
    ...o.layoutSlots.map((s) => `${s.viewKey} (${s.mode})`),
    ...o.layoutNodes.flatMap((n) => n.ids),
  ].slice(0, 4);

  box.classList.add('show');
  box.innerHTML = `
    <div class="orphan-head">
      <div style="flex:1;min-width:0">
        <div class="nm">${t('orphan.title')} <span class="badge">${o.total}</span></div>
        <div class="pt">${t('orphan.desc')}</div>
        <div class="ids">${sample.map(esc).join(' · ')}${o.total > sample.length ? ' …' : ''}</div>
      </div>
      <button id="orphanClean" class="primary">${t('orphan.clean')}</button>
    </div>`;

  document.getElementById('orphanClean')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = t('project.switching');
    const r = await api.purgeOrphans();
    btn.disabled = false;
    if (r && r.ok) {
      btn.textContent = `${t('orphan.cleaned')} ${r.removed}`;
      await renderOrphans();
      await hooks.reloadAll();
    } else {
      btn.textContent = t('orphan.failed');
    }
  });
}

function open() {
  openModal('projectModal');
  render();
  renderOrphans();
  pathInput?.focus();
}

btn?.addEventListener('click', open);
openBtn?.addEventListener('click', () => {
  const p = pathInput?.value.trim();
  // 填了路径直接切；空着则调起系统文件夹选择框（Electron 经 preload 暴露的能力）
  if (p) return switchTo({ path: p });
  if (window.callgraph?.pickFolder) window.callgraph.pickFolder();
  else pathInput?.focus();
});

// ---- 会话导出 / 导入 ----
const exportBtn = document.getElementById('sessionExport');
const importBtn = document.getElementById('sessionImport');
const fileInput = document.getElementById('sessionFile');
const hintEl = document.getElementById('sessionHint');

function hint(msg) {
  if (!hintEl) return;
  hintEl.textContent = msg;
  clearTimeout(hint.timer);
  hint.timer = setTimeout(() => (hintEl.textContent = ''), 4000);
}

exportBtn?.addEventListener('click', () => {
  hint(t('session.exporting'));
  // 直接走下载，不用 fetch——大文件交给浏览器流式处理更稳
  window.location.href = '/api/session/export';
});

importBtn?.addEventListener('click', () => fileInput?.click());

fileInput?.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    hint(`${t('session.importFailed')}：文件不是合法 JSON`);
    return;
  }
  const r = await api.importSession(payload);
  if (!r || !r.ok) {
    hint(`${t('session.importFailed')}：${r?.error || ''}`);
    return;
  }
  const i = r.imported || {};
  hint(
    t('session.imported').replace('{a}', i.annotations || 0).replace('{l}', i.layout || 0).replace('{b}', i.bookmarks || 0) +
      (r.sameCode ? '' : t('session.codeMismatch'))
  );
  // 导入后标注 / 布局全变了，整体重载一次
  await hooks.reloadAll();
});

pathInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const p = pathInput.value.trim();
    if (p) switchTo({ path: p });
  }
});

wireModals();
syncProjectLabel();

export { open as openProjectPanel };
