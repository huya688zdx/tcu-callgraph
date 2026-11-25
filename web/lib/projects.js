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
const switchOverlay = document.getElementById('projectSwitchOverlay');
const switchOverlayText = document.getElementById('projectSwitchText');
const projectError = document.getElementById('projectError') || (listEl && document.createElement('div'));
if (projectError && !projectError.id) {
  projectError.id = 'projectError';
  projectError.setAttribute('role', 'status');
  projectError.style.margin = '0 12px 8px';
  projectError.hidden = true;
  listEl.after(projectError);
}
let switching = false;
let orphanTimer = 0;
const lockedControls = new Set();

function showSwitchBanner(text) {
  if (!switchOverlay) return;
  if (switchOverlayText) switchOverlayText.textContent = text || '';
  switchOverlay.hidden = !text;
}

function lockProjectControls() {
  document.querySelectorAll('#projectNormalPane button, #projectNormalPane input, #projectModeCompare').forEach((control) => {
    if (control.disabled) return;
    control.disabled = true;
    lockedControls.add(control);
  });
}

function projectMessage(message, error = false) {
  if (!projectError) return;
  projectError.className = error ? 'df-error' : 'detail-meta';
  projectError.textContent = message;
  projectError.hidden = !message;
}

const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${t('common.today')} ${hh}:${mm}`;
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
  if (switching) return;
  clearTimeout(orphanTimer);
  switching = true;
  listEl?.setAttribute('aria-busy', 'true');
  lockProjectControls();
  const targetLabel = body.path
    ? String(body.path).replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    : listEl?.querySelector(`.proj[data-id="${body.id}"] .nm`)?.textContent?.trim() || '';
  const parseMsg = targetLabel ? `${t('project.switching')} ${targetLabel}…` : t('project.switching');
  projectMessage(parseMsg);
  showSwitchBanner(parseMsg);
  // 立即收起弹窗让用户看到画布上的全屏切换进度提示（失败时再打开弹窗显示错误）
  if (document.getElementById('projectModal')?.classList.contains('show')) closeModal();
  try {
    const result = await api.switchProject(body);
    if (!result?.ok) throw new Error(result?.error || t('common.unknown'));
    const name = result.project?.name || targetLabel;
    showSwitchBanner(name ? `正在加载 ${name} 的文件树与画布…` : '正在加载文件树与画布…');
    if (btn && result.project) {
      btn.textContent = result.project.name;
      btn.title = result.project.path || result.project.name;
    }
    await hooks.reloadAll();
    void syncProjectLabel();
    projectMessage('');
  } catch (error) {
    openModal('projectModal');
    projectMessage(`${t('project.failed')}：${error.message || error}`, true);
  } finally {
    switching = false;
    showSwitchBanner('');
    listEl?.removeAttribute('aria-busy');
    for (const control of lockedControls) control.disabled = false;
    lockedControls.clear();
  }
}

async function render() {
  if (!listEl) return;
  let rows = [];
  try {
    rows = await api.projects();
  } catch {
    return;
  }
  if (!rows.length) {
    listEl.innerHTML = `<div class="empty">${t('project.empty')}</div>`;
    return;
  }
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
          <button class="icon-btn" data-action="rename" title="${t('project.rename')}" aria-label="${t('project.rename')}">${ICONS.rename}</button>
          <button class="icon-btn" data-action="folder" title="${t('project.openFolder')}" aria-label="${t('project.folder')}">${ICONS.folder}</button>
          <button class="icon-btn danger" data-action="remove" title="${t('project.removeHint')}" aria-label="${t('project.remove')}">${ICONS.remove}</button>
        </div>
      </div>
    </div>`
    )
    .join('');
  listEl.querySelectorAll('.proj').forEach((row) => {
    const project = rows.find((p) => p.id === Number(row.dataset.id));
    row.addEventListener('click', async (event) => {
      if (switching) return;
      const button = event.target.closest('button');
      if (!button) {
        if (!event.target.closest('input') && !row.querySelector('.proj-rename')) switchTo({ id: project.id });
        return;
      }
      try {
        if (button.dataset.action === 'rename') return rename(row, project);
        if (button.dataset.action === 'folder') {
          if (!window.callgraph?.openProjectFolder) return hint(t('project.desktopFolder'));
          await window.callgraph.openProjectFolder(project.id);
        } else if (button.dataset.action === 'remove') {
          const ok = await confirmDialog({
            title: t('project.removeRecent'),
            message: [t('project.removeConfirm', { name: project.name }), project.path, t('project.removeKeep')].join('\n'),
            danger: true,
          });
          if (!ok || switching) return;
          button.disabled = true;
          const result = await api.removeProject(project.id);
          if (!result.ok) throw new Error(result.error);
          await render();
          hint(t('project.removedRecent'));
        }
      } catch (error) { hint(error.message); button.disabled = false; }
    });
  });
  if (switching) lockProjectControls();
}

/** 在列表内编辑，避免 Electron 不支持浏览器 prompt，也避免误触工程切换。 */
function rename(row, project) {
  if (row.querySelector('.proj-rename')) return;
  const name = row.querySelector('.nm');
  const original = name.innerHTML;
  row.classList.add('renaming'); // 编辑期间收起右侧操作图标，少一层干扰
  name.innerHTML = `<div class="proj-rename"><input aria-label="${t('project.name')}" maxlength="80" value="${esc(project.name)}"><button class="icon-btn ok" data-save title="${t('common.save')}" aria-label="${t('common.save')}">${ICONS.save}</button><button class="icon-btn" data-cancel title="${t('common.cancel')}" aria-label="${t('common.cancel')}">${ICONS.cancel}</button></div>`;
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
    if (switching) return;
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
  if (switching) lockProjectControls();
}

function open() {
  openModal('projectModal');
  render();
  // 延迟检测旧工程失效标注：用户立刻点击切换工程时绝不触发旧工程全量数据流分析
  clearTimeout(orphanTimer);
  orphanTimer = setTimeout(() => {
    if (!switching && document.getElementById('projectModal')?.classList.contains('show')) renderOrphans();
  }, 300);
  pathInput?.focus();
}

btn?.addEventListener('click', open);
openBtn?.addEventListener('click', async () => {
  const p = pathInput?.value.trim();
  // 填了路径直接切；空着则调起系统文件夹选择框并复用 switchTo 展示加载进度
  if (p) return switchTo({ path: p });
  if (window.callgraph?.pickFolder) {
    const dir = await window.callgraph.pickFolder();
    if (dir) return switchTo({ path: dir });
  } else {
    pathInput?.focus();
  }
});

// Electron 菜单 / Ctrl+O 选目录后走同一套带进度提示的切换流程
window.addEventListener('cg:switch-project-path', (ev) => {
  if (ev?.detail) void switchTo({ path: String(ev.detail) });
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
    hint(`${t('session.importFailed')}: ${t('session.invalidJson')}`);
    return;
  }
  const ok = await confirmDialog({ title: t('session.import'), message: t('session.overwrite') });
  if (!ok) return;
  const r = await api.importSession(payload).catch((error) => ({ ok: false, error: error.message }));
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
