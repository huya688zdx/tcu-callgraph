import { api } from './api.js';
import { hooks } from './hooks.js';
import { t } from '../i18n.js';
import { closeModal, openModal, esc } from './modal.js';
import { syncProjectLabel } from './projects.js';
import { state } from './state.js';
import { statusOptions } from './change-status.js';
import { periodCaption } from './period-text.js';

const normalMode = document.getElementById('projectModeNormal');
const compareMode = document.getElementById('projectModeCompare');
const normalPane = document.getElementById('projectNormalPane');
const comparePane = document.getElementById('projectComparePane');
const projectPath = document.getElementById('compareProjectPath');
const beforePath = document.getElementById('compareBeforePath');
const afterPath = document.getElementById('compareAfterPath');
const errorEl = document.getElementById('compareError');
const startBtn = document.getElementById('compareStart');
const swapBtn = document.getElementById('compareSwap');
const sessionTools = document.getElementById('sessionTools');
const summaryEl = document.getElementById('compareSummary');
const exitBtn = document.getElementById('compareExit');
const browseButtons = document.querySelectorAll('[data-compare-browse]');
let activeComparison = null;
let preview = null;
let selected = new Set();
let statuses = new Map();
let changePoints = [];
let focusedPoint = null;
const effectiveChange = (n) => statuses.get(n.id) || n.change || 'existing';
const isDirect = (n) => effectiveChange(n) !== 'existing';
const isCore = (n) => isDirect(n) || n.macroImpact || n.periodImpact || n.impact;
const priority = (n) => isDirect(n) ? 0 : n.macroImpact || n.periodImpact ? 1 : n.impact ? 2 : 3;
let selectionPage = 0;
let applying = false;
const pageSize = 100;
const maxAllowedCount = () => 600;
const picker = document.getElementById('compareSelectModal');
const pickList = document.getElementById('comparePickList');
const pickSearch = document.getElementById('comparePickSearch');
const pickType = document.getElementById('comparePickType');
const pickChange = document.getElementById('comparePickChange');
const pickApply = document.getElementById('comparePickApply');
const pickError = document.getElementById('comparePickError');
const pickFocus = document.getElementById('comparePickFocus');
const pickPoints = document.getElementById('comparePickPoints');
const retainedIds = () => {
  const valid = new Set(preview?.validRetainIds || []);
  return (state.view?.nodes || []).map((n) => n.id).filter((id) => valid.has(id));
};

const roleBadges = {
  direct_change: ['direct', '直接修改'],
  macro_lsb_impact: ['impact', 'LSB/宏影响'],
  period_impact: ['period', '周期变化'],
  dataflow_impact: ['impact', '数据流受影响'],
  caller_impact: ['impact', '调用方受影响'],
  callee_context: ['context', '被调上下文'],
};

function roleBadge(n) {
  const change = effectiveChange(n);
  if (change === 'added') return ['added', '新增'];
  if (change === 'deleted') return ['deleted', '删除'];
  if (change === 'modified') return roleBadges.direct_change;
  if (n.macroImpact) return roleBadges.macro_lsb_impact;
  if (n.periodImpact) return roleBadges.period_impact;
  const role = n.impactRole === 'direct_change' && statuses.has(n.id) ? null : roleBadges[n.impactRole];
  return role || (n.impact ? ['impact', '受影响'] :
    n.context ? roleBadges.callee_context : ['context', '未修改']);
}

function buildChangePoints() {
  const candidates = new Map(preview.candidates.map((n) => [n.id, n]));
  const chainItems = new Map();
  for (const n of candidates.values()) {
    for (const id of n.impactChainIds || []) {
      if (!chainItems.has(id)) chainItems.set(id, []);
      chainItems.get(id).push(n.id);
    }
  }
  const points = preview.changePoints?.length ? preview.changePoints : [
    ...(preview.macroDetails || []).map((m) => ({
      ...m, kind: 'macro_lsb', beforeValue: m.before, afterValue: m.after,
    })),
    ...preview.candidates.filter((n) => n.periodImpact || periodCaption(n).includes('→'))
      .map((n) => ({ ...n, id: 'period::' + n.id, sourceId: n.id, kind: 'period', summary: periodCaption(n) })),
    ...preview.candidates.filter(isDirect)
      .map((n) => ({ ...n, kind: n.kind === 'var' ? 'variable' : 'function' })),
  ];
  return points.map((point) => ({
    ...point,
    affectedIds: new Set([
      ...(point.affectedIds || chainItems.get(point.id) || []), point.sourceId || point.id,
    ].filter((id) => candidates.has(id))),
  })).sort((a, b) => pointPriority(a) - pointPriority(b));
}

const pointPriority = (point) => point.kind === 'macro_lsb' ? 0 : point.kind === 'period' ? 1 : 2;

function renderChangePoints() {
  if (!pickFocus || !pickPoints) return;
  pickFocus.hidden = !changePoints.length;
  pickPoints.innerHTML = changePoints.map((point, index) => {
    const type = point.kind === 'macro_lsb' ? 'LSB/宏' : point.kind === 'period' ? '周期Δ' :
      point.change === 'added' ? '新增' : point.change === 'deleted' ? '删除' : '修改';
    const showValues = point.kind === 'macro_lsb' || point.kind === 'period';
    const hasValues = showValues && (point.beforeValue != null || point.afterValue != null);
    const value = (v) => {
      const text = Array.isArray(v) ? v.join(' / ') : String(v ?? '');
      return text.length > 40 ? text.slice(0, 39) + '…' : text || '—';
    };
    const diff = hasValues ? `${value(point.beforeValue)} → ${value(point.afterValue)}` :
      point.kind === 'period' ? point.summary : '';
    return `<button class="compare-point" type="button" data-point="${index}" aria-pressed="false"
      title="${esc([point.file, point.summary].filter(Boolean).join('\n'))}">
      <span>${type}</span> <b>${esc(point.name || point.id)}</b>${diff ? ` <span>${esc(diff)}</span>` : ''}
      <small>影响 ${point.affectedIds.size} 项</small></button>`;
  }).join('');
}

function selectWithinLimit(ids, initial = []) {
  const included = new Set([...retainedIds(), ...initial]);
  const result = new Set(initial);
  for (const id of ids) {
    if (included.has(id) || included.size < maxAllowedCount()) {
      result.add(id);
      included.add(id);
    }
  }
  return result;
}

function resetSelectionPage() {
  selectionPage = 0;
  pickList.scrollTop = 0;
  renderSelection();
}

function renderSelection() {
  if (!preview || !pickList) return;
  const q = pickSearch.value.trim().toLowerCase();
  const limit = maxAllowedCount();
  const retained = new Set(retainedIds());
  const total = new Set([...retained, ...selected]).size;
  const focusedIds = focusedPoint?.affectedIds;
  const list = preview.candidates.filter((n) =>
    (!focusedIds || focusedIds.has(n.id)) &&
    (pickType.value === 'all' || n.kind === pickType.value) &&
    (focusedIds || pickChange.value === 'all' || (pickChange.value === 'core_chain' ? isCore(n) :
      pickChange.value === 'changed' ? isDirect(n) : effectiveChange(n) === pickChange.value)) &&
    (!q || `${n.name} ${n.file || ''}`.toLowerCase().includes(q)))
    .sort((a, b) => priority(a) - priority(b));
  selectionPage = Math.min(selectionPage, Math.max(0, Math.ceil(list.length / pageSize) - 1));
  pickList.innerHTML = list.slice(selectionPage * pageSize, (selectionPage + 1) * pageSize).map((n) => {
    const [role, label] = roleBadge(n);
    const period = periodCaption(n);
    const reason = n.reasons?.[0];
    const checked = selected.has(n.id);
    const loc = (version) => {
      const where = n.locations?.[version];
      return where?.file ? `${where.file}${where.line ? ':' + where.line : ''}` : '—';
    };
    const source = n.locations ? `修改前 ${loc('before')} · 修改后 ${loc('after')}` : n.file;
    return `<div class="compare-pick-row${focusedIds ? ' focused' : ''}">
      <label><input type="checkbox" data-id="${esc(n.id)}" ${checked ? 'checked' : ''}
        ${applying || (!checked && total >= limit && !retained.has(n.id)) ? 'disabled' : ''}>
        <span class="compare-row-copy"><span class="compare-row-heading"><b>${esc(n.name)}</b>
          <span class="compare-row-kind">${n.kind === 'var' ? '变量' : '函数'}</span>
          <span class="compare-badge ${role}">${label}</span>
          ${period ? `<span class="compare-badge ${period.includes('→') ? 'period' : 'context'}">${esc(period)}</span>` : ''}
        </span>
        ${reason ? `<small class="compare-row-reason">${esc(reason)}</small>` : ''}
        ${source ? `<small class="compare-row-source">${esc(source)}</small>` : ''}</span>
      </label>
      <select data-status-id="${esc(n.id)}" aria-label="${esc(n.name)} 状态" ${applying ? 'disabled' : ''}>${statusOptions(statuses.get(n.id) || 'auto', n.change || 'existing')}</select></div>`;
  }).join('') || '<div class="empty">没有符合筛选条件的对象</div>';
  pickPoints?.querySelectorAll('[data-point]').forEach((button) =>
    button.setAttribute('aria-pressed', String(changePoints[Number(button.dataset.point)] === focusedPoint)));
  pickChange.disabled = applying || Boolean(focusedIds);
  const missing = (state.view?.nodes.length || 0) - retained.size;
  document.getElementById('comparePickRetainWarning').textContent = missing ? `原图有 ${missing} 个节点未在对照模型中找到，无法保留到比较图；取消可继续保留原画面。` : '';
  document.getElementById('comparePickCount').textContent = `已选 ${selected.size} 项 · 保留 ${retained.size} 项 · 合计 ${total} / ${limit}${statuses.size ? ` · 手动状态 ${statuses.size} 项` : ''}`;
  document.getElementById('comparePickPage').textContent = `${selectionPage + 1} / ${Math.max(1, Math.ceil(list.length / pageSize))} · ${list.length} 项`;
  document.getElementById('comparePickPrev').disabled = selectionPage === 0;
  document.getElementById('comparePickNext').disabled = (selectionPage + 1) * pageSize >= list.length;
  pickApply.disabled = applying || !selected.size || total > limit;
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
  if (applying) return;
  if (event.target.dataset.statusId) {
    const id = event.target.dataset.statusId;
    if (event.target.value === 'auto') statuses.delete(id); else statuses.set(id, event.target.value);
    renderSelection();
    [...pickList.querySelectorAll('[data-status-id]')].find((el) => el.dataset.statusId === id)?.focus();
    return;
  }
  const id = event.target.dataset.id;
  if (!id) return;
  if (event.target.checked) selected.add(id); else selected.delete(id);
  renderSelection();
  [...pickList.querySelectorAll('[data-id]')].find((el) => el.dataset.id === id)?.focus();
});
for (const el of [pickSearch, pickType, pickChange]) el?.addEventListener('input', resetSelectionPage);
pickPoints?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-point]');
  if (!preview || applying || !button) return;
  const point = changePoints[Number(button.dataset.point)];
  focusedPoint = focusedPoint === point ? null : point;
  if (focusedPoint) {
    const ids = preview.candidates.filter((n) => point.affectedIds.has(n.id))
      .sort((a, b) => priority(a) - priority(b)).map((n) => n.id);
    selected = selectWithinLimit(ids, selected);
    pickSearch.value = '';
    pickType.value = 'all';
  }
  resetSelectionPage();
});
function selectGroup(filter, predicate) {
  if (!preview || applying) return;
  const ids = preview.candidates.filter(predicate).sort((a, b) => priority(a) - priority(b)).map((n) => n.id);
  selected = selectWithinLimit(ids);
  focusedPoint = null;
  pickSearch.value = '';
  pickType.value = 'all';
  pickChange.value = filter;
  resetSelectionPage();
}
document.getElementById('comparePickCore')?.addEventListener('click', () => selectGroup('core_chain', isCore));
document.getElementById('comparePickChanged')?.addEventListener('click', () => selectGroup('changed', isDirect));
document.getElementById('comparePickClear')?.addEventListener('click', () => {
  if (!applying) { selected.clear(); renderSelection(); }
});
document.getElementById('comparePickPrev')?.addEventListener('click', () => { selectionPage--; pickList.scrollTop = 0; renderSelection(); });
document.getElementById('comparePickNext')?.addEventListener('click', () => { selectionPage++; pickList.scrollTop = 0; renderSelection(); });
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
  if (applying || !preview || !selected.size) return;
  const retainIds = retainedIds();
  if (new Set([...retainIds, ...selected]).size > maxAllowedCount()) return;
  applying = true;
  renderSelection();
  document.getElementById('comparePickCancel').disabled = true;
  picker.querySelector('.modal-close').disabled = true;
  pickError.textContent = '';
  try {
    const result = await api.applyComparison({ previewId: preview.id, selectedIds: [...selected], retainIds, statusOverrides: Object.fromEntries(statuses) });
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

function openSelectionModal(data) {
  preview = { ...data, candidates: data.items ?? data.candidates ?? [] };
  statuses = new Map();
  focusedPoint = null;
  const core = preview.candidates.filter(isCore).sort((a, b) => priority(a) - priority(b));
  const retained = new Set(retainedIds());
  const fallback = preview.candidates.find((n) => retained.has(n.id)) || preview.candidates[0];
  selected = selectWithinLimit((core.length ? core : fallback ? [fallback] : []).map((n) => n.id));
  pickSearch.value = '';
  pickType.value = 'all';
  pickChange.value = core.length ? 'core_chain' : 'all';
  pickError.textContent = '';
  const warnings = preview.warnings || [];
  document.getElementById('comparePickWarnings').textContent = warnings.slice(0, 100).join('\n');
  document.getElementById('comparePickWarningCount').textContent = `解析提示与文件映射（${warnings.length}）`;
  changePoints = buildChangePoints();
  renderChangePoints();
  resetSelectionPage();
  openModal('compareSelectModal');
}

async function setProjectMode(comparing) {
  normalMode?.setAttribute('aria-pressed', String(!comparing));
  compareMode?.setAttribute('aria-pressed', String(comparing));
  if (normalPane) normalPane.hidden = comparing;
  if (comparePane) comparePane.hidden = !comparing;
  if (sessionTools) sessionTools.hidden = comparing || Boolean(activeComparison);
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

normalMode?.addEventListener('click', () => setProjectMode(false));
compareMode?.addEventListener('click', () => setProjectMode(true));

swapBtn?.addEventListener('click', () => {
  if (!beforePath || !afterPath) return;
  [beforePath.value, afterPath.value] = [afterPath.value, beforePath.value];
  if (errorEl) errorEl.textContent = '';
});

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
  if (swapBtn) swapBtn.disabled = true;
  startBtn.textContent = t('compare.starting');
  if (errorEl) errorEl.textContent = '';
  try {
    const result = await api.compare(paths);
    if (!result || result.ok === false) throw new Error(result?.error || t('compare.failed'));
    if (!result.preview) throw new Error('没有收到比较预览');
    if (comparePane?.hidden || !startBtn.closest('.modal')?.classList.contains('show')) {
      await api.cancelComparison(result.preview.id);
      return;
    }
    openSelectionModal(result.preview);
  } catch (error) {
    if (errorEl) errorEl.textContent = `${t('compare.failed')}：${error.message || error}`;
  } finally {
    startBtn.disabled = false;
    if (swapBtn) swapBtn.disabled = false;
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
  if (sessionTools) sessionTools.hidden = enabled || comparePane?.hidden === false;
}
