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
import { draw, pulseAdded } from './render.js';
import { constrainCam, focusBox } from './camera.js';
import { renderLabelPanel } from './label-panel.js';
import { markReviewUpdated, reloadTimeline, reviewTransition } from './timeline.js';
import { bookmarkMetadata, reloadBookmarks } from './bookmarks.js';
import { closeModal } from './modal.js';
import { syncProjectLabel } from './projects.js';
import { notifyGitChanged } from './git-compare.js';

// ---------------- SSE 监听 ----------------

let es = null;
try {
  es = new EventSource('/api/stream?clientId=' + encodeURIComponent(clientId));
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
let lastAiOp = '';

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
  if (reviewTransition()) return;
  if (state.view?.comparison && !pendingCompose) { dirtyCount = 0; return; }
  if (state.at > 0) {
    // 回看历史：画面是过去的重放，不能就地刷新，改完的量记在提示里
    dirtyCount = 0;
    markReviewUpdated();
    void reloadTimeline();
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
        (compose.page.comparisonId ?? null) === (state.view?.comparison?.id ?? null)) {
      const { page, reason } = compose;
      const prevNodes = state.view?.nodes || [];
      const prevIds = new Set(prevNodes.map((node) => node.id));
      const prevEdges = new Set((state.view?.edges || []).map(edgeKey));
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
      const nextIds = new Set(view.nodes.map((node) => node.id));
      const addedNodes = view.nodes.filter((node) => !prevIds.has(node.id));
      const addedEdges = view.edges.filter((edge) => !prevEdges.has(edgeKey(edge)));
      const removedNodes = prevNodes.filter((node) => !nextIds.has(node.id));
      renderVars();
      renderLabelPanel();
      if (addedNodes.length || addedEdges.length) {
        pulseAdded(addedNodes, addedEdges, { highlightMs: 6500, rippleMs: 1600 });
      } else {
        draw();
      }
      renderDetail(state.selected).catch(() => {});
      const formatNames = (list) => {
        const names = list.map((n) => n.name || String(n.id).split('::').pop()).filter(Boolean);
        if (!names.length) return '';
        const shown = names.slice(0, 4).join('、');
        return names.length > 4 ? `${shown} 等 ${names.length} 个` : shown;
      };
      const diffParts = [];
      if (addedNodes.length) diffParts.push(`+${addedNodes.length}（${formatNames(addedNodes)}）`);
      if (removedNodes.length) diffParts.push(`-${removedNodes.length}（${formatNames(removedNodes)}）`);
      const summaryText = diffParts.length
        ? `${t('live.composed')}：${diffParts.join('，')}${reason ? ` · ${reason}` : ''}`
        : [t('live.composed'), reason].filter(Boolean).join(' · ');
      toast(summaryText, {
        duration: diffParts.length ? 5500 : 2800,
        ...(addedNodes.length ? {
          actionLabel: '定位新增',
          onAction: () => {
            const currentAdded = (state.view?.nodes || []).filter((n) => addedNodes.some((a) => a.id === n.id));
            if (!currentAdded.length) return;
            const x0 = Math.min(...currentAdded.map((n) => n.x));
            const y0 = Math.min(...currentAdded.map((n) => n.y));
            const x1 = Math.max(...currentAdded.map((n) => n.x + n.w));
            const y1 = Math.max(...currentAdded.map((n) => n.y + n.h));
            focusBox({ x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }, 90, { keepZoom: false });
            pulseAdded(currentAdded, [], { highlightMs: 4000, rippleMs: 1400 });
          },
        } : {}),
      });
    } else {
      await hooks.reloadKeepCam();
      toast(n > 1 ? t('live.edits', { n }) : lastAiOp === 'layout.save' ? 'AI 已整理并更新画布布局' : lastAiOp === 'layout.clear' ? 'AI 已恢复自动布局' : t('live.updated'));
    }
    failures = 0;
    void loadStats().catch(() => {});
    void reloadTimeline(); // 时间轴面板开着时同步新事件
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
      const { page, project, comparisonId } = await api.savedPage();
      const sameProject = project?.id === state.view?.projectId;
      if (project && (!sameProject || comparisonId !== (state.view?.comparison?.id ?? null))) {
        if (state.at || reviewTransition()) markReviewUpdated(true);
        else {
          closeModal();
          await hooks.reloadAll({ preserveAiChat: sameProject });
        }
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
      if ((state.at || reviewTransition()) && m.actor === 'ai') {
        markReviewUpdated(true);
        return;
      }
      dirtyCount = 0;
      pendingCompose = null;
      const preserveAiChat = m.chatClientId === clientId && m.projectId === state.view?.projectId;
      closeModal();
      hooks.reloadAll({ preserveAiChat }).then(() => syncProjectLabel()).catch(() => toast(t('live.projectRefreshFailed')));
      toast(t('live.projectSwitched', { project: m.project || '' }));
      return;
    }
    const projectId = m.projectId ?? m.page?.projectId;
    if (projectId != null && projectId !== state.view?.projectId) return;
    if (m.op.startsWith('bookmark.')) {
      if (m.clientId !== clientId && m.bookmark && state.activeBookmark?.id === m.bookmark.id) {
        state.activeBookmark = bookmarkMetadata(state.activeBookmark, m.bookmark, m.op === 'bookmark.rename');
        hooks.syncBookmarkBadge?.();
        window.dispatchEvent(new CustomEvent('cg:bookmark-changed', { detail: { bookmark: state.activeBookmark, prev: null, remote: true } }));
      } else if (m.clientId !== clientId && m.op === 'bookmark.delete' && state.activeBookmark?.id === m.bookmarkId) {
        const prev = state.activeBookmark;
        state.activeBookmark = null;
        hooks.syncBookmarkBadge?.();
        window.dispatchEvent(new CustomEvent('cg:bookmark-changed', { detail: { bookmark: null, prev, remote: true } }));
      }
      if (m.actor === 'ai' || m.clientId !== clientId) {
        reloadBookmarks();
        void reloadTimeline();
        if (m.actor === 'ai' && (state.at || reviewTransition())) markReviewUpdated();
      }
      return;
    }
    if (m.actor !== 'ai') return;
    if (m.op === 'view.compose' && m.page) {
      if (m.page.revision <= Math.max(pageRevision, pendingCompose?.page.revision ?? 0)) return;
      pendingCompose = m;
    }
    lastAiOp = m.op || '';
    if (state.at || reviewTransition()) markReviewUpdated();
    scheduleReload();
  });
  es.addEventListener('canvas_overlay', (ev) => {
    let m = null;
    try { m = JSON.parse(ev.data || '{}'); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.action === 'clear') {
      state.aiOverlay = null;
      state.presentation = null;
      document.dispatchEvent(new CustomEvent('cg:ai-overlay-cleared'));
      draw({ geometryUnchanged: true });
      return;
    }
    state.aiOverlay = {
      action: m.action || 'spotlight',
      nodeIds: Array.isArray(m.nodeIds) ? m.nodeIds.filter(Boolean) : [],
      edgeKeys: Array.isArray(m.edgeKeys) ? m.edgeKeys.filter(Boolean) : [],
      title: typeof m.title === 'string' ? m.title : '',
      updatedAt: Date.now(),
    };
    if (m.focus && state.view && state.aiOverlay.nodeIds.length) {
      const hit = new Set(state.aiOverlay.nodeIds);
      const matched = (state.view.nodes || []).filter((n) => hit.has(n.id));
      if (matched.length) {
        const minX = Math.min(...matched.map((n) => n.x));
        const minY = Math.min(...matched.map((n) => n.y));
        const maxX = Math.max(...matched.map((n) => n.x + n.w));
        const maxY = Math.max(...matched.map((n) => n.y + n.h));
        focusBox({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
        return;
      }
    }
    draw({ geometryUnchanged: true });
  });
  // 断线由浏览器按服务端给的 retry 间隔自动重连，无需处理 onerror
}

// ---------------- 页面状态上报（cg_page 的数据源）----------------

/** 视图状态的指纹：变化才上报，避免空转打接口 */
let lastSig = '';
let restoring = true;
let restoreId = 0;
let pendingSave;
let queuedPage;
let reportingSig;

export function acceptRestoredRevision(revision) {
  pageRevision = revision ?? pageRevision;
  if (pendingCompose && pendingCompose.page.projectId === state.view?.projectId && pendingCompose.page.revision <= pageRevision) {
    pendingCompose = null;
  }
}

/** 串行写入，退出时等待最后一次选择落盘，避免旧请求覆盖新状态。 */
export function savePage(force = false) {
  if (restoring || reviewTransition() || applyingCompose || (pendingCompose && !state.at) || !state.view?.projectId ||
      (!state.at && state.view.reviewSnapshot !== undefined) ||
      (!state.view.empty && !state.roots.length && !state.expansions.length) ||
      (!force && isInteracting())) return Promise.resolve();
  const page = {
    projectId: state.view.projectId,
    comparisonId: state.view.comparison?.id ?? null,
    revision: pageRevision,
    roots: state.roots,
    expansions: state.expansions,
    empty: !!state.view.empty && !state.roots.length && !state.expansions.length,
    up: state.up,
    down: state.down,
    group: state.group,
    groupMode: state.groupMode,
    vars: [...state.vars],
    hiddenVars: [...state.hiddenVars],
    activeBookmark: state.activeBookmark,
    selected: state.selected,
    selectedEdge: state.selectedEdge ? edgeKey(state.selectedEdge) : null,
    ctxBox: state.ctxBox,
    cam: { ...cam },
    at: state.at,
  };
  const sig = JSON.stringify(page);
  if (sig !== queuedPage?.sig && (queuedPage || sig !== (reportingSig ?? lastSig))) queuedPage = { page, sig };
  if (!pendingSave && queuedPage) {
    pendingSave = Promise.resolve().then(async () => {
      while (queuedPage) {
        const next = queuedPage;
        queuedPage = null;
        if (next.sig === lastSig) continue;
        reportingSig = next.sig;
        try {
          const result = await api.reportPage(next.page);
          if (!result?.ok) throw new Error(result?.error || t('live.saveFailed'));
          lastSig = next.sig;
        } catch (error) {
          if (!queuedPage) throw error;
        }
      }
    }).finally(() => { pendingSave = null; reportingSig = null; });
  }
  return pendingSave ?? Promise.resolve();
}
setInterval(() => {
  if ((pendingCompose || dirtyCount) && !state.at && !reviewTransition() && !flushTimer && !applyingCompose) {
    dirtyCount ||= 1;
    flushTimer = setTimeout(flushReload, 400);
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
      state.activeBookmark = saved.activeBookmark || null;
      els.groupMode.checked = state.group;
      els.layoutGroupSelect.value = state.groupMode;
    }
    hooks.syncBookmarkBadge?.();
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

function toast(text, { duration = 2600, actionLabel = '', onAction = null } = {}) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.setAttribute('role', 'status');
    toastEl.style.cssText =
      'position:fixed;left:50%;bottom:56px;transform:translateX(-50%);' +
      'display:inline-flex;align-items:center;gap:10px;max-width:min(680px,calc(100vw - 32px));' +
      'padding:8px 14px;border-radius:9px;background:rgba(28,33,44,.94);color:#fff;' +
      'font:13px/1.4 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.28);opacity:0;pointer-events:none;' +
      'transition:opacity .25s;z-index:1200;';
    document.body.appendChild(toastEl);
  }
  toastEl.replaceChildren();
  const msg = document.createElement('span');
  msg.textContent = text;
  toastEl.appendChild(msg);
  if (actionLabel && typeof onAction === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = actionLabel;
    btn.style.cssText =
      'padding:2px 9px;border-radius:6px;border:1px solid rgba(255,255,255,.32);' +
      'background:rgba(2,132,199,.9);color:#fff;font-size:12px;cursor:pointer;flex-shrink:0;';
    btn.addEventListener('click', () => onAction());
    toastEl.appendChild(btn);
    toastEl.style.pointerEvents = 'auto';
  } else {
    toastEl.style.pointerEvents = 'none';
  }
  toastEl.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.style.opacity = '0';
    toastEl.style.pointerEvents = 'none';
  }, duration);
}
