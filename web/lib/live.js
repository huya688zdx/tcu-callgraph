import { t } from '../i18n.js';
/**
 * AI 改动实时同步
 *
 * 1. 监听 SSE（/api/stream）：AI 通过 MCP 写入（标注 / 删除 / 布局 / 切工程）后
 *    服务端广播 change 事件，页面立即刷新画面——用户不用手动刷新。
 *    工程切换同步到其他页面，其他操作只响应 actor=ai：若用户自己的写操作也刷新，
 *    重复刷新会打断用户正在进行的拖拽。
 * 2. 上报页面视图状态（POST /api/page）：入口、深度、选中项。
 *    AI 用 cg_page 工具读取，对齐「用户正在看什么」再动手改。
 *
 * 回看历史（state.at > 0）时不刷新画面——历史是重放出来的，就地刷新会把
 * 「过去」和「现在」搅在一起；只弹提示，让用户自己决定何时回到最新。
 */
import { state, cam, els, edgeKey } from './state.js';
import { api, clientId } from './api.js';
import { hooks } from './hooks.js';
import { loadStats, renderVars, renderDetail } from './panels.js';
import { draw } from './render.js';
import { constrainCam } from './camera.js';
import { renderLabelPanel } from './label-panel.js';
import { reloadTimeline } from './timeline.js';
import { syncProjectLabel } from './projects.js';
import { notifyGitChanged } from './git-compare.js';

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
let pendingCompose = null;
let applyingCompose = false;
let pageRevision = 0;

/** 用户是否正在拖节点 / 拖连线 / 平移——此刻刷新会打断操作，稍后再试 */
function isInteracting() {
  return !!(state.dragBox || state.dragNode || state.dragSeg || state.dragLabel || state.dragStart || state.panning || state.marquee);
}

function scheduleReload() {
  dirtyCount++;
  if (flushTimer) return;
  flushTimer = setTimeout(flushReload, 400);
}

async function flushReload() {
  flushTimer = null;
  if (!dirtyCount || applyingCompose) return;
  if (state.view?.comparison && !pendingCompose) { dirtyCount = 0; return; }
  if (state.at > 0) {
    // 回看历史：画面是过去的重放，不能就地刷新，改完的量记在提示里
    const n = dirtyCount;
    dirtyCount = 0;
    toast(pendingCompose ? t('live.reviewCompose') :
      t('live.reviewEdits', { n }));
    reloadTimeline();
    return;
  }
  if (isInteracting() || (pendingCompose && restoring)) {
    flushTimer = setTimeout(flushReload, 500); // 忙等拖拽结束，dirtyCount 保留
    return;
  }
  const n = dirtyCount;
  dirtyCount = 0;
  const compose = pendingCompose;
  pendingCompose = null;
  try {
    if (compose && compose.page.projectId === state.view?.projectId &&
        compose.page.comparisonId === state.view?.comparison?.id) {
      const { page, reason } = compose;
      applyingCompose = true;
      // loadView 成功后才安装新范围，并用旧范围生成画布的返回记录。
      const view = await hooks.loadView(page.roots, {
        nav: true, incremental: true, expansions: page.expansions || [],
        up: page.up ?? 0, down: page.down ?? 0, group: page.group, groupMode: page.groupMode, empty: !!page.empty,
        vars: page.vars || [], hiddenVars: page.hiddenVars || [],
      });
      if (!view) throw new Error(t('live.composeFailed'));
      pageRevision = page.revision;
      state.selected = view.nodes.some((node) => node.id === page.selected) ? page.selected : null;
      renderVars();
      renderLabelPanel();
      draw();
      renderDetail(state.selected).catch(() => {});
      toast([t('live.composed'), reason].filter(Boolean).join(' · '));
    } else {
      await hooks.reloadKeepCam();
      toast(n > 1 ? t('live.edits', { n }) : t('live.updated'));
    }
    failures = 0;
    loadStats();
    reloadTimeline(); // 时间轴面板开着时同步新事件
  } catch {
    // 刷新失败（服务重启中等）：稍后重试，连续失败则放弃并提示手动刷新
    failures++;
    if (failures <= 3) {
      dirtyCount += n;
      pendingCompose ??= compose;
      if (!flushTimer) flushTimer = setTimeout(flushReload, 2000);
    } else {
      toast(t('live.refreshFailed'));
    }
  } finally {
    applyingCompose = false;
    if (dirtyCount && !flushTimer) flushTimer = setTimeout(flushReload, 400);
  }
}

if (es) {
  es.addEventListener('open', async () => {
    // SSE 无事件重放，重连时检查断线期间是否有新版画布。
    if (restoring || !state.view?.projectId) return;
    try {
      const { page } = await api.savedPage();
      if (page?.projectId === state.view?.projectId && page.comparisonId !== state.view?.comparison?.id) {
        await hooks.reloadAll();
      } else if (page?.projectId === state.view?.projectId && page.revision > pageRevision &&
          page.revision > (pendingCompose?.page.revision ?? 0)) {
        pendingCompose = { page };
        scheduleReload();
      }
    } catch { /* 页面上报仍可重试 */ }
  });
  es.addEventListener('change', (ev) => {
    let m = null;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!m) return;
    if (m.op === 'git.changed') {
      notifyGitChanged(m);
      return;
    }
    if (m.op === 'project.switch') {
      if (m.clientId === clientId) return;
      dirtyCount = 0;
      pendingCompose = null;
      const preserveAiChat = m.chatClientId === clientId && m.projectId === state.view?.projectId;
      hooks.reloadAll({ preserveAiChat }).then(() => syncProjectLabel()).catch(() => toast(t('live.projectRefreshFailed')));
      toast(t('live.projectSwitched', { project: m.project || '' }));
      return;
    }
    if (m.actor !== 'ai') return;
    if (m.op === 'view.compose' && m.page) pendingCompose = m;
    scheduleReload();
  });
  // 断线由浏览器按服务端给的 retry 间隔自动重连，无需处理 onerror
}

// ---------------- 页面状态上报（cg_page 的数据源）----------------

/** 视图状态的指纹：变化才上报，避免空转打接口 */
let lastSig = '';
let restoring = true;
let restoreId = 0;
let pendingSave = Promise.resolve();

export function acceptRestoredRevision(revision) {
  pageRevision = revision ?? pageRevision;
  if (pendingCompose && pendingCompose.page.projectId === state.view?.projectId && pendingCompose.page.revision <= pageRevision) {
    pendingCompose = null;
    dirtyCount = 0;
  }
}

/** 串行写入，退出时等待最后一次选择落盘，避免旧请求覆盖新状态。 */
export function savePage(force = false) {
  if (restoring || applyingCompose || (pendingCompose && !state.at) || !state.view?.projectId ||
      (!state.at && state.view.reviewSnapshot !== undefined) ||
      (!state.view.empty && !state.roots.length && !state.expansions.length) ||
      (!force && isInteracting())) return pendingSave.catch(() => {});
  const page = {
    projectId: state.view.projectId,
    comparisonId: state.view.comparison?.id ?? null,
    revision: state.at && pendingCompose?.page.projectId === state.view.projectId ? pendingCompose.page.revision : pageRevision,
    roots: state.roots,
    expansions: state.expansions,
    empty: !!state.view.empty && !state.roots.length && !state.expansions.length,
    up: state.up,
    down: state.down,
    group: state.group,
    groupMode: state.groupMode,
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
    if (!result?.ok) throw new Error(result?.error || t('live.saveFailed'));
    lastSig = sig;
  });
  return pendingSave;
}
setInterval(() => {
  if (!state.view?.comparison && !state.at && (pendingCompose || dirtyCount) && !flushTimer) {
    flushTimer = setTimeout(flushReload, 400);
    if (!dirtyCount) dirtyCount = 1;
  }
  savePage().catch(() => {});
}, 800);

/** 显式链接优先；没有入口参数时恢复当前工程上次关闭前的选择。 */
export async function restorePage({ root = null, isCurrent = () => true } = {}) {
  const id = ++restoreId;
  restoring = true;
  let started = false;
  let view;
  const superseded = () => id !== restoreId || !isCurrent(started);
  try {
    if (superseded()) return { status: 'superseded' };
    let stored = null;
    try { stored = (await api.savedPage()).page; } catch { /* 首次打开或服务暂不可用，走默认入口。 */ }
    if (superseded()) return { status: 'superseded' };
    pageRevision = stored?.revision ?? 0;
    const saved = root ? null : stored;
    if (saved) {
      const groupMode = saved.groupMode ?? (saved.group === false ? 'flat' : 'file');
      Object.assign(state, { up: saved.up, down: saved.down, groupMode, group: groupMode !== 'flat' });
      state.vars = new Set(saved.vars || []);
      state.hiddenVars = new Set(saved.hiddenVars || []);
      els.groupMode.checked = state.group;
      els.layoutGroupSelect.value = state.groupMode;
    }
    let empty = !!saved && (saved.empty || (!saved.roots?.length && !saved.expansions?.length));
    if (!root && !saved) {
      const project = await api.project().catch(() => null);
      if (superseded()) return { status: 'superseded' };
      empty = !project?.focusFile && !project?.comparison;
    }
    started = true;
    view = await hooks.loadView(empty ? [] : root || saved?.roots || null,
      { nav: false, empty, expansions: empty ? [] : saved?.expansions || [], restore: true });
    if (superseded()) return { status: 'superseded' };
    if (!view || view.error || !Array.isArray(view.nodes)) {
      return { status: 'error', error: view?.error || t('app.noView') };
    }
    // 比较进行中刷新页面：saved page 为空、通常也没有 root 参数，服务端按 COMPARISON.roots 零层出图，
    // 但启动时从 uiPrefs 恢复的非零层数还留在 state 里，之后的重载（勾变量/换分组）会把未选节点拉回图。
    // 这里把生效层数归零并同步控件；只动本次会话，不回写 uiPrefs 里的普通偏好。
    if (state.view?.comparison && !saved?.comparisonId) {
      state.up = 0; state.down = 0;
    }
    if (saved && state.view === view) {
      state.selected = state.view.nodes.some((n) => n.id === saved.selected) ? saved.selected : null;
      state.selectedEdge = state.view.edges.find((e) => edgeKey(e) === saved.selectedEdge) || null;
      state.ctxBox = saved.ctxBox;
      if (saved.cam) Object.assign(cam, saved.cam);
      constrainCam();
      renderVars();
      void renderDetail(state.selected).catch((error) => console.warn(t('common.detailError'), error));
      renderLabelPanel();
      draw();
    }
  } catch (error) {
    if (superseded()) return { status: 'superseded' };
    return { status: 'error', error: error?.message || t('app.noView') };
  } finally {
    if (id === restoreId) restoring = false;
  }
  await savePage(true).catch(() => {});
  if (superseded()) return { status: 'superseded' };
  return { status: view.nodes.length ? 'ok' : 'empty' };
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
