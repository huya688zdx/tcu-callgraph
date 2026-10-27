/**
 * 侧栏面板：统计 / 文件树 / 搜索结果 / 节点详情
 */
import { t } from '../i18n.js';
import { els, state, esc, shortFile } from './state.js';
import { api } from './api.js';
import { hooks } from './hooks.js';
import { showMenuSections } from './ctxmenu.js';
import { locateNode, locateBox } from './locate.js';
import { analyseDataflow, clearDataflow } from './df.js';
import { findCallOrder } from './call-order.js';
import { showExpansion } from './expand.js';
import { setNodeName } from './node-name.js';
import { statusControl, bindStatusControl, statusLabel } from './change-status.js';
async function loadStats() {
  const d = await api.stats();
  const s = d.stats;
  const row = (label, val) => `<div class="stat-row"><span>${label}</span><span>${val}</span></div>`;
  els.stats.innerHTML = [
    row(t('stat.files'), s.files),
    row(t('stat.functions'), s.functions),
    ...(s.variables ? [row(t('stat.variables'), s.variables)] : []),
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
}

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

/** 当前视图里出现过的文件（变量面板按它过滤） */
function filesInView() {
  const v = state.view;
  const set = new Set();
  if (!v) return set;
  for (const n of v.nodes) {
    if (n.file && n.file !== '<external>') set.add(n.file);
  }
  return set;
}

/** 类型显示：常量已经用 const 标签标了，类型里就不再重复 */
const typeLabel = (x) =>
  String(x.typeText || '')
    .replace(/\bconst\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** 变量面板的筛选词与折叠状态（跨重绘保留） */
let varQuery = '';
const collapsedFiles = new Set();

/**
 * 渲染右侧「全局变量 / 常量」清单
 * 范围跟随当前点选的框：点文件框 → 该文件；点层级框 → 该目录下所有文件；
 * 什么都没点 → 提示先选一个框
 * 变量多时：顶部筛选框 + 文件分组可折叠 + 紧凑单行（类型省略、读写数用 9/7）
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

  const q = varQuery.trim().toLowerCase();
  const list = q
    ? scope.filter(
        (x) =>
          x.name.toLowerCase().includes(q) || String(x.typeText || '').toLowerCase().includes(q)
      )
    : scope;

  const inView = new Set(v.nodes.filter((n) => n.kind === 'var').map((n) => n.id));
  const multiFile = new Set(scope.map((x) => x.file)).size > 1;
  const checkedCount = scope.filter(
    (x) => (state.vars.has(x.id) || inView.has(x.id)) && !state.hiddenVars.has(x.id)
  ).length;

  const parts = [];
  // 顶部：筛选框 + 计数（变量多的时候才出现，少的时候保持简洁）
  if (scope.length > 6) {
    parts.push(`<div class="vars-bar">
      <input id="varFilter" type="search" placeholder="${esc(t('vars.filter'))}" value="${esc(varQuery)}">
      <span class="vars-cnt">${checkedCount}/${scope.length}</span>
    </div>`);
  }

  let lastFile = null;
  for (const x of list) {
    if (multiFile && x.file !== lastFile) {
      const inFile = list.filter((y) => y.file === x.file);
      const selInFile = inFile.filter(
        (y) => (state.vars.has(y.id) || inView.has(y.id)) && !state.hiddenVars.has(y.id)
      ).length;
      const folded = collapsedFiles.has(x.file);
      parts.push(`<div class="var-file" data-file="${esc(x.file)}">
        <span class="tw">${folded ? '\u25b6' : '\u25bc'}</span><span class="fn">${esc(
        shortFile(x.file)
      )}</span><span class="cnt">${selInFile}/${inFile.length}</span>
      </div>`);
      lastFile = x.file;
      if (folded) continue;
    } else if (multiFile && collapsedFiles.has(x.file)) {
      continue;
    }
    const checked = (state.vars.has(x.id) || inView.has(x.id)) && !state.hiddenVars.has(x.id);
    parts.push(`<label class="var-row" data-id="${esc(x.id)}" title="${esc(x.file)}:${x.line} \u00b7 ${esc(
      typeLabel(x)
    )} \u00b7 ${x.writers.length} \u5199 / ${x.readers.length} \u8bfb">
      <input type="checkbox" ${checked ? 'checked' : ''}>
      <span class="vn">${esc(x.name)}</span>
      ${x.isConst ? '<span class="vg">const</span>' : ''}
      <span class="vt">${esc(typeLabel(x))}</span>
      <span class="vc">${x.writers.length}/${x.readers.length}</span>
    </label>`);
  }

  if (!list.length) parts.push(`<div class="empty">${t('vars.noMatch')}</div>`);
  el.innerHTML = parts.join('');

  const filter = el.querySelector('#varFilter');
  if (filter) {
    filter.addEventListener('input', () => {
      varQuery = filter.value;
      renderVars();
      const again = els.vars.querySelector('#varFilter');
      if (again) {
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      }
    });
  }
  el.querySelectorAll('.var-file').forEach((h) => {
    h.addEventListener('click', () => {
      const f = h.dataset.file;
      if (collapsedFiles.has(f)) collapsedFiles.delete(f);
      else collapsedFiles.add(f);
      renderVars();
    });
  });
  el.querySelectorAll('.var-row input').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.closest('.var-row').dataset.id;
      hooks.toggleVar(id, cb.checked);
    });
  });
}

// ---------------- 文件树 ----------------

let treeData = null;
const populateTreeFiles = new Map();

async function loadTree() {
  try {
    treeData = await api.tree();
    renderTree();
  } catch {
    document.getElementById('tree').innerHTML = `<div class="empty">${t('tree.loadFail')}</div>`;
  }
}

function renderTree() {
  const el = document.getElementById('tree');
  if (!el) return;
  el.innerHTML = '';
  populateTreeFiles.clear();
  if (!treeData) return;
  const frag = document.createDocumentFragment();
  // 根节点就是打开的目录本身（名字由服务端给出），
  // 直接铺子节点会让人看不出这些文件属于哪个根目录
  if (treeData.name) {
    frag.appendChild(buildTreeNode(treeData, 0));
  } else {
    for (const child of treeData.children || []) frag.appendChild(buildTreeNode(child, 0));
  }
  el.appendChild(frag);
}

/** 当前勾选的所有函数 id（文件树支持多选） */
function checkedIds() {
  // 尚未展开的文件没有函数行，仍保留它们的勾选，不能把懒加载误当成取消。
  const ids = new Set(state.roots);
  for (const cb of document.querySelectorAll('#tree input[type=checkbox]')) {
    if (cb.checked) ids.add(cb.dataset.id);
    else ids.delete(cb.dataset.id);
  }
  return [...ids];
}

let selectTimer = null;

/** 勾选变化后统一重新加载：多个函数同时作为入口；全不勾则回到默认入口 */
function applyTreeSelection() {
  clearTimeout(selectTimer);
  // 连续勾选时合并成一次请求，避免连点几下就闪几次
  selectTimer = setTimeout(() => {
    const ids = checkedIds();
    hooks.loadView(ids.length ? ids : null, { incremental: !!ids.length });
  }, 120);
}

/** 视图切换后回填勾选状态，保证树和画布一致 */
export function syncTreeSelection(ids) {
  const set = new Set(ids || []);
  document.querySelectorAll('#tree input[type=checkbox]').forEach((c) => {
    c.checked = set.has(c.dataset.id);
  });
}

/** 展开某一行的所有祖先目录（并可选展开它自己） */
function expandRow(row, includeSelf = false) {
  const open = (head) => {
    const kids = head && head.nextElementSibling;
    if (!kids || kids.tagName !== 'DIV') return;
    if (kids.style.display === 'none') kids.style.display = 'block';
    const tw = head.querySelector('.tw');
    if (tw && head.dataset.kids !== '0') tw.textContent = '▾';
  };
  if (includeSelf) open(row);
  let p = row.parentElement;
  while (p && p.id !== 'tree') {
    if (p.style && p.style.display === 'none') {
      p.style.display = 'block';
      const head = p.previousElementSibling;
      const tw = head && head.querySelector('.tw');
      if (tw) tw.textContent = '▾';
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

/** 文件树右键：函数 → 定位到函数；文件 → 定位到文件；目录 → 定位到目录 */
function openTreeMenu(ev, kind, payload) {
  ev.preventDefault();
  ev.stopPropagation();
  const items = [];
  if (kind === 'fn') {
    items.push({ value: 'expand', label: 'expand.menu' });
    items.push({ value: 'dataflow', label: 'menu.dataflow' });
    if (!state.view?.comparison) items.push({ value: 'callOrder', label: 'callOrder.find' });
    items.push({ value: 'locate', label: 'locate.canvasFn' });
    items.push({ value: 'toggle', label: payload.checked ? 'tree.unselect' : 'tree.select' });
  } else if (kind === 'file') {
    items.push({ value: 'locate', label: 'locate.canvasFile' });
  } else {
    items.push({ value: 'locate', label: 'locate.canvasDir' });
  }
  showMenuSections(
    ev.clientX,
    ev.clientY,
    payload.label,
    [{ id: 'locate', label: 'menu.locate', items }],
    (v) => {
      if (v === 'expand') return showExpansion({ id: payload.id, name: payload.label });
      if (v === 'dataflow') return analyseDataflow(payload.id);
      if (v === 'callOrder') return findCallOrder(payload.id);
      if (v === 'locate') {
        if (kind === 'fn') locateNode(payload.id);
        else locateBox(kind === 'file' ? 'file' : 'dir', payload.id, payload.fnIds || []);
      } else if (v === 'toggle') {
        const cb = document.querySelector(`#tree input[data-id="${CSS.escape(payload.id)}"]`);
        if (cb) {
          cb.checked = !cb.checked;
          applyTreeSelection();
        }
      }
    }
  );
}

function buildTreeNode(node, depth) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'tn ' + node.type;
  row.dataset.path = node.path == null ? '' : node.path;
  row.style.paddingLeft = depth * 12 + 'px';

  const hasKids =
    (node.children && node.children.length) || (node.functions && node.functions.length);
  const tw = document.createElement('span');
  tw.className = 'tw';
  tw.textContent = hasKids ? '▸' : '';
  row.appendChild(tw);

  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = node.name;
  nm.title = node.path || node.name;
  row.appendChild(nm);
  wrap.appendChild(row);

  const kids = document.createElement('div');
  const openByDefault = node.type === 'dir';
  kids.style.display = openByDefault ? 'block' : 'none';
  if (openByDefault && hasKids) tw.textContent = '▾';
  if (node.children) for (const c of node.children) kids.appendChild(buildTreeNode(c, depth + 1));
  let populated = false;
  const populateFunctions = () => {
    if (populated) return;
    populated = true;
    const selected = new Set(state.roots);
    for (const f of node.functions || []) {
      const fr = document.createElement('div');
      fr.className = 'tn fn';
      fr.dataset.fnid = f.id;
      fr.style.paddingLeft = (depth + 1) * 12 + 'px';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.id = f.id;
      cb.checked = selected.has(f.id);
      const lab = document.createElement('span');
      lab.className = 'nm';
      lab.textContent = f.name;
      lab.title = `${node.path}:${f.line}`;
      fr.appendChild(cb);
      fr.appendChild(lab);
      fr.addEventListener('contextmenu', (ev) =>
        openTreeMenu(ev, 'fn', { id: f.id, label: f.name, checked: cb.checked })
      );
      kids.appendChild(fr);
    }
  };
  if (node.functions?.length) populateTreeFiles.set(node.path, populateFunctions);
  wrap.appendChild(kids);

  // 文件 / 目录行右键：定位到该文件或该目录
  row.addEventListener('contextmenu', (ev) =>
    openTreeMenu(ev, node.type === 'file' ? 'file' : 'dir', {
      id: node.path,
      label: node.name,
      fnIds: collectFnIds(node),
    })
  );

  row.addEventListener('click', (ev) => {
    if (ev.target.tagName === 'INPUT' || !hasKids) return;
    const open = kids.style.display !== 'none';
    if (!open) populateFunctions();
    kids.style.display = open ? 'none' : 'block';
    tw.textContent = open ? '▸' : '▾';
  });

  // 多选：勾选变化只做汇总，不再互斥
  kids.addEventListener('change', (ev) => {
    if (ev.target.tagName !== 'INPUT') return;
    applyTreeSelection();
  });

  return wrap;
}

let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 140);
});

/** 搜索请求序号：快速输入时只认最后一次，避免慢响应覆盖新结果 */
let searchSeq = 0;

async function runSearch() {
  const my = ++searchSeq;
  const q = els.search.value.trim();
  if (!q) {
    els.results.innerHTML = `<li class="empty">${t('empty.search')}</li>`;
    return;
  }
  const list = await api.search(q);
  if (my !== searchSeq) return; // 已经有更新的搜索，丢弃这次的结果
  if (!list.length) {
    els.results.innerHTML = `<li class="empty">${t('empty.noMatch')}</li>`;
    return;
  }
  els.results.innerHTML = list
    .map(
      (f) => `<li data-id="${esc(f.id)}" title="${esc(t('search.itemHint'))}">
        <div class="fn">${esc(f.name)}</div>
        <div class="meta">${esc(shortFile(f.file))}:${f.line} · ↑${f.inCount} ↓${f.outCount}</div>
      </li>`
    )
    .join('');
}

/**
 * 搜索结果的去向：单击只往画布里加入（已在画布就高亮定位），绝不整幅替换；
 * 想单独看某个函数用双击。单击延迟 250ms 是为了等双击事件，避免先加载两次。
 */
let pickTimer;
function searchPick(id) {
  const inView = state.view && state.view.nodes.some((n) => n.id === id);
  if (inView) return locateNode(id);
  hooks.loadView([...state.roots, id], { incremental: true });
}

els.results.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  clearTimeout(pickTimer);
  pickTimer = setTimeout(() => searchPick(li.dataset.id), 250);
});

els.results.addEventListener('dblclick', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  clearTimeout(pickTimer);
  hooks.loadView(li.dataset.id);
});

els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = els.results.querySelector('li[data-id]');
    if (first) searchPick(first.dataset.id);
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

function comparisonDetail(node) {
  const location = (side) => {
    const values = node.locations?.[side];
    const rows = (Array.isArray(values) ? values : values ? [values] : []).map((v) =>
      `${v.file || ''}${v.line ? `:${v.line}` : ''}`
    ).filter(Boolean);
    return rows.length ? rows.join(' · ') : '—';
  };
  const describe = (value) => {
    const values = Array.isArray(value) ? value : value == null ? [] : [value];
    return values.map((v) => {
      if (typeof v === 'string' || typeof v === 'number') return String(v);
      return v.reason || v.text || v.name || JSON.stringify(v);
    }).map(esc).join(' · ') || '—';
  };
  return `<div class="detail-meta">${t('compare.locationBefore')}: ${esc(location('before'))}</div>
    <div class="detail-meta">${t('compare.locationAfter')}: ${esc(location('after'))}</div>
    ${node.reasons ? `<div class="detail-meta">${t('compare.reasons')}: ${describe(node.reasons)}</div>` : ''}
    ${node.impact ? `<div class="detail-meta">${t('compare.impact')}</div>` : ''}
    ${node.context ? `<div class="detail-meta">${t('compare.context')}</div>` : ''}`;
}

async function renderDetail(id) {
  clearDataflow();
  const my = ++detailSeq;
  const target = id && state.view ? state.view.nodes.find((n) => n.id === id) : null;
  const isFn = !!target && target.kind !== 'var';
  syncDetailSections(isFn);
  if (target?.kind === 'var') {
    if (els.secDetail) els.secDetail.style.display = '';
    if (els.secEdges) els.secEdges.style.display = 'none';
    els.detail.innerHTML = `<div class="detail-title">${esc(target.name)}</div>
      <div class="detail-meta">${esc(target.file || '')}:${target.line || ''}</div>
      ${statusControl(target)}
      ${state.view?.comparison ? comparisonDetail(target) : ''}`;
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
  const n = state.view?.comparison ? { ...d.node, ...target } : d.node;

  // 节点只展示身份信息：标注已经改成「连线标签」，挂在连线上而不是函数上
  els.detail.innerHTML = `
    <div class="detail-title">${esc(target.displayName || n.name)}</div>
    <div class="detail-meta">${esc(n.file)}:${n.line}${n.isStatic ? ' · ' + t('node.static') : ''}${n.external ? ' · ' + t('node.externalTag') : ''}</div>
    ${statusControl(target)}
    ${n.headerSymbol ? `<div class="detail-meta">#define ${esc(n.name)}${Array.isArray(n.macroParams) ? '(' + esc(n.macroParams.join(', ')) + ')' : ''} ${esc(n.raw)}</div>
      <label>${t('name.title')} <select data-node-name ${state.at > 0 || state.view?.comparison ? 'disabled' : ''}>
        <option value="default" ${!target.nameModeOverride ? 'selected' : ''}>${t('name.default')}（${t(target.nameMode === 'target' ? 'name.target' : 'name.alias')}）</option>
        <option value="alias" ${target.nameModeOverride === 'alias' ? 'selected' : ''}>${t('name.alias')}: ${esc(n.name)}</option>
        <option value="target" ${target.nameModeOverride === 'target' ? 'selected' : ''}>${t('name.target')}: ${esc(n.targetNames.join(' / '))}</option>
      </select></label>` : ''}
    ${state.view?.comparison ? comparisonDetail(n) : ''}
    <div class="detail-hint">${t(state.view?.comparison ? 'compare.readOnly' : 'detail.hint')}</div>
  `;
  els.detail.querySelector('[data-node-name]')?.addEventListener('change', (ev) => setNodeName(target, ev.target.value));
  bindStatusControl(els.detail, target);

  const inE = d.inEdges || [];
  const outE = d.outEdges || [];
  const item = (e, dir) => {
    const other = dir === 'in' ? e.from : e.to;
    const nm = e.callee || other.split('::')[1] || other;
    let chip = '';
    if (e.kind === 'macro') chip = `<span class="chip macro">${t('edge.chipMacro')}${e.via ? ':' + esc(e.via) : ''}</span>`;
    else if (e.kind === 'fnptr') chip = `<span class="chip fnptr">${t('edge.chipFnptr')}${e.via ? ':' + esc(e.via) : ''}</span>`;
    else if (e.kind === 'manual') chip = `<span class="chip manual">${t('edge.chipManual')}</span>`;
    const cond = e.cond ? `<span class="chip">${esc(e.cond)}</span>` : '';
    return `<div class="edge-item">${dir === 'in' ? '←' : '→'} <b>${esc(dir === 'in' ? other.split('::').pop() : nm)}</b> <span style="color:#B4B2A9">:${e.line}</span> · ${statusLabel(e.change)} ${chip}${cond}</div>`;
  };

  els.edges.innerHTML =
    (inE.length
      ? `<div style="font-size:11.5px;color:#888780;margin-bottom:4px">${t('edge.calledBy')} (${inE.length})</div>` +
        inE.map((e) => item(e, 'in')).join('')
      : '') +
      (outE.length
        ? `<div style="font-size:11.5px;color:#888780;margin:8px 0 4px">${t('edge.calls')} (${outE.length})</div>` +
          outE.map((e) => item(e, 'out')).join('')
        : '') || `<div class="empty">${t('empty.noEdges')}</div>`;
}
export { loadStats, loadTree, loadVars, renderTree, buildTreeNode, runSearch, renderDetail };
