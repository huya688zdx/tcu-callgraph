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
import { state } from './state.js';
import { hooks } from './hooks.js';
import { openModal, closeModal, wireModals, esc } from './modal.js';

const btn = document.getElementById('timelineBtn');
const listEl = document.getElementById('timelineList');
const searchEl = document.getElementById('tlSearch');
const chipsEl = document.getElementById('tlChips');
const countEl = document.getElementById('tlCount');
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
};

/** 面板状态：已加载的事件、过滤条件、翻页游标 */
const tl = { events: [], ops: [], q: '', hasMore: false, total: 0, loading: false, seq: 0 };

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
    case 'bookmark.save':
      return [t('op.bookmark.save'), b.roots ? t('common.scopeCount', { n: b.roots }) : ''].filter(Boolean).join(' · ');
    case 'bookmark.delete':
      return t('op.bookmark.delete');
    case 'view.compose': {
      const reason = b.reason ?? (target.includes('::') ? '' : target);
      const caption = b.count == null ? t('timeline.compose') : t('timeline.composeCount', { n: b.count });
      return [caption, reason].filter(Boolean).join(' · ');
    }
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
    if (previous && previous.day === day && previous.event.op === event.op &&
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
    const displayTarget = kind === 'Layout' ? target.replace(/::(?:group|flat)$/, '')
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
async function load({ append = false } = {}) {
  if (append && tl.loading) return;
  tl.loading = true;
  const seq = ++tl.seq;
  const before = append && tl.events.length ? tl.events[tl.events.length - 1].id : 0;
  try {
    const r = await api.events({ limit: PAGE, before, ops: tl.ops, q: tl.q });
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
  setCount();
  renderAll();
}

function showBar(ts) {
  if (!bar) return;
  barText.textContent = `${t('timeline.reviewing')} · ${dayLabel(ts)} ${hhmm(ts)}`;
  bar.classList.add('show');
}

function hideBar() {
  bar?.classList.remove('show');
}

/** 进入回看：把 state.at 指到某个事件，重新拉一次视图 */
async function reviewAt(eventId, ts) {
  state.at = eventId;
  showBar(ts || Date.now());
  closeModal();
  await hooks.loadView(state.roots.length ? state.roots : state.root, { nav: false });
  if (listEl) {
    listEl.querySelectorAll('.ev').forEach((r) => r.classList.toggle('on', Number(r.dataset.id) === eventId));
  }
}

async function exitReview() {
  if (!state.at) return;
  state.at = 0;
  hideBar();
  await hooks.loadView(state.roots.length ? state.roots : state.root, { nav: false });
}

restoreBtn?.addEventListener('click', async () => {
  if (!state.at) return;
  restoreBtn.disabled = true;
  try {
    const r = await api.restore(state.at);
    if (r && r.ok) {
      state.at = 0;
      hideBar();
      await hooks.reloadAll();
    }
  } finally {
    restoreBtn.disabled = false;
  }
});

exitBtn?.addEventListener('click', exitReview);

btn?.addEventListener('click', () => {
  openModal('timelineModal');
  load();
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
    const prev = barText.textContent;
    barText.textContent = t('timeline.blocked');
    setTimeout(() => (barText.textContent = prev), 1600);
  }
});

wireModals();

export function reloadTimeline() {
  if (document.getElementById('timelineModal')?.classList.contains('show')) return load();
}

document.addEventListener('callgraph:langchange', () => {
  setCount();
  renderAll();
  if (state.at) showBar(tl.events.find(event => event.id === state.at)?.ts || Date.now());
});

export { exitReview, reviewAt, hideBar };
