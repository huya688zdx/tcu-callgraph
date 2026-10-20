/**
 * 入口：视图加载、删除、工具栏与快捷键、启动
 * 具体职责已拆到 lib/ 下的模块
 */
import { applyI18n } from './i18n.js';
import { els, state, cam, deleteStack, edgeKey, modifiedEdges, modifiedNodes } from './lib/state.js';
import { api } from './lib/api.js';
import { hooks } from './lib/hooks.js';
import { fit } from './lib/camera.js';
import { draw, resize } from './lib/render.js';
import { fullReroute } from './lib/geometry.js';
import { history, pushHistory, undo, redo } from './lib/history.js';
import { loadStats, loadTree, renderDetail } from './lib/panels.js';
import { buildSVG, download } from './lib/svg.js';
// 交互模块在加载时注册画布事件，没有导出给入口使用，纯副作用导入
import './lib/interact.js';
import { clearDataflow } from './lib/df.js';

async function loadView(rootId) {
  clearDataflow(false); // 换视图时旧的叠加层不再适用
  const data = await api.view({
    root: rootId,
    up: state.up,
    down: state.down,
    group: state.group,
  });
  state.view = data;
  state.root = data.root;
  state.selected = null;
  state.selectedEdge = null;
  modifiedNodes.clear(); // 新视图的节点都是自动布局位置，尚未被拖动
  if (data.edges && data.edges.some((e) => !e.points || e.points.length < 2)) {
    fullReroute(); // 兜底：服务端数据缺折线时本地补算
  }
  const rootNode = data.nodes.find((n) => n.id === data.root);
  els.rootName.textContent = rootNode ? `· ${rootNode.name}` : '';
  fit();
  renderDetail(null);
  history.stack = [];
  history.idx = -1;
  pushHistory();
}

// 面板与交互模块通过钩子回调入口，避免循环依赖
hooks.loadView = loadView;

async function postDelete(body) {
  await api.del(body);
}

/** 重新拉取视图但保留当前视角，避免删除后画面突然跳走 */
async function reloadKeepCam() {
  const before = { x: cam.x, y: cam.y, k: cam.k };
  await loadView(state.root);
  cam.x = before.x;
  cam.y = before.y;
  cam.k = before.k;
  draw();
}

async function deleteSelection() {
  const v = state.view;
  if (!v) return;
  let body = null;

  if (state.selectedEdge) {
    body = { edges: [edgeKey(state.selectedEdge)] };
  } else if (state.selected) {
    body = { nodes: [state.selected] };
  } else {
    return;
  }

  // 删掉的正是当前入口时，回退到自动选择入口，避免停在一个空视图上
  if (body.nodes && body.nodes.includes(state.root)) state.root = null;

  await postDelete(body);
  deleteStack.push({ ...body, at: Date.now() });
  if (deleteStack.length > 30) deleteStack.shift();

  state.selected = null;
  state.selectedEdge = null;
  state.hover = null;
  await reloadKeepCam();
  renderDetail(null);
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

document.getElementById('undoBtn')?.addEventListener('click', undo);
document.getElementById('redoBtn')?.addEventListener('click', redo);

window.addEventListener('keydown', (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) {
      redo();
    } else if (deleteStack.length && Date.now() - deleteStack[deleteStack.length - 1].at < 20000) {
      // 优先恢复刚删掉的函数 / 连线（20 秒内有效，可逐次回退）
      restoreLastDelete();
    } else {
      undo();
    }
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selected || state.selectedEdge) {
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

els.resetLayout.addEventListener('click', async () => {
  await api.layout({
    clear: true,
    root: state.root,
    mode: state.group ? 'group' : 'flat',
  });
  modifiedEdges.clear();
  modifiedNodes.clear();
  loadView(state.root);
});

// 一次性恢复所有被删除的函数与连线
els.restoreDeleted.addEventListener('click', async () => {
  await api.del({ clear: true });
  deleteStack.length = 0;
  await reloadKeepCam();
  await loadStats();
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
  /** 当前高亮的框 id（点击标题后短暂存在） */
  get flash() {
    return state.flash ? state.flash.box.id : null;
  },
  /** 当前选中项 */
  get selected() {
    return {
      node: state.selected,
      edge: state.selectedEdge ? edgeKey(state.selectedEdge) : null,
    };
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
