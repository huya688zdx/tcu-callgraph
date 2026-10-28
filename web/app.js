/**
 * 入口：视图加载、删除、工具栏与快捷键、启动
 * 具体职责已拆到 lib/ 下的模块
 */
import { applyI18n, t } from './i18n.js';
import { els, state, cam, deleteStack, edgeKey } from './lib/state.js';
import { api } from './lib/api.js';
import { hooks } from './lib/hooks.js';
import { fit, revealAdded, stopCamAnim, constrainCam } from './lib/camera.js';
import { draw, resize, pulseAdded } from './lib/render.js';
import { history, pushHistory, undo, redo } from './lib/history.js';
import { loadStats, loadTree, resetVars, renderVars, renderDetail, syncTreeSelection } from './lib/panels.js';
import { renderLabelPanel, deleteSelectedLabel } from './lib/label-panel.js';
import { buildSVG } from './lib/svg.js';
import { buildPNG, saveExport } from './lib/export.js';
import { buildStandaloneHtml } from './lib/html.js';
import { upgradeSelect } from './lib/ui-select.js';
// 样式设置面板：恢复已存主题并接好「样式」按钮，纯副作用导入
import './lib/appearance.js';
// 交互模块在加载时注册画布事件，没有导出给入口使用，纯副作用导入
import './lib/interact.js';
import { clearDataflow } from './lib/df.js';
// 工程切换与时间轴面板同样自带事件注册
import './lib/projects.js';
import './lib/timeline.js';
import './lib/bookmarks.js';
import './lib/ai-settings.js';
// AI 改动实时同步：SSE 监听 + 页面视图状态上报（cg_page 的数据源）
import { restorePage, savePage } from './lib/live.js';
import { syncComparison } from './lib/compare.js';

/**
 * 加载视图
 * @param {string|string[]|null} rootId 单个函数 id、多个函数 id（文件树多选）、或 null（默认入口）
 */
let viewSeq = 0;

/** 视图跳转历史（双击下钻 / 树里勾选 / 搜索结果），Ctrl+Z 逐级回退 */
const navStack = [];
const NAV_MAX = 30;

function syncViewDepths(up, down) {
  for (const [select, value, key] of [[els.updepth, up, 'depth.upN'], [els.depth, down, 'depth.downN']]) {
    if (![...select.options].some((option) => option.value === String(value))) {
      select.add(new Option(t(key).replace('{n}', value), String(value)));
    }
    select.value = String(value);
  }
}

async function loadView(rootId, opts = {}) {
  const { nav = true, incremental = false } = opts;
  const previous = incremental && !state.at && state.view?.nodes?.length ? state.view : null;
  stopCamAnim();
  // 请求成功后才记录跳转；聚焦查找失败时保留原画布和范围。
  const prior = nav && state.view && state.roots.length ? {
    roots: [...state.roots], expansions: structuredClone(state.expansions), cam: { ...cam },
    up: state.up, down: state.down, vars: [...state.vars], hiddenVars: [...state.hiddenVars],
  } : null;
  const seq = ++viewSeq;
  clearDataflow(); // 换视图时关闭旧的查询结果
  const roots = (Array.isArray(rootId) ? rootId : rootId ? [rootId] : []).filter(Boolean);
  const expansions = opts.expansions ?? (incremental || !nav ? state.expansions : []);
  const up = opts.exact ? 0 : opts.up ?? state.up;
  const down = opts.exact ? 0 : opts.down ?? state.down;
  const vars = opts.vars ?? [...state.vars];
  const hiddenVars = opts.hiddenVars ?? [...state.hiddenVars];
  const data = await api.view({
    roots,
    expansions,
    up,
    down,
    group: state.group,
    vars,
    hiddenVars,
    at: state.at,
    previous,
  });
  if (seq !== viewSeq) return; // 多选连点时丢弃过期响应
  if (!Array.isArray(data?.nodes) || !Array.isArray(data?.edges)) {
    console.warn(data?.error || '读取视图失败，保留当前画面');
    return;
  }
  if (prior) {
    navStack.push(prior);
    if (navStack.length > NAV_MAX) navStack.shift();
  }
  state.up = up; state.down = down;
  state.vars = new Set(vars); state.hiddenVars = new Set(hiddenVars);
  syncViewDepths(up, down);
  state.view = data;
  state.expansions = data.expansions || [];
  syncComparison(data.comparison);
  state.root = data.root;
  state.roots = roots.length ? roots : data.roots || (data.root ? [data.root] : []);
  state.selected = null;
  state.selectedEdge = null;
  state.selectedLabel = null;
  const rootNode = data.nodes.find((n) => n.id === data.root);
  els.rootName.textContent = rootNode
    ? `· ${rootNode.name}${state.roots.length > 1 ? ` +${state.roots.length - 1}` : ''}`
    : '';
  els.rootName.title = els.rootName.textContent;
  syncTreeSelection(state.roots);
  renderVars();
  if (!previous) fit();
  const oldNodes = new Map((previous?.nodes || []).map((n) => [n.id, n]));
  const oldEdges = new Set((previous?.edges || []).map(edgeKey));
  const common = data.nodes.filter((n) => oldNodes.has(n.id));
  // ELK 扩展层间通道可能整体平移文件框，用共同节点的中位偏移稳住屏幕位置。
  if (common.length) for (const axis of ['x', 'y']) {
    const shifts = common.map((n) => oldNodes.get(n.id)[axis] - n[axis]).sort((a, b) => a - b);
    cam[axis] += shifts[Math.floor(shifts.length / 2)] * cam.k;
  }
  const addedNodes = previous ? data.nodes.filter((n) => !oldNodes.has(n.id)) : [];
  constrainCam();
  const addedEdges = previous ? data.edges.filter((e) => !oldEdges.has(edgeKey(e))) : [];
  pulseAdded(addedNodes, addedEdges);
  if (previous) revealAdded(addedNodes, addedEdges);
  renderDetail(null);
  renderLabelPanel();
  history.stack = [];
  history.idx = -1;
  pushHistory();
  // 查找完成时立即保存范围，避免紧接着刷新还读到定时上报前的旧入口。
  await savePage(true).catch((error) => console.warn('保存视图范围失败：', error));
  return seq === viewSeq ? data : undefined;
}

// 面板与交互模块通过钩子回调入口，避免循环依赖
hooks.loadView = loadView;
hooks.expandFunction = async (root, direction, depth, { append = false } = {}) => {
  if (!['up', 'down'].includes(direction) || !Number.isInteger(depth) || depth < 1 || depth > 20) {
    throw new Error('请选择方向及 1 到 20 的整数层数');
  }
  if (!append) {
    // 只从选中函数沿一个方向查找；旧入口和局部范围不再把上层旁支带回来。
    return loadView(root, { up: direction === 'up' ? depth : 0, down: direction === 'down' ? depth : 0,
      expansions: [], vars: [], hiddenVars: [] });
  }
  const expansions = structuredClone(state.expansions);
  let scope = expansions.find((e) => e.root === root);
  if (!scope) { scope = { root, up: 0, down: 0 }; expansions.push(scope); }
  scope[direction] = Math.max(scope[direction], depth);
  return loadView(state.roots, { incremental: true, expansions });
};
hooks.renderDetail = renderDetail;
hooks.syncComparison = syncComparison;
// live.js 收到 AI 改动推送后用它刷新画面（保留视角）；函数声明有提升，这里可以先引用
hooks.reloadKeepCam = reloadKeepCam;
let comparisonPage = null;
hooks.applyComparison = async (roots) => {
  if (!comparisonPage) comparisonPage = {
    view: structuredClone(state.view), roots: [...state.roots], expansions: structuredClone(state.expansions),
    vars: [...state.vars], hiddenVars: [...state.hiddenVars], up: state.up, down: state.down,
    cam: { ...cam }, nav: [...navStack], deleted: [...deleteStack],
  };
  state.at = 0;
  state.expansions = [];
  state.vars = new Set(roots.filter((id) => id.startsWith('var::')));
  state.hiddenVars.clear();
  navStack.length = 0;
  await loadView(roots, { nav: false, incremental: true, exact: true, expansions: [] });
  if (!state.view?.comparison) throw new Error('比较结果已准备，画布加载失败，请重试');
  // 比较视图固定零层展开（原层数已存进 comparisonPage）：只把 exact 用在首次请求的话，
  // 之后每次 reloadKeepCam 都会按原层数展开全部保留+选中的根，把未选中的调用者/被调用者拉回图里
  state.up = 0; state.down = 0;
  els.depth.value = '0'; els.updepth.value = '0';
  resetVars();
  await Promise.all([loadStats(), loadTree()]);
};
hooks.restoreComparison = async () => {
  if (!comparisonPage) return hooks.reloadAll();
  const saved = comparisonPage;
  comparisonPage = null;
  state.view = saved.view;
  state.roots = saved.roots;
  state.expansions = saved.expansions;
  state.vars = new Set(saved.vars);
  state.hiddenVars = new Set(saved.hiddenVars);
  state.up = saved.up; state.down = saved.down;
  els.depth.value = String(saved.down); els.updepth.value = String(saved.up);
  Object.assign(cam, saved.cam);
  navStack.splice(0, navStack.length, ...saved.nav);
  deleteStack.splice(0, deleteStack.length, ...saved.deleted);
  resetVars();
  await loadView(saved.roots, { nav: false, incremental: true, expansions: saved.expansions });
  await Promise.all([loadStats(), loadTree()]);
};

/** 应用书签：把保存的视图参数写回 state 和工具栏控件，再重新加载 */
hooks.applyBookmark = async (b) => {
  state.at = 0;
  state.up = Number.isInteger(b.up) ? b.up : 1;
  state.down = Number.isInteger(b.down) ? b.down : 1;
  state.group = !!b.group;
  state.vars = new Set(b.vars || []);
  state.hiddenVars.clear();

  els.depth.value = String(state.down);
  els.updepth.value = String(state.up);
  els.groupMode.checked = state.group;

  const roots = (b.roots || []).filter(Boolean);
  await loadView(roots.length ? roots : null, { expansions: b.expansions || [] });
};

/** 换工程后整体重载：解析结果、文件树、变量清单、视图全变了 */
hooks.reloadAll = async () => {
  comparisonPage = null;
  const seq = ++viewSeq;
  state.view = null;
  state.selected = null;
  state.selectedEdge = null;
  state.selectedLabel = null;
  state.roots = [];
  state.expansions = [];
  state.root = null;
  state.at = 0;
  state.vars.clear();
  state.hiddenVars.clear();
  state.ctxBox = null;
  resetVars();
  navStack.length = 0;
  deleteStack.length = 0;
  await loadStats();
  await loadTree();
  await restorePage(null, () => seq === viewSeq);
};

// 右侧变量清单：勾选后重新拉视图（变量节点由服务端排版，保证落在文件框里）
hooks.toggleVar = (id, on) => {
  if (on) {
    state.vars.add(id);
    state.hiddenVars.delete(id);
  } else {
    state.vars.delete(id);
    state.hiddenVars.add(id);
  }
  reloadKeepCam();
};

async function postDelete(body) {
  await api.del(body);
}

/** 回退到上一个视图（入口 + 视角一起还原） */
async function navigateBack() {
  const prev = navStack.at(-1);
  if (!prev) return false;
  const view = await loadView(prev.roots.length ? prev.roots : null, { nav: false, expansions: prev.expansions || [],
    up: prev.up, down: prev.down, vars: prev.vars, hiddenVars: prev.hiddenVars });
  if (!view) return false;
  navStack.pop();
  cam.x = prev.cam.x;
  cam.y = prev.cam.y;
  cam.k = prev.cam.k;
  constrainCam();
  draw();
  return true;
}

/** 重新拉取视图但保留当前视角，避免删除后画面突然跳走 */
async function reloadKeepCam() {
  await loadView(state.roots.length ? state.roots : state.root, { nav: false, incremental: true });
}

async function deleteSelection() {
  const v = state.view;
  if (!v || v.comparison) return;
  // 选中标签时 Delete 只删标签，不删整条连线
  if (state.selectedLabel && (await deleteSelectedLabel())) return;
  let body = null;

  if (state.selectedEdge) {
    body = { edges: [edgeKey(state.selectedEdge)] };
  } else if (state.selected) {
    body = { nodes: [state.selected] };
  } else {
    return;
  }

  // 删掉的正是当前入口时，把它从入口集合里摘掉；全删空则回退到自动选择
  if (body.nodes && body.nodes.length) {
    const rest = state.roots.filter((id) => !body.nodes.includes(id));
    if (rest.length !== state.roots.length) {
      state.roots = rest;
      state.root = rest[0] || null;
    }
  }

  await postDelete(body);
  // 记下删除时所在的入口集合：换视图后不能拿这条记录去恢复（见 canRestoreDelete）
  deleteStack.push({ ...body, roots: state.roots.join('+'), at: Date.now() });
  if (deleteStack.length > 30) deleteStack.shift();

  state.selected = null;
  state.selectedEdge = null;
  state.selectedLabel = null;
  state.hover = null;
  await reloadKeepCam();
  renderDetail(null);
  renderLabelPanel();
  pushHistory();
  loadStats();
}

async function restoreLastDelete() {
  const rec = deleteStack.pop();
  if (!rec) return false;
  await postDelete({ nodes: rec.nodes || [], edges: rec.edges || [], restore: true });
  await reloadKeepCam();
  pushHistory();
  loadStats();
  return true;
}

/**
 * 栈顶删除记录是否还能在当前视图里恢复。
 * 删除记录是跨视图共享的（切视图不清栈），所以必须校验入口集合一致，
 * 否则在 A 视图删了东西、下钻到 B 视图按 Ctrl+Z，会把 A 的删除恢复进 B。
 */
function canRestoreDelete() {
  const rec = deleteStack[deleteStack.length - 1];
  if (!rec) return false;
  if (rec.roots !== state.roots.join('+')) return false;
  return Date.now() - rec.at < 20000;
}

window.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal.show')) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (state.view?.comparison) { navigateBack(); return; }
    if (e.shiftKey) {
      redo();
    } else if (canRestoreDelete()) {
      // 优先恢复刚删掉的函数 / 连线（20 秒内有效，可逐次回退）
      restoreLastDelete();
    } else if (history.idx > 0) {
      undo();
    } else if (navStack.length) {
      // 当前视图内已无可撤销的操作，退回上一次跳转（双击下钻 / 勾选函数）
      navigateBack();
    } else {
      undo();
    }
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selected || state.selectedEdge || state.selectedLabel) {
      e.preventDefault();
      deleteSelection();
    }
  }
});

window.addEventListener('keydown', (e) => {
  if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
  if (e.key === 'f' || e.key === 'F') fit();
});

// 范围下拉换成自定义样式（原 select 展开列表是系统绘制，无法定制）；change 仍派发在原 select 上
upgradeSelect(els.depth);
upgradeSelect(els.updepth);

// 范围是界面习惯：记到服务端 setting 表，重启后从 /api/ui-prefs 恢复（见启动段）
const saveUiPrefs = () => api.setUiPrefs({ down: state.down, up: state.up }).catch(() => {});

els.depth.addEventListener('change', () => {
  state.down = Number(els.depth.value);
  saveUiPrefs();
  loadView(state.roots.length ? state.roots : state.root, { incremental: true });
});
els.updepth.addEventListener('change', () => {
  state.up = Number(els.updepth.value);
  saveUiPrefs();
  loadView(state.roots.length ? state.roots : state.root, { incremental: true });
});

els.groupMode.addEventListener('change', () => {
  state.group = els.groupMode.checked;
  state.selectedEdge = null;
  loadView(state.roots.length ? state.roots : state.root, { expansions: state.expansions });
});
els.resetLayout.addEventListener('click', () => {
  loadView(state.roots.length ? state.roots : state.root, { expansions: state.expansions });
});

// 顶栏菜单一次只展开一个；选完、点击外部或按 Escape 即收起。
const toolMenus = [...document.querySelectorAll('header .tool-menu')];
document.addEventListener('click', (event) => {
  for (const menu of toolMenus) {
    if (!menu.contains(event.target) || event.target.closest('button')) menu.open = false;
  }
});
for (const menu of toolMenus) {
  menu.querySelector('summary').addEventListener('click', () => {
    for (const other of toolMenus) if (other !== menu) other.open = false;
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const menu of toolMenus) {
    if (!menu.open) continue;
    menu.open = false;
    menu.querySelector('summary').focus();
  }
});

// 三种导出共用命名和保存入口，原生 GUI 按工程记忆目录。
for (const [id, extension, build] of [
  ['exportSvg', 'svg', () => new Blob([buildSVG()], { type: 'image/svg+xml' })],
  ['exportPng', 'png', buildPNG],
  ['exportHtml', 'html', async () => new Blob([await buildStandaloneHtml()], { type: 'text/html; charset=utf-8' })],
]) {
  document.getElementById(id).addEventListener('click', async (event) => {
    if (!state.view) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await saveExport(extension, await build());
    } catch (error) {
      alert('导出失败：' + error.message);
    } finally {
      button.disabled = false;
    }
  });
}

document.getElementById('exportXlsx').addEventListener('click', () => {
  window.location.href = '/api/export/xlsx';
});

// ---------------- 启动 ----------------

applyI18n();
window.addEventListener('resize', () => { constrainCam(); resize(); });
resize();
const initialPanels = Promise.all([loadStats(), loadTree()]);
// 先恢复上次记住的范围再拉首屏：loadView 用 state.down/up 决定展开多少层。
// 拿不到（老服务端 / 网络失败）就落在 HTML 里的默认 1 / 1。
(async () => {
  const seq = viewSeq;
  try {
    const p = await api.uiPrefs();
    if (seq === viewSeq && Number.isInteger(p?.down)) {
      state.down = p.down;
      els.depth.value = String(p.down);
    }
    if (seq === viewSeq && Number.isInteger(p?.up)) {
      state.up = p.up;
      els.updepth.value = String(p.up);
    }
  } catch {
    /* 服务端没有该接口或暂时不可达：用默认值 */
  }
  await initialPanels;
  await restorePage(new URLSearchParams(location.search).get('root'), () => seq === viewSeq);
})();

// 只读调试接口：供自动化测试读取当前视图状态（不提供任何写操作）
window.__cg = {
  get view() {
    return state.view;
  },
  get cam() {
    return { x: cam.x, y: cam.y, k: cam.k };
  },
  get root() {
    return state.root;
  },
  /** 时间轴回看位置：0 = 看当前状态，>0 = 正在看该事件之后的历史 */
  get at() {
    return state.at;
  },
  /** 当前高亮的框 id（点击标题后短暂存在） */
  get flash() {
    return state.flash ? state.flash.box.id : null;
  },
  /** 当前选中项 */
  get selected() {
    return {
      node: state.selected,
      edge: state.selectedEdge ? edgeKey(state.selectedEdge) : null,
      label: state.selectedLabel,
    };
  },
  /** 连线标签：位置由画布算出，测试用它检查避让与「贴线」约束（一线可多条） */
  labels() {
    const v = state.view;
    if (!v) return [];
    const out = [];
    for (const e of v.edges) {
      const labels = e.labels || [];
      const rects = new Map((e._lbs || []).map((x) => [x.id, x.rect]));
      labels.forEach((l) =>
        out.push({
          edge: edgeKey(e),
          id: l.id,
          text: l.text,
          preset: l.preset,
          num: l.num ?? null,
          note: l.note || null,
          border: l.border,
          color: l.color,
          rect: rects.get(l.id) ? { ...rects.get(l.id) } : null,
        })
      );
    }
    return out;
  },
  /** 当前视图内是否存在节点互相重叠 */
  overlaps(pad = 0) {
    const v = state.view;
    if (!v) return [];
    const hits = [];
    for (let i = 0; i < v.nodes.length; i++) {
      for (let j = i + 1; j < v.nodes.length; j++) {
        const a = v.nodes[i];
        const b = v.nodes[j];
        if (
          a.x < b.x + b.w + pad &&
          a.x + a.w + pad > b.x &&
          a.y < b.y + b.h + pad &&
          a.y + a.h + pad > b.y
        ) {
          hits.push([a.id, b.id]);
        }
      }
    }
    return hits;
  },
};
