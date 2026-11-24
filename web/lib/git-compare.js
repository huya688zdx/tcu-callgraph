import { api } from './api.js';
import { state } from './state.js';
import { t } from '../i18n.js';

const element = id => document.getElementById(id);
const pane = element('projectComparePane');
const gitMode = element('gitCompareMode');
const directoryMode = element('directoryCompareMode');
const repoMessage = element('gitRepoMessage');
const start = element('gitCompareStart');
const refresh = element('gitCompareRefresh');
const baseInput = element('gitBaseRef');
const targetInput = element('gitTargetRef');
const untracked = element('gitIncludeUntracked');
const analysisMessage = element('gitAnalysisMessage');
const error = element('compareError');
const presets = [...document.querySelectorAll('[data-git-preset]')];
const presetRefs = { worktree: ['HEAD', 'WORKTREE'], index: ['HEAD', 'INDEX'], recent: ['HEAD~1', 'HEAD'] };
let repo;
let statusRequest = 0;
let gitSelected = false;
let preset = 'worktree';
let activeComparison;
let changeVersion = 0;
let appliedVersion = 0;
let busy = false;

function selectMode(useGit) {
  gitSelected = useGit;
  gitMode.setAttribute('aria-pressed', String(useGit));
  directoryMode.setAttribute('aria-pressed', String(!useGit));
  element('gitCompareOptions').hidden = !useGit;
  element('directoryCompareOptions').hidden = useGit;
  analysisMessage.hidden = true;
  error.textContent = '';
}

function renderStatus() {
  if (!repo) {
    repoMessage.hidden = false;
    repoMessage.textContent = t('git.loading');
    return;
  }
  gitMode.disabled = !repo.isRepo;
  const reasons = {
    projectNotDirectory: t('git.notDirectory'),
    gitUnavailable: t('git.unavailable'),
    notRepository: t('git.notRepo'),
    statusUnavailable: t('git.statusUnavailable'),
    statusTimeout: t('git.statusTimeout'),
  };
  repoMessage.textContent = repo.isRepo ? '' : reasons[repo.reason] ?? t('git.statusUnavailable');
  repoMessage.hidden = repo.isRepo;
  if (!repo.isRepo) return;
  const { head, workingTree } = repo;
  element('gitHead').textContent = head.hasCommits
    ? [t('git.head', head), head.subject].filter(Boolean).join(' · ')
    : t('git.unborn', head);
  element('gitWorkingSummary').textContent = workingTree.dirty
    ? t('git.workingSummary', workingTree) : t('git.clean');
  element('gitWorkingDetails').open &&= workingTree.dirty;
  const labels = {
    modified: t('git.modified'), added: t('git.added'), deleted: t('git.deleted'), untracked: t('git.untracked'),
  };
  element('gitWorkingFiles').replaceChildren(...workingTree.files.map(({ file, status, staged, unstaged }) => {
    const li = document.createElement('li');
    li.textContent = [file, labels[status], staged && t('git.index'), unstaged && t('git.worktree')].filter(Boolean).join(' · ');
    return li;
  }));
  const refs = new Map(['HEAD', ...repo.branches, ...repo.tags].map(ref => [ref, '']));
  for (const { sha, shortSha, subject } of repo.recentCommits) refs.set(sha, shortSha + ' ' + subject);
  const options = (entries) => [...entries].map(([ref, label]) => {
    const option = document.createElement('option');
    option.value = ref;
    if (label) option.label = label;
    return option;
  });
  element('gitBaseSuggestions').replaceChildren(...options(refs));
  element('gitTargetSuggestions').replaceChildren(...options([['WORKTREE', t('git.worktree')], ['INDEX', t('git.index')], ...refs]));
}

async function loadStatus(chooseDefault) {
  const request = ++statusRequest;
  if (chooseDefault) {
    repo = null;
    gitMode.disabled = true;
    selectMode(false);
    renderStatus();
  }
  const status = await api.gitStatus().catch(() => ({ isRepo: false, reason: 'statusUnavailable' }));
  if (request !== statusRequest || pane.hidden) return;
  repo = status;
  if (chooseDefault || !repo.isRepo) selectMode(repo.isRepo);
  renderStatus();
}

function renderPreset() {
  for (const button of presets) button.setAttribute('aria-pressed', String(button.dataset.gitPreset === preset));
  untracked.disabled = targetInput.value.trim() !== 'WORKTREE';
}

export function openGitCompare() {
  const git = activeComparison?.git;
  baseInput.value = git?.baseRef ?? 'HEAD';
  targetInput.value = git?.targetRef ?? 'WORKTREE';
  untracked.checked = git?.includeUntracked ?? true;
  preset = Object.keys(presetRefs).find(key => presetRefs[key][0] === baseInput.value && presetRefs[key][1] === targetInput.value)
    || 'custom';
  renderPreset();
  return loadStatus(true);
}

function localTarget(git) {
  return git.targetRef === 'WORKTREE' ? t('git.worktree') : git.targetRef === 'INDEX' ? t('git.index') : git.targetLabel;
}

export const gitRange = git => t('git.range', { base: git.baseLabel, target: localTarget(git) });

export function renderGitFacts(git) {
  const facts = element('gitPickFacts');
  facts.hidden = !git;
  if (!git) return;
  const { directIds, implicitImpactIds, chainImpactIds } = git.importFacts;
  facts.textContent = [
    gitRange(git),
    git.noSourceChanges ? t('git.noChanges') :
      t('git.facts', { direct: directIds.length, implicit: implicitImpactIds.length, chain: chainImpactIds.length }),
    git.commentOnlyFiles.length ? t('git.commentOnly', { n: git.commentOnlyFiles.length }) : '',
  ].filter(Boolean).join(' · ');
}

function renderRefresh() {
  refresh.hidden = activeComparison?.git?.targetRef !== 'WORKTREE' || changeVersion <= appliedVersion;
  refresh.disabled = busy;
}

export function syncGitComparison(comparison, version) {
  if (comparison?.id !== activeComparison?.id) {
    appliedVersion = version ?? changeVersion;
    refresh.title = '';
  }
  activeComparison = comparison;
  renderRefresh();
}

export function notifyGitChanged(event) {
  if (event.projectId !== state.view?.projectId) return;
  changeVersion++;
  renderRefresh();
  if (!pane.hidden && pane.closest('.modal.show') && repo) loadStatus(false);
}

export function wireGitCompare(showPreview) {
  gitMode.addEventListener('click', () => selectMode(true));
  directoryMode.addEventListener('click', () => selectMode(false));
  for (const button of presets) button.addEventListener('click', () => {
    preset = button.dataset.gitPreset;
    if (preset === 'custom') baseInput.focus();
    else [baseInput.value, targetInput.value] = presetRefs[preset];
    renderPreset();
  });
  for (const input of [baseInput, targetInput]) input.addEventListener('input', () => {
    preset = 'custom';
    renderPreset();
  });
  document.addEventListener('callgraph:langchange', () => {
    if (!pane.hidden) renderStatus();
    start.textContent = busy ? t('compare.starting') : t('git.analyze');
  });

  async function analyze({ baseRef, targetRef, includeUntracked }, refreshing) {
    if (busy) return;
    if (!baseRef || !targetRef) {
      error.textContent = t('git.missingRefs');
      return;
    }
    busy = true;
    const version = changeVersion;
    const comparisonId = activeComparison?.id;
    start.disabled = true;
    start.textContent = t('compare.starting');
    refresh.title = '';
    error.textContent = '';
    analysisMessage.hidden = true;
    renderRefresh();
    try {
      const result = await api.compare({ mode: 'git', baseRef, targetRef, includeUntracked, refresh: refreshing });
      if (!result?.ok || !result.preview) throw new Error(result?.error || t('compare.failed'));
      if (refreshing ? comparisonId !== activeComparison?.id : !gitSelected || pane.hidden || !pane.closest('.modal.show')) {
        if (result.preview.id) await api.cancelComparison(result.preview.id);
        return;
      }
      if (result.preview.git.noSourceChanges && !result.preview.refresh) {
        analysisMessage.hidden = false;
      } else {
        showPreview({ ...result.preview, gitAnalysisVersion: version });
      }
    } catch (err) {
      if (refreshing) refresh.title = err.message || String(err);
      else error.textContent = err.message || String(err);
    } finally {
      busy = false;
      start.disabled = false;
      start.textContent = t('git.analyze');
      renderRefresh();
    }
  }
  start.addEventListener('click', () => analyze({
    baseRef: baseInput.value.trim(), targetRef: targetInput.value.trim(), includeUntracked: untracked.checked,
  }, false));
  refresh.addEventListener('click', () => {
    if (activeComparison?.git) analyze(activeComparison.git, true);
  });
}
