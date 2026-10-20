/**
 * 右键菜单：变更分类标记、连线状态、选中
 */
import { t } from '../i18n.js';
import { els, state, edgeKey, esc, CHANGE_FILL, EDGE_COLOR } from './state.js';
import { api } from './api.js';
import { draw } from './render.js';
import { pushHistory } from './history.js';
import { renderDetail } from './panels.js';
import { df, expandDataflow, clearDataflow } from './df.js';
// ---------------- 右键菜单：标记变更分类 / 连线状态 ----------------

const CHANGE_ITEMS = [
  { value: 'existing', label: 'change.existing', color: CHANGE_FILL.existing },
  { value: 'modified', label: 'change.modified', color: CHANGE_FILL.modified },
  { value: 'added', label: 'change.added', color: CHANGE_FILL.added },
  { value: 'deleted', label: 'change.deleted', color: CHANGE_FILL.deleted },
];

const EDGE_ITEMS = [
  { value: 'existing', label: 'edgeState.existing', color: EDGE_COLOR.existing },
  { value: 'added', label: 'edgeState.added', color: EDGE_COLOR.added },
  { value: 'deleted', label: 'edgeState.deleted', color: EDGE_COLOR.existing },
];

function hideMenu() {
  if (!els.ctxMenu) return;
  els.ctxMenu.classList.remove('show');
  els.ctxMenu.innerHTML = '';
}

function showMenu(x, y, title, items, current, onPick) {
  const el = els.ctxMenu;
  if (!el) return;
  el.innerHTML =
    `<div class="title">${title}</div>` +
    items
      .map(
        (it, i) =>
          `<button data-i="${i}" class="${it.value === current ? 'active' : ''}">` +
          `<span class="swatch" style="background:${it.color}"></span>` +
          `<span>${t(it.label)}</span></button>`
      )
      .join('');
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.classList.add('show');

  const r = el.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
  if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;

  el.onclick = (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const it = items[Number(btn.dataset.i)];
    hideMenu();
    if (it) onPick(it.value);
  };
}

/**
 * 分组右键菜单：支持多个分区（数据流 / 变更分类）
 * sections: [{ id, label, items: [{ value, label, color?, active? }] }]
 */
export function showMenuSections(x, y, title, sections, onPick) {
  const el = els.ctxMenu;
  if (!el) return;
  const html = [`<div class="title">${esc(title)}</div>`];
  sections.forEach((sec, si) => {
    if (sec.label) html.push(`<div class="sec-title">${esc(t(sec.label))}</div>`);
    for (let ii = 0; ii < sec.items.length; ii++) {
      const it = sec.items[ii];
      html.push(
        `<button data-s="${si}" data-i="${ii}" class="${it.active ? 'active' : ''}">` +
          (it.color ? `<span class="swatch" style="background:${it.color}"></span>` : '') +
          `<span>${esc(t(it.label))}</span></button>`
      );
    }
  });
  el.innerHTML = html.join('');
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.classList.add('show');

  const r = el.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
  if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;

  el.onclick = (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const sec = sections[Number(btn.dataset.s)];
    const it = sec && sec.items[Number(btn.dataset.i)];
    hideMenu();
    if (it && onPick) onPick(it.value, sec.id);
  };
}

/** 函数节点的右键菜单：数据流分析 + 变更分类 */
export function showNodeMenu(x, y, n) {
  const sections = [
    {
      id: 'df',
      label: 'menu.dataflow',
      items: [
        { value: 'df:out', label: 'df.out', active: df.active && df.root === n.id && df.dir === 'out' },
        { value: 'df:in', label: 'df.in', active: df.active && df.root === n.id && df.dir === 'in' },
        ...(df.active ? [{ value: 'df:clear', label: 'df.clear' }] : []),
      ],
    },
    { id: 'change', label: 'menu.change', items: CHANGE_ITEMS },
  ];
  showMenuSections(x, y, n.name, sections, (v) => {
    if (v === 'df:out') return expandDataflow(n.id, 'out');
    if (v === 'df:in') return expandDataflow(n.id, 'in');
    if (v === 'df:clear') return clearDataflow();
    return setNodeChange(n, v);
  });
}

async function setNodeChange(n, change) {
  n.change = change;
  draw();
  await api.overlay({ nodeId: n.id, data: { change } });
  pushHistory();
}

async function setEdgeChange(edge, change) {
  edge.change = change;
  draw();
  await api.overlay({ edgeKey: edgeKey(edge), data: { change } });
  pushHistory();
}

function selectNode(id) {
  state.selected = id;
  draw();
  renderDetail(id);
}

export {
  CHANGE_ITEMS,
  EDGE_ITEMS,
  hideMenu,
  showMenu,
  selectNode,
  setNodeChange,
  setEdgeChange,
};
