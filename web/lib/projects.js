/**
 * 工程切换：最近打开的工程列表 + 手动输入路径
 * 切换后由 hooks.reloadAll 整体重载，服务端会重新解析目标工程
 */
import { t } from '../i18n.js';
import { api } from './api.js';
import { hooks } from './hooks.js';
import { openModal, closeModal, wireModals, esc } from './modal.js';

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
      <div class="tm">${fmtTime(p.openedAt)}</div>
    </div>`
    )
    .join('');
  listEl.querySelectorAll('.proj').forEach((row) => {
    row.addEventListener('click', () => switchTo({ id: Number(row.dataset.id) }));
  });
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
  if (p) switchTo({ path: p });
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
