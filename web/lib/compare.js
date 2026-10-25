import { api } from './api.js';
import { hooks } from './hooks.js';
import { t } from '../i18n.js';
import { closeModal } from './modal.js';
import { syncProjectLabel } from './projects.js';

const normalMode = document.getElementById('projectModeNormal');
const compareMode = document.getElementById('projectModeCompare');
const normalPane = document.getElementById('projectNormalPane');
const comparePane = document.getElementById('projectComparePane');
const beforePath = document.getElementById('compareBeforePath');
const afterPath = document.getElementById('compareAfterPath');
const errorEl = document.getElementById('compareError');
const startBtn = document.getElementById('compareStart');
const summaryEl = document.getElementById('compareSummary');
const exitBtn = document.getElementById('compareExit');
const browseButtons = document.querySelectorAll('[data-compare-browse]');
let activeComparison = null;

function showMode(comparing) {
  normalMode?.setAttribute('aria-pressed', String(!comparing));
  compareMode?.setAttribute('aria-pressed', String(comparing));
  if (normalPane) normalPane.hidden = comparing;
  if (comparePane) comparePane.hidden = !comparing;
  if (errorEl) errorEl.textContent = '';
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
    activeComparison = result.comparison || result;
    await hooks.reloadAll();
    syncComparison(activeComparison);
    closeModal();
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
    await hooks.reloadAll();
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
    const button = document.getElementById('projectBtn');
    if (button) {
      button.textContent = `${name(activeComparison.beforePath)} → ${name(activeComparison.afterPath)}`;
      button.title = `${activeComparison.beforePath}\n→ ${activeComparison.afterPath}`;
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
      summaryEl.title = [activeComparison.beforePath, activeComparison.afterPath, ...(activeComparison.warnings || [])].filter(Boolean).join('\n');
      if (activeComparison.warnings?.length) summaryEl.textContent += ' · ' + t('compare.warningCount', { n: activeComparison.warnings.length });
      if (activeComparison.truncated) summaryEl.textContent += ' · ' + t('compare.truncated');
    }
  }
  if (exitBtn) exitBtn.hidden = !enabled;
  document.getElementById('bookmarkBtn')?.toggleAttribute('hidden', enabled);
  document.getElementById('timelineBtn')?.toggleAttribute('hidden', enabled);
  document.getElementById('sessionTools')?.toggleAttribute('hidden', enabled);
}
