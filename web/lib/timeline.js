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
const CHANGE_LABEL = { existing: '既存', added: '追加', deleted: '删除', changed: '变更' };

const OP_KIND = {
  'node.annotate': 'k-annotate',
  'edge.annotate': 'k-annotate',
  'delete': 'k-delete',
  'delete.restore': 'k-delete',
  'delete.clear': 'k-delete',
  'layout.save': 'k-layout',
  'layout.clear': 'k-layout',
  baseline: 'k-anchor',
  import: 'k-anchor',
  restore_point: 'k-anchor',
  'orphan.purge': 'k-delete',
  'bookmark.save': 'k-anchor',
  'bookmark.delete': 'k-anchor',
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
    ? '今天'
    : `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
};

const pair = (a, b, sep) => (a && b ? sep : '');

/** 把一条事件翻译成人话：用户看时间轴时不该看到 op 名 */
function describe(e) {
  const b = e.brief || {};
  const target = e.target || '';
  switch (e.op) {
    case 'node.annotate':
    case 'edge.annotate': {
      const bits = [];
      if (b.change) bits.push(CHANGE_LABEL[b.change] || b.change);
      if (b.note) bits.push(`备注「${b.note}」`);
      if (b.tag) bits.push(`标签 ${b.tag}`);
      if (b.color) bits.push('标记颜色');
      return `${target} → ${bits.join(' · ') || '清空标注'}`;
    }
    case 'delete':
      return `${b.nodes ? `${b.nodes} 个函数` : ''}${pair(b.nodes, b.edges, ' / ')}${b.edges ? `${b.edges} 条连线` : ''} 被删除`;
    case 'delete.restore':
      return `恢复 ${b.nodes ? `${b.nodes} 个函数` : ''}${pair(b.nodes, b.edges, ' / ')}${
        b.edges ? `${b.edges} 条连线` : ''
      }`;
    case 'delete.clear':
      return '清空全部删除记录';
    case 'layout.save':
      return `${target || '视图'} 调整布局${b.nodes ? `（${b.nodes} 个节点）` : ''}`;
    case 'layout.clear':
      return `${target || '视图'} 重置布局`;
    case 'baseline':
      return '打开工程（历史起点）';
    case 'import':
      return '导入旧版 out/overlay.json';
    case 'session.import': {
      const im = b.import || {};
      const base = `导入会话「${target}」· 标注 ${im.annotations || 0} · 布局 ${im.layout || 0} · 书签 ${
        im.bookmarks || 0
      }`;
      return b.codeMismatch ? base + '（代码版本不一致）' : base;
    }
    case 'restore_point':
      return `恢复到 ${target || '历史时刻'}`;
    case 'bookmark.save':
      return `保存书签「${target}」${b.roots ? ` · ${b.roots} 个入口` : ''}`;
    case 'bookmark.delete':
      return `删除书签「${target}」`;
    case 'orphan.purge':
      return `清理 ${b.total || 0} 条失效标注`;
    default:
      return t(`op.${e.op}`) || e.op;
  }
}

function renderAll() {
  if (!listEl) return;
  if (!tl.events.length) {
    listEl.innerHTML = `<div class="empty">${tl.q || tl.ops.length ? t('timeline.none') : t('timeline.empty')}</div>`;
    return;
  }

  let html = '';
  let lastDay = '';
  for (const e of tl.events) {
    const dk = dayKey(e.ts);
    if (dk !== lastDay) {
      lastDay = dk;
      html += `<div class="ev-day">${dayLabel(e.ts)}</div>`;
    }
    const kind = OP_KIND[e.op] || '';
    const on = state.at === e.id ? ' on' : '';
    html += `<div class="ev ${kind}${on}" data-id="${e.id}" data-ts="${e.ts}">
      <span class="dot"></span>
      <div style="flex:1;min-width:0">
        <div class="txt">${esc(describe(e))}</div>
        <div class="sub">${hhmm(e.ts)}${e.actor === 'system' ? ' · 系统' : ''}${
          e.actor === 'ai' ? ' <span class="ai-badge">AI</span>' : ''
        }</div>
      </div>
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
  if (tl.loading) return;
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
    tl.events = [];
    tl.hasMore = false;
    tl.total = 0;
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

export { exitReview, reviewAt, hideBar, load as reloadTimeline };
