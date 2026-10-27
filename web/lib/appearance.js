/**
 * 样式设置面板：调整画布 / 连线 / 函数框 / 分组容器的颜色与虚实线型。
 * 单一数据源是 state.js 的 THEME——画布、图例、SVG 导出、离线导出全读它，
 * 改一项立即 draw()，即改即见。持久化在 localStorage（键 cg.theme.v1）。
 * 颜色通过应用内小调色板选取（预设色网格 + 自定义入口），不直接弹系统调色盘。
 * 模块加载即恢复已存主题（在首次画图之前），并自己接好工具栏入口。
 */
import { THEME, state, applyTheme, setThemeColor, setThemeFlag } from './state.js';
import { draw } from './render.js';
import { openModal, esc } from './modal.js';
import { api } from './api.js';
import { hooks } from './hooks.js';

const STORE_KEY = 'cg.theme.v1';
// 默认值快照必须在使用 localStorage 恢复之前取，否则「恢复默认」会恢复成自定义值
const DEFAULTS = structuredClone(THEME);
let macroNameMode = 'alias';

async function saveMacroNameMode(mode) {
  const result = await api.setUiPrefs({ macroNameMode: mode });
  if (!result?.ok) throw new Error(result?.error || '保存失败，请重试');
  macroNameMode = mode;
  const view = state.view;
  if (view) {
    view.macroNameMode = mode;
    for (const n of view.nodes) if (n.headerSymbol && !n.nameModeOverride) {
      n.nameMode = mode;
      n.displayName = mode === 'target' ? n.targetNames.join(' / ') : n.name;
    }
    draw();
    if (state.selected) hooks.renderDetail(state.selected);
  }
}

/** 调色板预设：灰阶 / 暖色 / 冷色 / 画布常用浅色，包含全部默认值，便于一键改回单项 */
const PALETTE = [
  '#FFFFFF', '#FAFAF7', '#F7F6F2', '#EFEDE7', '#D3D1C7', '#C9C6BC',
  '#9A9890', '#2C2C2A', '#D9303E', '#B22531', '#D85A30', '#E69A16',
  '#639922', '#97C459', '#185FA5', '#378ADD', '#6BA3E0', '#7F77DD',
  '#CCFFCC', '#FFFF99', '#FFCCFF', '#BFBFBF', '#FDF0C8', '#E6F1FB',
];

const SECTIONS = [
  {
    title: '函数框 / 变量框与分类',
    items: [
      { path: 'fill.existing', label: '既存底色', kind: 'box' },
      { path: 'fill.modified', label: '变更底色', kind: 'box' },
      { path: 'fill.added', label: '追加底色', kind: 'box' },
      { path: 'fill.deleted', label: '删除底色', kind: 'box' },
      { path: 'node.external', label: '外部符号底色', kind: 'box' },
      { path: 'node.border', label: '函数框描边', kind: 'line' },
      { path: 'node.varBorder', label: '变量框描边', kind: 'line' },
      { path: 'node.fnDash', label: '函数框线型', kind: 'toggle', icon: 'box', onLabel: '虚线', offLabel: '实线' },
      { path: 'node.varDash', label: '变量框线型', kind: 'toggle', icon: 'box', onLabel: '虚线', offLabel: '实线' },
      { path: 'node.selected', label: '选中描边', kind: 'line' },
    ],
  },
  {
    title: '连线',
    items: [
      { path: 'edge.call', label: '函数调用', kind: 'line' },
      { path: 'edge.callDash', label: '函数调用线型', kind: 'toggle', icon: 'line', onLabel: '虚线', offLabel: '实线' },
      { path: 'edge.var', label: '变量访问', kind: 'dash' },
      { path: 'edge.varDash', label: '变量访问线型', kind: 'toggle', icon: 'line', onLabel: '虚线', offLabel: '实线' },
      { path: 'edge.added', label: '新增边', kind: 'line' },
      { path: 'edge.modified', label: '修改边', kind: 'line' },
      { path: 'edge.manual', label: '手动连线预览', kind: 'dash' },
      { path: 'edge.selPulse', label: '选中线动画', kind: 'toggle', icon: 'line', onLabel: '开', offLabel: '关' },
    ],
  },
  {
    title: '画布与分组容器',
    items: [
      { path: 'bg', label: '画布背景', kind: 'box' },
      { path: 'container.fill', label: '容器底色', kind: 'box' },
      { path: 'container.stroke', label: '容器描边', kind: 'line' },
    ],
  },
];

const byPath = (path) => path.split('.').reduce((o, k) => o?.[k], THEME);
const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' ? flatten(v, prefix + k + '.') : [[prefix + k, v]]
  );

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(flatten(THEME))));
  } catch {
    /* 存不进去（隐私模式等）不影响当次会话 */
  }
}

/* ---------- 预览与控件 ---------- */

/** 线型图标：开关按钮里直接画出实线/虚线（框类画成小圆角矩形） */
const LINE_ICON = (dash) =>
  `<svg viewBox="0 0 20 8" width="20" height="8" aria-hidden="true"><line x1="1.5" y1="4" x2="18.5" y2="4" stroke="currentColor" stroke-width="2" stroke-linecap="round"${dash ? ' stroke-dasharray="4 3"' : ''}/></svg>`;
const BOX_ICON = (dash) =>
  `<svg viewBox="0 0 18 12" width="18" height="12" aria-hidden="true"><rect x="1" y="1.5" width="16" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"${dash ? ' stroke-dasharray="3 2"' : ''}/></svg>`;

function swatch(item) {
  if (item.kind === 'toggle') {
    const v = byPath(item.path);
    const icon = item.icon === 'box' ? BOX_ICON : LINE_ICON;
    return `<span class="seg" data-path="${item.path}">
      <button type="button" data-v="true" title="${esc(item.onLabel)}" class="${v ? 'on' : ''}">${icon(true)}</button>
      <button type="button" data-v="false" title="${esc(item.offLabel)}" class="${v ? '' : 'on'}">${icon(false)}</button>
    </span>`;
  }
  const picker = `<input type="color" class="sw-picker" data-path="${item.path}" value="${byPath(item.path)}" aria-label="${esc(item.label)}">`;
  if (item.kind === 'line' || item.kind === 'dash') {
    const dash = item.kind === 'dash' ? ' stroke-dasharray="6 3"' : '';
    return `<span class="sw-wrap" title="点击选择颜色"><svg class="sw" data-sw="${item.path}" viewBox="0 0 30 8" preserveAspectRatio="none"><line x1="1.5" y1="4" x2="28.5" y2="4" stroke-width="2.5" stroke-linecap="round"${dash}/></svg>${picker}</span>`;
  }
  return `<span class="sw-wrap" title="点击选择颜色"><i class="sw sw-box" data-sw="${item.path}"></i>${picker}</span>`;
}

function syncSwatches() {
  document.querySelectorAll('#styleBody .sw').forEach((sw) => {
    const c = byPath(sw.dataset.sw) || '#000';
    if (sw.classList.contains('sw-box')) {
      sw.style.background = c;
    } else {
      sw.querySelector('line')?.setAttribute('stroke', c);
    }
  });
}

/* ---------- 应用内调色板 ---------- */

let palEl = null;
let palCleanup = null;

function closePalette() {
  palCleanup?.();
  palEl?.remove();
  palEl = null;
  palCleanup = null;
}

function openPalette(item, anchor) {
  closePalette();
  const input = anchor.querySelector('.sw-picker');
  const current = (byPath(item.path) || '').toLowerCase();
  palEl = document.createElement('div');
  palEl.className = 'pal-pop';
  palEl.innerHTML = `
    <div class="pal-grid">
      ${PALETTE.map(
        (c) =>
          `<button type="button" class="pal-chip${c.toLowerCase() === current ? ' cur' : ''}" data-c="${c}" title="${c}" style="background:${c}"></button>`
      ).join('')}
    </div>
    <button type="button" class="pal-custom">自定义颜色…</button>`;
  palEl.addEventListener('click', (e) => e.stopPropagation());
  palEl.querySelectorAll('.pal-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (!setThemeColor(item.path, chip.dataset.c)) return;
      if (input) input.value = chip.dataset.c;
      syncSwatches(); // input.value 赋值不触发 input 事件，面板色样要手动刷
      persist();
      draw();
      closePalette();
    });
  });
  palEl.querySelector('.pal-custom').addEventListener('click', () => {
    closePalette();
    // 新版 Chromium 禁止用 click() 程序化拉起取色器，必须走 showPicker()；
    // showPicker 需要用户手势（这里在 click 回调里，满足），老内核没有该 API 再回退 click()。
    // 回退的合成 click 会冒泡到 .sw-wrap 拦截器被 preventDefault 掉，先给 input 挂一次性
    // stopPropagation 放行（label 文字点击的转发仍照常拦截，不会绕过应用内调色板）
    const openNative = () => {
      if (!input) return;
      input.addEventListener('click', (e) => e.stopPropagation(), { once: true });
      input.click();
    };
    if (input && typeof input.showPicker === 'function') {
      try {
        input.showPicker();
      } catch {
        openNative();
      }
    } else {
      openNative();
    }
  });
  document.body.appendChild(palEl);
  // 定位：预览右侧优先，放不下换左侧；上下贴着预览并收进视口
  const r = anchor.getBoundingClientRect();
  const pw = palEl.offsetWidth;
  const ph = palEl.offsetHeight;
  let left = r.right + 8;
  if (left + pw > window.innerWidth - 8) left = r.left - pw - 8;
  let top = Math.min(Math.max(8, r.top - 6), window.innerHeight - ph - 8);
  palEl.style.left = left + 'px';
  palEl.style.top = top + 'px';
  const onDoc = (e) => {
    if (palEl && !palEl.contains(e.target)) closePalette();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // 只关调色板，不把样式弹窗一起关掉
      closePalette();
    }
  };
  const onScroll = () => closePalette();
  document.addEventListener('click', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', onScroll, true);
  palCleanup = () => {
    document.removeEventListener('click', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', onScroll, true);
  };
}

/* ---------- 面板渲染 ---------- */

const findItem = (path) => SECTIONS.flatMap((s) => s.items).find((it) => it.path === path);

function render() {
  const body = document.getElementById('styleBody');
  if (!body) return;
  body.innerHTML = `<div class="style-sec">
    <h3>宏节点显示</h3>
    <label class="style-row"><span class="sl">默认显示名称</span>
      <select id="macroNameDefault">
        <option value="alias" ${macroNameMode === 'alias' ? 'selected' : ''}>左侧：宏名</option>
        <option value="target" ${macroNameMode === 'target' ? 'selected' : ''}>右侧：实际函数名</option>
      </select>
    </label>
    <p class="hint">跨工程保存，立即应用于跟随设置的节点。单个节点可通过右键或右侧详情单独选择。</p>
    <span id="macroNameStatus" role="status"></span>
  </div>` + SECTIONS.map(
    (sec) => `
    <div class="style-sec">
      <h3>${esc(sec.title)}</h3>
      <div class="style-rows">
        ${sec.items
          .map((it) => {
            // 开关行用 div：label 会把对文字的点击转发给第一个按钮，造成误切
            const tag = it.kind === 'toggle' ? 'div' : 'label';
            return `
          <${tag} class="style-row">
            <span class="sl">${esc(it.label)}</span>
            ${swatch(it)}
          </${tag}>`;
          })
          .join('')}
      </div>
    </div>`
  ).join('');
  const nameSelect = body.querySelector('#macroNameDefault');
  nameSelect.addEventListener('change', async () => {
    nameSelect.disabled = true;
    const status = body.querySelector('#macroNameStatus');
    status.textContent = '正在保存…';
    try { await saveMacroNameMode(nameSelect.value); status.textContent = '已保存'; }
    catch (err) { nameSelect.value = macroNameMode; status.textContent = err.message; }
    finally { nameSelect.disabled = false; }
  });
  body.querySelectorAll('input[type=color]').forEach((input) => {
    input.addEventListener('input', () => {
      if (!setThemeColor(input.dataset.path, input.value)) return;
      syncSwatches();
      persist();
      draw();
    });
  });
  body.querySelectorAll('.seg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const seg = btn.closest('.seg');
      if (!setThemeFlag(seg.dataset.path, btn.dataset.v === 'true')) return;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
      persist();
      draw();
    });
  });
  body.querySelectorAll('.sw-wrap').forEach((wrap) => {
    wrap.addEventListener('click', (e) => {
      // 拦下 label 对隐藏 input 的默认转发，改弹应用内调色板
      e.preventDefault();
      const path = wrap.querySelector('.sw-picker')?.dataset.path;
      const item = path && findItem(path);
      if (item) openPalette(item, wrap);
    });
  });
  syncSwatches();
}

async function resetDefaults() {
  try { await saveMacroNameMode('alias'); }
  catch (err) { document.getElementById('macroNameStatus').textContent = err.message; return; }
  applyTheme(Object.fromEntries(flatten(DEFAULTS)));
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* 同上，失败不致命 */
  }
  closePalette();
  render();
  draw();
}

const btn = document.getElementById('styleBtn');
btn?.addEventListener('click', async () => {
  try {
    const prefs = await api.uiPrefs();
    macroNameMode = prefs.macroNameMode === 'target' ? 'target' : 'alias';
  } catch { macroNameMode = state.view?.macroNameMode || 'alias'; }
  render();
  openModal('styleModal');
});
document.getElementById('styleReset')?.addEventListener('click', resetDefaults);

// 启动恢复：在首次画图之前把已存颜色写回 THEME
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  if (saved && typeof saved === 'object') applyTheme(saved);
} catch {
  /* 坏数据当没配过 */
}
