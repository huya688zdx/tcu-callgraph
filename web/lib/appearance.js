/**
 * 样式设置面板：调整画布 / 连线 / 函数框 / 分组容器的颜色。
 * 单一数据源是 state.js 的 THEME——画布、图例、SVG 导出、离线导出全读它，
 * 改一项立即 draw()，即改即见。持久化在 localStorage（键 cg.theme.v1），
 * 只存「路径 → 颜色」，没配过的项自动落默认值。
 * 模块加载即恢复已存主题（在首次画图之前），并自己接好工具栏入口。
 */
import { THEME, state, applyTheme, setThemeColor } from './state.js';
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

const SECTIONS = [
  {
    title: '函数框与分类',
    items: [
      { path: 'fill.existing', label: '既存底色', kind: 'box' },
      { path: 'fill.modified', label: '变更底色', kind: 'box' },
      { path: 'fill.added', label: '追加底色', kind: 'box' },
      { path: 'fill.deleted', label: '删除底色', kind: 'box' },
      { path: 'node.external', label: '外部符号底色', kind: 'box' },
      { path: 'node.border', label: '函数框描边', kind: 'line' },
      { path: 'node.selected', label: '选中描边', kind: 'line' },
    ],
  },
  {
    title: '连线',
    items: [
      { path: 'edge.call', label: '函数调用', kind: 'line' },
      { path: 'edge.var', label: '变量访问', kind: 'dash' },
      { path: 'edge.added', label: '新增边', kind: 'line' },
      { path: 'edge.modified', label: '修改边', kind: 'line' },
      { path: 'edge.manual', label: '手动连线预览', kind: 'dash' },
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

/** 预览小块与画布表现一一对应：线=细线（虚线项给虚线），底色=圆角小块 */
function swatch(item) {
  const cls = item.kind === 'line' ? 'sw sw-line' : item.kind === 'dash' ? 'sw sw-line dash' : 'sw sw-box';
  return `<i class="${cls}" data-sw="${item.path}"></i>`;
}

function syncSwatches() {
  document.querySelectorAll('#styleBody .sw').forEach((sw) => {
    const c = byPath(sw.dataset.sw) || '#000';
    if (sw.classList.contains('sw-box')) {
      sw.style.background = c;
      sw.style.borderColor = THEME.node.border;
    } else {
      sw.style.borderTopColor = c;
    }
  });
}

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
      ${sec.items
        .map(
          (it) => `
        <label class="style-row">
          <span class="sl">${esc(it.label)}</span>
          ${swatch(it)}
          <input type="color" data-path="${it.path}" value="${byPath(it.path)}">
        </label>`
        )
        .join('')}
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
  syncSwatches();
}

async function resetDefaults() {
  try { await saveMacroNameMode('alias'); }
  catch (err) { document.getElementById('macroNameStatus').textContent = err.message; return; }
  for (const sec of SECTIONS) {
    for (const it of sec.items) {
      const value = it.path.split('.').reduce((o, k) => o?.[k], DEFAULTS);
      if (typeof value === 'string') setThemeColor(it.path, value);
    }
  }
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* 同上，失败不致命 */
  }
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
