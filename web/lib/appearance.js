/**
 * 样式设置面板：调整画布 / 连线 / 函数框 / 分组容器的颜色与虚实线型。
 * 单一数据源是 state.js 的 THEME——画布、图例、SVG 导出、离线导出全读它，
 * 改一项立即 draw()，即改即见。持久化在 localStorage（键 cg.theme.v1）。
 * 颜色通过应用内小调色板选取（预设色网格 + 自定义入口），不直接弹系统调色盘。
 * 模块加载即恢复已存主题（在首次画图之前），并自己接好工具栏入口。
 */
import { THEME, state, applyTheme, setThemeColor, setThemeFlag, hexToRgba } from './state.js';
import { draw } from './render.js';
import { openModal, esc } from './modal.js';
import { api } from './api.js';
import { hooks } from './hooks.js';

const STORE_KEY = 'cg.theme.v1';
// 默认值快照必须在使用 localStorage 恢复之前取，否则「恢复默认」会恢复成自定义值
const DEFAULTS = structuredClone(THEME);
let macroNameMode = 'alias';
let savingPrefs = false;

function applyMacroNameMode(mode) {
  macroNameMode = mode;
  const view = state.view;
  if (view) {
    view.macroNameMode = mode;
    for (const n of view.nodes) if (n.headerSymbol && !n.nameModeOverride) {
      n.nameMode = mode;
      n.displayName = mode === 'target' ? n.targetNames.join(' / ') : n.name;
    }
  }
}

/** 调色板预设：灰阶 / 暖色 / 冷色 / 画布常用浅色，包含全部默认值，便于一键改回单项 */
const PALETTE = [
  '#FFFFFF', '#FAFAF7', '#F7F6F2', '#EFEDE7', '#D3D1C7', '#C9C6BC',
  '#9A9890', '#2C2C2A', '#D9303E', '#B22531', '#D85A30', '#E69A16',
  '#639922', '#97C459', '#185FA5', '#378ADD', '#6BA3E0', '#7F77DD',
  '#CCFFCC', '#FFFF99', '#FFCCFF', '#BFBFBF', '#FDF0C8', '#E6F1FB',
];

const SEMANTICS = [
  { path: 'fill.existing', label: '既存', detail: '未修改' },
  { path: 'fill.modified', label: '变更', detail: '修改' },
  { path: 'fill.added', label: '追加', detail: '新增' },
  { path: 'fill.deleted', label: '删除' },
];

const SECTIONS = [
  {
    title: '节点',
    items: [
      { path: 'node.border', label: '函数框描边', kind: 'line' },
      { path: 'node.fnDash', label: '函数框线型', kind: 'toggle' },
      { path: 'node.varBorder', label: '变量框描边', kind: 'line' },
      { path: 'node.varDash', label: '变量框线型', kind: 'toggle' },
      { path: 'node.selected', label: '选中描边', kind: 'line' },
      { path: 'node.external', label: '外部符号底色' },
    ],
  },
  {
    title: '连线',
    items: [
      { path: 'edge.call', label: '函数调用', kind: 'line' },
      { path: 'edge.var', label: '数据流', kind: 'dash' },
      { path: 'edge.added', label: '新增连线', kind: 'line' },
      { path: 'edge.manual', label: '手动连线预览', kind: 'dash' },
    ],
  },
  {
    title: '画布与容器',
    items: [
      { path: 'bg', label: '画布背景' },
      { path: 'container.fill', label: '容器底色' },
      { path: 'container.stroke', label: '容器描边', kind: 'line' },
    ],
  },
];

const byPath = (path) => path.split('.').reduce((o, k) => o?.[k], THEME);
const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' ? flatten(v, prefix + k + '.') : [[prefix + k, v]]
  );

const DEFAULT_COLORS = Object.fromEntries(flatten(DEFAULTS).filter(([, value]) => typeof value === 'string'));
const PRESETS = [
  { label: '默认工程风', colors: DEFAULT_COLORS },
  {
    label: '纯白打印风',
    colors: {
      ...DEFAULT_COLORS,
      bg: '#FFFFFF',
      'fill.existing': '#E5F1E8', 'fill.modified': '#FFF1B5',
      'fill.added': '#F4E5FB', 'fill.deleted': '#E3E5E7',
      'node.border': '#252B31', 'node.varBorder': '#252B31',
      'node.external': '#F6F7F8', 'node.externalBorder': '#7C8389',
      'node.selected': '#174975', 'node.hover': '#29628F',
      'edge.call': '#252B31', 'edge.var': '#454D56',
      'edge.added': '#A52A38', 'edge.manual': '#315D40',
      'container.fill': '#E7EDF2', 'container.stroke': '#697784',
    },
  },
  {
    label: '柔和护眼风',
    colors: {
      ...DEFAULT_COLORS,
      bg: '#F7F5EE',
      'fill.existing': '#E4EBDD', 'fill.modified': '#F3E7C9',
      'fill.added': '#EEE2EB', 'fill.deleted': '#E6DED5',
      'node.border': '#6D6556', 'node.varBorder': '#77705F',
      'node.external': '#F5EFE4', 'node.externalBorder': '#A69A87',
      'node.selected': '#476C6D', 'node.hover': '#658A86',
      'edge.call': '#645D50', 'edge.var': '#627260',
      'edge.added': '#9B5752', 'edge.manual': '#61764E',
      'container.fill': '#E8DFC9', 'container.stroke': '#A3967A',
    },
  },
];

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(flatten(THEME))));
  } catch {
    /* 存不进去（隐私模式等）不影响当次会话 */
  }
}

/* ---------- 预览与控件 ---------- */

function colorControl({ path, label, detail, kind = 'box' }) {
  return `<span class="appearance-color">
    <button type="button" data-color="${path}" aria-label="${esc(label)}配色" aria-haspopup="dialog">
      <i class="appearance-swatch ${kind}" aria-hidden="true"></i>
      <span>${esc(label)}${detail ? `<small>${esc(detail)}</small>` : ''}</span>
    </button>
    <input type="color" class="sw-picker" tabindex="-1" data-path="${path}" aria-label="${esc(label)}自定义颜色">
  </span>`;
}

function syncThemeControls(body) {
  body.querySelectorAll('[data-color]').forEach((button) => {
    const color = byPath(button.dataset.color);
    button.style.setProperty('--swatch', color);
    button.nextElementSibling.value = color;
  });
  body.querySelectorAll('[data-flag]').forEach((button) => {
    button.setAttribute('aria-pressed', byPath(button.dataset.flag) === (button.value === 'true'));
  });
  body.querySelectorAll('[data-preset]').forEach((button) => {
    const { colors } = PRESETS[button.dataset.preset];
    const matches = Object.entries(colors).every(([path, color]) => byPath(path).toLowerCase() === color.toLowerCase());
    button.setAttribute('aria-pressed', matches);
  });
  const preview = body.querySelector('.appearance-preview');
  for (const [path, value] of flatten(THEME)) {
    if (typeof value === 'string') preview.style.setProperty('--preview-' + path.replace('.', '-'), value);
  }
  preview.style.setProperty('--preview-container-fill', hexToRgba(THEME.container.fill, 0.32));
  preview.style.setProperty('--preview-fn-line', THEME.node.fnDash ? 'dashed' : 'solid');
  preview.style.setProperty('--preview-var-line', THEME.node.varDash ? 'dashed' : 'solid');
}

function saveTheme(body) {
  syncThemeControls(body);
  persist();
  draw();
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

function openPalette(body, anchor) {
  closePalette();
  const path = anchor.dataset.color;
  const input = anchor.nextElementSibling;
  const current = byPath(path).toLowerCase();
  palEl = document.createElement('div');
  palEl.className = 'pal-pop';
  palEl.setAttribute('role', 'dialog');
  palEl.setAttribute('aria-label', anchor.getAttribute('aria-label'));
  palEl.innerHTML = `
    <div class="pal-grid">
      ${PALETTE.map(
        (c) =>
          `<button type="button" class="pal-chip${c.toLowerCase() === current ? ' cur' : ''}" data-c="${c}" aria-label="${c}" title="${c}" style="background:${c}"></button>`
      ).join('')}
    </div>
    <button type="button" class="pal-custom">自定义颜色…</button>`;
  palEl.addEventListener('click', (e) => e.stopPropagation());
  palEl.querySelectorAll('.pal-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (!setThemeColor(path, chip.dataset.c)) return;
      saveTheme(body);
      closePalette();
      anchor.focus({ preventScroll: true });
    });
  });
  palEl.querySelector('.pal-custom').addEventListener('click', () => {
    closePalette();
    anchor.focus({ preventScroll: true });
    // showPicker 需要用户手势，因此在点击事件中直接调用。
    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
        return;
      }
    } catch {
      // 旧内核回退到原生输入框的点击行为。
    }
    input.click();
  });
  document.body.appendChild(palEl);
  // 定位：预览右侧优先，放不下换左侧；上下贴着预览并收进视口
  const r = anchor.getBoundingClientRect();
  const pw = palEl.offsetWidth;
  const ph = palEl.offsetHeight;
  let left = r.right + 8;
  if (left + pw > window.innerWidth - 8) left = r.left - pw - 8;
  const top = Math.max(8, Math.min(r.top - 6, window.innerHeight - ph - 8));
  palEl.style.left = Math.max(8, left) + 'px';
  palEl.style.top = top + 'px';
  const onDoc = (e) => {
    if (palEl && !palEl.contains(e.target)) closePalette();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // 只关调色板，不把样式弹窗一起关掉
      closePalette();
      anchor.focus({ preventScroll: true });
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
  (palEl.querySelector('.cur') || palEl.querySelector('.pal-chip'))?.focus({ preventScroll: true });
}

/* ---------- 面板渲染 ---------- */

function depthRow(direction, label) {
  const id = direction === 'up' ? 'addDepthUp' : 'addDepthDown';
  return `<div class="appearance-depth">
    <span id="${id}Label">${label}</span>
    <div class="appearance-depth-options">
      <div class="appearance-segment" role="group" aria-labelledby="${id}Label">
        ${[0, 1, 2, 3].map((n) => `<button type="button" data-depth="${direction}" value="${n}">${n}层</button>`).join('')}
      </div>
      <select id="${id}" data-depth="${direction}" aria-label="${label}：更多层数">
        <option value="" disabled hidden>更多层数</option>
        ${Array.from({ length: 17 }, (_, n) => `<option value="${n + 4}">${n + 4}层</option>`).join('')}
      </select>
    </div>
  </div>`;
}

function advancedSection({ title, items }) {
  return `<section>
    <h4>${esc(title)}</h4>
    <div class="appearance-advanced-grid">
      ${items.map((item) => item.kind === 'toggle'
        ? `<div class="appearance-line-type">
            <span id="${item.path}Label">${esc(item.label)}</span>
            <div class="appearance-segment" role="group" aria-labelledby="${item.path}Label">
              <button type="button" data-flag="${item.path}" value="true">虚线框</button>
              <button type="button" data-flag="${item.path}" value="false">实线框</button>
            </div>
          </div>`
        : colorControl(item)).join('')}
    </div>
  </section>`;
}

const PREVIEW = `
  <div class="appearance-preview">
    <div class="appearance-preview-group">
      <div class="appearance-preview-graph">
        <span class="appearance-preview-node existing">既存函数</span>
        <span class="appearance-preview-edge call">调用<i aria-hidden="true"></i></span>
        <span class="appearance-preview-node modified">变更函数</span>
        <span class="appearance-preview-edge data">数据流<i aria-hidden="true"></i></span>
        <span class="appearance-preview-node variable">全局变量</span>
      </div>
    </div>
    <div class="appearance-preview-samples">
      <span class="appearance-preview-node external">外部符号</span>
      <span class="appearance-preview-node added">追加</span>
      <span class="appearance-preview-node deleted">删除</span>
      <span class="appearance-preview-edge new-line"><i aria-hidden="true"></i>新增连线</span>
      <span class="appearance-preview-edge manual"><i aria-hidden="true"></i>手动连线</span>
    </div>
  </div>`;

function installPanelStyle() {
  if (document.getElementById('appearancePanelStyle')) return;
  const style = document.createElement('style');
  style.id = 'appearancePanelStyle';
  style.textContent = `
    #styleModal { width: min(584px, calc(100vw - 24px)); max-height: min(700px, calc(100vh - 28px)); }
    #styleModal .modal-head, #styleModal .modal-foot { padding: 12px 16px; }
    #styleModal .modal-head h2 { font-size: 15px; font-weight: 650; }
    #styleModal .modal-foot { align-items: center; justify-content: space-between; background: #fff; }
    #styleModal .modal-foot .hint { white-space: normal; }
    #styleBody {
      --settings-border: #e0e4e6;
      --settings-muted: #5d6970;
      --settings-accent: #174d76;
      --settings-active: #eaf2fa;
      padding: 0 16px 16px; color: #27343c; background: #f6f7f8; font-size: 13px;
    }
    #styleBody .appearance-tabs {
      display: flex; gap: 18px; position: sticky; top: 0; z-index: 1;
      margin-bottom: 12px; padding-top: 3px; background: #f6f7f8;
      border-bottom: 1px solid var(--settings-border);
    }
    #styleBody .appearance-tabs button {
      height: 37px; padding: 0 5px; color: var(--settings-muted); background: transparent;
      border: 0; border-bottom: 2px solid transparent; border-radius: 0; font: inherit;
    }
    #styleBody .appearance-tabs button[aria-selected="true"] {
      border-bottom-color: var(--settings-accent); color: var(--settings-accent); font-weight: 650;
    }
    #styleBody .appearance-tabs button:hover { color: var(--settings-accent); }
    #styleBody .appearance-panel:not([hidden]) { display: grid; gap: 9px; }
    #styleBody .appearance-card {
      padding: 12px 13px; border: 1px solid var(--settings-border); border-radius: 8px; background: #fff;
    }
    #styleBody h3 { margin: 0 0 8px; color: #27343c; font-size: 13px; font-weight: 650; }
    #styleBody p { margin: -3px 0 8px; color: var(--settings-muted); font-size: 12px; line-height: 1.5; }
    #styleBody .appearance-depth, #styleBody .appearance-line-type {
      display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 10px;
    }
    #styleBody .appearance-depth + .appearance-depth { margin-top: 5px; }
    #styleBody .appearance-depth-options { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
    #styleBody .appearance-segment {
      display: inline-flex; gap: 2px; padding: 2px; border-radius: 6px; background: #f1f3f4;
    }
    #styleBody .appearance-segment button, #styleBody .appearance-depth select {
      height: auto; min-height: 25px; padding: 3px 7px; border: 1px solid transparent;
      color: #47565f; border-radius: 5px; font-family: inherit; font-size: 12px;
    }
    #styleBody .appearance-segment button { background: transparent; }
    #styleBody .appearance-depth select { background: #f1f3f4; }
    #styleBody .appearance-segment button:hover, #styleBody .appearance-depth select:hover { background: #e6ebee; }
    #styleBody .appearance-segment button[aria-pressed="true"], #styleBody .appearance-depth select[data-extended] {
      color: var(--settings-accent); border-color: #adc7df; background: #fff; font-weight: 650;
    }
    #styleBody .appearance-choices { display: grid; grid-template-columns: 1fr 1fr; }
    #styleBody .appearance-choices button { padding: 5px 6px; white-space: normal; }
    #styleBody small { display: block; color: var(--settings-muted); font-size: 11px; font-weight: 400; }
    #styleBody .appearance-choices small { margin-top: 2px; }
    #styleBody :is(button, select):disabled, #styleReset:disabled { cursor: wait; opacity: .65; }
    #styleBody :is(button, select, summary):focus-visible { outline: 2px solid var(--settings-accent); outline-offset: 2px; }
    #appearanceStatus { font-size: 12px; color: var(--settings-muted); }
    #appearanceStatus:not(:empty) { margin-top: 8px; }
    #appearanceStatus.error { color: #a32d2d; }
    #styleBody .appearance-preview {
      padding: 9px; background: var(--preview-bg); border: 1px solid #d5dadd; border-radius: 6px;
      color: #222b30; font-size: 11px;
    }
    #styleBody .appearance-preview-group {
      padding: 13px 11px; background: var(--preview-container-fill);
      border: 1px solid var(--preview-container-stroke); border-radius: 5px;
    }
    #styleBody .appearance-preview-graph {
      display: grid; grid-template-columns: 1fr .7fr 1fr .7fr 1fr; align-items: center; gap: 4px;
    }
    #styleBody .appearance-preview-node {
      display: inline-block; padding: 5px 3px; border: 1px var(--preview-fn-line) var(--preview-node-border);
      border-radius: 4px; text-align: center; line-height: 1.2; background: var(--preview-fill-existing);
    }
    #styleBody .appearance-preview-node.modified {
      background: var(--preview-fill-modified); outline: 1px solid var(--preview-node-selected); outline-offset: 2px;
    }
    #styleBody .appearance-preview-node.variable {
      border-color: var(--preview-node-varBorder); border-style: var(--preview-var-line);
    }
    #styleBody .appearance-preview-node.external {
      background: var(--preview-node-external); border: 1px solid var(--preview-node-externalBorder);
    }
    #styleBody .appearance-preview-node.added { background: var(--preview-fill-added); }
    #styleBody .appearance-preview-node.deleted { background: var(--preview-fill-deleted); }
    #styleBody .appearance-preview-edge { display: grid; gap: 2px; text-align: center; }
    #styleBody .appearance-preview-edge i {
      position: relative; display: block; border-top: 2px solid var(--edge-color);
    }
    #styleBody .appearance-preview-graph .appearance-preview-edge {
      position: relative; height: 100%; align-content: center; padding-bottom: 14px;
    }
    #styleBody .appearance-preview-graph .appearance-preview-edge i {
      position: absolute; top: 50%; left: 0; right: 0;
    }
    #styleBody .appearance-preview-graph .appearance-preview-edge i::after {
      content: ''; position: absolute; right: 0; top: -4px;
      border-style: solid; border-width: 3px 0 3px 5px; border-color: transparent transparent transparent var(--edge-color);
    }
    #styleBody .appearance-preview-edge.call { --edge-color: var(--preview-edge-call); }
    #styleBody .appearance-preview-edge.data { --edge-color: var(--preview-edge-var); }
    #styleBody .appearance-preview-edge.new-line { --edge-color: var(--preview-edge-added); }
    #styleBody .appearance-preview-edge.manual { --edge-color: var(--preview-edge-manual); }
    #styleBody .appearance-preview-edge:is(.data, .manual) i { border-top-style: dashed; }
    #styleBody .appearance-preview-samples {
      display: flex; align-items: center; gap: 5px 9px; flex-wrap: wrap; margin-top: 8px;
    }
    #styleBody .appearance-preview-samples .appearance-preview-node { padding: 2px 4px; }
    #styleBody .appearance-preview-samples .appearance-preview-edge {
      grid-template-columns: 14px auto; align-items: center; gap: 4px;
    }
    #styleBody .appearance-presets, #styleBody .appearance-semantics, #styleBody .appearance-advanced-grid {
      display: grid; gap: 6px; grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    #styleBody .appearance-presets button, #styleBody .appearance-color button {
      display: flex; width: 100%; align-items: center; gap: 6px; justify-content: center; text-align: left;
      min-height: 34px; height: auto; padding: 5px 7px; border: 1px solid var(--settings-border);
      border-radius: 5px; font-family: inherit; font-size: 12px; white-space: normal;
    }
    #styleBody .appearance-presets button:hover, #styleBody .appearance-color button:hover { background: #f1f5f8; }
    #styleBody .appearance-presets button[aria-pressed="true"] { background: var(--settings-active); border-color: #adc7df; }
    #styleBody .appearance-preset-sample {
      display: flex; align-items: center; gap: 2px; padding: 3px; border: 1px solid; border-radius: 3px;
    }
    #styleBody .appearance-preset-sample i { display: block; width: 6px; height: 8px; border-radius: 1px; }
    #styleBody .appearance-semantics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    #styleBody .appearance-semantics button { min-height: 42px; }
    #styleBody .appearance-color { position: relative; min-width: 0; }
    #styleBody .appearance-swatch { display: inline-block; width: 19px; flex-shrink: 0; }
    #styleBody .appearance-swatch.box {
      height: 18px; border-radius: 3px; background: var(--swatch); box-shadow: inset 0 0 0 1px #0003;
    }
    #styleBody .appearance-swatch.line { border-top: 2px solid var(--swatch); }
    #styleBody .appearance-swatch.dash { border-top: 2px dashed var(--swatch); }
    #styleBody .sw-picker {
      position: absolute; inset: auto auto 0 0; width: 1px; height: 1px;
      opacity: 0; pointer-events: none; border: 0; padding: 0;
    }
    #styleBody .appearance-advanced summary { cursor: pointer; font-weight: 600; }
    #styleBody .appearance-advanced section { margin-top: 10px; border-top: 1px solid var(--settings-border); padding-top: 8px; }
    #styleBody .appearance-advanced h4 { margin: 0 0 5px; font-size: 12px; font-weight: 600; color: var(--settings-muted); }
    #styleBody .appearance-advanced-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    #styleBody .appearance-advanced-grid button[data-color] { justify-content: flex-start; min-height: 31px; }
    #styleBody .appearance-line-type { font-size: 12px; padding: 0 4px 0 7px; }
    @media (max-width: 430px) {
      #styleBody { padding-right: 10px; padding-left: 10px; }
      #styleBody .appearance-card { padding-right: 9px; padding-left: 9px; }
      #styleBody .appearance-preview-group { padding: 10px 5px; }
      #styleBody .appearance-presets button { flex-direction: column; }
      #styleBody .appearance-semantics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      #styleBody .appearance-advanced-grid { grid-template-columns: 1fr; }
    }`;
  document.head.appendChild(style);
}

const resetButton = document.getElementById('styleReset');

function syncPrefControls(body) {
  body.querySelectorAll('[data-depth]').forEach((control) => {
    const depth = state.addDepths[control.dataset.depth];
    if (control.tagName === 'SELECT') {
      control.value = depth > 3 ? String(depth) : '';
      control.toggleAttribute('data-extended', depth > 3);
    } else {
      control.setAttribute('aria-pressed', Number(control.value) === depth);
    }
    control.disabled = savingPrefs;
  });
  body.querySelectorAll('[data-macro-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', button.value === macroNameMode);
    button.disabled = savingPrefs;
  });
  if (resetButton) resetButton.disabled = savingPrefs;
}

async function savePreferences(body, prefs, reset = false) {
  if (savingPrefs) return;
  const status = body.querySelector('#appearanceStatus');
  const focused = document.activeElement;
  savingPrefs = true;
  status.textContent = '正在保存…';
  status.classList.remove('error');
  syncPrefControls(body);
  try {
    const result = await api.setUiPrefs(prefs);
    if (!result?.ok) throw new Error(result?.error || '保存失败，请重试');
    if (prefs.up !== undefined) state.addDepths = { up: prefs.up, down: prefs.down };
    if (prefs.macroNameMode) applyMacroNameMode(prefs.macroNameMode);
    if (reset) {
      applyTheme(DEFAULTS);
      try { localStorage.removeItem(STORE_KEY); } catch { /* 存储不可用时仍应用当前主题 */ }
      closePalette();
      syncThemeControls(body);
    }
    if (reset || (prefs.macroNameMode && state.view)) draw();
    if (prefs.macroNameMode && state.view && state.selected) hooks.renderDetail(state.selected);
    status.textContent = reset ? '已恢复默认设置' : '已保存';
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('error');
  } finally {
    savingPrefs = false;
    syncPrefControls(body);
    if (document.activeElement === document.body && focused?.closest('#styleModal.show')) {
      focused.focus({ preventScroll: true });
    }
  }
}

function selectTab(body, id) {
  closePalette();
  body.querySelectorAll('[role="tab"]').forEach((tab) => {
    const selected = tab.id === id;
    tab.setAttribute('aria-selected', selected);
    tab.tabIndex = selected ? 0 : -1;
    body.querySelector('#' + tab.getAttribute('aria-controls')).hidden = !selected;
  });
  body.scrollTop = 0;
}

function render(body) {
  installPanelStyle();
  body.innerHTML = `
    <div class="appearance-tabs" role="tablist" aria-label="显示与样式设置">
      <button type="button" role="tab" id="appearanceGeneralTab" aria-controls="appearanceGeneral">通用与行为</button>
      <button type="button" role="tab" id="appearanceCanvasTab" aria-controls="appearanceCanvas">画布配色与线型</button>
    </div>
    <div id="appearanceGeneral" class="appearance-panel" role="tabpanel" aria-labelledby="appearanceGeneralTab">
      <section class="appearance-card">
        <h3>添加关系默认展开深度</h3>
        <p>用于“挑选调用关系”预览时的默认初始层数。</p>
        ${depthRow('up', '↑ 向上查调用方')}
        ${depthRow('down', '↓ 向下查被调函数')}
      </section>
      <section class="appearance-card">
        <h3 id="appearanceMacroTitle">宏函数节点显示名称</h3>
        <div class="appearance-segment appearance-choices" role="group" aria-labelledby="appearanceMacroTitle">
          <button type="button" data-macro-mode value="alias">显示宏别名<small>例如 #define 名称</small></button>
          <button type="button" data-macro-mode value="target">显示实际函数名<small>展开后的目标函数</small></button>
        </div>
      </section>
      <section class="appearance-card">
        <h3 id="appearanceMotionTitle">连线选中动效</h3>
        <div class="appearance-segment appearance-choices" role="group" aria-labelledby="appearanceMotionTitle">
          <button type="button" data-flag="edge.selPulse" value="true">流动脉冲动画<small>沿调用方向流动</small></button>
          <button type="button" data-flag="edge.selPulse" value="false">静态高亮<small>低占用、无动画</small></button>
        </div>
      </section>
    </div>
    <div id="appearanceCanvas" class="appearance-panel" role="tabpanel" aria-labelledby="appearanceCanvasTab" hidden>
      <section class="appearance-card">
        <h3>画布预览</h3>
        ${PREVIEW}
      </section>
      <section class="appearance-card">
        <h3>配色预设</h3>
        <div class="appearance-presets">
          ${PRESETS.map(({ label, colors }, index) => `
            <button type="button" data-preset="${index}">
              <span class="appearance-preset-sample" aria-hidden="true" style="background:${colors.bg};border-color:${colors['node.border']}">
                <i style="background:${colors['fill.existing']}"></i>
                <i style="background:${colors['fill.modified']}"></i>
                <i style="background:${colors['fill.added']}"></i>
              </span>${label}
            </button>`).join('')}
        </div>
      </section>
      <section class="appearance-card">
        <h3>变更状态配色</h3>
        <div class="appearance-semantics">${SEMANTICS.map(colorControl).join('')}</div>
      </section>
      <details class="appearance-card appearance-advanced">
        <summary>高级：边框线型、连线与容器配色</summary>
        ${SECTIONS.map(advancedSection).join('')}
      </details>
    </div>
    <div id="appearanceStatus" role="status"></div>`;

  const tabs = [...body.querySelectorAll('[role="tab"]')];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(body, tab.id));
    tab.addEventListener('keydown', (event) => {
      const next = { ArrowLeft: tabs.length - 1, ArrowRight: 1, Home: -index, End: tabs.length - 1 - index }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const target = tabs[(index + next) % tabs.length];
      selectTab(body, target.id);
      target.focus();
    });
  });
  body.querySelectorAll('[data-depth]').forEach((control) => {
    const event = control.tagName === 'SELECT' ? 'change' : 'click';
    control.addEventListener(event, () => {
      const direction = control.dataset.depth;
      const value = Number(control.value);
      if (value !== state.addDepths[direction]) savePreferences(body, { ...state.addDepths, [direction]: value });
    });
  });
  body.querySelectorAll('[data-macro-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.value !== macroNameMode) savePreferences(body, { macroNameMode: button.value });
    });
  });
  body.querySelectorAll('[data-color]').forEach((button) => {
    button.addEventListener('click', () => openPalette(body, button));
  });
  body.querySelectorAll('input[type=color]').forEach((input) => {
    input.addEventListener('input', () => {
      if (setThemeColor(input.dataset.path, input.value)) saveTheme(body);
    });
  });
  body.querySelectorAll('[data-flag]').forEach((button) => {
    button.addEventListener('click', () => {
      if (setThemeFlag(button.dataset.flag, button.value === 'true')) saveTheme(body);
    });
  });
  body.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      applyTheme(PRESETS[button.dataset.preset].colors);
      saveTheme(body);
    });
  });
}

const body = document.getElementById('styleBody');
const btn = document.getElementById('styleBtn');
btn?.addEventListener('click', async () => {
  if (!body) return;
  if (!savingPrefs) {
    btn.disabled = true;
    try {
      const prefs = await api.uiPrefs();
      macroNameMode = prefs.macroNameMode === 'target' ? 'target' : 'alias';
      if (Number.isInteger(prefs.up) && Number.isInteger(prefs.down)) state.addDepths = { up: prefs.up, down: prefs.down };
    } catch {
      macroNameMode = state.view?.macroNameMode || macroNameMode;
    } finally {
      btn.disabled = false;
    }
  }
  if (!body.querySelector('.appearance-tabs')) render(body);
  selectTab(body, 'appearanceGeneralTab');
  body.querySelector('.appearance-advanced').open = false;
  if (!savingPrefs) body.querySelector('#appearanceStatus').textContent = '';
  syncPrefControls(body);
  syncThemeControls(body);
  openModal('styleModal');
});
resetButton?.addEventListener('click', () => {
  if (body?.querySelector('#appearanceStatus')) savePreferences(body, { up: 1, down: 1, macroNameMode: 'alias' }, true);
});

// 启动恢复：在首次画图之前把已存颜色写回 THEME
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  if (saved && typeof saved === 'object') applyTheme(saved);
} catch {
  /* 坏数据当没配过 */
}
