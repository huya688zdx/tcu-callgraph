/**
 * 操作时间轴：列出事件、回看历史某一刻、恢复到此
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
const bar = document.getElementById('reviewBar');
const barText = document.getElementById('reviewText');
const restoreBtn = document.getElementById('reviewRestore');
const exitBtn = document.getElementById('reviewExit');

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
};

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
  const same = d.toDateString() === today.toDateString();
  return same ? '今天' : `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
};

/** 把一条事件翻译成人话：用户看时间轴时不该看到 op 名 */
function describe(e) {
  const after = e.after || {};
  const target = e.target || '';
  switch (e.op) {
    case 'node.annotate':
    case 'edge.annotate': {
      const bits = [];
      if (after.change) bits.push(CHANGE_LABEL[after.change] || after.change);
      if (after.note) bits.push(`备注「${after.note}」`);
      if (after.tag) bits.push(`标签 ${after.tag}`);
      if (after.color) bits.push('标记颜色');
      return `${target} → ${bits.join(' · ') || '清空标注'}`;
    }
    case 'delete': {
      const n = (after.nodes || []).length;
      const m = (after.edges || []).length;
      return `${n ? `${n} 个函数` : ''}${n && m ? ' / ' : ''}${m ? `${m} 条连线` : ''} 被删除`;
    }
    case 'delete.restore': {
      const n = (after.nodes || []).length;
      const m = (after.edges || []).length;
      return `恢复 ${n ? `${n} 个函数` : ''}${n && m ? ' / ' : ''}${m ? `${m} 条连线` : ''}`;
    }
    case 'delete.clear':
      return '清空全部删除记录';
    case 'layout.save':
      return `${target || '视图'} 调整布局`;
    case 'layout.clear':
      return `${target || '视图'} 重置布局`;
    case 'baseline':
      return '打开工程（历史起点）';
    case 'import':
      return '导入旧版 out/overlay.json';
    case 'restore_point':
      return `恢复到 ${target || '历史时刻'}`;
    case 'bookmark.save':
      return `保存书签「${target}」`;
    case 'bookmark.delete':
      return `删除书签「${target}」`;
    default:
      return t(`op.${e.op}`) || e.op;
  }
}

async function render() {
  if (!listEl) return;
  listEl.innerHTML = `<div class="empty">${t('timeline.empty')}</div>`;
  let data;
  try {
    data = await api.events(300);
  } catch {
    return;
  }
  const events = data.events || [];
  if (!events.length) return;

  let html = `<div class="hint" style="padding:0 9px 6px">${t('timeline.hint')}</div>`;
  let lastDay = '';
  for (const e of events) {
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
        <div class="sub">${hhmm(e.ts)}${e.actor === 'system' ? ' · 系统' : ''}</div>
      </div>
    </div>`;
  }
  listEl.innerHTML = html;

  listEl.querySelectorAll('.ev').forEach((row) => {
    row.addEventListener('click', () => reviewAt(Number(row.dataset.id), Number(row.dataset.ts)));
  });
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
  if (listEl) listEl.querySelectorAll('.ev').forEach((r) => r.classList.toggle('on', Number(r.dataset.id) === eventId));
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
  render();
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

export { exitReview, reviewAt, hideBar };
