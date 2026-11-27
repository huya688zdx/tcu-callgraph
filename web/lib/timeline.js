/**
 * 操作时间轴：分页浏览、按类型/关键词过滤、回看历史某一刻、恢复到此
 *
 * 性能上的两个关键点：
 * 1. 列表接口只回 brief（几十字节），不回 before/after。以前一次拿 300 条完整事件，
 *    每条带几 KB 的布局坐标，操作一多面板就卡。
 * 2. 分页加载，一次 50 条，底部「加载更多」。DOM 只渲染已经加载的部分。
 *
 * 回看是只读的：state.at > 0 时 api.js 会拦掉所有写接口，
 * 想编辑必须先点「回到最新」。这样历史状态永远不会被就地改脏。
 */
import { t } from '../i18n.js';
import { api } from './api.js';
import { currentViewScope, isBookmarkDirty, state, cam, edgeKey } from './state.js';
import { hooks } from './hooks.js';
import { openModal, closeModal, wireModals, esc } from './modal.js';
import { constrainCam } from './camera.js';
import { draw } from './render.js';
import { acceptRestoredRevision, savePage } from './live.js';
import { renderLabelPanel } from './label-panel.js';

const btn = document.getElementById('timelineBtn');
const listEl = document.getElementById('timelineList');
const searchEl = document.getElementById('tlSearch');
const chipsEl = document.getElementById('tlChips');
const countEl = document.getElementById('tlCount');
const scopeBookmarkCheck = document.getElementById('tlScopeBookmark');
const scopeBookmarkWrap = document.getElementById('tlScopeBookmarkWrap');
const checkpointInput = document.getElementById('tlCheckpointInput');
const checkpointBtn = document.getElementById('tlCheckpointBtn');
const bar = document.getElementById('reviewBar');
const barText = document.getElementById('reviewText');
const restoreBtn = document.getElementById('reviewRestore');
const exitBtn = document.getElementById('reviewExit');

const PAGE = 50;

const OP_KIND = {
  'node.annotate': 'Node',
  'edge.annotate': 'Edge',
  'labels.renumber': 'Edge',
  'delete': 'Delete',
  'delete.restore': 'Delete',
  'delete.clear': 'Delete',
  'layout.save': 'Layout',
  'layout.clear': 'Layout',
  'orphan.purge': 'Delete',
  'bookmark.save': 'Bookmark',
  'bookmark.delete': 'Bookmark',
  'view.compose': 'Compose',
  'view.snapshot': 'Canvas',
  'view.checkpoint': 'Checkpoint',
  'view.clear': 'ClearCanvas',
};

/** 面板状态：默认展示「关键节点」（milestone） */
const tl = { events: [], ops: [], level: '', bookmarkId: null, q: '', hasMore: false, total: 0, loading: false, seq: 0 };

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const dayLabel = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? t('common.today')
    : `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
};

function formatTarget(target) {
  const parts = target.split('->');
  const isEdge = parts.length === 2;
  const line = isEdge ? parts[1].match(/:(\d+)$/) : null;
  if (line) parts[1] = parts[1].slice(0, -line[0].length);
  const names = [];
  const files = [];
  for (const part of parts) {
    const segments = part.split('::');
    if (segments.length === 1) return { title: target, meta: '' };
    names.push(segments.pop());
    if (segments[0] === 'header' || segments[0] === 'var') segments.shift();
    files.push(segments.join('::'));
  }
  const path = files.filter(Boolean).join(' → ');
  return { title: names.join(' → '), meta: [path, line?.[0]].filter(Boolean).join(' ') };
}

/** 把一条事件翻译成人话：用户看时间轴时不该看到 op 名 */
function describe(e) {
  const b = e.brief || {};
  const target = e.target || '';
  switch (e.op) {
    case 'node.annotate':
    case 'edge.annotate': {
      const bits = [];
      if (b.change) bits.push(t(`compare.version.${b.change === 'changed' ? 'modified' : b.change}`));
      if (b.note) bits.push(t('timeline.note', { note: b.note }));
      if (b.tag) bits.push(t('timeline.tag', { tag: b.tag }));
      if (b.color) bits.push(t('timeline.color'));
      const labels = Array.isArray(b.labels) ? b.labels.filter(Boolean) : [];
      if (!labels.length && b.label) labels.push(b.label);
      if (labels.length) bits.push(t('timeline.labels', { labels: labels.join(' · ') }));
      else if (b.labelsCount > 0) bits.push(t('timeline.labelCount', { n: b.labelsCount }));
      if (b.cleared === true) bits.push(t('timeline.cleared'));
      return bits.join(' · ') || t(e.op === 'edge.annotate' ? 'op.edge.annotate' : 'op.node.annotate');
    }
    case 'labels.renumber':
      return t('timeline.renumber');
    case 'delete':
    case 'delete.restore': {
      const items = [b.nodes && t('common.functionCount', { n: b.nodes }), b.edges && t('common.edgeCount', { n: b.edges })]
        .filter(Boolean).join(' / ');
      return items ? t(e.op === 'delete' ? 'timeline.deleted' : 'timeline.recovered', { items }) : t(`op.${e.op}`);
    }
    case 'delete.clear':
      return t('op.delete.clear');
    case 'layout.save':
      return b.nodes ? t('timeline.layoutNodes', { n: b.nodes }) : t('op.layout.save');
    case 'layout.clear':
      return t('op.layout.clear');
    case 'baseline':
      return t('op.baseline');
    case 'import':
      return t('timeline.legacy');
    case 'session.import': {
      const im = b.import || {};
      const base = t('session.imported', { a: im.annotations || 0, l: im.layout || 0, b: im.bookmarks || 0 });
      return b.codeMismatch ? base + ' ' + t('session.codeMismatch') : base;
    }
    case 'restore_point':
      return t('op.restore_point');
    case 'manual.variable.bind':
      return t('op.manual.variable.bind');
    case 'bookmark.save': {
      const act = e.ctx?.action === 'update' ? '更新书签' : e.ctx?.action === 'rename' ? '重命名书签' : t('op.bookmark.save');
      return [
        act,
        e.ctx?.diffSummary || '',
        b.roots ? t('common.scopeCount', { n: b.roots }) : '',
      ].filter(Boolean).join(' · ');
    }
    case 'bookmark.delete':
      return t('op.bookmark.delete');
    case 'view.compose': {
      const reason = b.reason ?? (target.includes('::') ? '' : target);
      const caption = b.count == null ? t('timeline.compose') : t('timeline.composeCount', { n: b.count });
      return [caption, reason].filter(Boolean).join(' · ');
    }
    case 'view.checkpoint':
      return [
        e.ctx?.bookmarkName ? `书签「${e.ctx.bookmarkName}」` : '',
        e.ctx?.diffSummary || (b.count != null ? t('timeline.canvasCount', { n: b.count }) : ''),
      ].filter(Boolean).join(' · ');
    case 'view.snapshot':
      return [
        e.ctx?.bookmarkName ? `书签「${e.ctx.bookmarkName}」` : '',
        e.ctx?.diffSummary || t('timeline.canvasCount', { n: b.count ?? 0 }),
        b.label,
      ].filter(Boolean).join(' · ');
    case 'view.clear':
      return t('timeline.kindClearCanvas');
    case 'orphan.purge':
      return t('timeline.orphanCount', { n: b.total || 0 });
    default:
      return t(`op.${e.op}`) || e.op;
  }
}

function collapseEvents(events) {
  const rows = [];
  // 接口按事件 ID 倒序返回，合并时保留每组最新的一条。
  for (const event of events) {
    const day = dayKey(event.ts);
    const detail = describe(event);
    const previous = rows.at(-1);
    if (!event.op.startsWith('view.') && previous && previous.day === day && previous.event.op === event.op &&
        previous.event.target === event.target && previous.detail === detail) {
      previous.count++;
    } else {
      rows.push({ event, day, detail, count: 1 });
    }
  }
  return rows;
}

function renderAll() {
  if (!listEl) return;
  if (!tl.events.length) {
    listEl.innerHTML = `<div class="empty">${tl.q || tl.ops.length ? t('timeline.none') : t('timeline.empty')}</div>`;
    return;
  }

  let html = '';
  let lastDay = '';
  for (const { event: e, day, detail, count } of collapseEvents(tl.events)) {
    if (day !== lastDay) {
      lastDay = day;
      html += `<div class="ev-day">${dayLabel(e.ts)}</div>`;
    }
    const kind = OP_KIND[e.op] || 'Project';
    const category = t(`timeline.kind${kind}`);
    const target = e.target || '';
    const codeTarget = ['Node', 'Edge', 'Delete', 'Layout', 'Compose'].includes(kind);
    const displayTarget = kind === 'Canvas' || kind === 'ClearCanvas' ? ''
      : kind === 'Checkpoint' ? (e.ctx?.checkpointName || e.brief?.label || target || t('timeline.kindCheckpoint'))
      : kind === 'Layout' ? target.replace(/::(?:group|flat)$/, '')
      : kind === 'Compose' && !target.includes('::') ? '' : target;
    const { title, meta } = codeTarget
      ? formatTarget(displayTarget)
      : { title: displayTarget, meta: '' };
    const on = state.at === e.id ? ' on' : '';
    const sub = [meta, hhmm(e.ts), e.actor === 'system' ? t('common.system') : ''].filter(Boolean).join(' · ');
    html += `<div class="ev k-${kind.toLowerCase()}${on}" data-id="${esc(e.id)}" data-ts="${esc(e.ts)}">
      <div class="ev-content">
        <div class="ev-heading">
          <span class="ev-kind">${esc(category)}</span>
          <strong class="ev-title">${esc(title || detail)}</strong>
          ${count > 1 ? `<span class="ev-repeat">×${count}</span>` : ''}
          ${e.actor === 'ai' && kind !== 'Compose' ? '<span class="ai-badge">AI</span>' : ''}
        </div>
        ${title && title !== detail ? `<div class="ev-detail">${esc(detail)}</div>` : ''}
        <div class="sub">${esc(sub)}</div>
      </div>
      <button type="button" class="ev-review">${esc(t('timeline.review'))}</button>
    </div>`;
  }
  if (tl.hasMore) {
    html += `<button class="tl-more" id="tlMore">${t('timeline.more').replace(
      '{n}',
      Math.max(0, tl.total - tl.events.length)
    )}</button>`;
  }
  listEl.innerHTML = html;

  listEl.querySelectorAll('.ev').forEach((row) => {
    row.addEventListener('click', () => reviewAt(Number(row.dataset.id), Number(row.dataset.ts)));
  });
  listEl.querySelector('#tlMore')?.addEventListener('click', () => load({ append: true }));
}

function setCount() {
  if (countEl) countEl.textContent = tl.total ? t('timeline.count').replace('{n}', tl.total) : '';
}

/** 拉一页。append=true 时接着上一页往后取（游标 = 已加载的最后一条 id） */
async function load({ append = false, allowFallback = true } = {}) {
  if (reviewSessionChanged) return;
  if (append && tl.loading) return;
  tl.loading = true;
  const seq = ++tl.seq;
  const before = append && tl.events.length ? tl.events[tl.events.length - 1].id : 0;
  try {
    const r = await api.events({ limit: PAGE, before, ops: tl.ops, level: tl.level, bookmarkId: tl.bookmarkId, q: tl.q });
    if (seq !== tl.seq) return; // 过滤条件变了，丢弃过期响应
    const list = r.events || [];
    tl.events = append ? [...tl.events, ...list] : list;
    tl.hasMore = !!r.hasMore;
    tl.total = Number(r.total || 0);
  } catch {
    if (seq !== tl.seq) return;
    if (!append) {
      tl.events = [];
      tl.hasMore = false;
      tl.total = 0;
    }
  } finally {
    if (seq === tl.seq) tl.loading = false;
  }
  if (!append && allowFallback && tl.level === 'milestone' && !tl.ops.length && !tl.q && !tl.bookmarkId && tl.total === 0) {
    tl.level = '';
    chipsEl?.querySelectorAll('button').forEach((c) => {
      c.classList.toggle('on', !c.dataset.level && !c.dataset.ops);
    });
    return load({ append: false, allowFallback: false });
  }
  setCount();
  renderAll();
}

let preReview = null;
let reviewTime = 0;
let reviewSeq = 0;
let changingReview = false;
let restoringSnapshot = false;
let latestUpdated = false;
let reviewSessionChanged = false;

export const reviewTransition = () => changingReview || restoringSnapshot;
export function markReviewUpdated(sessionChanged = false) {
  if (latestUpdated && (!sessionChanged || reviewSessionChanged)) return;
  latestUpdated = true;
  reviewSessionChanged ||= sessionChanged;
  showBar();
}

function syncReviewControls() {
  restoreBtn.disabled = changingReview || restoringSnapshot || reviewSessionChanged;
  exitBtn.disabled = changingReview || restoringSnapshot;
  document.dispatchEvent(new Event('cg:review-mode'));
}

function showBar() {
  if (!bar) return;
  const time = `${dayLabel(reviewTime)} ${hhmm(reviewTime)}`;
  const key = changingReview ? 'timeline.reviewLoading'
    : state.view?.reviewSnapshot ? 'timeline.reviewSnapshot' : 'timeline.reviewOverlay';
  barText.textContent = [t(key, { time, n: state.view?.nodes.length || 0 }),
    latestUpdated && t('live.reviewLatestUpdated')].filter(Boolean).join(' · ');
  bar.classList.add('show');
  syncReviewControls();
}

function hideBar() {
  ++reviewSeq;
  preReview = null;
  reviewTime = 0;
  changingReview = false;
  latestUpdated = false;
  reviewSessionChanged = false;
  bar?.classList.remove('show');
  syncReviewControls();
}

/** 进入回看：把 state.at 指到某个事件，重新拉一次视图 */
async function reviewAt(eventId, ts) {
  if (reviewTransition() || reviewSessionChanged || state.view?.comparison || !eventId || hooks.canReview?.() === false) return;
  if (!state.at) {
    preReview = { roots: [...state.roots], expansions: structuredClone(state.expansions),
      up: state.up, down: state.down, group: state.group, groupMode: state.groupMode, vars: [...state.vars], hiddenVars: [...state.hiddenVars],
      empty: !!state.view?.empty && !state.roots.length && !state.expansions.length, cam: { ...cam } };
  }
  const seq = ++reviewSeq;
  const previousId = state.at;
  const previousTime = reviewTime;
  state.at = eventId;
  reviewTime = ts || Date.now();
  changingReview = true;
  showBar();
  closeModal();
  try {
    const view = await hooks.loadView(preReview.roots, { ...preReview, nav: false, useSnapshot: true, fitOnLoad: true });
    if (seq !== reviewSeq) return;
    if (!view) throw new Error(t('app.viewFailed'));
    changingReview = false;
    showBar();
    renderAll();
    void savePage(true).catch(() => {});
  } catch (error) {
    if (seq !== reviewSeq) return;
    state.at = previousId;
    reviewTime = previousTime;
    changingReview = false;
    if (state.at) showBar();
    else hideBar();
    alert(error.message || t('app.viewFailed'));
  }
}

async function exitReview() {
  if (!state.at || changingReview || restoringSnapshot) return;
  const saved = preReview;
  const eventId = state.at;
  const seq = ++reviewSeq;
  changingReview = true;
  syncReviewControls();
  try {
    const latest = await api.savedPage();
    if (seq !== reviewSeq) return;
    if (latest.ok === false) throw new Error(latest.error);
    const page = latest.page;
    const sameProject = latest.project?.id === state.view?.projectId;
    if (!sameProject || latest.comparisonId) {
      closeModal();
      await hooks.reloadAll({ preserveAiChat: sameProject });
      return;
    }
    const target = page || saved;
    state.at = 0;
    const view = await hooks.loadView(target.roots, { ...target, nav: false });
    if (seq !== reviewSeq) return;
    if (!view) throw new Error(t('app.viewFailed'));
    acceptRestoredRevision(page?.revision);
    if (target.cam) Object.assign(cam, target.cam);
    if (page) {
      state.selected = view.nodes.some(node => node.id === page.selected) ? page.selected : null;
      state.selectedEdge = view.edges.find(edge => edgeKey(edge) === page.selectedEdge) || null;
      state.ctxBox = page.ctxBox;
      renderLabelPanel();
      void hooks.renderDetail(state.selected).catch(() => {});
    }
    constrainCam();
    draw();
    hideBar();
    void savePage(true).catch(() => {});
  } catch (error) {
    if (seq !== reviewSeq) return;
    state.at = eventId;
    changingReview = false;
    showBar();
    alert(error.message || t('app.viewFailed'));
  }
}

restoreBtn?.addEventListener('click', async () => {
  if (!state.at || reviewTransition() || reviewSessionChanged) return;
  const seq = reviewSeq;
  restoringSnapshot = true;
  syncReviewControls();
  try {
    const r = await api.restore(state.at);
    if (seq !== reviewSeq) return;
    if (!r?.ok) throw new Error(r?.error || t('timeline.restoreFailed'));
    state.at = 0;
    hideBar();
    if (r.restoredView) await hooks.restoreTimelineView(r.restoredView, r.eventId);
    else await hooks.reloadAll();
  } catch (error) {
    alert(error.message || t('timeline.restoreFailed'));
  } finally {
    restoringSnapshot = false;
    syncReviewControls();
  }
});

exitBtn?.addEventListener('click', exitReview);

function syncTimelineControls() {
  if (scopeBookmarkWrap) {
    scopeBookmarkWrap.hidden = !state.activeBookmark;
    if (scopeBookmarkCheck) {
      if (!state.activeBookmark) {
        scopeBookmarkCheck.checked = false;
        tl.bookmarkId = null;
      } else {
        tl.bookmarkId = scopeBookmarkCheck.checked ? state.activeBookmark.id : null;
      }
    }
  }
  if (checkpointBtn) {
    checkpointBtn.disabled = state.at > 0 || !!state.view?.comparison || !state.roots.length;
  }
}

window.addEventListener('cg:bookmark-changed', () => {
  syncTimelineControls();
});

btn?.addEventListener('click', () => {
  openModal('timelineModal');
  syncTimelineControls();
  load();
});

scopeBookmarkCheck?.addEventListener('change', () => {
  tl.bookmarkId = scopeBookmarkCheck.checked && state.activeBookmark ? state.activeBookmark.id : null;
  load();
});

async function submitCheckpoint() {
  if (state.at > 0 || state.view?.comparison || !state.roots.length || !checkpointBtn) return;
  checkpointBtn.disabled = true;
  const name = checkpointInput?.value.trim() || `检查点 ${hhmm(Date.now())}`;
  try {
    const r = await api.saveCheckpoint(name, currentViewScope(), state.activeBookmark
      ? { bookmarkId: state.activeBookmark.id, bookmarkName: state.activeBookmark.name }
      : {});
    if (!r?.ok) throw new Error(r?.error || '记录检查点失败');
    if (checkpointInput) checkpointInput.value = '';
    await load();
  } catch (err) {
    alert(err.message || '记录检查点失败');
  } finally {
    syncTimelineControls();
  }
}

checkpointBtn?.addEventListener('click', submitCheckpoint);
checkpointInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) submitCheckpoint();
});

// 搜索：输入 220ms 后触发，避免每敲一个字都打一次库
let searchTimer = null;
searchEl?.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    tl.q = searchEl.value.trim();
    load();
  }, 220);
});

chipsEl?.querySelectorAll('button').forEach((chip) => {
  chip.addEventListener('click', () => {
    chipsEl.querySelectorAll('button').forEach((c) => c.classList.toggle('on', c === chip));
    tl.level = chip.dataset.level || '';
    tl.ops = chip.dataset.ops ? chip.dataset.ops.split(',').filter(Boolean) : [];
    load();
  });
});

// 回看模式下试图编辑：横幅抖一下提示，不做静默失败
document.addEventListener('cg:review-blocked', () => {
  if (!bar) return;
  bar.classList.remove('blocked');
  void bar.offsetWidth;
  bar.classList.add('blocked');
  if (barText) {
    const eventId = state.at;
    barText.textContent = t('timeline.blocked');
    setTimeout(() => { if (state.at === eventId && bar.classList.contains('show')) showBar(); }, 1600);
  }
});

wireModals();

export function reloadTimeline() {
  if (document.getElementById('timelineModal')?.classList.contains('show')) return load();
}

document.addEventListener('callgraph:langchange', () => {
  setCount();
  renderAll();
  if (state.at) showBar();
});

export { exitReview, reviewAt, hideBar };
