/**
 * AI 改动实时同步
 *
 * 1. 监听 SSE（/api/stream）：AI 通过 MCP 写入（标注 / 删除 / 布局 / 切工程）后
 *    服务端广播 change 事件，页面立即刷新画面——用户不用手动刷新。
 *    只响应 actor=ai：用户自己的写操作界面已就地处理，若也跟着刷新，
 *    重复刷新会打断用户正在进行的拖拽。
 * 2. 上报页面视图状态（POST /api/page）：入口、深度、选中项。
 *    AI 用 cg_page 工具读取，对齐「用户正在看什么」再动手改。
 *
 * 回看历史（state.at > 0）时不刷新画面——历史是重放出来的，就地刷新会把
 * 「过去」和「现在」搅在一起；只弹提示，让用户自己决定何时回到最新。
 */
import { state, cam, els, edgeKey } from './state.js';
import { api } from './api.js';
import { hooks } from './hooks.js';
import { loadStats, renderVars, renderDetail } from './panels.js';
import { draw } from './render.js';
import { renderLabelPanel } from './label-panel.js';
import { reloadTimeline } from './timeline.js';

// ---------------- SSE 监听 ----------------

let es = null;
try {
  es = new EventSource('/api/stream');
} catch {
  /* 环境不支持 SSE：退回「手动刷新可见」，不影响其他功能 */
}

/** 防抖状态：AI 连续多个写操作合并成一次刷新 */
let flushTimer = null;
let dirtyCount = 0;
let failures = 0; // 连续刷新失败次数：服务重启期间有限重试，超过就放弃并提示

/** 用户是否正在拖节点 / 拖连线 / 平移——此刻刷新会打断操作，稍后再试 */
function isInteracting() {
  return !!(state.dragBox || state.dragNode || state.dragSeg || state.dragLabel || state.dragStart || state.panning);
}

function scheduleReload() {
  dirtyCount++;
  if (flushTimer) return;
  flushTimer = setTimeout(flushReload, 400);
}

async function flushReload() {
  flushTimer = null;
  if (!dirtyCount) return;
  if (state.at > 0) {
    // 回看历史：画面是过去的重放，不能就地刷新，改完的量记在提示里
    const n = dirtyCount;
    dirtyCount = 0;
    toast(`AI 改了 ${n} 处（正在回看历史，回到最新后可见）`);
    reloadTimeline();
    return;
  }
  if (isInteracting()) {
    flushTimer = setTimeout(flushReload, 500); // 忙等拖拽结束，dirtyCount 保留
    return;
  }
  const n = dirtyCount;
  dirtyCount = 0;
  try {
    await hooks.reloadKeepCam();
    failures = 0;
    loadStats();
    reloadTimeline(); // 时间轴面板开着时同步新事件
    toast(n > 1 ? `AI 更新了视图（${n} 处改动）` : 'AI 更新了视图');
  } catch {
    // 刷新失败（服务重启中等）：稍后重试，连续失败则放弃并提示手动刷新
    failures++;
    if (failures <= 3) {
      dirtyCount = n;
      flushTimer = setTimeout(flushReload, 2000);
    } else {
      toast('AI 的改动刷新失败，请手动刷新页面');
    }
  }
}

if (es) {
  es.addEventListener('change', (ev) => {
    let m = null;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!m || m.actor !== 'ai') return;
    if (m.op === 'project.switch') {
      dirtyCount = 0;
      hooks.reloadAll(); // 跨工程没有任何可保留的状态，整体重载
      toast(`AI 切换了工程：${m.project || ''}`);
      return;
    }
    scheduleReload();
  });
  // 断线由浏览器按服务端给的 retry 间隔自动重连，无需处理 onerror
}

// ---------------- 页面状态上报（cg_page 的数据源）----------------

/** 视图状态的指纹：变化才上报，避免空转打接口 */
let lastSig = '';
let restoring = true;
let pendingSave = Promise.resolve();

/** 串行写入，退出时等待最后一次选择落盘，避免旧请求覆盖新状态。 */
export function savePage(force = false) {
  if (restoring || !state.view?.projectId || !state.roots.length || (!force && isInteracting())) return pendingSave;
  const page = {
    projectId: state.view.projectId,
    roots: state.roots,
    up: state.up,
    down: state.down,
    group: state.group,
    vars: [...state.vars],
    hiddenVars: [...state.hiddenVars],
    selected: state.selected,
    selectedEdge: state.selectedEdge ? edgeKey(state.selectedEdge) : null,
    ctxBox: state.ctxBox,
    cam: { ...cam },
    at: state.at,
  };
  const sig = JSON.stringify(page);
  pendingSave = pendingSave.catch(() => {}).then(async () => {
    if (sig === lastSig) return;
    const result = await api.reportPage(page);
    if (!result?.ok) throw new Error(result?.error || '保存当前视图失败');
    lastSig = sig;
  });
  return pendingSave;
}
setInterval(() => savePage().catch(() => {}), 800);

/** 显式链接优先；没有入口参数时恢复当前工程上次关闭前的选择。 */
export async function restorePage(root = null, isCurrent = () => true) {
  restoring = true;
  try {
    if (!isCurrent()) return;
    let saved = null;
    if (!root) {
      try { saved = (await api.savedPage()).page; } catch { /* 首次打开或服务暂不可用，走默认入口。 */ }
    }
    if (!isCurrent()) return; // 旧设置等待期间已有新操作，不再回填旧选择。
    if (saved) {
      Object.assign(state, { up: saved.up, down: saved.down, group: saved.group });
      state.vars = new Set(saved.vars || []);
      state.hiddenVars = new Set(saved.hiddenVars || []);
      els.depth.value = String(state.down);
      els.updepth.value = String(state.up);
      els.groupMode.checked = state.group;
    }
    const view = await hooks.loadView(root || saved?.roots || null, { nav: false });
    if (saved && view && state.view === view) {
      state.selected = state.view.nodes.some((n) => n.id === saved.selected) ? saved.selected : null;
      state.selectedEdge = state.view.edges.find((e) => edgeKey(e) === saved.selectedEdge) || null;
      state.ctxBox = saved.ctxBox;
      if (saved.cam) Object.assign(cam, saved.cam);
      renderVars();
      await renderDetail(state.selected);
      renderLabelPanel();
      draw();
    }
  } finally { restoring = false; }
}

// ---------------- 轻量提示条 ----------------
// 这个界面没有 toast 系统（见 bookmarks.js 的先例），临时提示就地造一个

let toastEl = null;
let toastTimer = null;

function toast(text) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.setAttribute('role', 'status');
    toastEl.style.cssText =
      'position:fixed;left:50%;bottom:56px;transform:translateX(-50%);' +
      'padding:8px 16px;border-radius:8px;background:rgba(38,39,48,.92);color:#fff;' +
      'font:13px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.25);opacity:0;pointer-events:none;' +
      'transition:opacity .25s;z-index:99;';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.style.opacity = '0';
  }, 2600);
}
