/** 从画布或文件树里的函数发起局部层级查找。 */
import { t } from '../i18n.js';
import { state, edgeKey } from './state.js';
import { hooks } from './hooks.js';
import { api } from './api.js';
import { openModal, closeModal, esc } from './modal.js';
import { formatPeriod, periodText } from './period-text.js';
import { LABEL_PRESETS } from '/core/labels.js';

const pickList = document.getElementById('addFunctionsList');
const pickApply = document.getElementById('addFunctionsApply');
const pickAll = document.getElementById('addFunctionsAll');
const pickMessage = document.getElementById('addFunctionsMessage');
let previewSequence = 0;
let previewView = null;
let previewTarget = null;
let missingEdges = [];

function syncPickCount() {
  const inputs = [...pickList.querySelectorAll('input')];
  const selected = inputs.filter(input => input.checked);
  const shown = new Set(previewView?.nodes.map(node => node.id));
  const count = new Set(selected.map(input => input.dataset.functionId).filter(id => !shown.has(id))).size;
  const varCount = new Set(selected.map(input => input.dataset.varId).filter(Boolean)).size;
  pickAll.checked = !!inputs.length && selected.length === inputs.length;
  pickAll.indeterminate = selected.length > 0 && selected.length < inputs.length;
  pickAll.disabled = !inputs.length;
  pickApply.disabled = !selected.length && !missingEdges.length;
  const additions = [count && `${count} 个函数`, varCount && `${varCount} 个变量`].filter(Boolean).join('、');
  pickApply.textContent = additions ? `确认添加 ${additions}` : missingEdges.length ? `确认补充 ${missingEdges.length} 条关系` : '确认添加';
}

function pickRow(node, { checked = false, varId, chips = [], description = '' } = {}) {
  const details = [node.file && (node.line ? `${node.file}:${node.line}` : node.file), description].filter(Boolean);
  return `<label class="function-pick"><input type="checkbox" data-function-id="${esc(node.id)}"${varId ? ` data-var-id="${esc(varId)}"` : ''}${checked ? ' checked' : ''}>
    <span class="function-pick-info"><b>${esc(node.name)}</b>${chips.length ? `<span class="function-pick-chips">${chips.join('')}</span>` : ''}
    ${details.map(text => `<small>${esc(text)}</small>`).join('')}</span></label>`;
}

const chip = (text, style = '') => `<span class="chip${style ? ' ' + style : ''}">${esc(text)}</span>`;
const pickGroup = (title, rows) => rows ? `<section class="function-pick-group"><h3>${title}</h3>${rows}</section>` : '';
const periodChip = (contexts) => {
  const period = periodText(contexts);
  return period ? chip(period === formatPeriod(null) ? period : `周期 ${period}`) : '';
};

function periodImpact(current, other) {
  const known = periods => new Set((periods || []).map(c => c.us).filter(us => us > 0));
  const own = known(current), peer = known(other);
  if (!own.size || !peer.size) return '';
  return own.size === peer.size && [...own].every(us => peer.has(us))
    ? chip('同周期') : chip('跨周期影响', 'cross-period');
}

function renderRecommendations(fn, view, dataflow, shown, callsByNode) {
  const rec = view.recommendations || {};
  const hidden = new Set(rec.hiddenIds || []);
  if (hidden.has(fn.id)) return;
  const chains = (rec.taskChains || []).filter(chain => !chain.path.some(id => hidden.has(id)));
  const taskIds = new Set();
  const taskRows = chains.map(chain => {
    const rows = chain.nodes.filter(node => !shown.has(node.id) && !taskIds.has(node.id)).map(node => {
      taskIds.add(node.id);
      return pickRow(node, { checked: true });
    });
    return `<div class="function-pick-context" title="${esc(chain.source)}">${chip(`TASK · ${formatPeriod(chain.us)}`)} ${esc(chain.nodes.map(node => node.name).join(' → '))}</div>${rows.join('')}`;
  }).join('');
  const target = view.nodes.find(node => node.id === fn.id && node.kind !== 'var');
  const targetRow = target && !shown.has(fn.id) && !taskIds.has(fn.id)
    ? pickRow(target, { checked: true, chips: [chip('目标函数'), periodChip(rec.target?.taskPeriods)] }) : '';

  const peerIds = new Set();
  const dataRows = (dataflow?.vars || []).filter(v => !hidden.has(v.id)).map(v => {
    const peers = v.peers.filter(peer => !hidden.has(peer.id));
    if (!peers.length) return '';
    const writes = v.mode === 'write';
    const version = v.version ? ` · ${v.version === 'before' ? '修改前' : '修改后'}` : '';
    const rows = peers.map(peer => {
      peerIds.add(peer.id);
      return pickRow(peer, { varId: v.id, chips: [
        chip(writes ? '读变量' : '写变量'), periodChip(peer.taskPeriods) || chip('周期待确认'),
        periodImpact(dataflow.fn?.taskPeriods || rec.target?.taskPeriods, peer.taskPeriods),
        shown.has(peer.id) ? chip('已在画布') : '',
      ] });
    }).join('');
    return `<div class="function-pick-context"><b>${esc(v.name)}</b> ${chip(`目标函数${writes ? '写' : '读'}${version}`)}</div>${rows}`;
  }).join('');

  const calls = new Map();
  const relatedPeriods = new Map(rec.relatedPeriods || []);
  const canAdd = id => id !== fn.id && !shown.has(id) && !taskIds.has(id) && !peerIds.has(id) && !hidden.has(id);
  const addCall = (node, relation) => {
    if (!canAdd(node.id)) return;
    if (!calls.has(node.id)) calls.set(node.id, { node, descriptions: [] });
    const order = node.callNumbers?.length ? ` · ${LABEL_PRESETS.call.text}${node.callNumbers.join('、')}` : '';
    calls.get(node.id).descriptions.push(relation + order);
  };
  for (const node of rec.callSequence?.callees || []) addCall(node, '被调函数');
  const positions = { before: '前序调用', after: '后序调用', same: '同组或交错调用' };
  for (const node of rec.callSequence?.siblings || []) {
    if (!hidden.has(node.callerId)) addCall(node, `${node.callerName} · ${positions[node.position]}`);
  }
  for (const node of view.nodes) {
    if (node.kind !== 'var' && !calls.has(node.id)) {
      addCall({ ...node, taskPeriods: relatedPeriods.get(node.id) }, callsByNode.get(node.id)?.join('；') || '查找范围内');
    }
  }
  const callRows = [...calls.values()].map(({ node, descriptions }) => pickRow(node, {
    checked: !chains.length && !peerIds.size,
    chips: [periodChip(node.taskPeriods)].filter(Boolean),
    description: descriptions.join('；'),
  })).join('');

  pickList.innerHTML = targetRow +
    pickGroup('所属 TASK 周期溯源链', taskRows) +
    pickGroup('共享变量与读写影响函数', dataRows) +
    pickGroup('先后调用顺序', callRows);
}

/** 仅预览候选范围；确认时用零层范围加入勾选函数，避免未勾选分支再次展开。 */
export async function previewAddition(fn, depths = state.addDepths) {
  if (!pickList || !state.view || window.__EXPORT) return;
  const seq = ++previewSequence;
  previewView = state.view;
  previewTarget = fn.id;
  const { up, down } = depths;
  document.getElementById('addFunctionsTarget').textContent = fn.name || fn.id.split('::').pop();
  document.getElementById('addFunctionsScope').textContent = `查找调用者 ${up} 层 / 被调用函数 ${down} 层。`;
  pickList.replaceChildren();
  missingEdges = [];
  syncPickCount();
  pickMessage.textContent = '正在查找，画布尚未改动…';
  openModal('addFunctionsModal');
  try {
    const [view, dataflow] = await Promise.all([
      api.view({ root: fn.id, up, down, group: false, at: state.at, preview: true }),
      api.dataflow(fn.id, 'both').catch(() => null),
    ]);
    if (seq !== previewSequence) return;
    if (!Array.isArray(view.nodes)) throw new Error(view.error || '查找失败，请重试');
    if (state.view !== previewView || view.projectId !== previewView.projectId) throw new Error('画布已变化，请重新预览');
    const shown = new Set(previewView.nodes.map((node) => node.id));
    const names = new Map(view.nodes.map((node) => [node.id, node.name]));
    const existingEdges = new Set(previewView.edges.map(edgeKey));
    const callsByNode = new Map();
    for (const [i, edge] of view.edges.entries()) {
      const order = view.recommendations?.edgeOrders?.[i];
      const suffix = order?.length ? ` · ${LABEL_PRESETS.call.text}${order.join('、')}` : '';
      const label = `${names.get(edge.from) || edge.from} → ${names.get(edge.to) || edge.to}${suffix}`;
      for (const id of new Set([edge.from, edge.to])) {
        if (!callsByNode.has(id)) callsByNode.set(id, []);
        callsByNode.get(id).push(label);
      }
    }
    missingEdges = view.edges.filter((edge) => shown.has(edge.from) && shown.has(edge.to) && !existingEdges.has(edgeKey(edge)));
    renderRecommendations(fn, view, dataflow, shown, callsByNode);
    pickMessage.textContent = missingEdges.length ? `已有函数之间可补充 ${missingEdges.length} 条关系，取消不会改动画布`
      : pickList.querySelector('input') ? (view.truncated ? '查找已达上限，可减少层数后重试' : '取消不会改动画布')
      : '没有可添加的函数或变量';
    syncPickCount();
  } catch (error) { if (seq === previewSequence) pickMessage.textContent = error.message; }
}

pickList?.addEventListener('change', (event) => {
  const input = event.target;
  const target = [...pickList.querySelectorAll('input')].find(row => row.dataset.functionId === previewTarget);
  if (input.dataset.varId && input.checked && target) target.checked = true;
  if (input === target && !target.checked) {
    pickList.querySelectorAll('[data-var-id]').forEach(row => { row.checked = false; });
  }
  syncPickCount();
});
pickAll?.addEventListener('change', () => {
  pickList.querySelectorAll('input').forEach((input) => { input.checked = pickAll.checked; });
  syncPickCount();
});
pickApply?.addEventListener('click', async () => {
  if (pickApply.disabled) return;
  if (state.view !== previewView) { pickMessage.textContent = '画布已变化，请重新预览'; return; }
  const selected = [...pickList.querySelectorAll('input:checked')];
  const ids = [...new Set(selected.map(input => input.dataset.functionId))];
  const varIds = [...new Set(selected.map(input => input.dataset.varId).filter(Boolean))];
  const seq = previewSequence;
  const originalView = previewView;
  const edges = missingEdges;
  const vars = state.vars, hiddenVars = state.hiddenVars;
  const varChanges = varIds.map(id => ({ id, included: vars.has(id), hidden: hiddenVars.has(id) }));
  pickApply.disabled = true;
  pickMessage.textContent = '正在加入…';
  try {
    const edgeIds = edges.flatMap((edge) => [edge.from, edge.to]);
    for (const id of varIds) {
      vars.add(id);
      hiddenVars.delete(id);
    }
    // 预览结果已经过滤了隐藏函数，无需为每个候选单独请求详情。
    const view = await hooks.addFunction([...ids, ...edgeIds], { includeShown: true, restoreHidden: false });
    const visible = new Set(view?.nodes.map(node => node.id));
    if (!view || ![...ids, ...varIds].every(id => visible.has(id)) ||
        !edges.every(edge => view?.edges.some(item => edgeKey(item) === edgeKey(edge)))) throw new Error('加入失败，请重试');
    if (seq === previewSequence) closeModal();
  } catch (error) {
    if (state.view === originalView && state.vars === vars && state.hiddenVars === hiddenVars) {
      for (const { id, included, hidden } of varChanges) {
        if (!included) vars.delete(id);
        if (hidden) hiddenVars.add(id);
      }
    }
    if (seq === previewSequence) { pickMessage.textContent = error.message; syncPickCount(); }
  }
});
document.getElementById('addFunctionsCancel')?.addEventListener('click', closeModal);

const form = document.getElementById('expandForm');
const direction = document.getElementById('expandDirection');
const depth = document.getElementById('expandDepth');
const message = document.getElementById('expandMessage');
const apply = document.getElementById('expandApply');
let target = null;
let sequence = 0;

export function showExpansion(fn) {
  if (!form || !state.view) return;
  sequence++;
  target = { root: fn.id, projectId: state.view.projectId, comparisonId: state.view.comparison?.id };
  document.getElementById('expandFunction').textContent = fn.name || fn.label || fn.id;
  direction.value = 'up';
  depth.value = '1';
  message.textContent = '';
  apply.disabled = false;
  openModal('expandModal');
  depth.focus();
  depth.select();
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (apply.disabled || !target || !form.reportValidity()) return;
  const seq = sequence;
  const current = target;
  if (current.projectId !== state.view?.projectId || current.comparisonId !== state.view?.comparison?.id) {
    message.textContent = t('expand.projectChanged');
    return;
  }
  apply.disabled = true;
  message.textContent = t('expand.loading');
  try {
    await previewAddition({ id: current.root, name: document.getElementById('expandFunction').textContent },
      { up: direction.value === 'up' ? Number(depth.value) : 0, down: direction.value === 'down' ? Number(depth.value) : 0 });
    if (seq !== sequence) return;
  } catch (err) {
    if (seq === sequence) message.textContent = err.message || t('expand.failed');
  } finally {
    if (seq === sequence) apply.disabled = false;
  }
});
