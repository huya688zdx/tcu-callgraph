/**
 * 把原生 <select> 升级成自定义下拉。
 * 原生 select 的展开列表是系统绘制的，套不上主题样式（圆角/投影/悬停），也没有过渡动画。
 * 升级后原 select 仍是唯一数据源：value 读写、option、change 事件全部照旧，
 * 外部代码（含程序里直接写 select.value 的书签恢复）不需要任何改动。
 */

// 所有已升级实例，用于「点外面收起」和「同时只开一个」
const instances = [];

export function upgradeSelect(sel) {
  const wrap = document.createElement('div');
  wrap.className = 'fsel';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fsel-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  if (sel.getAttribute('aria-label')) btn.setAttribute('aria-label', sel.getAttribute('aria-label'));
  const labelSpan = document.createElement('span');
  btn.append(labelSpan);

  const pop = document.createElement('div');
  pop.className = 'fsel-pop';
  pop.setAttribute('role', 'listbox');

  sel.replaceWith(wrap);
  wrap.append(btn, pop, sel);

  function buildItems() {
    // 每次展开都重建：option 文字可能被 i18n 改过
    pop.textContent = '';
    for (const opt of sel.options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.textContent = opt.textContent;
      item.dataset.value = opt.value;
      item.classList.toggle('on', opt.selected);
      item.addEventListener('click', () => {
        sel.value = opt.value;
        syncLabel();
        close();
        sel.dispatchEvent(new Event('change'));
        btn.focus();
      });
      pop.append(item);
    }
  }

  function syncLabel() {
    labelSpan.textContent = sel.options[sel.selectedIndex]?.textContent ?? '';
    buildItems(); // 关着的时候也重建一次，保证 aria/选中态不错位
  }

  function open() {
    for (const other of instances) other.close();
    buildItems();
    wrap.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  }

  function close() {
    wrap.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', (e) => {
    // 拦下冒泡，否则 document 上的「点外面收起」会立刻把它又关掉
    e.stopPropagation();
    wrap.classList.contains('open') ? close() : open();
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  // 程序里绕过 UI 直接写 select.value（书签恢复）时，同步按钮文字
  const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', {
    get: () => native.get.call(sel),
    set(v) {
      native.set.call(sel, v);
      syncLabel();
    },
  });

  syncLabel();
  const api = { close };
  instances.push(api);
  return api;
}
