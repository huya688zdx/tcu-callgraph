/**
 * 入口：视图加载、删除、工具栏与快捷键、启动
 * 具体职责已拆到 lib/ 下的模块
 */
import { applyI18n, t } from './i18n.js';
import { els, state, cam, deleteStack, edgeKey, currentViewScope, scopeFingerprint, isBookmarkDirty } from './lib/state.js';
import { api } from './lib/api.js';
import { hooks } from './lib/hooks.js';
import { fit, revealAdded, stopCamAnim, constrainCam } from './lib/camera.js';
import { draw, resize, pulseAdded } from './lib/render.js';
import { history, pushHistory, undo, redo } from './lib/history.js';
import { loadStats, loadTree, resetVars, renderVars, renderDetail, renderTree, runSearch, syncTreeSelection } from './lib/panels.js';
import { renderLabelPanel, deleteSelectedLabel } from './lib/label-panel.js';
import { buildSVG } from './lib/svg.js';
import { buildPNG, saveExport } from './lib/export.js';
import { buildStandaloneHtml } from './lib/html.js';
import './lib/ui-select.js';
// 样式设置面板：恢复已存主题并接好「样式」按钮，纯副作用导入
import './lib/appearance.js';
// 交互模块在加载时注册画布事件，没有导出给入口使用，纯副作用导入
import './lib/interact.js';
import { clearDataflow } from './lib/df.js';
// 工程切换与时间轴面板同样自带事件注册
import './lib/projects.js';
import { hideBar, reloadTimeline } from './lib/timeline.js';
import './lib/bookmarks.js';
import './lib/ai-settings.js';
// AI 改动实时同步：SSE 监听 + 页面视图状态上报（cg_page 的数据源）
import { acceptRestoredRevision, restorePage, savePage } from './lib/live.js';
import { syncComparison } from './lib/compare.js';
import { clearPairFlow } from './lib/pair-flow.js';
import { syncFlowchart, wireFlowchart } from './lib/flowchart.js';
import { openModal, closeModal } from './lib/modal.js';

wireFlowchart();

/**
 * 加载视图
 * @param {string|string[]|null} rootId 单个函数 id、多个函数 id（文件树多选）、或 null（默认入口）
 */
let viewSeq = 0;
let viewRequest;
let reloadEpoch = 0;
const pendingVarChoices = new Map();
const varRestores = new Map();

const varRestoreKey = (projectId, id) => `${projectId}:${id}`;

function restoreVariables(ids, projectId) {
  const keys = ids.map((id) => varRestoreKey(projectId, id));
  const missing = ids.filter((id, i) => !varRestores.has(keys[i]));
  if (missing.length) {
    const request = postDelete({ nodes: missing, restore: true, projectId }).finally(() => {
      for (const id of missing) varRestores.delete(varRestoreKey(projectId, id));
    });
    for (const id of missing) varRestores.set(varRestoreKey(projectId, id), request);
  }
  return Promise.all(new Set(keys.map((key) => varRestores.get(key))));
}

/** 视图跳转历史（双击下钻 / 树里勾选 / 搜索结果），Ctrl+Z 逐级回退 */
const navStack = [];
const NAV_MAX = 30;

function currentViewSnapshot() {
  return {
    roots: [...state.roots], expansions: structuredClone(state.expansions),
    up: state.up, down: state.down, group: state.group, groupMode: state.groupMode,
    vars: [...state.vars], hiddenVars: [...state.hiddenVars],
    empty: !!state.view?.empty && !state.roots.length && !state.expansions.length,
  };
}

function rememberView(prior) {
  navStack.push(prior);
  if (navStack.length > NAV_MAX) navStack.shift();
}

function recordViewEvent(op = 'view.snapshot') {
  if (!state.view?.projectId || state.at || state.view.comparison) return;
  const ctx = state.activeBookmark
    ? { bookmarkId: state.activeBookmark.id, bookmarkName: state.activeBookmark.name }
    : undefined;
  api.recordViewEvent({ op, projectId: state.view.projectId, view: currentViewSnapshot(), ...(ctx ? { ctx } : {}) })
    .then((result) => {
      if (!result?.ok) throw new Error(result?.error || t('app.viewFailed'));
      return reloadTimeline();
    })
    .catch((error) => console.warn(t('app.viewEventFailed'), error));
}

async function loadView(rootId, opts = {}) {
  const { nav = true, incremental = false, fitOnLoad = !incremental } = opts;
  const startedSelected = state.selected;
  const previous = incremental && !state.at && state.view ? state.view : null;
  if (state.pairFlow) clearPairFlow();
  stopCamAnim();
  // 请求成功后才记录跳转；聚焦查找失败时保留原画布和范围。
  const prior = opts.prior ?? (nav && state.view && !state.at ? { ...currentViewSnapshot(), cam: { ...cam } } : null);
  const seq = ++viewSeq;
  viewRequest?.abort();
  const request = new AbortController();
  viewRequest = request;
  clearDataflow(); // 换视图时关闭旧的查询结果
  const roots = (Array.isArray(rootId) ? rootId : rootId ? [rootId] : []).filter(Boolean);
  const expansions = opts.expansions ?? (incremental || !nav ? state.expansions : []);
  const up = opts.exact ? 0 : opts.up ?? state.up;
  const down = opts.exact ? 0 : opts.down ?? state.down;
  const grouped = opts.group ?? state.group;
  const groupedMode = opts.group == null && state.groupMode === 'period' ? 'period' : 'file';
  const groupMode = opts.groupMode ?? (grouped ? groupedMode : 'flat');
  const group = groupMode !== 'flat';
  const vars = new Set(opts.vars ?? state.vars);
  const hiddenVars = new Set(opts.hiddenVars ?? state.hiddenVars);
  const choices = opts.vars === undefined && opts.hiddenVars === undefined ? [...pendingVarChoices] : [];
  const addVars = opts.addVars || [];
  const restoreIds = new Set();
  for (const [id, on] of [...addVars.map((id) => [id, true]), ...choices]) {
    if (on) { vars.add(id); hiddenVars.delete(id); restoreIds.add(id); }
    else { vars.delete(id); hiddenVars.add(id); restoreIds.delete(id); }
  }
  const empty = opts.empty ?? (!roots.length && !expansions.length && !!state.view?.empty && !state.view.comparison);
  let data;
  try {
    if (restoreIds.size && !state.at && state.view && !state.view.comparison) {
      await restoreVariables([...restoreIds], state.view.projectId);
      if (seq !== viewSeq) return;
    }
    data = await api.view({ roots, expansions, up, down, groupMode, vars: [...vars], hiddenVars: [...hiddenVars],
      at: state.at, previous, empty, useSnapshot: opts.useSnapshot ?? state.at > 0, signal: request.signal });
  } catch (error) {
    if (seq !== viewSeq) return;
    pendingVarChoices.clear();
    renderVars();
    throw error;
  } finally {
    if (viewRequest === request) viewRequest = null;
  }
  if (seq !== viewSeq) return; // 多选连点时丢弃过期响应
  pendingVarChoices.clear();
  if (data?.error || !Array.isArray(data?.nodes) || !Array.isArray(data?.edges)) {
    renderVars();
    if (opts.restore) return { error: data?.error || t('app.noView') };
    if (choices.length || addVars.length) throw new Error(data?.error || t('app.viewFailed'));
    console.warn(data?.error || t('app.viewFailed'));
    return;
  }
  if (prior) rememberView(prior);
  const snapshot = data.reviewSnapshot;
  state.up = snapshot?.up ?? up; state.down = snapshot?.down ?? down;
  state.group = snapshot?.group ?? group;
  state.groupMode = snapshot?.groupMode ?? (snapshot ? (state.group ? 'file' : 'flat') : groupMode);
  els.groupMode.checked = state.group;
  els.layoutGroupSelect.value = state.groupMode;
  const visibleVars = new Set(data.nodes.filter((node) => node.kind === 'var').map((node) => node.id));
  state.vars = new Set([...(snapshot?.vars ?? vars)].filter((id) => visibleVars.has(id)));
  state.hiddenVars = new Set(snapshot?.hiddenVars ?? hiddenVars);
  // 请求期间旧画布仍可交互；安装新视图时清除可能重新创建的旧双点查询。
  if (state.pairFlow) clearPairFlow({ paint: false });
  const priorView = state.view;
  const selected = incremental && priorView?.projectId === data.projectId &&
    priorView?.comparison?.id === data.comparison?.id ? state.selected : null;
  stopCamAnim();
  state.view = data;
  syncFlowchart();
  state.expansions = data.expansions || [];
  syncComparison(data.comparison);
  state.roots = data.roots ?? (data.root ? [data.root] : roots);
  state.root = data.root || state.roots[0] || null;
  state.hoverRelation = null;
  state.selected = data.nodes.some((node) => node.id === selected) ? selected : null;
  state.selectedEdge = null;
  state.selectedLabel = null;
  state.multiSelection = null;
  state.marquee = null;
  if (!incremental && (empty || data.empty)) state.ctxBox = null;
  state.trunkHits = null;
  state.prevTrunkHits = null;
  state.trunkFocusNode = null;
  const rootNode = data.nodes.find((n) => n.id === state.root);
  els.rootName.textContent = rootNode
    ? `· ${rootNode.name}${state.roots.length > 1 ? ` +${state.roots.length - 1}` : ''}`
    : '';
  if (data.truncated && !data.comparison) els.rootName.textContent += ` · ${t('compare.truncated')}`;
  els.rootName.title = els.rootName.textContent;
  syncTreeSelection(state.roots);
  renderVars();
  const keepCam = !fitOnLoad && Boolean(priorView?.nodes.length);
  const oldNodes = new Map((keepCam ? priorView.nodes : []).map((n) => [n.id, n]));
  const oldEdges = new Set((keepCam ? priorView.edges : []).map(edgeKey));
  const addedNodes = keepCam || opts.selectAdded ? data.nodes.filter((n) => !oldNodes.has(n.id)) : [];
  const addedEdges = keepCam ? data.edges.filter((e) => !oldEdges.has(edgeKey(e))) : [];
  if (!keepCam) {
    fit({ paint: false });
  } else {
    // 先按共同节点的位移锚定当前镜头起点，避免重排瞬间旧节点在屏幕上跳变，再平滑移向新增节点。
    const common = data.nodes.filter((n) => oldNodes.has(n.id));
    if (common.length) {
      for (const axis of ['x', 'y']) {
        const shifts = common.map((n) => oldNodes.get(n.id)[axis] - n[axis]).sort((a, b) => a - b);
        cam[axis] += shifts[Math.floor(shifts.length / 2)] * cam.k;
      }
    }
    if (addedNodes.length || addedEdges.length) {
      revealAdded(addedNodes, addedEdges);
    }
  }
  if (opts.selectAdded && !startedSelected && !selected && addedNodes.length === 1 && addedNodes[0].kind !== 'var') {
    state.selected = addedNodes[0].id;
  }
  pulseAdded(addedNodes, addedEdges);
  renderDetail(state.selected).catch((error) => console.warn(t('common.detailError'), error));
  renderLabelPanel();
  history.stack = [];
  history.idx = -1;
  pushHistory();
  hooks.syncBookmarkBadge?.();
  if (opts.recordOp) recordViewEvent(opts.recordOp);
  // 查找完成时立即保存范围，避免紧接着刷新还读到定时上报前的旧入口。
  await savePage(true).catch((error) => console.warn(t('app.scopeSaveFailed'), error));
  return seq === viewSeq ? data : undefined;
}

// 面板与交互模块通过钩子回调入口，避免循环依赖
hooks.loadView = loadView;
hooks.openFunctionAlone = (id) => {
  if (state.at || canvasAction) return;
  return loadView(id, { recordOp: 'view.snapshot' });
};
hooks.addFunction = async (root, { includeShown = false, restoreHidden = true, varIds = [] } = {}) => {
  if (state.at || canvasAction) return;
  const shown = new Set(state.view?.nodes.map((n) => n.id));
  const ids = [...new Set(Array.isArray(root) ? root : [root])].filter((id) => includeShown || !shown.has(id));
  if (!ids.length && !varIds.length) return state.view;
  const projectId = state.view?.projectId;
  if (restoreHidden && !state.at && !state.view?.comparison) {
    const hidden = (await Promise.all(ids.filter((id) => !shown.has(id))
      .map(async (id) => (await api.node(id)).hidden ? id : null))).filter(Boolean);
    if (state.view?.projectId !== projectId || state.at || canvasAction) return;
    if (hidden.length) {
      const result = await api.del({ nodes: hidden, restore: true, projectId });
      if (!result?.ok) throw new Error(result?.error || t('app.readdFailed'));
    }
  }
  if (state.view?.projectId !== projectId || state.at || canvasAction) return;
  const expanded = new Set(state.expansions.map((scope) => scope.root));
  const expansions = [...state.expansions, ...ids.filter((id) => !expanded.has(id))
    .map((id) => ({ root: id, up: 0, down: 0 }))];
  return loadView(state.roots, { incremental: true, selectAdded: true, expansions,
    addVars: varIds, recordOp: 'view.snapshot' });
};
hooks.removeFunction = (id) => removeFunctions([id]);
hooks.removeFunctions = removeFunctions;
hooks.clearCanvas = clearCanvas;
hooks.canReview = () => !canvasAction;
hooks.restoreTimelineView = async (snapshot, revision) => {
  acceptRestoredRevision(revision);
  navStack.length = 0;
  deleteStack.length = 0;
  const view = await loadView(snapshot.roots, { ...snapshot, nav: false, empty: !!snapshot.empty });
  if (!view) throw new Error(t('app.viewFailed'));
  await loadStats();
};
hooks.renderDetail = renderDetail;
hooks.syncComparison = syncComparison;
// live.js 收到 AI 改动推送后用它刷新画面（保留视角）；函数声明有提升，这里可以先引用
hooks.reloadKeepCam = reloadKeepCam;
let comparisonPage = null;
hooks.applyComparison = async (roots) => {
  pendingVarChoices.clear();
  if (!comparisonPage) comparisonPage = {
    view: structuredClone(state.view), roots: [...state.roots], expansions: structuredClone(state.expansions),
    vars: [...state.vars], hiddenVars: [...state.hiddenVars], up: state.up, down: state.down,
    cam: { ...cam }, nav: [...navStack], deleted: [...deleteStack],
  };
  state.at = 0;
  hideBar();
  state.expansions = [];
  state.vars = new Set(roots.filter((id) => id.startsWith('var::')));
  state.hiddenVars.clear();
  navStack.length = 0;
  await loadView(roots, { nav: false, incremental: true, exact: true, expansions: [] });
  if (!state.view?.comparison) throw new Error(t('app.compareViewFailed'));
  // 比较视图固定零层展开（原层数已存进 comparisonPage）：只把 exact 用在首次请求的话，
  // 之后每次 reloadKeepCam 都会按原层数展开全部保留+选中的根，把未选中的调用者/被调用者拉回图里
  state.up = 0; state.down = 0;
  resetVars();
  await Promise.all([loadStats(), loadTree()]);
};
hooks.restoreComparison = async () => {
  pendingVarChoices.clear();
  if (!comparisonPage) return hooks.reloadAll();
  const saved = comparisonPage;
  comparisonPage = null;
  state.view = saved.view;
  syncFlowchart();
  state.roots = saved.roots;
  state.expansions = saved.expansions;
  state.vars = new Set(saved.vars);
  state.hiddenVars = new Set(saved.hiddenVars);
  state.up = saved.up; state.down = saved.down;
  Object.assign(cam, saved.cam);
  navStack.splice(0, navStack.length, ...saved.nav);
  deleteStack.splice(0, deleteStack.length, ...saved.deleted);
  resetVars();
  await loadView(saved.roots, { nav: false, incremental: true, expansions: saved.expansions,
    empty: !!saved.view?.empty && !saved.roots.length && !saved.expansions.length });
  await Promise.all([loadStats(), loadTree()]);
};

const bookmarkSplit = document.getElementById('bookmarkSplit');
const bookmarkBtn = document.getElementById('bookmarkBtn');
const bookmarkQuickSave = document.getElementById('bookmarkQuickSave');

function syncBookmarkBadge() {
  const bm = state.activeBookmark;
  const dirty = isBookmarkDirty();
  const hasContent = state.roots.length > 0 || state.expansions.length > 0;
  const readOnly = state.at > 0 || !!state.view?.comparison;
  if (bookmarkSplit) {
    bookmarkSplit.classList.toggle('active', !!bm);
    bookmarkSplit.classList.toggle('dirty', !!bm && dirty);
  }
  if (bookmarkBtn) {
    if (bm) {
      bookmarkBtn.textContent = `🔖 ${bm.name}${dirty ? ' ●' : ''}`;
      bookmarkBtn.title = dirty ? t('bookmark.dirtyHint') : `当前书签：${bm.name}`;
    } else if (hasContent && !state.view?.comparison) {
      bookmarkBtn.textContent = `🔖 ${t('bookmark.unnamed')}`;
      bookmarkBtn.title = t('btn.bookmark');
    } else {
      bookmarkBtn.textContent = t('btn.bookmark');
      bookmarkBtn.title = t('btn.bookmark');
    }
  }
  if (bookmarkQuickSave) {
    bookmarkQuickSave.hidden = readOnly || (!dirty && (!hasContent || !!bm));
    bookmarkQuickSave.classList.toggle('dirty', dirty);
    bookmarkQuickSave.textContent = bm ? t('common.save') : t('bookmark.saveAs');
    bookmarkQuickSave.title = bm ? '更新当前书签 (Ctrl+S)' : '保存为书签 (Ctrl+S)';
  }
}
hooks.syncBookmarkBadge = syncBookmarkBadge;

async function saveActiveBookmark({ saveAs = false } = {}) {
  if (state.at || state.view?.comparison || !state.roots.length) return;
  const bm = state.activeBookmark;
  if (saveAs || !bm?.id) {
    bookmarkBtn?.click();
    return;
  }
  const scope = currentViewScope();
  const result = await api.updateBookmark({
    id: bm.id,
    expectedRevision: bm.revision,
    ...scope,
  });
  if (result?.conflict) {
    alert(t('bookmark.conflict'));
    bookmarkBtn?.click();
    return;
  }
  if (!result?.ok || !result.bookmark) throw new Error(result?.error || t('bookmark.failed'));
  const saved = result.bookmark;
  state.activeBookmark = {
    id: saved.id,
    name: saved.name,
    revision: saved.revision || 1,
    baseFingerprint: scopeFingerprint(scope),
  };
  state.bookmarkDrafts.delete(String(saved.id));
  syncBookmarkBadge();
  await savePage(true).catch(() => {});
  void reloadTimeline();
}

bookmarkQuickSave?.addEventListener('click', () => {
  saveActiveBookmark().catch(reportCanvasError);
});
document.addEventListener('callgraph:langchange', syncBookmarkBadge);

/** 应用书签：先暂存未保存草稿、以参数请求 loadView，成功后再切 activeBookmark 并派发事件 */
hooks.applyBookmark = async (b) => {
  if (state.at || canvasAction) return;
  pendingVarChoices.clear();
  const prev = state.activeBookmark;
  if (prev ? isBookmarkDirty() : (state.roots.length > 0 || state.expansions.length > 0)) {
    const draftKey = prev?.id ? String(prev.id) : '__unnamed__';
    state.bookmarkDrafts.set(draftKey, { scope: currentViewScope(), cam: { ...cam } });
  }
  const roots = (b.roots || []).filter(Boolean);
  const up = Number.isInteger(b.up) ? b.up : 1;
  const down = Number.isInteger(b.down) ? b.down : 1;
  const groupMode = b.groupMode ?? (b.group === false ? 'flat' : 'file');
  const vars = b.vars || [];
  const hiddenVars = b.hiddenVars || [];
  const expansions = b.expansions || [];
  const view = await loadView(roots.length ? roots : null, {
    empty: !roots.length && !expansions.length,
    expansions,
    up,
    down,
    group: groupMode !== 'flat',
    groupMode,
    vars,
    hiddenVars,
  });
  if (!view) return;
  state.activeBookmark = b.id
    ? { id: b.id, name: b.name, revision: b.revision || 1, baseFingerprint: scopeFingerprint(b) }
    : null;
  syncBookmarkBadge();
  await savePage(true).catch(() => {});
  window.dispatchEvent(new CustomEvent('cg:bookmark-changed', { detail: { bookmark: state.activeBookmark, prev } }));
};

/** 换工程后整体重载：解析结果、文件树、变量清单、视图全变了 */
hooks.reloadAll = async ({ preserveAiChat = false } = {}) => {
  const epoch = ++reloadEpoch;
  pendingVarChoices.clear();
  comparisonPage = null;
  state.activeBookmark = null;
  state.bookmarkDrafts.clear();
  syncBookmarkBadge();
  const seq = ++viewSeq;
  viewRequest?.abort();
  if (state.pairFlow) clearPairFlow({ paint: false });
  state.view = null;
  syncFlowchart();
  state.hoverRelation = null;
  state.selected = null;
  state.selectedEdge = null;
  state.selectedLabel = null;
  state.roots = [];
  state.expansions = [];
  state.root = null;
  state.at = 0;
  hideBar();
  state.vars.clear();
  state.hiddenVars.clear();
  state.ctxBox = null;
  resetVars();
  navStack.length = 0;
  deleteStack.length = 0;
  // 并行恢复统计、文件树与画布，解析器探测异步执行不阻塞首帧；并通知 AI 助手按新工程隔离切换对话。
  if (!preserveAiChat) document.dispatchEvent(new CustomEvent('cg:project-changed'));
  void loadParsers();
  void loadBuildConfigs();
  const [result] = await Promise.all([
    restorePage({ isCurrent: (started) => epoch === reloadEpoch && seq + Number(started) === viewSeq }),
    loadTree(),
    loadStats(),
  ]);
  if (epoch === reloadEpoch && result.status === 'error') throw new Error(result.error);
};

// 右侧变量清单：勾选后重新拉视图（变量节点由服务端排版，保证落在文件框里）
hooks.toggleVar = (id, on) => {
  if (state.at || canvasAction) { renderVars(); return; }
  pendingVarChoices.set(id, on);
  return reloadKeepCam();
};

async function postDelete(body) {
  const result = await api.del(body);
  if (!result?.ok) throw new Error(result?.error || t('common.removeFailed'));
}

const clearButton = document.getElementById('clearCanvas');
const emptyGuide = document.getElementById('canvasEmptyGuide');
const emptyGuideCompare = document.getElementById('emptyGuideCompare');
const selectBar = document.getElementById('multiSelectBar');
const selectCount = document.getElementById('multiSelectCount');
let canvasAction = false;

function canEditCanvas() {
  return !state.at && state.view?.reviewSnapshot === undefined && !state.view?.comparison && !!state.view?.nodes.length;
}

function syncCanvasControls() {
  clearButton.disabled = canvasAction || !canEditCanvas();
  els.groupMode.disabled = !!state.at;
  els.layoutGroupSelect.disabled = !!state.at;
  els.parserSelect.disabled = parserBusy || !!state.at || !!state.view?.comparison || els.parserSelect.options.length < 2;
  if (buildConfigBtn) buildConfigBtn.disabled = parserBusy || !!state.at || !!state.view?.comparison;
  els.resetLayout.disabled = !!state.at;
  emptyGuide.hidden = !!state.view?.nodes.length || !!state.view?.comparison;
  emptyGuideCompare.disabled = !!state.at;
  const count = state.multiSelection?.kind === 'nodes' ? state.multiSelection.nodes.size : 0;
  selectBar.hidden = !count || !canEditCanvas();
  if (!selectBar.hidden) selectCount.textContent = t('canvas.selectedCount', { n: count });
}

document.addEventListener('cg:canvas-selection', syncCanvasControls);
document.addEventListener('cg:review-mode', () => {
  syncCanvasControls();
  syncTreeSelection();
});

function reportCanvasError(error) {
  alert(error.message || t('common.removeFailed'));
}

async function clearCanvas() {
  if (canvasAction || !canEditCanvas()) return;
  const prior = { ...currentViewSnapshot(), cam: { ...cam }, composition: true, lastDelete: deleteStack.at(-1) };
  canvasAction = true;
  syncCanvasControls();
  try {
    const seq = viewSeq + 1;
    await loadView([], { nav: false, prior, empty: true, expansions: [], vars: [], hiddenVars: [],
      recordOp: 'view.clear' });
    if (seq === viewSeq && navStack.at(-1) !== prior) throw new Error(t('app.viewFailed'));
  } finally {
    canvasAction = false;
    syncCanvasControls();
  }
}

async function removeFunctions(ids) {
  if (canvasAction || !canEditCanvas()) return;
  const selected = new Set(ids);
  const shown = state.view.nodes.filter((node) => selected.has(node.id)).map((node) => node.id);
  if (!shown.length) return;
  const varIds = new Set(shown.filter((id) => id.startsWith('var::')));
  const fnIds = shown.filter((id) => !varIds.has(id));
  const removed = new Set(shown);
  const prior = { ...currentViewSnapshot(), cam: { ...cam }, composition: true, lastDelete: deleteStack.at(-1) };
  const roots = prior.roots.filter((id) => !removed.has(id));
  const expansions = prior.expansions.filter((scope) => !removed.has(scope.root));
  const vars = prior.vars.filter((id) => !varIds.has(id));
  const hiddenVars = [...new Set([...prior.hiddenVars, ...varIds])];
  const empty = !roots.length && !expansions.length;
  const projectId = state.view.projectId;
  const seq = viewSeq;
  let deleted = [];
  canvasAction = true;
  syncCanvasControls();
  try {
    if (!empty && fnIds.length) {
      // 先验证缩小后的范围，仅隐藏仍会被展开带回来的函数。
      const preview = await api.view({ roots, expansions, vars, hiddenVars, up: prior.up, down: prior.down,
        groupMode: prior.groupMode, preview: true });
      if (seq !== viewSeq || state.at || projectId !== state.view?.projectId) return;
      if (!Array.isArray(preview?.nodes)) throw new Error(preview?.error || t('app.viewFailed'));
      const remaining = new Set(preview.nodes.map((node) => node.id));
      const childIds = fnIds.filter((id) => remaining.has(id));
      if (childIds.length) {
        await postDelete({ nodes: childIds, projectId });
        deleted = childIds;
      }
    }
    if (seq !== viewSeq || state.at || projectId !== state.view?.projectId) return;
    const entry = { ...prior, deleted };
    await loadView(roots, { nav: false, incremental: true, empty, expansions, vars, hiddenVars,
      prior: entry, recordOp: 'view.snapshot' });
    if (!navStack.includes(entry)) {
      if (seq + 1 === viewSeq) throw new Error(t('app.viewFailed'));
      return;
    }
    if (deleted.length) loadStats().catch(() => {});
    deleted = [];
  } finally {
    canvasAction = false;
    syncCanvasControls();
    if (deleted.length && !state.at && !state.view?.comparison && projectId === state.view?.projectId) {
      await postDelete({ nodes: deleted, projectId, restore: true });
    }
  }
}

/** 回退到上一个视图（入口 + 视角一起还原） */
async function navigateBack() {
  const prev = navStack.at(-1);
  if (!prev || canvasAction) return false;
  canvasAction = true;
  syncCanvasControls();
  try {
    if (prev.deleted?.length) await postDelete({ nodes: prev.deleted, restore: true });
    const view = await loadView(prev.roots, { ...prev, nav: false, recordOp: 'view.snapshot' });
    if (!view) return false;
    navStack.pop();
    Object.assign(cam, prev.cam);
    constrainCam();
    draw();
    if (prev.deleted?.length) loadStats().catch(() => {});
    return true;
  } finally {
    canvasAction = false;
    syncCanvasControls();
  }
}

/** 重新拉取视图但保留当前视角，避免删除后画面突然跳走 */
async function reloadKeepCam() {
  return loadView(state.roots.length ? state.roots : state.root, { nav: false, incremental: true });
}

async function deleteSelection() {
  const v = state.view;
  if (!v || v.comparison || state.at || canvasAction) return;
  if (state.multiSelection?.kind === 'nodes' && state.multiSelection.nodes.size) {
    return removeFunctions(state.multiSelection.nodes);
  }
  // 选中标签时 Delete 只删标签，不删整条连线
  if (!state.selected && state.selectedEdge && state.selectedLabel && (await deleteSelectedLabel())) return;
  let body = null;

  if (state.selected) {
    body = { nodes: [state.selected] };
  } else if (state.selectedEdge) {
    body = { edges: [edgeKey(state.selectedEdge)] };
  } else if (state.moveTarget?.kind === 'file' && state.moveTarget.view === v) {
    // 文件框只隐藏当前框内节点，沿用单节点删除的存档与撤销。
    body = { nodes: v.nodes.filter(n => n.group === state.moveTarget.item.id).map(n => n.id) };
    if (!body.nodes.length) return;
  } else {
    return;
  }

  const ids = new Set(body.nodes);
  const variables = v.nodes.filter((node) => node.kind === 'var' && ids.has(node.id));
  canvasAction = true;
  syncCanvasControls();
  try {
    await Promise.allSettled(variables.map(({ id }) => varRestores.get(varRestoreKey(v.projectId, id))));
    // 保留原入口作为范围锚点，以便撤销时恢复原图。
    await postDelete({ ...body, projectId: v.projectId });
    if (state.view?.projectId !== v.projectId || state.at || state.view?.comparison) return;
    const varChoices = variables.map(({ id }) => ({ id, included: state.vars.delete(id), hidden: state.hiddenVars.has(id) }));
    for (const { id } of varChoices) {
      pendingVarChoices.delete(id);
      state.hiddenVars.add(id);
    }
    deleteStack.push({ ...body, varChoices, roots: v.roots.join('+'), at: Date.now() });
    if (deleteStack.length > 30) deleteStack.shift();

    state.hoverRelation = null;
    state.selected = null;
    state.selectedEdge = null;
    state.selectedLabel = null;
    state.hover = null;
    if (state.moveTarget?.kind === 'file') state.moveTarget = null;
    await reloadKeepCam();
    if (body.nodes) recordViewEvent();
    loadStats();
  } finally {
    canvasAction = false;
    syncCanvasControls();
  }
}

async function restoreLastDelete() {
  const rec = deleteStack.at(-1);
  if (!rec) return false;
  const projectId = state.view.projectId;
  canvasAction = true;
  syncCanvasControls();
  try {
    await postDelete({ nodes: rec.nodes || [], edges: rec.edges || [], restore: true, projectId });
    if (state.view?.projectId !== projectId || state.at || state.view?.comparison) return false;
    for (const { id, included, hidden } of rec.varChoices || []) {
      if (included) state.vars.add(id);
      if (!hidden) state.hiddenVars.delete(id);
    }
    if (!await reloadKeepCam()) return false;
    deleteStack.pop();
    if (rec.nodes) recordViewEvent();
    loadStats();
    return true;
  } finally {
    canvasAction = false;
    syncCanvasControls();
  }
}

/**
 * 栈顶删除记录是否还能在当前视图里恢复。
 * 删除记录是跨视图共享的（切视图不清栈），所以必须校验入口集合一致，
 * 否则在 A 视图删了东西、下钻到 B 视图按 Ctrl+Z，会把 A 的删除恢复进 B。
 */
function canRestoreDelete() {
  const rec = deleteStack[deleteStack.length - 1];
  if (!rec) return false;
  if (rec.roots !== state.roots.join('+')) return false;
  return Date.now() - rec.at < 20000;
}

window.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal.show')) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveActiveBookmark({ saveAs: e.shiftKey }).catch(reportCanvasError);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (state.at || canvasAction) return;
    if (state.view?.comparison) { navigateBack().catch(reportCanvasError); return; }
    const prior = navStack.at(-1);
    if (e.shiftKey) {
      if (redo()) renderLabelPanel();
    } else if (canRestoreDelete() && (!prior?.composition || prior.lastDelete !== deleteStack.at(-1))) {
      // 优先恢复刚删掉的函数 / 连线（20 秒内有效，可逐次回退）
      restoreLastDelete().catch(reportCanvasError);
    } else if (history.idx > 0) {
      if (undo()) renderLabelPanel();
    } else if (navStack.length) {
      // 当前视图内已无可撤销的操作，退回上一次跳转（双击下钻 / 勾选函数）
      navigateBack().catch(reportCanvasError);
    } else {
      if (undo()) renderLabelPanel();
    }
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selected || state.selectedEdge || state.selectedLabel || state.moveTarget?.kind === 'file' ||
        state.multiSelection?.kind === 'nodes') {
      e.preventDefault();
      deleteSelection().catch(reportCanvasError);
    }
  }
});

window.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal.show')) return;
  if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
  if (e.key === 'f' || e.key === 'F') fit();
});

async function changeGrouping(groupMode) {
  if (state.at) return;
  state.selectedEdge = null;
  state.selectedLabel = null;
  try {
    await loadView(state.roots.length ? state.roots : state.root, { expansions: state.expansions, groupMode });
  } finally {
    els.groupMode.checked = state.group;
    els.layoutGroupSelect.value = state.groupMode;
  }
}
els.layoutGroupSelect.addEventListener('change', () => changeGrouping(els.layoutGroupSelect.value).catch(reportCanvasError));
els.groupMode.addEventListener('change', () => {
  changeGrouping(els.groupMode.checked ? 'file' : 'flat').catch(reportCanvasError);
});

let parserBusy = false;
let activeParser = '';
let parserList = [];
let buildConfigState = null;
const buildConfigBtn = document.getElementById('buildConfigBtn');
const buildProfileSelect = document.getElementById('buildProfileSelect');
const buildProfileInfo = document.getElementById('buildProfileInfo');
const buildMultiCoreHint = document.getElementById('buildMultiCoreHint');
const buildParserSelect = document.getElementById('buildParserSelect');
const buildStrictCheck = document.getElementById('buildStrictCheck');
const buildDispatchExpandCheck = document.getElementById('buildDispatchExpandCheck');
const buildClangBin = document.getElementById('buildClangBin');
const buildClangStatus = document.getElementById('buildClangStatus');
const buildConfigMessage = document.getElementById('buildConfigMessage');
const buildConfigCancel = document.getElementById('buildConfigCancel');
const buildExportDb = document.getElementById('buildExportDb');
const buildConfigApply = document.getElementById('buildConfigApply');
let buildModalSeq = 0;
let buildStrictTouched = false;

function setBuildMessage(text, isError = false) {
  if (!buildConfigMessage) return;
  buildConfigMessage.textContent = text || '';
  buildConfigMessage.className = isError ? 'err' : 'ok';
  buildConfigMessage.hidden = !text;
}

function updateBuildConfigBtn() {
  if (!buildConfigBtn) return;
  if (!buildConfigState || buildConfigState.unsupported) {
    buildConfigBtn.hidden = true;
    return;
  }
  buildConfigBtn.hidden = false;
  const active = (buildConfigState.profiles || []).find((p) => p.id === buildConfigState.activeProfileId);
  if (active) {
    buildConfigBtn.textContent = `⚙ ${active.label}`;
    buildConfigBtn.classList.add('active');
    buildConfigBtn.title = `当前构建配置：${active.label}（${active.compiler} · ${active.activeFileCount} 个 .c）`;
  } else {
    const count = (buildConfigState.profiles || []).length;
    buildConfigBtn.textContent = count ? `⚙ 构建配置 (${count})` : '⚙ 构建配置';
    buildConfigBtn.classList.remove('active');
    buildConfigBtn.title = '选择机种构建配置（.cproject / .mak / QAC）、设置便携版 Clang 路径或导出 compile_commands.json';
  }
}

function renderBuildProfileSummary() {
  if (!buildProfileInfo || !buildConfigState) return;
  const id = buildProfileSelect?.value || '';
  const p = (buildConfigState.profiles || []).find((item) => item.id === id);
  buildProfileInfo.replaceChildren();
  if (!p) {
    const line = document.createElement('div');
    line.textContent = `全部源码（未按机种过滤）：共 ${buildConfigState.totalSourceFiles || 0} 个 .c 文件。` +
      ((buildConfigState.profiles || []).length
        ? `已检测到 ${buildConfigState.profiles.length} 个构建配置，切换后将按所选机种过滤参与编译的源码并注入宏定义。`
        : '当前目录未发现 .cproject / .mak / QAC 配置，可直接使用全部源码或配置 Clang 路径。');
    buildProfileInfo.append(line);
    return;
  }
  const head = document.createElement('div');
  head.textContent = `来源：${p.configFile} · 编译器/架构：${p.compiler} (${p.arch}) · 参与编译：${p.activeFileCount} / ${buildConfigState.totalSourceFiles || 0} 个 .c`;
  buildProfileInfo.append(head);
  const tags = document.createElement('div');
  tags.className = 'build-tags';
  const items = [
    `-I 目录 ${p.includeCount}`,
    `-D 宏定义 ${p.defineCount}`,
    ...(p.exclusionCount ? [`排除规则 ${p.exclusionCount}`] : []),
    ...(p.sampleDefines || []).slice(0, 6).map((d) => `-D${d}`),
  ];
  for (const label of items) {
    const span = document.createElement('span');
    span.className = 'build-tag';
    span.textContent = label;
    tags.append(span);
  }
  buildProfileInfo.append(tags);
}

function renderBuildConfigModal() {
  if (!buildConfigState || !buildProfileSelect) return;
  const profiles = buildConfigState.profiles || [];
  buildProfileSelect.replaceChildren(
    new Option(`全部源码（默认 · ${buildConfigState.totalSourceFiles || 0} 个 .c）`, ''),
    ...profiles.map((p) => new Option(`${p.label} [${p.source} · ${p.activeFileCount} .c]`, p.id)),
  );
  buildProfileSelect.value = buildConfigState.activeProfileId || '';
  if (buildMultiCoreHint) {
    buildMultiCoreHint.hidden = !buildConfigState.multiCoreHint;
    buildMultiCoreHint.textContent = buildConfigState.multiCoreHint
      ? `检测到 ${buildConfigState.cprojectCount} 个 .cproject（多核或多工程结构），已按目录前缀拆分为独立配置供单独选择。`
      : '';
  }
  if (buildParserSelect) {
    buildParserSelect.value = buildConfigState.activeParser || activeParser || 'builtin';
  }
  if (buildStrictCheck) {
    buildStrictCheck.checked = buildConfigState.strictCompileCommands !== false;
  }
  if (buildDispatchExpandCheck) {
    buildDispatchExpandCheck.checked = buildConfigState.dispatchPolicy !== 'strict';
  }
  if (buildClangBin) {
    buildClangBin.value = buildConfigState.clangBin || '';
  }
  if (buildClangStatus) {
    const st = buildConfigState.clangStatus;
    if (st?.ok) {
      buildClangStatus.className = 'build-status ok';
      buildClangStatus.textContent = `✓ 已就绪：${st.version}（${st.bin}）`;
    } else {
      buildClangStatus.className = 'build-status warn';
      buildClangStatus.textContent = `⚠ 未检测到 Clang（${st?.reason || '未安装'}）。仍可使用「内置快速解析」按所选机种过滤源码与宏定义；后续拷贝便携版 clang.exe 后在此填入路径即可启用 Clang AST。`;
    }
  }
  renderBuildProfileSummary();
}

async function loadBuildConfigs() {
  const epoch = reloadEpoch;
  const data = await api.buildConfigs();
  if (epoch !== reloadEpoch) return;
  buildConfigState = data;
  updateBuildConfigBtn();
  if (document.getElementById('buildConfigModal')?.classList.contains('show')) {
    renderBuildConfigModal();
  }
}

buildStrictCheck?.addEventListener('change', () => {
  buildStrictTouched = true;
});

buildProfileSelect?.addEventListener('change', () => {
  if (buildProfileSelect.value && buildStrictCheck && !buildStrictTouched) {
    buildStrictCheck.checked = true;
  }
  renderBuildProfileSummary();
  setBuildMessage('');
});

buildConfigCancel?.addEventListener('click', () => closeModal());

buildConfigBtn?.addEventListener('click', async () => {
  if (parserBusy || state.at || state.view?.comparison) return;
  const seq = ++buildModalSeq;
  const epoch = reloadEpoch;
  buildStrictTouched = false;
  setBuildMessage('正在刷新工程构建配置…');
  if (buildConfigApply) buildConfigApply.disabled = true;
  if (buildExportDb) buildExportDb.disabled = true;
  openModal('buildConfigModal');
  const data = await api.buildConfigs();
  if (seq !== buildModalSeq || epoch !== reloadEpoch) return;
  if (!data) {
    setBuildMessage('获取构建配置失败，请关闭重试', true);
    return;
  }
  buildConfigState = data;
  updateBuildConfigBtn();
  renderBuildConfigModal();
  setBuildMessage('');
  if (buildConfigApply) buildConfigApply.disabled = false;
  if (buildExportDb) buildExportDb.disabled = false;
});

buildExportDb?.addEventListener('click', async () => {
  if (parserBusy) return;
  buildExportDb.disabled = true;
  setBuildMessage('正在生成 compile_commands.json…');
  try {
    const result = await api.saveBuildConfig({
      profileId: buildProfileSelect?.value || null,
      exportCompileCommands: true,
    });
    if (!result?.ok) throw new Error(result?.error || '导出失败');
    setBuildMessage(`已导出 ${result.exportedPath}（共 ${result.unitCount} 个编译单元，${result.includeCount} 个 -I，${result.defineCount} 个 -D${result.shimPath ? '，含 GHS 兼容垫片' : ''}）`);
  } catch (error) {
    setBuildMessage(error.message || '导出失败', true);
  } finally {
    buildExportDb.disabled = false;
  }
});

buildConfigApply?.addEventListener('click', async () => {
  if (parserBusy) return;
  parserBusy = true;
  buildConfigApply.disabled = true;
  buildExportDb.disabled = true;
  syncCanvasControls();
  setBuildMessage('正在应用构建配置并重新解析工程…');
  try {
    const result = await api.saveBuildConfig({
      profileId: buildProfileSelect?.value || null,
      parserId: buildParserSelect?.value || 'builtin',
      clangBin: buildClangBin?.value ?? '',
      strictCompileCommands: Boolean(buildStrictCheck?.checked),
      dispatchPolicy: buildDispatchExpandCheck && !buildDispatchExpandCheck.checked ? 'strict' : 'expand',
    });
    if (!result?.ok) {
      if (result?.clangStatus && buildClangStatus) {
        buildClangStatus.className = 'build-status warn';
        buildClangStatus.textContent = `⚠ ${result.clangStatus.reason || 'Clang 不可用'}`;
      }
      throw new Error(result?.error || '应用构建配置失败');
    }
    closeModal();
    await hooks.reloadAll();
  } catch (error) {
    setBuildMessage(error.message || '应用构建配置失败', true);
  } finally {
    parserBusy = false;
    buildConfigApply.disabled = false;
    buildExportDb.disabled = false;
    syncCanvasControls();
  }
});
function renderParserSelect() {
  const select = els.parserSelect;
  select.replaceChildren(...parserList.map(({ id, name, available }) => {
    const option = new Option(id === 'builtin' ? t('toolbar.parserBuiltin') : name || id, id);
    option.disabled = available === false;
    return option;
  }));
  select.hidden = !parserList.length;
  select.value = activeParser;
  syncCanvasControls();
}
async function loadParsers() {
  const epoch = reloadEpoch;
  const data = await api.parsers();
  if (epoch !== reloadEpoch) return;
  activeParser = data?.active || '';
  parserList = Array.isArray(data?.parsers) ? data.parsers.filter(parser => typeof parser?.id === 'string' &&
    (parser.id === 'dot') === (activeParser === 'dot')) : [];
  renderParserSelect();
}
els.parserSelect.addEventListener('change', async () => {
  const id = els.parserSelect.value;
  if (parserBusy || !id || id === activeParser) return;
  parserBusy = true;
  syncCanvasControls();
  try {
    const result = await api.setParser(id);
    if (!result?.ok) throw new Error(t('toolbar.parserFailed') + (result?.error ? ` · ${result.error}` : ''));
    await hooks.reloadAll();
  } catch (error) {
    reportCanvasError(error);
  } finally {
    parserBusy = false;
    els.parserSelect.value = activeParser;
    syncCanvasControls();
  }
});
els.resetLayout.addEventListener('click', async () => {
  const { view, roots, root, expansions, groupMode } = state;
  try {
    if (view && !view.comparison) {
      const result = await api.layout({
        root: roots.join('+') || root || '',
        mode: groupMode === 'flat' ? 'flat' : 'group', resetPositions: groupMode,
      });
      if (!result?.ok) throw new Error(result?.error || t('app.viewFailed'));
    }
    if (state.view === view && !state.at) await loadView(roots.length ? roots : root, { expansions });
  } catch (error) { reportCanvasError(error); }
});
clearButton.addEventListener('click', () => clearCanvas().catch(reportCanvasError));
document.getElementById('multiSelectRemove').addEventListener('click', () => deleteSelection().catch(reportCanvasError));
document.getElementById('multiSelectCancel').addEventListener('click', () => {
  state.multiSelection = null;
  draw();
});
document.getElementById('emptyGuideSearch').addEventListener('click', () => els.search.focus());
emptyGuideCompare.addEventListener('click', () => {
  document.getElementById('projectBtn').click();
  document.getElementById('projectModeCompare').click();
});

// interact.js 先完成命中检测和点选，普通单击选中节点后退出双点路径。
els.cv.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || !state.selected) return;
  state.selectedEdge = null;
  state.selectedLabel = null;
  if (state.pairFlow) clearPairFlow();
});

// 顶栏菜单一次只展开一个；选完、点击外部或按 Escape 即收起。
const toolMenus = [...document.querySelectorAll('header .tool-menu')];
document.addEventListener('click', (event) => {
  for (const menu of toolMenus) {
    if (!menu.contains(event.target) || event.target.closest('button')) menu.open = false;
  }
});
for (const menu of toolMenus) {
  menu.querySelector('summary').addEventListener('click', () => {
    for (const other of toolMenus) if (other !== menu) other.open = false;
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || document.querySelector('.modal.show')) return;
  for (const menu of toolMenus) {
    if (!menu.open) continue;
    menu.open = false;
    menu.querySelector('summary').focus();
  }
});

// 三种导出共用命名和保存入口，原生 GUI 按工程记忆目录。
for (const [id, extension, build] of [
  ['exportSvg', 'svg', () => new Blob([buildSVG()], { type: 'image/svg+xml' })],
  ['exportPng', 'png', buildPNG],
  ['exportHtml', 'html', async () => new Blob([await buildStandaloneHtml()], { type: 'text/html; charset=utf-8' })],
]) {
  document.getElementById(id).addEventListener('click', async (event) => {
    if (!state.view) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await saveExport(extension, await build());
    } catch (error) {
      alert(t('app.exportFailed', { error: error.message }));
    } finally {
      button.disabled = false;
    }
  });
}

document.getElementById('exportXlsx').addEventListener('click', () => {
  window.location.href = '/api/export/xlsx';
});

// ---------------- 启动 ----------------

applyI18n();
document.addEventListener('callgraph:langchange', () => {
  renderParserSelect();
  renderTree(true);
  syncTreeSelection();
  runSearch().catch(() => {});
  loadStats().catch(() => {});
  renderVars();
  if (document.getElementById('secDataflow').hidden) renderDetail(state.selected).catch(() => {});
  renderLabelPanel();
  syncCanvasControls();
  draw();
});
window.addEventListener('resize', () => { constrainCam(); resize(); });
resize();
// 添加偏好与现有画布范围分开；没有已保存视图时，首屏使用默认查找层数。
(async () => {
  const myEpoch = reloadEpoch;
  const seq = viewSeq;
  void loadParsers();
  void loadBuildConfigs();
  try {
    const p = await api.uiPrefs();
    if (myEpoch !== reloadEpoch) return;
    if (seq === viewSeq && Number.isInteger(p?.down)) {
      state.down = p.down;
      state.addDepths.down = p.down;
    }
    if (seq === viewSeq && Number.isInteger(p?.up)) {
      state.up = p.up;
      state.addDepths.up = p.up;
    }
  } catch {
    /* 服务端没有该接口或暂时不可达：用默认值 */
  }
  if (myEpoch !== reloadEpoch) return;
  const pendingRestore = restorePage({
    root: new URLSearchParams(location.search).get('root'),
    isCurrent: (started) => myEpoch === reloadEpoch && seq + Number(started) === viewSeq,
  });
  void loadTree();
  void loadStats().catch((error) => console.warn(error));
  const res = await pendingRestore;
  if (myEpoch !== reloadEpoch || res.status === 'superseded') return;
  if (res.status === 'error' || !state.view) {
    if (confirm(t('app.retryStart', { error: res.error || t('app.noView') }))) location.reload();
  }
})();

// 只读调试接口：供自动化测试读取当前视图状态（不提供任何写操作）
window.__cg = {
  get view() {
    return state.view;
  },
  get cam() {
    return { x: cam.x, y: cam.y, k: cam.k };
  },
  get root() {
    return state.root;
  },
  /** 时间轴回看位置：0 = 看当前状态，>0 = 正在看该事件之后的历史 */
  get at() {
    return state.at;
  },
  /** 当前高亮的框 id（点击标题后短暂存在） */
  get flash() {
    return state.flash ? state.flash.box.id : null;
  },
  /** 当前选中项 */
  get selected() {
    return {
      node: state.selected,
      edge: state.selectedEdge ? edgeKey(state.selectedEdge) : null,
      label: state.selectedLabel,
    };
  },
  get aiOverlay() {
    return state.aiOverlay;
  },
  get presentation() {
    return state.presentation;
  },
  get aiHover() {
    return state.aiHover;
  },
  /** 连线标签：位置由画布算出，测试用它检查避让与「贴线」约束（一线可多条） */
  labels() {
    const v = state.view;
    if (!v) return [];
    const out = [];
    for (const e of v.edges) {
      const labels = e.labels || [];
      const rects = new Map((e._lbs || []).map((x) => [x.id, x.rect]));
      labels.forEach((l) =>
        out.push({
          edge: edgeKey(e),
          id: l.id,
          text: l.text,
          preset: l.preset,
          num: l.num ?? null,
          note: l.note || null,
          border: l.border,
          color: l.color,
          rect: rects.get(l.id) ? { ...rects.get(l.id) } : null,
        })
      );
    }
    return out;
  },
  /** 当前视图内是否存在节点互相重叠 */
  overlaps(pad = 0) {
    const v = state.view;
    if (!v) return [];
    const hits = [];
    for (let i = 0; i < v.nodes.length; i++) {
      for (let j = i + 1; j < v.nodes.length; j++) {
        const a = v.nodes[i];
        const b = v.nodes[j];
        if (
          a.x < b.x + b.w + pad &&
          a.x + a.w + pad > b.x &&
          a.y < b.y + b.h + pad &&
          a.y + a.h + pad > b.y
        ) {
          hits.push([a.id, b.id]);
        }
      }
    }
    return hits;
  },
};
