/** 从画布或文件树里的函数发起局部层级查找。 */
import { t } from '../i18n.js';
import { state, edgeKey } from './state.js';
import { hooks } from './hooks.js';
import { api } from './api.js';
import { openModal, closeModal, esc } from './modal.js';
import { isDataEdge } from './edge-flow.js';

const pickList = document.getElementById('addFunctionsList');
const pickApply = document.getElementById('addFunctionsApply');
const pickAll = document.getElementById('addFunctionsAll');
const pickMessage = document.getElementById('addFunctionsMessage');
const pickModal = document.getElementById('addFunctionsModal');
const pickScope = document.getElementById('addFunctionsScope');
const pickControls = document.getElementById('addFunctionsControls');
const pickCustomDepth = document.getElementById('addFunctionsCustomDepth');
let previewOptions = null;
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
  const additions = [count && t('common.functionCount', { n: count }), varCount && t('common.variableCount', { n: varCount })].filter(Boolean).join(' · ');
  pickApply.textContent = additions ? t('expand.confirmCount', { items: additions })
    : missingEdges.length ? t('expand.confirmLinks', { n: missingEdges.length }) : t('callOrder.apply');
  for (const button of pickList.querySelectorAll('[data-pick-group]')) {
    const rows = button.closest('section').querySelectorAll('input');
    button.textContent = t([...rows].every(row => row.checked) ? 'expand.clearGroup' : 'expand.selectGroup');
  }
}

function pickRow(node, { group, checked = false, varId, version, chips = [], description = '' }) {
  const key = JSON.stringify([group, node.id, varId, version]);
  const selected = previewOptions.checked.get(key) ?? checked;
  const details = [node.file && (node.line ? `${node.file}:${node.line}` : node.file), description].filter(Boolean);
  return `<label class="function-pick"><input type="checkbox" data-pick-key="${esc(key)}" data-function-id="${esc(node.id)}"${varId ? ` data-var-id="${esc(varId)}"` : ''}${selected ? ' checked' : ''}>
    <span class="function-pick-info"><b>${esc(node.name)}</b>${chips.length ? `<span class="function-pick-chips">${chips.join('')}</span>` : ''}
    ${details.map(text => `<small>${esc(text)}</small>`).join('')}</span></label>`;
}

const chip = (text, style = '') => `<span class="chip${style ? ' ' + style : ''}">${esc(text)}</span>`;
function pickGroup(group, title, rows) {
  const toggle = rows ? `<button type="button" data-pick-group>${esc(t('expand.selectGroup'))}</button>` : '';
  return `<section class="function-pick-group ${group}"><div class="function-pick-heading"><h3>${esc(title)}</h3>${toggle}</div>
    ${rows || `<p class="empty">${esc(t('expand.noCandidates'))}</p>`}</section>`;
}

// 每个方向独立广搜，同一个函数在递归链上可能既是调用方也是被调函数。
function callPaths(root, adjacent, depth) {
  const paths = new Map([[root, [root]]]);
  let frontier = [root];
  for (let level = 0; level < depth && frontier.length; level++) {
    const next = [];
    for (const id of frontier) {
      for (const peer of adjacent.get(id) || []) {
        if (paths.has(peer)) continue;
        paths.set(peer, [...paths.get(id), peer]);
        next.push(peer);
      }
    }
    frontier = next;
  }
  paths.delete(root);
  return paths;
}

function renderRecommendations(fn, view, dataflow, shown) {
  const rec = view.recommendations || {};
  const hidden = new Set(rec.hiddenIds || []);
  if (hidden.has(fn.id)) return;
  const nodes = new Map(view.nodes.filter(node => node.kind !== 'var' && !hidden.has(node.id)).map(node => [node.id, node]));
  const target = nodes.get(fn.id);
  const name = target?.name || fn.name;
  document.getElementById('addFunctionsTarget').textContent = name;
  const targetRow = target && !shown.has(fn.id)
    ? `<div class="function-pick-target">${pickRow(target, {
      group: 'target', checked: true, chips: [chip(t('expand.targetBadge'))],
      description: t('expand.targetAddition'),
    })}</div>` : '';

  const incoming = new Map();
  const outgoing = new Map();
  for (const edge of view.edges) {
    if (isDataEdge(edge) || !nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    incoming.get(edge.to).push(edge.from);
    outgoing.get(edge.from).push(edge.to);
  }
  const upstream = callPaths(fn.id, incoming, previewOptions.up);
  const downstream = callPaths(fn.id, outgoing, previewOptions.down);
  const callNumbers = new Map((rec.callSequence?.callees || []).map(node => [node.id, node.callNumbers]));
  const callGroup = (paths, group, badge, style) => {
    const rows = [...paths].filter(([id]) => !shown.has(id)).map(([id, path]) => {
      const isUp = group === 'up';
      const names = (isUp ? [...path].reverse() : path).map(id => nodes.get(id).name);
      const order = !isUp && path.length === 2 ? callNumbers.get(id) : null;
      const chips = [chip(t(badge), style)];
      if (order?.length) chips.push(chip(t('expand.callOrder', { n: order.join(' / ') })));
      return pickRow(nodes.get(id), { group, checked: true, chips, description: names.join(' → ') });
    });
    return pickGroup(group, t(`expand.group.${group}`, { name, n: rows.length }), rows.join(''));
  };

  const siblings = new Map();
  for (const node of rec.callSequence?.siblings || []) {
    if (node.id === fn.id || shown.has(node.id) || hidden.has(node.id) || hidden.has(node.callerId) ||
        upstream.has(node.id) || downstream.has(node.id)) continue;
    if (!siblings.has(node.id)) siblings.set(node.id, { node, labels: new Set() });
    const position = node.position || 'same';
    siblings.get(node.id).labels.add(t(`expand.sibling.${position}`, { name: node.callerName }));
  }
  const siblingRows = [...siblings.values()].map(({ node, labels }) =>
    pickRow(node, { group: 'siblings', chips: [...labels].map(label => chip(label)) })).join('');

  const canRestoreVars = !state.at && !state.view?.comparison;
  const sharedVars = (dataflow?.vars || []).filter(v => canRestoreVars || !hidden.has(v.id));
  const accessByVariable = new Map();
  for (const v of sharedVars) {
    const key = `${v.version || ''}|${v.id}`;
    if (!accessByVariable.has(key)) accessByVariable.set(key, { write: new Set(), read: new Set() });
    const counts = accessByVariable.get(key);
    const opposite = v.mode === 'write' ? 'read' : 'write';
    counts[v.mode].add(fn.id);
    for (const peer of v.peers) {
      if (!hidden.has(peer.id)) counts[opposite].add(peer.id);
    }
  }
  const dataRows = sharedVars.map(v => {
    const peers = v.peers.filter(peer => !hidden.has(peer.id));
    if (!peers.length) return '';
    const writes = v.mode === 'write';
    const rows = peers.map(peer => pickRow(peer, { group: v.mode, varId: v.id, version: v.version, chips: [
        chip(writes ? t('expand.readVar') : t('expand.writeVar')),
        shown.has(peer.id) ? chip(t('compare.inCanvas')) : '',
      ].filter(Boolean) })).join('');
    const { write, read } = accessByVariable.get(`${v.version || ''}|${v.id}`);
    return `<div class="function-pick-context"><b>${esc(v.name)}</b>
      ${v.version ? chip(t(`compare.version.${v.version}`)) : ''}
      ${chip(t(writes ? 'expand.flow.write' : 'expand.flow.read'))}
      ${chip(t('expand.flow.count', { write: write.size, read: read.size }))}</div>${rows}`;
  }).join('');

  pickList.innerHTML = targetRow +
    (previewOptions.up ? callGroup(upstream, 'up', 'expand.callerBadge', 'caller-chip') : '') +
    (previewOptions.down ? callGroup(downstream, 'down', 'expand.calleeBadge', 'callee-chip') : '') +
    (siblingRows ? pickGroup('siblings', t('expand.group.siblings', { n: siblings.size }), siblingRows) : '') +
    (dataRows ? pickGroup('dataflow', t('expand.group.dataflow'), dataRows) : '');
}

/** 仅预览候选范围；确认时用零层范围加入勾选函数，避免未勾选分支再次展开。 */
export async function previewAddition(fn, depths = state.addDepths) {
  if (!pickList || !state.view || window.__EXPORT) return;
  const name = fn.name || state.view.nodes.find(node => node.id === fn.id)?.name || fn.id.split('::').pop();
  const { up, down } = depths;
  previewOptions = { fn: { ...fn, name }, up, down, customDepth: Math.max(up, down), checked: new Map() };
  openModal('addFunctionsModal');
  const pending = loadPreview();
  const first = pickControls.querySelector('[data-scope-direction][aria-pressed="true"]') ||
    pickControls.querySelector('[data-scope-direction]');
  first?.focus();
  await pending;
}

function previewDirection({ up, down }) {
  if (up && down) return 'both';
  if (up) return 'up';
  if (down) return 'down';
  return '';
}

function syncScopeButtons(root, direction, depth) {
  for (const button of root.querySelectorAll('[data-scope-direction], [data-scope-depth]')) {
    const active = button.dataset.scopeDirection === direction || button.dataset.scopeDepth === String(depth);
    button.setAttribute('aria-pressed', String(active));
  }
}

async function loadPreview() {
  const seq = ++previewSequence;
  const { fn, up, down, customDepth } = previewOptions;
  previewView = state.view;
  previewTarget = fn.id;
  document.getElementById('addFunctionsTarget').textContent = fn.name;
  pickScope.textContent = t('expand.scope', { up, down });
  pickCustomDepth.hidden = customDepth <= 3;
  pickCustomDepth.dataset.scopeDepth = String(customDepth);
  pickCustomDepth.textContent = t('expand.layers', { n: customDepth });
  const depth = up && down && up !== down ? null : Math.max(up, down);
  syncScopeButtons(pickControls, previewDirection(previewOptions), depth);
  pickControls.disabled = false;
  pickList.inert = false;
  pickList.replaceChildren();
  missingEdges = [];
  syncPickCount();
  pickMessage.textContent = t('expand.previewLoading');
  try {
    const [view, dataflow] = await Promise.all([
      api.view({ root: fn.id, up, down, group: false, at: state.at, preview: true }),
      api.dataflow(fn.id, 'both').catch(() => null),
    ]);
    if (seq !== previewSequence || !pickModal.classList.contains('show')) return;
    if (!Array.isArray(view.nodes)) throw new Error(view.error || t('expand.failed'));
    if (state.view !== previewView || view.projectId !== previewView.projectId) throw new Error(t('common.viewChanged'));
    const shown = new Set(previewView.nodes.map((node) => node.id));
    const existingEdges = new Set(previewView.edges.map(edgeKey));
    missingEdges = view.edges.filter((edge) => shown.has(edge.from) && shown.has(edge.to) && !existingEdges.has(edgeKey(edge)));
    renderRecommendations(fn, view, dataflow, shown);
    pickMessage.textContent = missingEdges.length ? t('expand.linkPreview', { n: missingEdges.length })
      : pickList.querySelector('input') ? (view.truncated ? t('expand.limit') : t('expand.cancelHint'))
      : t('expand.noItems');
    syncPickCount();
  } catch (error) { if (seq === previewSequence) pickMessage.textContent = error.message; }
}

pickControls?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-scope-direction], [data-scope-depth]');
  if (!button || !previewOptions || pickControls.disabled) return;
  const current = previewOptions;
  const direction = button.dataset.scopeDirection || previewDirection(current) || 'both';
  const depth = Number(button.dataset.scopeDepth) || Math.max(current.up, current.down, 1);
  const up = direction === 'down' ? 0 : depth;
  const down = direction === 'up' ? 0 : depth;
  if (up === current.up && down === current.down) return;
  for (const input of pickList.querySelectorAll('[data-pick-key]')) {
    current.checked.set(input.dataset.pickKey, input.checked);
  }
  Object.assign(current, { up, down });
  void loadPreview();
});

function ensureTargetForDataflow() {
  const target = pickList.querySelector('.function-pick-target input');
  if (target && pickList.querySelector('[data-var-id]:checked')) target.checked = true;
}

pickList?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-pick-group]');
  if (!button) return;
  const rows = [...button.closest('section').querySelectorAll('input')];
  const select = !rows.every(row => row.checked);
  for (const row of rows) row.checked = select;
  ensureTargetForDataflow();
  syncPickCount();
});

pickList?.addEventListener('change', (event) => {
  const input = event.target;
  if (input.dataset.varId) ensureTargetForDataflow();
  if (input.dataset.functionId === previewTarget && input.closest('.function-pick-target') && !input.checked) {
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
  if (state.view !== previewView) { pickMessage.textContent = t('common.viewChanged'); return; }
  const selected = [...pickList.querySelectorAll('input:checked')];
  const ids = [...new Set(selected.map(input => input.dataset.functionId))];
  const varIds = [...new Set(selected.map(input => input.dataset.varId).filter(Boolean))];
  const seq = previewSequence;
  const edges = missingEdges;
  pickApply.disabled = true;
  pickAll.disabled = true;
  pickControls.disabled = true;
  pickList.inert = true;
  pickMessage.textContent = t('expand.adding');
  try {
    const edgeIds = edges.flatMap((edge) => [edge.from, edge.to]);
    // 预览结果已经过滤了隐藏函数，无需为每个候选单独请求详情。
    const view = await hooks.addFunction([...ids, ...edgeIds], { includeShown: true, restoreHidden: false, varIds });
    const visible = new Set(view?.nodes.map(node => node.id));
    if (!view || ![...ids, ...varIds].every(id => visible.has(id)) ||
        !edges.every(edge => view?.edges.some(item => edgeKey(item) === edgeKey(edge)))) throw new Error(t('common.addFailed'));
    if (seq === previewSequence) closeModal();
  } catch (error) {
    if (seq === previewSequence) {
      pickControls.disabled = false;
      pickList.inert = false;
      pickMessage.textContent = error.message;
      syncPickCount();
    }
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
  syncScopeButtons(form, direction.value, depth.value);
  message.textContent = '';
  apply.disabled = false;
  openModal('expandModal');
  form.querySelector('[data-scope-direction="up"]')?.focus();
}

form?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-scope-direction], [data-scope-depth]');
  if (!button) return;
  if (button.dataset.scopeDirection) direction.value = button.dataset.scopeDirection;
  if (button.dataset.scopeDepth) depth.value = button.dataset.scopeDepth;
  syncScopeButtons(form, direction.value, depth.value);
});
direction?.addEventListener('change', () => syncScopeButtons(form, direction.value, depth.value));
depth?.addEventListener('input', () => syncScopeButtons(form, direction.value, depth.valueAsNumber));

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
