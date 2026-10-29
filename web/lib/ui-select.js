/** 所有下拉共用一个浮层，原 select 仍负责保存值和触发 change。 */
const controls = new WeakMap();
const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const pop = document.createElement('div');
pop.className = 'fsel-pop';
pop.setAttribute('role', 'listbox');
document.body.append(pop);
let active = null;
let highlighted = -1;

function sync(sel) {
  const control = controls.get(sel);
  if (!control) return;
  control.label.textContent = sel.options[sel.selectedIndex]?.textContent ?? '';
  control.button.disabled = sel.disabled;
  if (active === sel && sel.disabled) close();
}

function close() {
  if (!active) return;
  const { wrap, button } = controls.get(active);
  wrap.classList.remove('open');
  button.setAttribute('aria-expanded', 'false');
  pop.style.display = 'none';
  active = null;
}

function position() {
  if (!active || !active.isConnected) { close(); return; }
  const rect = controls.get(active).button.getBoundingClientRect();
  pop.style.minWidth = `${rect.width}px`;
  pop.style.maxHeight = `${Math.max(80, window.innerHeight - 12)}px`;
  pop.style.left = '0px';
  pop.style.top = '0px';
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  pop.style.left = `${Math.max(6, Math.min(rect.left, window.innerWidth - width - 6))}px`;
  pop.style.top = `${Math.max(6, rect.bottom + 6 + height <= window.innerHeight ? rect.bottom + 6 : rect.top - height - 6)}px`;
}

function highlight(index) {
  highlighted = index;
  [...pop.children].forEach((item, i) => item.classList.toggle('focus', i === index));
  pop.children[index]?.scrollIntoView({ block: 'nearest' });
}

function choose(index) {
  const sel = active;
  const opt = sel?.options[index];
  if (!opt || opt.disabled || opt.parentElement.disabled) return;
  const changed = sel.selectedIndex !== index;
  sel.selectedIndex = index;
  sync(sel);
  close();
  if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
  controls.get(sel).button.focus();
}

function open(sel) {
  if (sel.disabled) return;
  close();
  active = sel;
  const { wrap, button } = controls.get(sel);
  pop.replaceChildren();
  for (const opt of sel.options) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'option');
    item.textContent = opt.textContent;
    item.disabled = opt.disabled || opt.parentElement.disabled;
    item.classList.toggle('on', opt.selected);
    item.setAttribute('aria-selected', String(opt.selected));
    pop.append(item);
  }
  wrap.classList.add('open');
  button.setAttribute('aria-expanded', 'true');
  pop.style.display = 'block';
  position();
  highlight(sel.selectedIndex);
}

function upgrade(sel) {
  if (controls.has(sel)) return;
  const wrap = document.createElement('span');
  wrap.className = 'fsel';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fsel-btn';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  if (sel.getAttribute('aria-label')) button.setAttribute('aria-label', sel.getAttribute('aria-label'));
  const label = document.createElement('span');
  button.append(label);
  sel.replaceWith(wrap);
  wrap.append(button, sel);
  controls.set(sel, { wrap, button, label });
  Object.defineProperty(sel, 'value', {
    get() { return nativeValue.get.call(this); },
    set(value) { nativeValue.set.call(this, value); sync(this); },
  });
  sel.addEventListener('change', () => sync(sel));
  button.addEventListener('click', () => active === sel ? close() : open(sel));
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'Escape') { if (active === sel) { event.preventDefault(); event.stopPropagation(); close(); } return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (active !== sel) { open(sel); return; }
    if (event.key === 'Enter' || event.key === ' ') { choose(highlighted); return; }
    const options = [...sel.options];
    const enabled = options.map((opt, i) => !opt.disabled && !opt.parentElement.disabled ? i : -1).filter((i) => i >= 0);
    if (!enabled.length) return;
    const current = enabled.indexOf(highlighted);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : event.key === 'ArrowDown' ? Math.min(current + 1, enabled.length - 1) : Math.max(current - 1, 0);
    highlight(enabled[next]);
  });
  sync(sel);
}

pop.addEventListener('click', (event) => {
  const item = event.target.closest('button');
  if (item && active) choose([...pop.children].indexOf(item));
});
document.addEventListener('click', (event) => {
  if (active && !controls.get(active).wrap.contains(event.target) && !pop.contains(event.target)) close();
}, true);
document.addEventListener('scroll', position, true);
window.addEventListener('resize', position);

function scan(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (node.matches('select')) upgrade(node);
  node.querySelectorAll('select').forEach(upgrade);
}
document.querySelectorAll('select').forEach(upgrade);
new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === 'childList') record.addedNodes.forEach(scan);
    const sel = record.target.nodeType === Node.ELEMENT_NODE ? record.target.closest('select') : record.target.parentElement?.closest('select');
    if (sel) sync(sel);
  }
  if (active && !active.isConnected) close();
}).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true, attributeFilter: ['disabled', 'selected', 'label'] });
