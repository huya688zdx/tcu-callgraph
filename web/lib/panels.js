/**
 * 侧栏面板：统计 / 文件树 / 搜索结果 / 节点详情
 */
import { t } from '../i18n.js';
import { els, state, esc, shortFile, edgeKey, nodeById } from './state.js';
import { edgeCaption, isDataEdge } from './edge-flow.js';
import { visibleCallEdge } from './relation-focus.js';
import { formatPeriod, nodePeriodBadge, periodCaption } from './period-text.js';
import { api } from './api.js';
import { hooks } from './hooks.js';
import { showMenuSections, hideMenu } from './ctxmenu.js';
import { locateNode, locateBox, peekNode } from './locate.js';
import { draw } from './render.js';
import { analyseDataflow, clearDataflow } from './df.js';
import { findCallOrder } from './call-order.js';
import { showExpansion, previewAddition } from './expand.js';
import { setNodeName } from './node-name.js';
import { statusControl, bindStatusControl, statusLabel } from './change-status.js';
import { canOpenFlowchart, openFlowchart } from './flowchart.js';
import { openManualNodeDialog, removeManualNodePermanently } from './manual-node.js';

export function nodeAiDetail(node) {
  return {
    kind: 'node',
    id: node.id,
    name: node.displayName || node.name,
    nodeKind: node.kind || 'fn',
    file: node.file || '',
    line: node.line || 0,
    change: node.change || 'existing',
    taskPeriods: (node.taskPeriods || []).slice(0, 4).map(({ task, us, kind }) => ({ task, us, kind })),
  };
}

export function fileAiDetail(path, containerKind, label) {
  return { kind: 'file', path, containerKind, label };
}

export function publishAiSelection(detail) {
  document.dispatchEvent(new CustomEvent('cg:selection-changed', { detail }));
}

export function askAi(detail) {
  document.dispatchEvent(new CustomEvent('cg:ask-ai', { detail }));
}

let statsSeq = 0;
async function loadStats() {
  const seq = ++statsSeq;
  const d = await fetch('/api/stats?summary=1').then(res => res.json());
  if (seq !== statsSeq || !d.stats) return;
  const s = d.stats;
  const row = (label, val) => `<div class="stat-row"><span>${label}</span><span>${val}</span></div>`;
  const metrics = [
    row(t('stat.edges'), s.edges),
    // 只有存在重复调用（同一对函数被调多次）时才显示，用来解释与边数的差额
    ...(s.calls && s.calls !== s.edges ? [row(t('stat.calls'), s.calls)] : []),
    row(t('stat.macros'), s.macros),
    row(t('stat.macroEdges'), s.macroEdges),
    row(t('stat.fnptrEdges'), s.fnptrEdges),
    row(t('stat.cycles'), s.cycles),
    row(t('stat.maxFanOut'), s.maxFanOut),
  ].join('') +
    (s.files > 1500
      ? `<div class="stat-row" style="color:#993C1D"><span>${t('stat.hintTitle')}</span><span>${t('stat.hintSlow')}</span></div>`
      : '');
  els.stats.innerHTML = row(t('stat.filesFnsVars'), `${s.files} / ${s.functions} / ${s.variables || 0}`) +
    `<details class="stat-more"><summary>${t('stat.more')}</summary>${metrics}</details>`;
}

els.stats?.addEventListener('click', (event) => {
  const row = event.target.closest('[data-task-id]');
  if (row) searchPick(row.dataset.taskId, row.querySelector('[data-add-function]'));
});

// ---------------- 全局变量 / 常量 ----------------

let varList = null;
let varsLoading = false;
let varsError = '';
let varsSeq = 0;

export function resetVars() {
  varsSeq++;
  varList = null;
  varsLoading = false;
  varsError = '';
  varQuery = '';
  varMode = 'all';
  collapsedFiles.clear();
  renderVars();
}

async function loadVars() {
  if (varsLoading || varList) return;
  const seq = ++varsSeq;
  varsLoading = true;
  varsError = '';
  renderVars();
  try {
    const result = await api.vars();
    if (seq !== varsSeq) return;
    if (!Array.isArray(result?.list)) throw new Error(result?.error || t('vars.failed'));
    varList = result.list;
  } catch (err) {
    if (seq !== varsSeq) return;
    varsError = String(err.message || err);
  } finally {
    if (seq === varsSeq) {
      varsLoading = false;
      renderVars();
    }
  }
}

/** 类型显示：常量已经用 const 标签标了，类型里就不再重复 */
const typeLabel = (x) => {
  const type = String(x.typeText || '');
  return (x.isConst ? type.replace(/\bconst\b/g, '') : type).replace(/\s+/g, ' ').trim();
};

const varPeerId = (peer) => typeof peer === 'string' ? peer : peer.id;

function varPeerNames(peers) {
  if (!peers.length) return t('common.none');
  const names = peers.slice(0, 6).map((peer) => (peer.name || varPeerId(peer)).split('::').pop());
  return [...names, peers.length > names.length ? t('vars.otherPeers', { n: peers.length - names.length }) : '']
    .filter(Boolean).join(' · ');
}

function varTitle(x) {
  return [
    x.name,
    `${x.file}:${x.line}`,
    x.typeText || t('vars.unknownType'),
    `${t('vars.writers', { n: x.writers.length })}: ${varPeerNames(x.writers)}`,
    `${t('vars.readers', { n: x.readers.length })}: ${varPeerNames(x.readers)}`,
  ].join('\n');
}

/** 变量面板的搜索、筛选与折叠状态（跨重绘保留） */
let varQuery = '';
let varMode = 'all';
const collapsedFiles = new Set();

/**
 * 渲染右侧「全局变量 / 常量」清单
 * 范围跟随当前点选的框：点文件框 → 该文件；点层级框 → 该目录下所有文件；
 * 什么都没点 → 提示先选一个框
 * 顶部搜索和快速筛选，列表按优先级排序，跨文件时显示可折叠的文件标题。
 */
export function renderVars() {
  const el = els.vars;
  if (!el) return;
  const v = state.view;
  const ctx = state.ctxBox;
  if (!v || !ctx) {
    el.innerHTML = `<div class="empty">${t('vars.hint')}</div>`;
    return;
  }
  if (!varList) {
    el.innerHTML = `<div class="empty">${esc(varsError || t('vars.onDemand'))}</div>
      <button type="button" data-load-vars ${varsLoading ? 'disabled' : ''}>${t(varsLoading ? 'vars.loading' : 'vars.load')}</button>`;
    el.querySelector('[data-load-vars]').addEventListener('click', () => loadVars());
    return;
  }

  const prefix = ctx.id ? ctx.id + '/' : '';
  const scope = varList.filter((x) =>
    ctx.kind === 'file' ? x.file === ctx.id : x.file === ctx.id || x.file.startsWith(prefix)
  );
  if (!scope.length) {
    el.innerHTML = `<div class="empty">${t('vars.none')}</div>`;
    return;
  }

  const inView = new Set(v.nodes.filter((n) => n.kind === 'var').map((n) => n.id));
  const functions = new Set(v.nodes.filter((n) => n.kind !== 'var').map((n) => n.id));
  const isInCanvas = (peer) => functions.has(varPeerId(peer));
  const rows = scope.map((x) => {
    const checked = inView.has(x.id);
    const linked = x.writers.some(isInCanvas) || x.readers.some(isInCanvas);
    const mutable = !x.isConst && x.writers.length > 0;
    return { x, checked, linked, mutable };
  });
  const multiFile = new Set(scope.map((x) => x.file)).size > 1;
  const checkedCount = rows.filter((row) => row.checked).length;
  const mutableCount = rows.filter((row) => row.mutable).length;
  const modes = [
    ['all', t('common.all'), rows.length],
    ['linked', t('vars.linked'), rows.filter((row) => row.linked).length],
    ['mutable', t('vars.mutable'), mutableCount],
    ['readonly', t('vars.readonly'), rows.length - mutableCount],
  ];

  const q = varQuery.trim().toLowerCase();
  const list = rows.filter(({ x, linked, mutable }) => {
    if (varMode === 'linked' && !linked) return false;
    if (varMode === 'mutable' && !mutable) return false;
    if (varMode === 'readonly' && mutable) return false;
    return !q || x.name.toLowerCase().includes(q) || String(x.typeText || '').toLowerCase().includes(q);
  }).sort((a, b) =>
    Number(b.checked) - Number(a.checked) ||
    Number(b.linked) - Number(a.linked) ||
    Number(b.mutable) - Number(a.mutable) ||
    a.x.file.localeCompare(b.x.file) ||
    a.x.line - b.x.line
  );

  const fileCounts = new Map();
  if (multiFile) {
    for (const row of list) {
      const { x, checked } = row;
      if (!fileCounts.has(x.file)) fileCounts.set(x.file, { rows: [], checked: 0 });
      const count = fileCounts.get(x.file);
      count.rows.push(row);
      if (checked) count.checked++;
    }
  }

  const parts = [];
  let lastFile = null;
  const groupedList = multiFile ? Array.from(fileCounts.values()).flatMap(group => group.rows) : list;
  for (const { x, checked, linked } of groupedList) {
    const folded = multiFile && collapsedFiles.has(x.file);
    if (multiFile && x.file !== lastFile) {
      if (lastFile !== null) parts.push('</div>');
      lastFile = x.file;
      const count = fileCounts.get(x.file);
      parts.push(`<div>
        <button type="button" class="var-file" data-file="${esc(x.file)}" title="${esc(x.file)}" aria-expanded="${!folded}">
          <span class="tw" aria-hidden="true">${folded ? '▶' : '▼'}</span>
          <span class="fn">${esc(shortFile(x.file))}</span><span class="cnt">${count.checked}/${count.rows.length}</span>
        </button>`);
    }
    if (folded) continue;
    parts.push(`<label class="var-row" data-id="${esc(x.id)}" title="${esc(varTitle(x))}">
      <span class="var-name">
        <input type="checkbox" aria-label="${esc(x.name)}" ${checked ? 'checked' : ''} ${state.at ? 'disabled' : ''}>
        <span class="vn">${esc(x.name)}</span>
      </span>
      <span class="var-meta">
        ${x.isConst ? '<span class="vg">const</span>' : ''}
        ${x.isStatic ? '<span class="vg static">static</span>' : ''}
        <span class="vt">${esc(typeLabel(x))}${x.line ? ` :${esc(x.line)}` : ''}</span>
        ${linked ? `<span class="vg in-canvas">${t('vars.linked')}</span>` : ''}
        <span class="vc ${x.writers.length ? 'rw' : 'ro'}">${t('vars.rwCount', { write: x.writers.length, read: x.readers.length })}</span>
      </span>
    </label>`);
  }
  if (lastFile !== null) parts.push('</div>');

  if (!list.length) parts.push(`<div class="empty">${t('vars.noMatch')}</div>`);
  const scrollTop = el.querySelector('.vars-list')?.scrollTop || 0;
  const filterLabel = esc(t('vars.filter'));
  el.innerHTML = `<div class="vars-bar">
    <div class="vars-search">
      <input id="varFilter" type="search" aria-label="${filterLabel}" placeholder="${filterLabel}" value="${esc(varQuery)}">
      <span class="vars-cnt" title="${t('vars.checked')}">${checkedCount}/${scope.length}</span>
    </div>
    <div class="vars-modes">${modes.map(([mode, label, count]) =>
      `<button type="button" data-var-mode="${mode}" aria-pressed="${varMode === mode}">${label} (${count})</button>`
    ).join('')}</div>
  </div><div class="vars-list">${parts.join('')}</div>`;
  const scroller = el.querySelector('.vars-list');
  scroller.scrollTop = scrollTop;

  const filter = el.querySelector('#varFilter');
  filter.addEventListener('input', () => {
    const { selectionStart, selectionEnd } = filter;
    varQuery = filter.value;
    scroller.scrollTop = 0;
    renderVars();
    const again = el.querySelector('#varFilter');
    again.focus({ preventScroll: true });
    again.setSelectionRange(selectionStart, selectionEnd);
  });
  el.querySelectorAll('[data-var-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      varMode = button.dataset.varMode;
      scroller.scrollTop = 0;
      renderVars();
      el.querySelector(`[data-var-mode="${varMode}"]`).focus({ preventScroll: true });
    });
  });
  el.querySelectorAll('.var-file').forEach((h) => {
    h.addEventListener('click', () => {
      const f = h.dataset.file;
      if (collapsedFiles.has(f)) collapsedFiles.delete(f);
      else collapsedFiles.add(f);
      renderVars();
      el.querySelector(`.var-file[data-file="${CSS.escape(f)}"]`)?.focus({ preventScroll: true });
    });
  });
  el.querySelectorAll('.var-row input').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const id = cb.closest('.var-row').dataset.id;
      try { await hooks.toggleVar(id, cb.checked); }
      catch (error) { alert(error.message || t('app.viewFailed')); }
    });
  });
}

// ---------------- 文件树 ----------------

let treeData = null;
let treeSeq = 0;
let showEmptyFiles = false;
const emptyTreeFiles = new Set();
let visibleTreeNodes = new WeakSet();
const populateTreeFiles = new Map();

function hasVisibleContent(node) {
  return showEmptyFiles || visibleTreeNodes.has(node);
}

function visibleTreeChildren(node) {
  const rank = (child) => {
    if (child.type === 'dir') return 0;
    if (/\.c$/i.test(child.name)) return 1;
    return /\.h$/i.test(child.name) ? 3 : 2;
  };
  return (node.children || []).filter(hasVisibleContent)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

async function loadTree() {
  const seq = ++treeSeq;
  try {
    const data = await api.tree();
    if (seq !== treeSeq) return;
    treeData = data;
    emptyTreeFiles.clear();
    visibleTreeNodes = new WeakSet();
    const visit = (node) => {
      let visible = Boolean(node.functions?.length);
      if (node.type === 'file' && !visible) emptyTreeFiles.add(node.path);
      for (const child of node.children || []) if (visit(child)) visible = true;
      if (visible) visibleTreeNodes.add(node);
      return visible;
    };
    visit(treeData);
    renderTree();
  } catch {
    if (seq !== treeSeq) return;
    document.getElementById('tree').innerHTML = `<div class="empty">${t('tree.loadFail')}</div>`;
  }
}

function renderTree(preserveExpansion = false) {
  const el = document.getElementById('tree');
  if (!el) return;
  const expanded = new Map();
  if (preserveExpansion) {
    for (const row of el.querySelectorAll('.tn[aria-expanded]')) {
      expanded.set(row.dataset.path, row.getAttribute('aria-expanded') === 'true');
    }
  }
  const scroller = el.closest('.tree-sec');
  const scrollTop = scroller?.scrollTop || 0;
  el.innerHTML = '';
  populateTreeFiles.clear();
  if (!treeData) return;
  const frag = document.createDocumentFragment();
  // 根节点就是打开的目录本身（名字由服务端给出），
  // 直接铺子节点会让人看不出这些文件属于哪个根目录
  if (treeData.name && hasVisibleContent(treeData)) {
    frag.appendChild(buildTreeNode(treeData, 0, expanded));
  } else {
    for (const child of visibleTreeChildren(treeData)) frag.appendChild(buildTreeNode(child, 0, expanded));
  }
  const hiddenEmptyCount = showEmptyFiles ? 0 : emptyTreeFiles.size;
  if (emptyTreeFiles.size) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-empty-toggle';
    toggle.textContent = showEmptyFiles ? t('tree.hideEmpty') : t('tree.showEmpty', { n: hiddenEmptyCount });
    toggle.addEventListener('click', () => {
      showEmptyFiles = !showEmptyFiles;
      renderTree(true);
      el.querySelector('.tree-empty-toggle')?.focus();
    });
    frag.appendChild(toggle);
  }
  el.appendChild(frag);
  if (preserveExpansion && scroller) scroller.scrollTop = scrollTop;
}

let shownOnly = false;
const shownFilter = document.getElementById('shownFunctions');
const batchBar = document.getElementById('shownBatchBar');
const selectShown = document.getElementById('shownBatchSelect');
const removeShown = document.getElementById('shownBatchRemove');
const clearShown = document.getElementById('shownBatchClear');
const checkedFunctions = new Set();
let checkedProjectId;

/**视图切换后同步已加入数量、函数状态与当前筛选。 */
export function syncTreeSelection() {
  const shown = new Set(state.view?.nodes.map((n) => n.id) || []);
  document.querySelectorAll('#tree .tn.fn').forEach((row) => {
    row.classList.toggle('shown', shown.has(row.dataset.fnid));
  });
  document.querySelectorAll('[data-add-function]').forEach((button) => {
    const inView = shown.has(button.dataset.addFunction);
    const label = inView ? t('tree.locateManage') : t('tree.addOrOpen');
    button.textContent = inView ? t('tree.manage') : t('tree.add');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-haspopup', 'menu');
    button.hidden = !!window.__EXPORT;
  });
  if (shownFilter) shownFilter.lastElementChild.textContent = (state.view?.nodes || []).filter((n) => n.kind !== 'var').length;
  if (shownOnly) renderShownFunctions();
}

const inCanvas = (id) => state.view?.nodes.some((node) => node.id === id);

function addFunctionButton(id) {
  if (id.startsWith('var::')) return '';
  const inView = inCanvas(id);
  const label = inView ? t('tree.locateManage') : t('tree.addOrOpen');
  const key = esc(id);
  return `<button type="button" class="add-function" data-add-function="${key}" title="${label}" aria-label="${label}" aria-haspopup="menu" aria-expanded="false" ${window.__EXPORT ? 'hidden' : ''}>${inView ? t('tree.manage') : t('tree.add')}</button>`;
}

async function removeShownFunction(id) {
  try { await hooks.removeFunction(id); }
  catch (error) { alert(error.message || t('common.removeFailed')); }
}

async function addSingleFunction(id) {
  try {
    const view = await hooks.addFunction(id);
    if (!view?.nodes.some((node) => node.id === id)) throw new Error(t('tree.addRetry'));
  } catch (error) { alert(error.message || t('tree.addFailed')); }
}

async function openFunctionAlone(id) {
  try {
    const view = await (hooks.openFunctionAlone ?? hooks.loadView)(id);
    if (!view?.nodes.some((node) => node.id === id)) throw new Error(t('tree.openRetry'));
    if (view === state.view) locateNode(id);
  } catch (error) { alert(error.message || t('tree.openFailed')); }
}

function functionViewActions(id) {
  if (!inCanvas(id)) return [
    { value: 'single', label: 'functionAction.single' },
    { value: 'relations', label: 'functionAction.relationsAdd' },
    { value: 'alone', label: 'functionAction.alone' },
  ];
  return [
    { value: 'locate', label: 'functionAction.locate' },
    { value: 'relations', label: 'functionAction.relationsExpand' },
    ...(!state.at && !state.view?.comparison ? [{ value: 'remove', label: 'functionAction.remove' }] : []),
  ];
}

function handleFunctionViewAction(value, id, fromRelation = false) {
  if (value === 'locate' && inCanvas(id)) return (fromRelation ? peekNode : locateNode)(id);
  if (value === 'single') return addSingleFunction(id);
  if (value === 'alone') return openFunctionAlone(id);
  if (value === 'relations') return previewAddition({ id });
  if (value === 'remove') return removeShownFunction(id);
}

function openFunctionAddMenu(button) {
  if (button.getAttribute('aria-expanded') === 'true') { hideMenu(); return; }
  const id = button.dataset.addFunction;
  const fromRelation = !!button.closest('#edges, #detail');
  const items = functionViewActions(id);
  const rect = button.getBoundingClientRect();
  showMenuSections(rect.left, rect.bottom + 4, id.split('::').pop(), [{ items }],
    (value) => handleFunctionViewAction(value, id, fromRelation), button);
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-add-function], [data-locate-node]');
  if (!button) return;
  event.stopPropagation();
  if (button.dataset.locateNode) {
    if (inCanvas(button.dataset.locateNode)) locateNode(button.dataset.locateNode);
  } else {
    openFunctionAddMenu(button);
  }
}, true);

/** 展开某一行的所有祖先目录（并可选展开它自己） */
function expandRow(row, includeSelf = false) {
  const open = (head) => {
    const kids = head && head.nextElementSibling;
    if (!kids || kids.tagName !== 'DIV') return;
    if (kids.style.display === 'none') kids.style.display = 'block';
    const tw = head.querySelector('.tw');
    if (tw && head.hasAttribute('aria-expanded')) {
      tw.textContent = '▾';
      head.setAttribute('aria-expanded', 'true');
    }
  };
  if (includeSelf) open(row);
  let p = row.parentElement;
  while (p && p.id !== 'tree') {
    if (p.style && p.style.display === 'none') {
      p.style.display = 'block';
      open(p.previousElementSibling);
    }
    p = p.parentElement;
  }
}

function flashRow(row) {
  row.classList.add('hl');
  setTimeout(() => row.classList.remove('hl'), 1600);
}

/**
 * 在左侧文件列里定位：展开父目录、滚动到可见、高亮一下
 * @param {'fn'|'file'|'dir'} kind
 * @param {string} id 函数 id / 文件相对路径 / 目录路径
 */
export function revealInTree(kind, id) {
  if (kind === 'file' && !showEmptyFiles && emptyTreeFiles.has(id)) {
    showEmptyFiles = true;
    renderTree(true);
  }
  let row = null;
  populateTreeFiles.get(kind === 'fn' ? (id.startsWith('header::') ? id.split('::')[1] : id.split('::')[0]) : id)?.();
  if (kind === 'fn') {
    row = document.querySelector(`#tree .tn.fn[data-fnid="${CSS.escape(id)}"]`);
  } else {
    const cls = kind === 'file' ? 'file' : 'dir';
    row = [...document.querySelectorAll(`#tree .tn.${cls}`)].find(
      (r) => r.dataset.path === (id || '')
    );
  }
  if (!row) return false;
  expandRow(row, kind === 'file'); // 定位到文件时顺手展开它下面的函数
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  flashRow(row);
  return true;
}

/** 目录/文件节点下的所有函数 id —— 定位时如果它不在视图里，用这些函数当入口 */
function collectFnIds(node) {
  const out = [];
  const walk = (n) => {
    for (const f of n.functions || []) out.push(f.id);
    for (const c of n.children || []) walk(c);
  };
  walk(node);
  return out;
}

/** 文件树右键：区分图中定位、以新入口查看，以及文件节点上手工添加函数/变量。 */
function openTreeMenu(ev, kind, payload) {
  ev.preventDefault();
  ev.stopPropagation();
  const editable = !window.__EXPORT && !state.at && !state.view?.comparison;
  const sections = [];
  const items = [];
  if (kind === 'fn') {
    if (!payload.manual) {
      items.push({ value: 'expand', label: 'expand.menu' });
      items.push({ value: 'dataflow', label: 'menu.dataflow' });
      if (!state.view?.comparison) items.push({ value: 'callOrder', label: 'callOrder.find' });
    }
    items.push(...functionViewActions(payload.id).filter(({ value }) => !window.__EXPORT || value === 'locate'));
    if (items.length) sections.push({ items });
    if (payload.manual && editable) {
      sections.push({ id: 'manualDel', items: [{ value: 'deleteManual', label: 'manual.deleteFn' }] });
    }
  } else {
    if (kind === 'file' && editable) {
      sections.push({
        id: 'manualAdd',
        label: 'manual.menuSection',
        items: [
          { value: 'addFn', label: 'manual.addFn' },
          { value: 'addVar', label: 'manual.addVar' },
        ],
      });
    }
    const boxes = kind === 'file' ? state.view?.groups : state.view?.containers;
    if (boxes?.some((box) => box.id === payload.id)) items.push({ value: 'locate', label: t('common.locateCanvas') });
    else if (!window.__EXPORT && payload.fnIds?.length) items.push({ value: 'alone', label: t('common.openAlone') });
    if (items.length) sections.push({ items });
  }
  if (!window.__EXPORT) sections.push({ items: [{ value: 'askAi', label: '✨ 问 AI' }] });
  if (!sections.length) return;
  showMenuSections(
    ev.clientX,
    ev.clientY,
    payload.label,
    sections,
    async (v) => {
      if (v === 'askAi') return askAi(kind === 'fn'
        ? nodeAiDetail(nodeById(payload.id) || payload.node)
        : fileAiDetail(payload.id, kind, payload.label));
      if (v === 'addFn') return openManualNodeDialog({ file: payload.id, kind: 'fn' });
      if (v === 'addVar') return openManualNodeDialog({ file: payload.id, kind: 'var' });
      if (v === 'deleteManual') return removeManualNodePermanently({ id: payload.id, name: payload.label });
      if (v === 'expand') return showExpansion({ id: payload.id, name: payload.label });
      if (v === 'dataflow') return analyseDataflow(payload.id);
      if (v === 'callOrder') return findCallOrder(payload.id);
      if (kind === 'fn') return handleFunctionViewAction(v, payload.id);
      if (await locateBox(kind, payload.id, v === 'alone' ? payload.fnIds : [])) {
        renderVars();
        publishAiSelection(fileAiDetail(payload.id, kind, payload.label));
      }
    }
  );
}

function buildTreeNode(node, depth, expanded = new Map()) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'tn ' + node.type;
  row.dataset.path = node.path == null ? '' : node.path;
  row.style.paddingLeft = depth * 8 + 4 + 'px';

  const children = visibleTreeChildren(node);
  const count = node.functions?.length || 0;
  const hasKids = children.length > 0 || count > 0;
  const isExpanded = hasKids && (expanded.get(node.path) ?? (node.type === 'dir'));
  if (hasKids) row.setAttribute('aria-expanded', String(isExpanded));
  const tw = document.createElement('span');
  tw.className = 'tw';
  tw.textContent = hasKids ? (isExpanded ? '▾' : '▸') : '';
  row.appendChild(tw);

  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = node.name;
  nm.title = node.path || node.name;
  row.appendChild(nm);
  if (node.type === 'file') {
    const badge = document.createElement('span');
    badge.className = 'tree-fn-count';
    badge.textContent = count;
    badge.title = t('tree.functionCount', { n: count });
    row.appendChild(badge);
  }
  wrap.appendChild(row);

  const kids = document.createElement('div');
  kids.style.display = isExpanded ? 'block' : 'none';
  for (const child of children) kids.appendChild(buildTreeNode(child, depth + 1, expanded));
  let populated = false;
  const populateFunctions = () => {
    if (populated) return;
    populated = true;
    const shown = new Set(state.view?.nodes.map(node => node.id));
    for (const f of node.functions || []) {
      const fr = document.createElement('div');
      fr.className = 'tn fn';
      fr.dataset.fnid = f.id;
      fr.style.paddingLeft = (depth + 1) * 8 + 18 + 'px';
      const lab = document.createElement('span');
      lab.className = 'nm';
      lab.textContent = f.name;
      lab.title = f.manual ? `${node.path} · ${t('node.manualFn')}` : `${node.path}:${f.line}`;
      fr.appendChild(lab);
      fr.insertAdjacentHTML('beforeend', addFunctionButton(f.id));
      fr.classList.toggle('shown', shown.has(f.id));
      const treeFn = { ...f, file: node.path };
      fr.addEventListener('click', () => {
        if (!inCanvas(f.id)) publishAiSelection(nodeAiDetail(treeFn));
        searchPick(f.id, fr.querySelector('[data-add-function]'));
      });
      fr.addEventListener('contextmenu', (ev) =>
        openTreeMenu(ev, 'fn', { id: f.id, label: f.name, manual: !!f.manual, node: treeFn })
      );
      kids.appendChild(fr);
    }
  };
  if (count) {
    populateTreeFiles.set(node.path, populateFunctions);
    if (isExpanded) populateFunctions();
  }
  wrap.appendChild(kids);

  // 文件 / 目录行右键：定位到该文件或该目录
  const kind = node.type === 'file' ? 'file' : 'dir';
  row.addEventListener('contextmenu', (ev) =>
    openTreeMenu(ev, kind, {
      id: node.path,
      label: node.name,
      fnIds: collectFnIds(node),
    })
  );

  row.addEventListener('click', (ev) => {
    if (ev.target.tagName === 'INPUT') return;
    publishAiSelection(fileAiDetail(node.path, kind, node.name));
    if (!hasKids) return;
    const open = kids.style.display !== 'none';
    if (!open) populateFunctions();
    kids.style.display = open ? 'none' : 'block';
    tw.textContent = open ? '▸' : '▾';
    row.setAttribute('aria-expanded', String(!open));
  });

  return wrap;
}

let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchSeq++;
  syncSearchMode();
  hideMenu();
  if (shownOnly) { runSearch(); return; }
  searchTimer = setTimeout(runSearch, 140);
});

/** 搜索请求序号：快速输入时只认最后一次，避免慢响应覆盖新结果 */
let searchSeq = 0;

shownFilter?.addEventListener('click', () => {
  shownOnly = !shownOnly;
  if (!shownOnly) checkedFunctions.clear();
  shownFilter.setAttribute('aria-pressed', String(shownOnly));
  hideMenu();
  runSearch();
});

function renderFunctionResults(list, batch = false) {
  els.results.innerHTML = list.length ? list.map((f) => `<li data-id="${esc(f.id)}" title="${esc(t('search.itemHint'))}">
    <div class="search-summary">
      ${batch ? `<input type="checkbox" data-batch-function aria-label="${esc(t('tree.selectFunction', { name: f.displayName || f.name }))}"
        ${checkedFunctions.has(f.id) ? 'checked' : ''}>` : ''}
      <div class="fn">${esc(f.displayName || f.name)}</div>${addFunctionButton(f.id)}</div>
    <div class="meta">${esc(shortFile(f.file || ''))}:${f.line || ''}${Number.isInteger(f.inCount) ? ` · ↑${f.inCount} ↓${f.outCount}` : ''}</div>
    </li>`).join('') : `<li class="empty">${shownOnly ? t('tree.noShownMatch') : t('empty.noMatch')}</li>`;
}

function syncBatchControls() {
  if (!batchBar || batchBar.hidden) return;
  const checks = [...els.results.querySelectorAll('[data-batch-function]')];
  const allChecked = checks.length > 0 && checks.every((check) => check.checked);
  selectShown.disabled = !checks.length;
  selectShown.setAttribute('aria-pressed', String(allChecked));
  removeShown.disabled = !checkedFunctions.size;
  removeShown.textContent = t('tree.removeChecked', { n: checkedFunctions.size });
  clearShown.disabled = !state.view?.nodes.length;
}

function renderShownFunctions() {
  const q = els.search.value.trim().toLowerCase();
  const nodes = (state.view?.nodes || []).filter((n) => n.kind !== 'var');
  const batch = !!batchBar && !window.__EXPORT && !state.at && !state.view?.comparison;
  if (!batch || state.view?.projectId !== checkedProjectId) checkedFunctions.clear();
  checkedProjectId = state.view?.projectId;
  const ids = new Set(nodes.map((n) => n.id));
  for (const id of checkedFunctions) if (!ids.has(id)) checkedFunctions.delete(id);
  if (batchBar) batchBar.hidden = !batch;
  renderFunctionResults(nodes.filter((n) => !q || `${n.name} ${n.displayName || ''} ${n.file || ''}`.toLowerCase().includes(q)), batch);
  syncBatchControls();
}

selectShown?.addEventListener('click', () => {
  const checked = selectShown.getAttribute('aria-pressed') !== 'true';
  for (const check of els.results.querySelectorAll('[data-batch-function]')) {
    const id = check.closest('li').dataset.id;
    check.checked = checked;
    if (checked) checkedFunctions.add(id);
    else checkedFunctions.delete(id);
  }
  syncBatchControls();
});
removeShown?.addEventListener('click', () => {
  hooks.removeFunctions([...checkedFunctions]).catch((error) => alert(error.message || t('common.removeFailed')));
});
clearShown?.addEventListener('click', () => {
  hooks.clearCanvas().catch((error) => alert(error.message || t('common.removeFailed')));
});
els.results.addEventListener('change', (e) => {
  if (!e.target.matches('[data-batch-function]')) return;
  const id = e.target.closest('li').dataset.id;
  if (e.target.checked) checkedFunctions.add(id);
  else checkedFunctions.delete(id);
  syncBatchControls();
});

function syncSearchMode() {
  const searching = !!els.search.value.trim();
  const tree = document.getElementById('tree');
  if (tree) tree.hidden = searching || shownOnly;
  els.results.hidden = !searching && !shownOnly;
  if (batchBar && !shownOnly) batchBar.hidden = true;
  const section = els.results.closest('.tree-sec');
  if (section) {
    section.scrollTop = 0;
    section.querySelector('h3').textContent = shownOnly ? t('tree.shownFunctions') : searching ? t('panel.results') : t('panel.files');
  }
}

async function runSearch() {
  const my = ++searchSeq;
  const q = els.search.value.trim();
  syncSearchMode();
  if (shownOnly) { renderShownFunctions(); return; }
  if (!q) {
    els.results.innerHTML = '';
    return;
  }
  const list = await api.search(q);
  if (my !== searchSeq) return; // 已经有更新的搜索，丢弃这次的结果
  renderFunctionResults(list);
}

/** 点击名称只定位或选择添加方式，不隐式展开和替换画布。 */
function searchPick(id, button) {
  if (inCanvas(id)) return locateNode(id);
  if (button && !window.__EXPORT) openFunctionAddMenu(button);
}

els.results.addEventListener('click', (e) => {
  if (e.target.matches('[data-batch-function]')) return;
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  searchPick(li.dataset.id, li.querySelector('[data-add-function]'));
});

els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = els.results.querySelector('li[data-id]');
    if (first) searchPick(first.dataset.id, first.querySelector('[data-add-function]'));
  }
});

/**
 * 节点详情 / 调用关系只对函数节点有意义：
 * 点文件框、目录层级、变量节点时直接收起来，免得留两块空面板
 */
function syncDetailSections(isFn) {
  if (els.secDetail) els.secDetail.style.display = isFn ? '' : 'none';
  if (els.secEdges) els.secEdges.style.display = isFn ? '' : 'none';
}

/**
 * 详情请求序号：快速点 A→B 时，A 的慢响应不能覆盖 B 的面板
 * （否则面板显示 A 的内容却标在 B 上，或把备注写到已经切换掉的节点）
 */
let detailSeq = 0;

const impactRoles = {
  added: ['added', 'compare.version.added'],
  deleted: ['deleted', 'compare.version.deleted'],
  modified: ['direct', 'compare.role.direct'],
  direct_change: ['direct', 'compare.role.direct'],
  macro_lsb_impact: ['impact', 'compare.role.macro'],
  period_impact: ['period', 'compare.role.period'],
  dataflow_impact: ['impact', 'compare.role.data'],
  caller_impact: ['impact', 'compare.role.caller'],
  callee_context: ['context', 'compare.role.callee'],
};

function impactRoleBadge(node) {
  const automaticRole = node.impactRole === 'direct_change' && node.statusSource === 'manual' ? null : impactRoles[node.impactRole];
  const [style, label] = impactRoles[node.change] || (node.macroImpact && impactRoles.macro_lsb_impact) ||
    (node.periodImpact && impactRoles.period_impact) || automaticRole || (node.context && impactRoles.callee_context) ||
    (node.impact ? ['impact', 'compare.role.affected'] : ['context', 'status.existing']);
  return `<span class="compare-badge ${style}" title="${esc(t('compare.role.title'))}">${t(label)}</span>`;
}

function compactDetailText(value) {
  const chars = Array.from(value.replace(/\s+/g, ' ').trim());
  return chars.length > 48 ? chars.slice(0, 47).join('') + '…' : chars.join('');
}

function rootChangePoints(node, rootPoints) {
  if (!rootPoints.length) return '';
  const value = (v) => (Array.isArray(v) ? v.join(' / ') : String(v ?? '')) || '—';
  return `<div class="detail-meta"><b>${t('compare.relatedPoints')}</b></div><div class="compare-points">${rootPoints.map((point) => {
    const sourceId = point.sourceId || (point.kind === 'period' ? point.id.replace(/^period::/, '') : point.id);
    const source = inCanvas(sourceId) ? sourceId : point.kind === 'macro_lsb'
      ? state.view?.nodes.find((n) => n.headerSymbol && n.name === point.name && n.file === point.file)?.id : null;
    const affected = point.affectedIds?.find((id) => id !== node.id && inCanvas(id)) || node.id;
    const target = source || affected;
    const before = value(point.beforeValue);
    const after = value(point.afterValue);
    const hasDiff = point.beforeValue != null || point.afterValue != null;
    const diff = hasDiff ? `${compactDetailText(before)} → ${compactDetailText(after)}` : '';
    const summary = compactDetailText(String(point.summary ?? ''));
    const description = point.kind === 'function' ? summary || diff : diff || summary;
    const action = source ? t('compare.point.locate') : t('compare.point.locateAffected');
    const title = [action, point.file, point.summary, hasDiff ? `${before} → ${after}` : ''].filter(Boolean).join('\n');
    return `<button type="button" class="compare-point" data-locate-node="${esc(target)}" title="${esc(title)}"><b>${esc(point.name || point.id)}</b>${description ? ` <span>${esc(description)}</span>` : ''}</button>`;
  }).join('')}</div>`;
}

function comparisonDetail(node, points) {
  const location = (side) => {
    const values = node.locations?.[side];
    const rows = (Array.isArray(values) ? values : values ? [values] : []).map((v) =>
      `${v.file || ''}${v.line ? `:${v.line}` : ''}`
    ).filter(Boolean);
    return rows.join(' · ');
  };
  const before = location('before');
  const after = location('after');
  const locations = before === after ? (before ? [before] : []) : [
    `${t('compare.locationBefore')}: ${before || '—'}`,
    `${t('compare.locationAfter')}: ${after || '—'}`,
  ];
  const ids = new Set(node.impactChainIds);
  const rootPoints = (points || []).filter((point) => ids.has(point.id));
  const reasons = (Array.isArray(node.reasons) ? node.reasons : [node.reasons]).filter(Boolean);
  const reasonText = reasons.map((reason) =>
    typeof reason === 'object' ? reason.reason || reason.text || reason.name || JSON.stringify(reason) : reason
  ).map(esc).join(' · ');
  const count = rootPoints.length + reasons.length + locations.length;
  const period = periodCaption(node);
  return `<div class="detail-meta">${impactRoleBadge(node)}
    ${period.includes('→') ? `<span class="compare-badge period" title="${esc(t('compare.role.period'))}">${esc(period)}</span>` : ''}
    </div>
    ${count ? `<details class="period-detail">
      <summary><span class="period-summary-label">${t('compare.reasons')}</span><span class="period-summary-rate">(${count})</span></summary>
      <div class="period-detail-body">
        ${rootChangePoints(node, rootPoints)}
        ${reasonText ? `<div class="detail-meta">${reasonText}</div>` : ''}
        ${locations.map((line) => `<div class="detail-meta">${esc(line)}</div>`).join('')}
      </div>
    </details>` : ''}`;
}

function showEdgeDetails(edge) {
  if (!edge || isDataEdge(edge)) return false;
  const count = (side) => {
    const locations = edge.locations?.[side];
    if (Array.isArray(locations)) return locations.length;
    return edge[`${side}Calls`]?.length ?? (locations ? 1 : 0);
  };
  const before = count('before');
  const after = count('after');
  if (before === after) return false;
  const name = (id) => state.view.nodes.find((n) => n.id === id)?.name || id;
  if (els.secDetail) els.secDetail.style.display = '';
  els.detail.innerHTML = `<div class="detail-title">${esc(edgeCaption(edge, name))}</div>
    <div class="detail-meta"><b>${t('compare.callsChanged', { before, after })}</b></div>`;
  els.edges.innerHTML = '';
  return true;
}

function compactRateText(c) {
  const rate = formatPeriod(c.us).replace(' ', '');
  return [c.kind === 'isr' && 'ISR', rate].filter(Boolean).join('·') || t('period.unknown');
}

function periodDetail(node) {
  if (node.kind === 'var') {
    const cross = node.crossPeriod;
    if (!cross) return '';
    const rates = values => values.map(formatPeriod).join(' / ') || 'ISR';
    const badge = nodePeriodBadge(node);
    return `<details class="period-detail">
      <summary title="${esc(t('period.triggers'))}"><span class="period-summary-label">${t('period.summary')}</span><span class="period-summary-val">${esc(badge?.text || rates(cross.writerUs))}</span></summary>
      <div class="period-detail-body">
        <div>${t('period.writers', { period: rates(cross.writerUs) })}</div>
        <div>${t('period.readers', { period: rates(cross.readerUs) })}</div>
        ${cross.hasIsr ? `<div class="detail-meta">${t('period.isrContext')}</div>` : ''}
        <div class="period-warning ${cross.protected ? 'guarded' : ''}">${cross.protected ? t('period.guarded') : t('period.hazard')}</div>
      </div>
    </details>`;
  }
  const periods = node.taskPeriods?.length ? node.taskPeriods : node.previousTaskPeriods;
  if (!periods?.length) return '';
  const first = periods[0];
  const firstName = first.task?.split('::').at(-1) || '';
  const firstRate = compactRateText(first);
  const extra = periods.length > 1 ? ` +${periods.length - 1}` : '';
  const fullSummary = `${firstName ? `${firstName} (${firstRate})` : firstRate}${extra}`;
  const rateBadge = firstName ? `(${firstRate})${extra}` : `${firstRate}${extra}`;
  return `<details class="period-detail">
    <summary title="${esc(`${t('period.triggers')}：${fullSummary}`)}"><span class="period-summary-label">${t('period.summary')}</span>${firstName ? `<span class="period-summary-task">${esc(firstName)}</span>` : ''}<span class="period-summary-rate">${esc(rateBadge)}</span></summary>
    <div class="period-detail-body">
      ${node.multiRate ? `<div class="period-multi">${t('period.multiRate')}</div>` : ''}
      <ul>${periods.map(c => {
        const evidence = c.dividers?.map(d => t('period.divider', {
          counter: d.counter, divider: d.divider, location: `${d.file}:${d.line}`,
        })) || [];
        const source = c.source || evidence[0] || '';
        const sourceTitle = [c.source, ...evidence].filter(Boolean).join('\n');
        return `<li><strong title="${esc(c.task || '')}">${esc(c.task?.split('::').at(-1) || '')}</strong> · ${esc(compactRateText(c))}
          ${source ? `<small title="${esc(sourceTitle)}">${esc(compactDetailText(source))}</small>` : ''}</li>`;
      }).join('')}</ul>
    </div>
  </details>`;
}

async function renderDetail(id, boxDetail = null) {
  clearDataflow();
  state.hoverRelation = null;
  const my = ++detailSeq;
  const target = id ? nodeById(id) : null;
  if (target || !state.selectedEdge) publishAiSelection(target ? nodeAiDetail(target) : boxDetail);
  const isFn = !!target && target.kind !== 'var';
  const comparison = state.compareInfo?.active ? state.compareInfo : state.view?.comparison;
  syncDetailSections(isFn);
  if (!target && comparison && showEdgeDetails(state.selectedEdge)) return;
  const askAiButton = target && !window.__EXPORT
    ? `<button class="flowchart-detail" type="button" data-node-ask-ai="${esc(target.id)}">✨ 问 AI</button>`
    : '';
  const inViewIds = new Set((state.view?.nodes || []).map((n) => n.id));
  const dataEdges = target ? state.view.edges.filter(e => isDataEdge(e) && (e.from === id || e.to === id)) : [];
  const names = dataEdges.length ? new Map(state.view.nodes.map(n => [n.id, n.displayName || n.name])) : null;
  const dataDir = (e) => {
    if (e.kind === 'var') {
      if (e.via === t('ai.level.readwrite')) return 'both';
      if (e.via === '读') return e.from === id ? 'in' : 'out';
      if (e.via === '写') return e.from === id ? 'out' : 'in';
      return '';
    }
    return e.from === id ? 'out' : 'in';
  };
  const dataRows = dataEdges.map(e => {
    const peerId = e.from === id ? e.to : e.from;
    const dir = dataDir(e);
    const inView = inViewIds.has(peerId);
    const fullCaption = edgeCaption(e, nodeId => names.get(nodeId) || nodeId);
    const caption = edgeCaption(e, nodeId => compactDetailText((names.get(nodeId) || nodeId).split('::').at(-1)));
    return `<div class="df-dir-item call-relation${inView ? ' in-view' : ''}" data-peer-id="${esc(peerId)}" data-edge-key="${esc(edgeKey(e))}"${dir ? ` data-rel-dir="${dir}"` : ''}${inView ? ` title="${esc(t('common.locateClick'))}"` : ''}><span title="${esc(fullCaption)}">${esc(caption)}</span>${addFunctionButton(peerId)}</div>`;
  }).join('');
  const dataDirections = dataEdges.length > 4 ? `<details class="period-detail" open>
    <summary><span class="period-summary-label">${t('node.rwDirections')}</span><span class="period-summary-rate">(${dataEdges.length})</span></summary>
    <div class="period-detail-body detail-directions">${dataRows}</div>
  </details>` : dataRows ? `<div class="detail-directions"><b>${t('node.rwDirections')}</b>${dataRows}</div>` : '';
  if (target?.kind === 'var') {
    if (els.secDetail) els.secDetail.style.display = '';
    if (els.secEdges) els.secEdges.style.display = 'none';
    els.detail.innerHTML = `<div class="detail-title">${esc(target.name)}</div>
      <div class="detail-meta">${esc(target.file || '')}${target.manual ? ` · ${t('node.manualVar')}${target.typeText ? ' · ' + esc(target.typeText) : ''}` : `:${target.line || ''}`}</div>
      ${askAiButton}
      ${comparison ? comparisonDetail(target, comparison.changePoints ?? state.view?.comparison?.changePoints) : ''}
      ${dataDirections}
      ${statusControl(target)}
      ${periodDetail(target)}
      `;
    bindStatusControl(els.detail, target);
    els.edges.innerHTML = '';
    return;
  }
  if (!isFn) {
    els.detail.innerHTML = '';
    els.edges.innerHTML = '';
    return;
  }
  if (!id) {
    els.detail.innerHTML = `<div class="empty">${t('empty.detail')}</div>`;
    els.edges.innerHTML = `<div class="empty">${t('empty.edges')}</div>`;
    return;
  }
  const d = await api.node(id);
  if (my !== detailSeq) return; // 已经切到别的节点，丢弃这次的结果
  if (d.error) return;
  const n = comparison ? { ...d.node, ...target } : d.node;

  els.detail.innerHTML = `
    <div class="detail-title">${esc(target.displayName || n.name)}</div>
    <div class="detail-meta">${esc(n.file)}${n.manual ? ' · ' + t('node.manualFn') : `:${n.line}`}${n.isStatic ? ' · ' + t('node.static') : ''}${n.external ? ' · ' + t('node.externalTag') : ''}</div>
    ${canOpenFlowchart(n) ? `<button class="flowchart-detail" type="button" data-node-flowchart>${t('flowchart.menu')}</button>` : ''}
    ${askAiButton}
    ${comparison ? comparisonDetail(n, comparison.changePoints ?? state.view?.comparison?.changePoints ?? d.changePoints) : ''}
    ${dataDirections}
    ${statusControl(target)}
    ${n.headerSymbol ? `<div class="detail-meta">#define ${esc(n.name)}${Array.isArray(n.macroParams) ? '(' + esc(n.macroParams.join(', ')) + ')' : ''} ${esc(n.raw)}</div>
      <label>${t('name.title')} <select data-node-name ${state.at > 0 || state.view?.comparison ? 'disabled' : ''}>
        <option value="default" ${!target.nameModeOverride ? 'selected' : ''}>${t('name.default')}（${t(target.nameMode === 'target' ? 'name.target' : 'name.alias')}）</option>
        <option value="alias" ${target.nameModeOverride === 'alias' ? 'selected' : ''}>${t('name.alias')}: ${esc(n.name)}</option>
        <option value="target" ${target.nameModeOverride === 'target' ? 'selected' : ''}>${t('name.target')}: ${esc(n.targetNames.join(' / '))}</option>
      </select></label>` : ''}
    ${periodDetail(target)}
  `;
  els.detail.querySelector('[data-node-name]')?.addEventListener('change', (ev) => setNodeName(target, ev.target.value));
  els.detail.querySelector('[data-node-flowchart]')?.addEventListener('click', () => openFlowchart(id));
  bindStatusControl(els.detail, target);

  const inE = (d.inEdges || []).filter(e => !isDataEdge(e));
  const outE = (d.outEdges || []).filter(e => !isDataEdge(e));
  const callsByPeer = new Map();
  for (const edge of state.view.edges) {
    if (isDataEdge(edge) || (edge.from !== id && edge.to !== id)) continue;
    const peer = edge.from === id ? edge.to : edge.from;
    if (!callsByPeer.has(peer)) callsByPeer.set(peer, []);
    callsByPeer.get(peer).push(edge);
  }
  const item = (e, dir) => {
    const other = dir === 'in' ? e.from : e.to;
    const nm = e.callee || other.split('::')[1] || other;
    const inView = inViewIds.has(other);
    let chip = '';
    if (e.kind === 'macro') chip = `<span class="chip macro">${t('edge.chipMacro')}${e.via ? ':' + esc(e.via) : ''}</span>`;
    else if (e.kind === 'fnptr') chip = `<span class="chip fnptr">${t('edge.chipFnptr')}${e.via ? ':' + esc(e.via) : ''}</span>`;
    else if (e.kind === 'manual') chip = `<span class="chip manual">${t('edge.chipManual')}</span>`;
    const cond = e.cond ? `<span class="chip">${esc(e.cond)}</span>` : '';
    const status = e.change && e.change !== 'existing' ? ` · ${statusLabel(e.change)}` : '';
    const arrow = `<span class="rel-dir ${dir}">${dir === 'in' ? '←' : '→'}</span>`;
    const route = visibleCallEdge(e, callsByPeer.get(other) || []);
    const file = dir === 'out' ? n.file : nodeById(other)?.file;
    const location = file && e.line > 0 ? ` title="${esc(file)}:${esc(e.line)}${e.col > 0 ? ':' + esc(e.col) : ''}"` : '';
    return `<div class="edge-item call-relation${inView ? ' in-view' : ''}"${inView ? ` data-peer-id="${esc(other)}" data-rel-dir="${dir}" data-edge-key="${esc(edgeKey(route || e))}" title="${t('common.locateCanvas')}"` : ''}><span>${arrow} <b>${esc(dir === 'in' ? other.split('::').pop() : nm)}</b> <span style="color:#B4B2A9"${location}>:${esc(e.line)}</span>${status} ${chip}${cond}</span>${addFunctionButton(other)}</div>`;
  };

  els.edges.innerHTML =
    (inE.length
      ? `<div class="call-group-heading in">${t('edge.calledBy', { n: inE.length })}</div>` +
        inE.map((e) => item(e, 'in')).join('')
      : '') +
      (outE.length
        ? `<div class="call-group-heading out">${t('edge.calls', { n: outE.length })}</div>` +
          outE.map((e) => item(e, 'out')).join('')
        : '') || `<div class="empty">${t('empty.noEdges')}</div>`;
}

function setHoverRelation(next) {
  const cur = state.hoverRelation;
  if ((cur?.peerId || null) === (next?.peerId || null) &&
      (cur?.dir || null) === (next?.dir || null) &&
      (cur?.edgeKey || null) === (next?.edgeKey || null)) return;
  state.hoverRelation = next;
  draw({ geometryUnchanged: true });
}

for (const panel of [els.edges, els.detail]) {
  if (!panel) continue;
  panel.addEventListener('click', (event) => {
    if (!state.selected) return;
    const ask = event.target.closest('[data-node-ask-ai]');
    if (ask?.dataset.nodeAskAi === state.selected) {
      const node = nodeById(state.selected);
      if (node) askAi(nodeAiDetail(node));
      return;
    }
    if (event.target.closest('button, select, input, a')) return;
    const row = event.target.closest('[data-peer-id].in-view');
    if (row) peekNode(row.dataset.peerId);
  });
  panel.addEventListener('mouseover', (event) => {
    if (!state.selected) { setHoverRelation(null); return; }
    const row = event.target.closest('[data-peer-id].in-view');
    setHoverRelation(row ? { peerId: row.dataset.peerId, dir: row.dataset.relDir || null, edgeKey: row.dataset.edgeKey || null } : null);
  });
  panel.addEventListener('mouseleave', () => setHoverRelation(null));
}
export { loadStats, loadTree, loadVars, renderTree, buildTreeNode, runSearch, renderDetail };
