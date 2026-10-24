/**
 * 入口：视图加载、删除、工具栏与快捷键、启动
 * 具体职责已拆到 lib/ 下的模块
 */
import { applyI18n } from './i18n.js';
import { els, state, cam, deleteStack, edgeKey } from './lib/state.js';
import { api } from './lib/api.js';
import { hooks } from './lib/hooks.js';
import { fit } from './lib/camera.js';
import { draw, resize } from './lib/render.js';
import { history, pushHistory, undo, redo } from './lib/history.js';
import { loadStats, loadTree, loadVars, renderVars, renderDetail, syncTreeSelection } from './lib/panels.js';
import { renderLabelPanel, deleteSelectedLabel } from './lib/label-panel.js';
import { buildSVG, download } from './lib/svg.js';
// 交互模块在加载时注册画布事件，没有导出给入口使用，纯副作用导入
import './lib/interact.js';
import { clearDataflow } from './lib/df.js';
// 工程切换与时间轴面板同样自带事件注册
import './lib/projects.js';
import './lib/timeline.js';
import './lib/bookmarks.js';
import './lib/ai-settings.js';
// AI 改动实时同步：SSE 监听 + 页面视图状态上报（cg_page 的数据源）
import './lib/live.js';

/**
 * 加载视图
 * @param {string|string[]|null} rootId 单个函数 id、多个函数 id（文件树多选）、或 null（默认入口）
 */
let viewSeq = 0;

/** 视图跳转历史（双击下钻 / 树里勾选 / 搜索结果），Ctrl+Z 逐级回退 */
const navStack = [];
const NAV_MAX = 30;

async function loadView(rootId, opts = {}) {
  const { nav = true } = opts;
  // 记录跳转前的入口与视角，供 Ctrl+Z 回退
  if (nav && state.view && state.roots.length) {
    navStack.push({ roots: [...state.roots], cam: { x: cam.x, y: cam.y, k: cam.k } });
    if (navStack.length > NAV_MAX) navStack.shift();
  }
  const seq = ++viewSeq;
  clearDataflow(); // 换视图时关闭旧的查询结果
  const roots = (Array.isArray(rootId) ? rootId : rootId ? [rootId] : []).filter(Boolean);
  const data = await api.view({
    roots,
    up: state.up,
    down: state.down,
    group: state.group,
    vars: [...state.vars],
    hiddenVars: [...state.hiddenVars],
    at: state.at,
  });
  if (seq !== viewSeq) return; // 多选连点时丢弃过期响应
  state.view = data;
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
  fit();
  renderDetail(null);
  renderLabelPanel();
  history.stack = [];
  history.idx = -1;
  pushHistory();
}

// 面板与交互模块通过钩子回调入口，避免循环依赖
hooks.loadView = loadView;
hooks.renderDetail = renderDetail;
// live.js 收到 AI 改动推送后用它刷新画面（保留视角）；函数声明有提升，这里可以先引用
hooks.reloadKeepCam = reloadKeepCam;

/** 应用书签：把保存的视图参数写回 state 和工具栏控件，再重新加载 */
hooks.applyBookmark = async (b) => {
  state.at = 0;
  state.up = Number(b.up) || 0;
  state.down = Number(b.down) || 3;
  state.group = !!b.group;
  state.vars = new Set(b.vars || []);
  state.hiddenVars.clear();

  els.depth.value = String(state.down);
  els.updepth.value = String(state.up);
  els.groupMode.checked = state.group;

  const roots = (b.roots || []).filter(Boolean);
  await loadView(roots.length ? roots : null);
  await loadVars();
};

/** 换工程后整体重载：解析结果、文件树、变量清单、视图全变了 */
hooks.reloadAll = async () => {
  state.view = null;
  state.selected = null;
  state.selectedEdge = null;
  state.selectedLabel = null;
  state.roots = [];
  state.root = null;
  state.at = 0;
  state.vars.clear();
  state.hiddenVars.clear();
  navStack.length = 0;
  deleteStack.length = 0;
  await loadStats();
  await loadTree();
  await loadVars();
  await loadView(null);
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
  const prev = navStack.pop();
  if (!prev) return false;
  await loadView(prev.roots.length ? prev.roots : null, { nav: false });
  cam.x = prev.cam.x;
  cam.y = prev.cam.y;
  cam.k = prev.cam.k;
  draw();
  return true;
}

/** 重新拉取视图但保留当前视角，避免删除后画面突然跳走 */
async function reloadKeepCam() {
  const before = { x: cam.x, y: cam.y, k: cam.k };
  await loadView(state.roots.length ? state.roots : state.root, { nav: false });
  cam.x = before.x;
  cam.y = before.y;
  cam.k = before.k;
  draw();
}

async function deleteSelection() {
  const v = state.view;
  if (!v) return;
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
  loadStats(); // 同步「恢复删除 (N)」上的计数
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

document.getElementById('undoBtn')?.addEventListener('click', undo);
document.getElementById('redoBtn')?.addEventListener('click', redo);

window.addEventListener('keydown', (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
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

els.depth.addEventListener('change', () => {
  state.down = Number(els.depth.value);
  loadView(state.root);
});
els.updepth.addEventListener('change', () => {
  state.up = Number(els.updepth.value);
  loadView(state.root);
});

els.groupMode.addEventListener('change', () => {
  state.group = els.groupMode.checked;
  state.selectedEdge = null;
  loadView(state.root);
});
els.fit.addEventListener('click', fit);

els.resetLayout.addEventListener('click', () => {
  loadView(state.roots.length ? state.roots : state.root);
});

// 一次性恢复所有被删除的函数与连线
els.restoreDeleted.addEventListener('click', async () => {
  await api.del({ clear: true });
  deleteStack.length = 0;
  await reloadKeepCam();
  await loadStats();
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

document.getElementById('exportSvg').addEventListener('click', () => {
  if (!state.view) return;
  download('callgraph.svg', new Blob([buildSVG()], { type: 'image/svg+xml' }));
});

document.getElementById('exportPng').addEventListener('click', () => {
  els.cv.toBlob((b) => download('callgraph.png', b));
});

document.getElementById('exportHtml').addEventListener('click', () => {
  if (!state.root) return;
  window.location.href = `/api/export/html?root=${encodeURIComponent(state.root)}&up=${state.up}&down=${state.down}`;
});

document.getElementById('exportXlsx').addEventListener('click', () => {
  window.location.href = '/api/export/xlsx';
});

// ---------------- 启动 ----------------

applyI18n();
window.addEventListener('resize', resize);
resize();
loadStats();
loadTree();
loadVars();
loadView(new URLSearchParams(location.search).get('root'));

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
