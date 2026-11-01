/**
 * 右键菜单渲染原语（纯 DOM，不依赖任何业务模块）
 * 拆出来是为了让文件树、画布、节点菜单都能用，又不产生循环依赖
 */
import { t } from '../i18n.js';
import { els, esc } from './state.js';
let menuAnchor = null;

export function hideMenu() {
  if (!els.ctxMenu) return;
  menuAnchor?.setAttribute('aria-expanded', 'false');
  menuAnchor = null;
  els.ctxMenu.classList.remove('show');
  els.ctxMenu.innerHTML = '';
}

function place(el, x, y, anchor = null) {
  menuAnchor = anchor;
  menuAnchor?.setAttribute('aria-expanded', 'true');
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.classList.add('show');
  const r = el.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
  if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;
}

/** 单层菜单（带色块，用于变更分类这类互斥选项） */
export function showMenu(x, y, title, items, current, onPick) {
  const el = els.ctxMenu;
  if (!el) return;
  el.innerHTML =
    `<div class="title">${esc(title)}</div>` +
    items
      .map(
        (it, i) =>
          `<button data-i="${i}" class="${it.value === current ? 'active' : ''}">` +
          (it.color ? `<span class="swatch" style="background:${it.color}"></span>` : '') +
          `<span>${esc(t(it.label))}</span></button>`
      )
      .join('');
  place(el, x, y);
  el.onclick = (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const it = items[Number(btn.dataset.i)];
    hideMenu();
    if (it) onPick(it.value);
  };
}

/**
 * 分组菜单：sections = [{ id, label, items: [{ value, label, color?, active? }] }]
 */
export function showMenuSections(x, y, title, sections, onPick, anchor = null) {
  const el = els.ctxMenu;
  if (!el) return;
  hideMenu();
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
  place(el, x, y, anchor);
  el.onclick = (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const sec = sections[Number(btn.dataset.s)];
    const it = sec && sec.items[Number(btn.dataset.i)];
    hideMenu();
    if (it && onPick) onPick(it.value, sec.id);
  };
}

document.addEventListener('pointerdown', (event) => {
  if (!els.ctxMenu?.contains(event.target) && !menuAnchor?.contains(event.target)) hideMenu();
}, true);
document.addEventListener('focusin', (event) => {
  if (!els.ctxMenu?.contains(event.target) && !menuAnchor?.contains(event.target)) hideMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && els.ctxMenu?.classList.contains('show')) {
    event.preventDefault();
    event.stopPropagation();
    hideMenu();
  }
}, true);
document.addEventListener('scroll', hideMenu, true);
window.addEventListener('resize', hideMenu);
