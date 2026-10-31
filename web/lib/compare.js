import { api } from './api.js';
import { hooks } from './hooks.js';
import { t } from '../i18n.js';
import { closeModal, openModal, esc } from './modal.js';
import { syncProjectLabel } from './projects.js';
import { state } from './state.js';
import { statusOptions } from './change-status.js';

const normalMode = document.getElementById('projectModeNormal');
const compareMode = document.getElementById('projectModeCompare');
const normalPane = document.getElementById('projectNormalPane');
const comparePane = document.getElementById('projectComparePane');
const projectPath = document.getElementById('compareProjectPath');
const beforePath = document.getElementById('compareBeforePath');
const afterPath = document.getElementById('compareAfterPath');
const errorEl = document.getElementById('compareError');
const startBtn = document.getElementById('compareStart');
const summaryEl = document.getElementById('compareSummary');
const exitBtn = document.getElementById('compareExit');
const browseButtons = document.querySelectorAll('[data-compare-browse]');
let activeComparison = null;
let preview = null;
let selected = new Set();
let statuses = new Map();
const effectiveChange = (n) => statuses.get(n.id) || n.change;
let selectionPage = 0;
let applying = false;
const pageSize = 100;
const picker = document.getElementById('compareSelectModal');
const pickList = document.getElementById('comparePickList');
const pickSearch = document.getElementById('comparePickSearch');
const pickType = document.getElementById('comparePickType');
const pickChange = document.getElementById('comparePickChange');
const pickApply = document.getElementById('comparePickApply');
const pickError = document.getElementById('comparePickError');
const retainedIds = () => {
  const valid = new Set(preview?.validRetainIds || []);
  return (state.view?.nodes || []).map((n) => n.id).filter((id) => valid.has(id));
};

function renderSelection() {
  if (!preview || !pickList) return;
  const q = pickSearch.value.trim().toLowerCase();
  const list = preview.candidates.filter((n) =>
    (pickType.value === 'all' || n.kind === pickType.value) &&
    (pickChange.value === 'all' || (pickChange.value === 'changed' ? effectiveChange(n) !== 'existing' : effectiveChange(n) === pickChange.value)) &&
    (!q || `${n.name} ${n.file}`.toLowerCase().includes(q)));
  selectionPage = Math.min(selectionPage, Math.max(0, Math.ceil(list.length / pageSize) - 1));
  const loc = (n, version) => n.locations?.[version] ? `${n.locations[version].file}:${n.locations[version].line}` : '—';
  pickList.innerHTML = list.slice(selectionPage * pageSize, (selectionPage + 1) * pageSize).map((n) =>
    `<label class="compare-pick-row"><input type="checkbox" data-id="${esc(n.id)}" ${selected.has(n.id) ? 'checked' : ''}>
      <span><b>${esc(n.name)}</b> · ${n.kind === 'var' ? '变量' : '函数'}
      <select data-status-id="${esc(n.id)}" aria-label="${esc(n.name)} 状态">${statusOptions(statuses.get(n.id) || 'auto', n.change)}</select>
      <small>before：${esc(loc(n, 'before'))}<br>after：${esc(loc(n, 'after'))}</small>
      <small>${esc((n.reasons || []).join('；'))}${n.context ? ' · 调用上下文' : ''}</small></span></label>`
  ).join('') || '<div class="empty">没有符合筛选条件的对象</div>';
  const retained = retainedIds();
  const total = new Set([...retained, ...selected]).size;
  const missing = (state.view?.nodes.length || 0) - retained.length;
  document.getElementById('comparePickRetainWarning').textContent = missing ? `原图有 ${missing} 个节点未在对照模型中找到，无法保留到比较图；取消可继续保留原画面。` : '';
  document.getElementById('comparePickCount').textContent = `已选 ${selected.size} 项；保留原图 ${retained.length} 个节点；合计 ${total} / 600；手动状态 ${statuses.size} 项`;
  document.getElementById('comparePickPage').textContent = `${selectionPage + 1} / ${Math.max(1, Math.ceil(list.length / pageSize))} · ${list.length} 项`;
  document.getElementById('comparePickPrev').disabled = selectionPage === 0;
  document.getElementById('comparePickNext').disabled = (selectionPage + 1) * pageSize >= list.length;
  pickApply.disabled = !selected.size || total > 600;
}

function cancelSelection() {
  if (applying) return;
  const id = preview?.id;
  preview = null;
  selected.clear();
  statuses.clear();
  closeModal();
  if (id) api.cancelComparison(id).catch(() => {});
}
pickList?.addEventListener('change', (event) => {
  if (event.target.dataset.statusId) {
    const id = event.target.dataset.statusId;
    if (event.target.value === 'auto') statuses.delete(id); else statuses.set(id, event.target.value);
    renderSelection();
    return;
  }
  const id = event.target.dataset.id;
  if (!id) return;
  if (event.target.checked) selected.add(id); else selected.delete(id);
  renderSelection();
});
for (const el of [pickSearch, pickType, pickChange]) el?.addEventListener('input', () => { selectionPage = 0; renderSelection(); });
document.getElementById('comparePickChanged')?.addEventListener('click', () => {
  selected = new Set(preview.candidates.filter((n) => effectiveChange(n) !== 'existing').map((n) => n.id)); renderSelection();
});
document.getElementById('comparePickClear')?.addEventListener('click', () => { selected.clear(); renderSelection(); });
document.getElementById('comparePickPrev')?.addEventListener('click', () => { selectionPage--; renderSelection(); });
document.getElementById('comparePickNext')?.addEventListener('click', () => { selectionPage++; renderSelection(); });
document.getElementById('comparePickCancel')?.addEventListener('click', cancelSelection);
picker?.querySelector('.modal-close')?.addEventListener('click', cancelSelection);
document.getElementById('overlayMask')?.addEventListener('click', (event) => {
  if (applying) { event.stopImmediatePropagation(); return; }
  if (preview) cancelSelection();
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && applying) { event.stopImmediatePropagation(); return; }
  if (event.key === 'Escape' && preview && picker?.classList.contains('show')) cancelSelection();
}, true);
pickApply?.addEventListener('click', async () => {
  if (!preview || !selected.size) return;
  applying = true;
  pickApply.disabled = true;
  document.getElementById('comparePickCancel').disabled = true;
  picker.querySelector('.modal-close').disabled = true;
  pickError.textContent = '';
  try {
    const result = await api.applyComparison({ previewId: preview.id, selectedIds: [...selected], retainIds: retainedIds(), statusOverrides: Object.fromEntries(statuses) });
    if (!result?.ok) throw new Error(result?.error || '加入失败');
    preview = null;
    activeComparison = result.comparison;
    syncComparison(activeComparison);
    await hooks.applyComparison(result.roots);
    closeModal();
  } catch (error) { pickError.textContent = error.message || String(error); }
  finally {
    applying = false;
    document.getElementById('comparePickCancel').disabled = false;
    picker.querySelector('.modal-close').disabled = false;
    if (preview) renderSelection();
  }
});

async function showMode(comparing) {
  normalMode?.setAttribute('aria-pressed', String(!comparing));
  compareMode?.setAttribute('aria-pressed', String(comparing));
  if (normalPane) normalPane.hidden = comparing;
  if (comparePane) comparePane.hidden = !comparing;
  if (errorEl) errorEl.textContent = '';
  if (comparing) {
    try {
      const project = await api.project();
      if (projectPath) projectPath.value = project.comparison?.projectPath || project.path;
    } catch (error) {
      if (errorEl) errorEl.textContent = `${t('compare.failed')}：${error.message || error}`;
    }
  }
}

normalMode?.addEventListener('click', () => showMode(false));
compareMode?.addEventListener('click', () => showMode(true));

browseButtons.forEach((button) => {
  button.disabled = typeof window.callgraph?.chooseDirectory !== 'function';
  button.addEventListener('click', async () => {
    const input = button.dataset.compareBrowse === 'before' ? beforePath : afterPath;
    if (!window.callgraph?.chooseDirectory || !input) return;
    try {
      const selected = await window.callgraph.chooseDirectory({ title: t(`compare.${button.dataset.compareBrowse}`) });
      if (selected) input.value = selected;
    } catch (error) {
      if (errorEl) errorEl.textContent = `${t('compare.failed')}：${error.message || error}`;
    }
  });
});

startBtn?.addEventListener('click', async () => {
  const paths = { beforePath: beforePath?.value.trim(), afterPath: afterPath?.value.trim() };
  if (!paths.beforePath || !paths.afterPath) {
    if (errorEl) errorEl.textContent = t('compare.missingPath');
    return;
  }
  startBtn.disabled = true;
  startBtn.textContent = t('compare.starting');
  if (errorEl) errorEl.textContent = '';
  try {
    const result = await api.compare(paths);
    if (!result || result.ok === false) throw new Error(result?.error || t('compare.failed'));
    if (!result.preview) throw new Error('没有收到比较预览');
    if (!startBtn.closest('.modal')?.classList.contains('show')) {
      await api.cancelComparison(result.preview.id);
      return;
    }
    preview = result.preview;
    selected = new Set(); statuses = new Map(); selectionPage = 0;
    pickSearch.value = ''; pickType.value = 'all'; pickChange.value = 'changed';
    pickError.textContent = '';
    const warnings = preview.warnings || [];
    document.getElementById('comparePickWarnings').textContent = warnings.slice(0, 100).join('\n');
    document.getElementById('comparePickWarningCount').textContent = `解析提示与文件映射（${warnings.length}）`;
    renderSelection();
    openModal('compareSelectModal');
  } catch (error) {
    if (errorEl) errorEl.textContent = `${t('compare.failed')}：${error.message || error}`;
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = t('compare.start');
  }
});

exitBtn?.addEventListener('click', async () => {
  exitBtn.disabled = true;
  try {
    const result = await api.exitComparison();
    if (result && result.ok === false) throw new Error(result.error || t('compare.failed'));
    activeComparison = null;
    await hooks.restoreComparison();
    await syncProjectLabel();
    syncComparison(null);
  } catch (error) {
    if (summaryEl) summaryEl.title = `${t('compare.failed')}：${error.message || error}`;
  } finally {
    exitBtn.disabled = false;
  }
});

export function syncComparison(comparison) {
  activeComparison = comparison || null;
  const enabled = Boolean(activeComparison);
  const emptyEl = document.getElementById('compareEmpty');
  if (emptyEl) {
    emptyEl.hidden = !enabled || activeComparison.totalNodes > 0;
    emptyEl.textContent = t('compare.noChanges');
  }
  if (enabled) {
    const name = (p) => p?.replace(/\\/g, '/').split('/').pop() || '';
    if (projectPath) projectPath.value = activeComparison.projectPath;
    const button = document.getElementById('projectBtn');
    if (button) {
      button.textContent = activeComparison.projectName || name(activeComparison.projectPath);
      button.title = `${activeComparison.projectPath}\n${activeComparison.beforePath} → ${activeComparison.afterPath}`;
    }
  }
  if (summaryEl) {
    summaryEl.hidden = !enabled;
    if (enabled) {
      const f = activeComparison.summary?.functions || {};
      const v = activeComparison.summary?.variables || {};
      summaryEl.textContent = t('compare.summary', {
        fExisting: f.existing || 0, fModified: f.modified || 0, fAdded: f.added || 0, fDeleted: f.deleted || 0,
        vExisting: v.existing || 0, vModified: v.modified || 0, vAdded: v.added || 0, vDeleted: v.deleted || 0,
        shown: activeComparison.shownNodes ?? activeComparison.totalNodes ?? 0,
        total: activeComparison.totalNodes ?? 0,
      });
      summaryEl.title = [activeComparison.projectPath, activeComparison.beforePath, activeComparison.afterPath, ...(activeComparison.warnings || [])].filter(Boolean).join('\n');
      if (activeComparison.warnings?.length) summaryEl.textContent += ' · ' + t('compare.warningCount', { n: activeComparison.warnings.length });
      if (activeComparison.truncated) summaryEl.textContent += ' · ' + t('compare.truncated');
      if (activeComparison.manualStatusCount) summaryEl.textContent += ` · 手动状态 ${activeComparison.manualStatusCount} 项`;
    }
  }
  if (exitBtn) exitBtn.hidden = !enabled;
  document.getElementById('bookmarkBtn')?.toggleAttribute('hidden', enabled);
  document.getElementById('timelineBtn')?.toggleAttribute('hidden', enabled);
  document.getElementById('sessionTools')?.toggleAttribute('hidden', enabled);
}
