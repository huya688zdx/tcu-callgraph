/** 函数右键查找コール順，用户确认后才写入标签。 */
import { t } from '../i18n.js';
import { state, edgeKey, esc } from './state.js';
import { api } from './api.js';
import { hooks } from './hooks.js';
import { openModal, closeModal } from './modal.js';
import { edgeLabels, makeLabel, applyLabels } from './edge-labels.js';
import { LABELS_MAX } from '/core/labels.js';
import { draw } from './render.js';
import { pushHistory } from './history.js';

const modal = document.getElementById('callOrderModal');
const body = document.getElementById('callOrderList');
const confirm = document.getElementById('callOrderApply');
const message = document.getElementById('callOrderMessage');
let sequence = 0;
let pending = null;
let applying = false;

function syncConfirm() {
  confirm.disabled = applying || !pending || !body.querySelector('input:checked:not(:disabled)');
}

export async function findCallOrder(fnId) {
  if (!modal) return;
  const seq = ++sequence;
  const projectId = state.view?.projectId;
  pending = null;
  confirm.disabled = true;
  message.textContent = '';
  body.innerHTML = `<div class="empty">${t('callOrder.loading')}</div>`;
  openModal('callOrderModal');
  try {
    const [result, preview] = await Promise.all([
      api.detectTasks(fnId),
      api.view({ roots: [fnId], up: 0, down: 1, group: false, at: state.at }),
    ]);
    if (seq !== sequence || projectId !== state.view?.projectId || !modal.classList.contains('show')) return;
    if (!result?.ok || !preview.edges) throw new Error(result?.error || preview.error || t('callOrder.failed'));
    const byKey = new Map(preview.edges.map((e) => [edgeKey(e), e]));
    const nodes = new Map(preview.nodes.map((n) => [n.id, n]));
    const source = nodes.get(fnId);
    const rows = result.suggestions.filter((s) => s.kind === 'call').map((s) => ({ suggestion: s, edge: byKey.get(s.edgeKey) }));
    pending = { projectId, fnId, rows };
    const items = rows.map(({ suggestion: s, edge }, index) => {
      const labels = edgeLabels(edge);
      const previous = labels.find((l) => l.preset === 'call');
      const disabled = !edge || !previous && labels.length >= LABELS_MAX;
      const status = !edge ? 'callOrder.unavailable' : disabled ? 'callOrder.full' : previous ? 'callOrder.marked' : null;
      return `<label class="call-order-row${disabled ? ' unavailable' : ''}" title="${esc(s.evidence)}">
        <input type="checkbox" data-index="${index}" ${disabled ? 'disabled' : 'checked'}>
        <span class="call-order-number">${esc(s.text)}</span>
        <span class="call-order-target"><b>${esc(nodes.get(s.to)?.name || s.to.split('::').pop())}</b><small>${esc(source?.file || '')}:${s.line}</small></span>
        <span class="call-order-status">${status ? t(status) : ''}</span>
      </label>`;
    }).join('');
    const warnings = (result.skipped || []).map((s) => `<p class="detail-meta">${esc(s.reason)}</p>`).join('');
    body.innerHTML = `<div class="detail-title">${esc(source?.name || fnId.split('::').pop())}</div>
      ${items ? `<p class="detail-meta">${t('callOrder.hint')}</p>${items}` : warnings || `<div class="empty">${t('callOrder.empty')}</div>`}`;
    syncConfirm();
  } catch (error) {
    if (seq !== sequence || projectId !== state.view?.projectId || !modal.classList.contains('show')) return;
    pending = null;
    body.innerHTML = `<div class="empty">${esc(error.message || t('callOrder.failed'))}</div>`;
  }
}

async function applySelected() {
  const session = pending;
  if (applying || !session || session.projectId !== state.view?.projectId) return;
  const chosen = [...body.querySelectorAll('input:checked:not(:disabled)')].map((input) => session.rows[Number(input.dataset.index)]);
  if (!chosen.length) return;
  applying = true;
  syncConfirm();
  const view = state.view;
  const current = new Map(view.edges.map((e) => [edgeKey(e), e]));
  const expand = chosen.some(({ suggestion: s }) => !current.has(s.edgeKey));
  try {
    for (const { suggestion: s, edge } of chosen) {
      const labels = structuredClone(edgeLabels(edge));
      const previous = labels.find((l) => l.preset === 'call');
      if (previous?.text === s.text) continue;
      if (previous) previous.text = s.text;
      else labels.push({ ...makeLabel('call', edge), text: s.text });
      const result = await api.overlay({ edgeKey: s.edgeKey, data: { labels }, projectId: session.projectId });
      if (!result?.ok) throw new Error(result?.error === 'review-mode' ? t('timeline.blocked') : result?.error || t('callOrder.failed'));
      if (state.view?.projectId !== session.projectId) return;
      const target = current.get(s.edgeKey);
      if (state.view === view && target) applyLabels(target, labels);
    }
    if (state.view === view) {
      if (expand) await hooks.loadView([...new Set([...state.roots, session.fnId])], { incremental: true });
      else { draw(); pushHistory(); }
    }
    if (pending === session) { pending = null; closeModal(); }
  } catch (error) {
    if (pending === session) message.textContent = error.message || t('callOrder.failed');
  } finally {
    applying = false;
    syncConfirm();
  }
}

body?.addEventListener('change', syncConfirm);
confirm?.addEventListener('click', () => { void applySelected(); });
document.getElementById('callOrderCancel')?.addEventListener('click', closeModal);
