/**
 * 侧栏面板：统计 / 文件树 / 搜索结果 / 节点详情
 */
import { t } from '../i18n.js';
import { els, state, nodeById, esc, shortFile } from './state.js';
import { api } from './api.js';
import { draw } from './render.js';
import { pushHistory } from './history.js';
import { hooks } from './hooks.js';
import { showMenuSections } from './ctxmenu.js';
import { locateNode, locateBox } from './locate.js';
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
      ? '<div class="stat-row" style="color:#993C1D"><span>提示</span><span>文件较多，首次解析稍慢</span></div>'
      : '');

  // 有删除记录时才让「恢复删除」可点，并在按钮上显示数量
  const del = d.deleted || { nodes: 0, edges: 0 };
  const delTotal = (del.nodes || 0) + (del.edges || 0);
  if (els.restoreDeleted) {
    els.restoreDeleted.disabled = delTotal === 0;
    els.restoreDeleted.textContent = delTotal
      ? `${t('btn.restoreDeleted')} (${delTotal})`
      : t('btn.restoreDeleted');
  }
}

// ---------------- 文件树 ----------------

let treeData = null;

async function loadTree() {
  try {
    treeData = await api.tree();
    renderTree();
  } catch {
    document.getElementById('tree').innerHTML = '<div class="empty">加载失败</div>';
  }
}

function renderTree() {
  const el = document.getElementById('tree');
  if (!el) return;
  el.innerHTML = '';
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
  return [...document.querySelectorAll('#tree input[type=checkbox]')]
    .filter((c) => c.checked)
    .map((c) => c.dataset.id);
}

let selectTimer = null;

/** 勾选变化后统一重新加载：多个函数同时作为入口；全不勾则回到默认入口 */
function applyTreeSelection() {
  clearTimeout(selectTimer);
  // 连续勾选时合并成一次请求，避免连点几下就闪几次
  selectTimer = setTimeout(() => {
    const ids = checkedIds();
    hooks.loadView(ids.length ? ids : null);
  }, 120);
}

/** 视图切换后回填勾选状态，保证树和画布一致 */
export function syncTreeSelection(ids) {
  const set = new Set(ids || []);
  document.querySelectorAll('#tree input[type=checkbox]').forEach((c) => {
    c.checked = set.has(c.dataset.id);
  });
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
    items.push({ value: 'locate', label: 'locate.fn' });
    items.push({ value: 'toggle', label: payload.checked ? 'tree.unselect' : 'tree.select' });
  } else if (kind === 'file') {
    items.push({ value: 'locate', label: 'locate.file' });
  } else {
    items.push({ value: 'locate', label: 'locate.dir' });
  }
  showMenuSections(
    ev.clientX,
    ev.clientY,
    payload.label,
    [{ id: 'locate', label: 'menu.locate', items }],
    (v) => {
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
  if (node.functions) {
    for (const f of node.functions) {
      const fr = document.createElement('div');
      fr.className = 'tn fn';
      fr.style.paddingLeft = (depth + 1) * 12 + 'px';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.id = f.id;
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
  }
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

async function runSearch() {
  const q = els.search.value.trim();
  if (!q) {
    els.results.innerHTML = `<li class="empty">${t('empty.search')}</li>`;
    return;
  }
  const list = await api.search(q);
  if (!list.length) {
    els.results.innerHTML = `<li class="empty">${t('empty.noMatch')}</li>`;
    return;
  }
  els.results.innerHTML = list
    .map(
      (f) => `<li data-id="${esc(f.id)}">
        <div class="fn">${esc(f.name)}</div>
        <div class="meta">${esc(shortFile(f.file))}:${f.line} · ↑${f.inCount} ↓${f.outCount}</div>
      </li>`
    )
    .join('');
}

els.results.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  hooks.loadView(li.dataset.id);
});

els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = els.results.querySelector('li[data-id]');
    if (first) hooks.loadView(first.dataset.id);
  }
});

async function renderDetail(id) {
  if (!id) {
    els.detail.innerHTML = `<div class="empty">${t('empty.detail')}</div>`;
    els.edges.innerHTML = `<div class="empty">${t('empty.edges')}</div>`;
    return;
  }
  const d = await api.node(id);
  if (d.error) return;
  const n = d.node;
  const ov = d.overlay || {};
  const colorList = ['', '#FCEBEB', '#FAEEDA', '#EAF3DE', '#E6F1FB', '#EEEDFE', '#FBEAF0'];

  els.detail.innerHTML = `
    <div class="detail-title">${esc(n.name)}</div>
    <div class="detail-meta">${esc(n.file)}:${n.line}${n.isStatic ? ' · ' + t('node.static') : ''}${n.external ? ' · ' + t('node.externalTag') : ''}</div>
    <div class="field">
      <label>${t('detail.note')}</label>
      <textarea id="note" rows="3" placeholder="${t('detail.notePlaceholder')}">${esc(ov.note || '')}</textarea>
    </div>
    <div class="field">
      <label>${t('detail.color')}</label>
      <div class="swatches" id="swatches">
        ${colorList
          .map(
            (c) =>
              `<div class="sw ${(ov.color || '') === c ? 'on' : ''}" data-color="${c}" style="background:${c || '#fff'};border-color:${c ? 'transparent' : '#D3D1C7'}"></div>`
          )
          .join('')}
      </div>
    </div>
    <div class="field">
      <label>${t('detail.tag')}</label>
      <input id="tag" type="text" placeholder="${t('detail.tagPlaceholder')}" value="${esc(ov.tag || '')}">
    </div>
    <button class="primary" id="saveNote" style="width:100%">${t('detail.save')}</button>
  `;

  let pickedColor = ov.color || '';
  els.detail.querySelector('#swatches').addEventListener('click', (e) => {
    const sw = e.target.closest('.sw');
    if (!sw) return;
    pickedColor = sw.dataset.color;
    els.detail.querySelectorAll('.sw').forEach((s) => s.classList.toggle('on', s === sw));
  });

  els.detail.querySelector('#saveNote').addEventListener('click', async () => {
    const note = els.detail.querySelector('#note').value;
    const tag = els.detail.querySelector('#tag').value;
    await api.overlay({ nodeId: id, data: { note, tag, color: pickedColor } });
    const target = nodeById(id);
    if (target) {
      target.note = note;
      target.tag = tag;
      target.color = pickedColor;
    }
    draw();
    pushHistory();
    const btn = els.detail.querySelector('#saveNote');
    btn.textContent = t('detail.saved');
    setTimeout(() => (btn.textContent = t('detail.save')), 1200);
  });

  const inE = d.inEdges || [];
  const outE = d.outEdges || [];
  const item = (e, dir) => {
    const other = dir === 'in' ? e.from : e.to;
    const nm = e.callee || other.split('::')[1] || other;
    let chip = '';
    if (e.kind === 'macro') chip = `<span class="chip macro">宏${e.via ? ':' + esc(e.via) : ''}</span>`;
    else if (e.kind === 'fnptr') chip = `<span class="chip fnptr">指针${e.via ? ':' + esc(e.via) : ''}</span>`;
    else if (e.kind === 'manual') chip = `<span class="chip manual">手动</span>`;
    const cond = e.cond ? `<span class="chip">${esc(e.cond)}</span>` : '';
    return `<div class="edge-item">${dir === 'in' ? '←' : '→'} <b>${esc(dir === 'in' ? other.split('::').pop() : nm)}</b> <span style="color:#B4B2A9">:${e.line}</span> ${chip}${cond}</div>`;
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
export { loadStats, loadTree, renderTree, buildTreeNode, runSearch, renderDetail };
