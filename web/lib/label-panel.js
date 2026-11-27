import { edgeCaption, edgeDirection } from './edge-flow.js';
/**
 * 右侧「连线标签」面板：只在选中连线时出现。
 *
 * 一条连线可以挂多条标签（任务 / 結合点 / コール順并存）：
 *   - 列表区：每条一行（预设样式演示 + 摘要 + 删除），点击行选中（画布上虚线框）；
 *   - 编辑区：按当前标签类型展示控件，颜色和边框默认折叠；
 *   - 添加区：按预设添加；结合点在「固定编号」模式下先挑编号（空缺号 + 下一号）；
 *   - 编号模式：固定 / 自动重排，重排模式下删除结合点会自动紧凑成 1..n；
 *   - 自动检测：服务端扫源码给出 TASK 建议；コール順 从函数右键查找。
 *
 * 与画布的分工不变：这里只负责表单与落库（edge-labels 的 save 系）；
 * 位置、避让、命中都在 edge-labels / core/labels 里，面板不碰几何。
 */
import { t } from '../i18n.js';
import { els, state, esc, edgeKey, nodeById } from './state.js';
import { draw } from './render.js';
import { pushHistory } from './history.js';
import { api } from './api.js';
import { CONN_PREFIX, LABEL_PRESETS, LABELS_MAX, numberedCallLabel, visibleCallOrderMap } from '/core/labels.js';
import {
  edgeLabels,
  visibleEdgeLabels,
  promoteAutoLabel,
  applyLabels,
  persistLabels,
  makeLabel,
  connChoices,
  afterConnDelete,
} from './edge-labels.js';
import { hooks } from './hooks.js';
import { statusControl, bindStatusControl } from './change-status.js';

const LABEL_NAMES = { call: 'label.callOrder', task: 'label.taskPeriod', conn: 'label.conn', free: 'label.free', custom: 'label.custom' };
const TRUNK_ARROWS = { forward: '→', reverse: '←', both: '↔', unknown: '—' };

const selectedId = (edge) => {
  const s = state.selectedLabel || '';
  const i = s.lastIndexOf('#');
  return i > 0 && s.slice(0, i) === edgeKey(edge) ? s.slice(i + 1) : null;
};

let connMode = null; // 'fixed' | 'renumber'，懒加载
async function ensureMode() {
  if (connMode) return connMode;
  const cfg = await api.labelConfig().catch(() => ({ mode: 'fixed' }));
  connMode = cfg.mode === 'renumber' ? 'renumber' : 'fixed';
  return connMode;
}

let saveTimer = null;
// 待落库的那条边：面板重绘 / 换选中时要把这次保存**冲掉再换**，不能直接丢
let pendingEdge = null;
let pendingProjectId = null;

function flushPendingSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const edge = pendingEdge;
  const projectId = pendingProjectId;
  pendingEdge = null;
  if (edge) commit(edge, projectId);
}

function scheduleCommit(edge, delay = 160) {
  flushPendingSave();
  pendingEdge = edge;
  const projectId = pendingProjectId = state.view?.projectId;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    pendingEdge = null;
    commit(edge, projectId);
  }, delay);
}

function nodeName(id) {
  const n = state.view?.nodes.find((x) => x.id === id);
  return n ? n.name || n.id : id;
}

export function edgeAiDetail(edge) {
  const name = (id) => {
    const node = nodeById(id);
    return node?.displayName || node?.name || id;
  };
  return {
    kind: 'edge',
    edgeKey: edgeKey(edge),
    from: edge.from,
    to: edge.to,
    fromName: name(edge.from),
    toName: name(edge.to),
    line: edge.line || 0,
    edgeKind: edge.kind || 'direct',
    change: edge.change || 'existing',
    labels: edgeLabels(edge).map(({ preset, text, note }) => ({ preset, text, note: note || '' })),
  };
}

/** 保存后统一收尾：重绘 + 记一步撤销（标签不在布局存档里，但快照里带着） */
async function commit(edge, projectId = state.view?.projectId) {
  applyLabels(edge, edge.labels);
  draw();
  try {
    await persistLabels(edge, projectId);
    if (state.view?.projectId === projectId) pushHistory();
    return true;
  } catch (error) {
    alert(t('label.notSaved', { error: error.message }));
    return false;
  }
}

/** 删一条标签；结合点删除后按编号模式收尾（重排 → 紧凑） */
async function removeLabel(edge, id) {
  const target = edgeLabels(edge).find((l) => l.id === id);
  const wasConn = target && target.preset === 'conn';
  applyLabels(edge, edgeLabels(edge).filter((l) => l.id !== id));
  if (state.selectedLabel === `${edgeKey(edge)}#${id}`) {
    state.selectedLabel = null;
  }
  draw();
  renderLabelPanel();
  try {
    await persistLabels(edge);
    pushHistory();
    if (wasConn) {
      const changes = await afterConnDelete();
      if (changes.length) {
        const result = await api.renumberConns(changes);
        if (!result?.ok) throw new Error(result?.error || t('label.renumberFailed'));
        if (hooks.reloadKeepCam) await hooks.reloadKeepCam();
      }
    }
  } catch (error) {
    alert(t('label.reorderSaveFailed', { error: error.message }));
  }
}

/** 添加或更新一条标签：固定模式下结合点先挑编号（connPick 状态）；コール順 若已有则直接更新序号 */
let connPick = null; // 当前展开新增编号选择的连线
async function addLabel(edge, preset, num) {
  const current = edgeLabels(edge);
  if (preset === 'call') {
    const existingCall = numberedCallLabel(current) || current.find((l) => l.preset === 'call');
    if (existingCall) {
      if (num !== undefined) existingCall.text = `${LABEL_PRESETS.call.text}${num}`;
      state.selectedLabel = `${edgeKey(edge)}#${existingCall.id}`;
      draw();
      renderLabelPanel();
      if (num !== undefined) await commit(edge);
      return;
    }
    const promoted = promoteAutoLabel(edge);
    if (promoted) {
      if (num !== undefined) promoted.text = `${LABEL_PRESETS.call.text}${num}`;
      state.selectedLabel = `${edgeKey(edge)}#${promoted.id}`;
      draw();
      renderLabelPanel();
      await commit(edge);
      return;
    }
  }
  if (current.length >= LABELS_MAX) return;
  const label = makeLabel(preset, edge, num !== undefined ? { num } : {});
  if (!label) return;
  applyLabels(edge, [...current, label]);
  state.selectedLabel = `${edgeKey(edge)}#${label.id}`;
  connPick = null;
  draw();
  renderLabelPanel();
  if (preset === 'free') {
    const input = els.labelPanel?.querySelector('#lblText');
    input?.focus();
    input?.select();
  }
  try {
    await persistLabels(edge);
    pushHistory();
  } catch (error) {
    alert(t('label.notSaved', { error: error.message }));
  }
}

/** 一键保存当前调用方的可见调用编号，保留已保存的编号。 */
async function applyCallerVisibleCallOrders(edge) {
  const view = state.view;
  if (!view || !edge?.from) return;
  const orders = visibleCallOrderMap(view, edge.from);
  if (!orders.size) return;
  const projectId = view.projectId;
  for (const { order, edge: targetEdge } of orders.values()) {
    if (state.view !== view) return;
    const list = edgeLabels(targetEdge).slice();
    if (numberedCallLabel(list)) continue;
    const existing = list.find((l) => l.preset === 'call');
    const text = `${LABEL_PRESETS.call.text}${order}`;
    if (existing) {
      existing.text = text;
      applyLabels(targetEdge, list);
    } else if (list.length < LABELS_MAX) {
      const created = makeLabel('call', targetEdge, { num: order });
      applyLabels(targetEdge, [...list, created]);
    } else continue;
    await persistLabels(targetEdge, projectId);
  }
  if (state.view !== view) return;
  draw();
  renderLabelPanel();
  pushHistory();
}

// ---- 自动检测 ----
let detectResult = null;
let applyingDetect = false;

async function runDetect(edge, labelId) {
  const view = state.view;
  const result = await api.detectTasks(edge.from).catch(() => null);
  if (state.view !== view || state.selectedEdge !== edge || selectedId(edge) !== labelId) return;
  const keys = new Set(view.edges.map(edgeKey));
  const inView = [];
  const offView = [];
  for (const suggestion of result?.suggestions || []) {
    if (suggestion.kind !== 'task') continue;
    (keys.has(suggestion.edgeKey) ? inView : offView).push(suggestion);
  }
  detectResult = { edge, labelId, inView, offView, error: !result?.ok };
  renderLabelPanel();
}

/** 应用勾选的检测建议：并进对应连线已有的标签（同预设不重复挂） */
async function applyDetect() {
  const result = detectResult;
  const view = state.view;
  if (applyingDetect || !result || !view?.projectId) return;
  const projectId = view.projectId;
  const byKey = new Map(view.edges.map((e) => [edgeKey(e), e]));
  const boxes = [...els.labelPanel.querySelectorAll('.dt-check:checked')];
  let applied = 0;
  applyingDetect = true;
  try {
    for (const cb of boxes) {
      if (state.view !== view) return;
      const s = result.inView[Number(cb.dataset.idx)];
      const target = s && byKey.get(s.edgeKey);
      if (!target) continue;
      const labels = edgeLabels(target);
      const currentTask = target === result.edge ? labels.find((l) => l.id === result.labelId && l.preset === 'task') : null;
      if (!currentTask && (labels.length >= LABELS_MAX || labels.some((l) => l.preset === 'task'))) continue;
      const label = currentTask || makeLabel('task', target);
      const updated = { ...label, text: s.text || label.text, note: label.note || s.note };
      applyLabels(target, currentTask ? labels.map((l) => l === currentTask ? updated : l) : [...labels, updated]);
      try { await persistLabels(target, projectId); }
      catch (error) { applyLabels(target, labels); throw error; }
      applied++;
    }
    if (state.view !== view) return;
    if (detectResult === result) detectResult = null;
    draw();
    renderLabelPanel();
    if (applied) pushHistory();
  } catch (error) {
    if (state.view === view) {
      draw();
      renderLabelPanel();
      const message = document.createElement('div');
      message.className = 'lbl-note';
      message.textContent = error.message;
      els.labelPanel.appendChild(message);
    }
  } finally {
    applyingDetect = false;
  }
}

let displayedTrunk = null;

function trunkNavigator(trunkHits, activeBranches, allTrunk, edge) {
  return `<div class="trunk-nav">
    <div class="trunk-header">
      <strong>${t('trunk.title', { n: trunkHits.length })}</strong>
      <button type="button" class="trunk-all${allTrunk ? ' on' : ''}" data-trunk-pick="all" aria-pressed="${allTrunk}">${t('trunk.all', { n: trunkHits.length })}</button>
    </div>
    <p class="trunk-hint">${t('trunk.hint')}</p>
    <div class="trunk-list" role="group" aria-label="${t('trunk.branches')}">
      ${trunkHits.map((item, idx) => {
        const active = activeBranches.has(item);
        const line = item.line > 0 ? `<span class="trunk-line">:${esc(item.line)}</span>` : '';
        return `<button type="button" class="trunk-branch-row${active ? ' on' : ''}" data-trunk-pick="${idx}"
          aria-pressed="${active}"${item === edge ? ' data-trunk-anchor' : ''} title="${esc(edgeCaption(item, nodeName))}">
          <span class="trunk-from">${esc(nodeName(item.from))}</span>
          <span class="trunk-arrow">${TRUNK_ARROWS[edgeDirection(item)]}</span>
          <span class="trunk-to">${esc(nodeName(item.to))}</span>${line}
        </button>`;
      }).join('')}
    </div>
  </div>`;
}

function bindTrunkNavigator(box, trunkHits, scrollTop, revealAnchor) {
  const list = box.querySelector('.trunk-list');
  if (!list) return;
  list.scrollTop = scrollTop;
  const anchor = revealAnchor && list.querySelector('[data-trunk-anchor]');
  if (anchor) {
    const viewport = list.getBoundingClientRect();
    const row = anchor.getBoundingClientRect();
    if (row.top < viewport.top) list.scrollTop += row.top - viewport.top;
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
  }

  box.querySelectorAll('[data-trunk-pick]').forEach((button) => {
    button.addEventListener('click', () => {
      const pick = button.dataset.trunkPick;
      const all = pick === 'all';
      const edge = all ? trunkHits[0] : trunkHits[Number(pick)];
      if (!edge) return;
      hooks.selectEdge(edge, { trunkHits, trunkGroup: all ? trunkHits : null });
      box.querySelector(`[data-trunk-pick="${pick}"]`)?.focus({ preventScroll: true });
    });
  });
}

function labelRow(label, selected, readOnly = false) {
  const auto = Boolean(label.auto);
  const detail = auto && !readOnly ? t('label.changeNumber') : label.note;
  const summary = `<span class="lbl-demo ${label.preset}">${esc(label.text || t(LABEL_NAMES[label.preset] || LABEL_NAMES.custom))}</span>
    <span class="lbl-state${auto ? ' auto' : ''}">${auto ? t('common.ready') : t('common.saved')}</span>
    ${detail ? `<span class="lbl-row-txt" title="${esc(detail)}">${esc(detail)}</span>` : ''}`;
  if (readOnly) return `<div class="lbl-row"><div class="lbl-row-summary">${summary}</div></div>`;
  return `<div class="lbl-row${selected ? ' on' : ''}" data-id="${esc(label.id)}">
    <button type="button" class="lbl-row-summary" aria-pressed="${selected}">${summary}</button>
    ${auto ? '' : `<button type="button" class="lbl-row-del" data-del="${esc(label.id)}" aria-label="${t('label.delete')}" title="${t('label.delete')}">✕</button>`}
  </div>`;
}

function taskDetection() {
  if (!detectResult) return `<button type="button" class="lbl-add lbl-detect" id="lblDetect">${t('label.detectAuto')}</button>`;
  const { error, inView, offView } = detectResult;
  const items = inView.map((suggestion, index) => `<label class="dt-item">
    <input type="checkbox" class="dt-check" data-idx="${index}" checked>
    <span class="lbl-demo task">${esc(suggestion.text)}</span>
    <span class="dt-ev">${esc(suggestion.evidence || '')}</span>
  </label>`).join('');
  const message = error ? t('label.detectFailed') : items ? t('label.detect.title') : t('label.detect.none');
  return `<div class="lbl-note">${message}</div>
    ${items ? `<div class="dt-list">${items}</div>` : ''}
    ${offView.length ? `<div class="lbl-note">${offView.length} ${t('label.detect.offview')}</div>` : ''}
    <div class="lbl-actions">
      ${items ? `<button type="button" id="dtApply">${t('label.detect.apply')}</button>` : `<button type="button" id="lblDetect">${t('label.detectAgain')}</button>`}
      <button type="button" id="dtCancel">${t('label.hideSuggestions')}</button>
    </div>`;
}

export function renderLabelPanel({ scrollToTrunkBranch = false, notifySelection = true } = {}) {
  const sec = els.secLabel;
  const box = els.labelPanel;
  if (!sec || !box) return;
  if (state.view?.comparison) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    pendingEdge = null;
    pendingProjectId = null;
  } else flushPendingSave();
  const edge = state.selectedEdge;
  if (!edge) {
    displayedTrunk = null;
    sec.style.display = 'none';
    box.innerHTML = '';
    detectResult = null;
    connPick = null;
    // 选中的是连线时右侧栏只留标签面板（变量区块对连线没意义）；
    // 离开连线选择后恢复
    if (els.secVars) els.secVars.style.display = '';
    return;
  }
  sec.style.display = '';
  if (els.secVars) els.secVars.style.display = 'none';

  const labels = visibleEdgeLabels(edge, state.view);
  const sel = selectedId(edge);
  let selLabel = labels.find((l) => l.id === sel) || null;
  if (!selLabel) state.selectedLabel = null;
  const trunkHits = state.trunkHits?.length > 1 && state.trunkHits.includes(edge) ? state.trunkHits : null;
  const activeBranches = new Set(state.multiSelection?.trunk ? state.multiSelection.hits : [edge]);
  const allTrunk = Boolean(trunkHits && trunkHits.every((item) => activeBranches.has(item)));
  const aiDetail = edgeAiDetail(edge);
  if (trunkHits?.length > 1) {
    aiDetail.trunkBranches = trunkHits.map((item) => edgeAiDetail(item));
    aiDetail.trunkActiveIndex = trunkHits.indexOf(edge);
    aiDetail.trunkAll = allTrunk;
  }
  if (notifySelection) document.dispatchEvent(new CustomEvent('cg:selection-changed', { detail: aiDetail }));
  if (connPick !== edge || connMode !== 'fixed' || selLabel) connPick = null;
  if (detectResult && (detectResult.edge !== edge || detectResult.labelId !== selLabel?.id)) detectResult = null;
  const focusName = trunkHits && state.trunkFocusNode ? nodeName(state.trunkFocusNode) : null;
  const caption = focusName && activeBranches.size > 1 ? `${focusName} · ${t('trunk.highlighted', { n: activeBranches.size })}`
    : allTrunk ? t('trunk.highlightedAll', { n: trunkHits.length })
    : focusName ? `${focusName} · ${edgeCaption(edge, nodeName)}` : edgeCaption(edge, nodeName);
  const trunkScrollTop = trunkHits === displayedTrunk ? box.querySelector('.trunk-list')?.scrollTop || 0 : 0;
  displayedTrunk = trunkHits;
  const navigator = trunkHits ? trunkNavigator(trunkHits, activeBranches, allTrunk, edge) : '';
  const askAiButton = window.__EXPORT ? '' : `<button type="button" class="lbl-add" data-edge-ask-ai>${t('ai.ask')}</button>`;
  const head = navigator + `<div class="lbl-head" title="${esc(caption)}">${esc(caption)}</div>${askAiButton}${statusControl(edge, true)}`;

  if (state.view?.comparison) {
    const rows = labels.map((label) => labelRow(label, false, true)).join('');
    box.innerHTML = head + (rows ? `<div class="lbl-rows"><h4>${t('label.existing')}</h4>${rows}</div>` : `<div class="lbl-note">${t('compare.readOnly')}</div>`);
    bindStatusControl(box, edge, true, renderLabelPanel);
    bindTrunkNavigator(box, trunkHits, trunkScrollTop, scrollToTrunkBranch);
    return;
  }

  const rows = labels.map((label) => labelRow(label, sel === label.id)).join('');
  const hasAutoCallOrder = labels.some((label) => label.auto && label.preset === 'call');
  const existing = `<section class="lbl-rows">
    <h4>${t('label.existing')}</h4>
    ${rows || `<div class="lbl-note">${t('label.empty')}</div>`}
    ${hasAutoCallOrder ? `<button type="button" class="lbl-batch" id="lblBatchCallOrder"
      title="${esc(nodeName(edge.from))}">${t('label.keepAllOrders')}</button>` : ''}
  </section>`;

  // ---- 选中条的编辑区 ----
  let editor = '';
  if (selLabel) {
    const isConn = selLabel.preset === 'conn';
    const isCall = selLabel.preset === 'call';
    const isTask = selLabel.preset === 'task';
    const isFree = selLabel.preset === 'free';
    const maxOrder = isCall ? visibleCallOrderMap(state.view, edge.from).size : 0;
    const quickCallNums = isCall
      ? `<div class="lbl-picknum">${Array.from({ length: Math.min(12, Math.max(maxOrder, 4)) }, (_, i) => i + 1)
          .map((n) => `<button type="button" class="lbl-num${selLabel.text === `${LABEL_PRESETS.call.text}${n}` ? ' on' : ''}" data-quick-text="${esc(`${LABEL_PRESETS.call.text}${n}`)}">${n}</button>`)
          .join('')}</div>`
      : '';
    const quickTaskPeriods = isTask
      ? `<div class="lbl-picknum">${['1ms', '2ms', '5ms', '10ms', '20ms', '50ms', '100ms', 'Init']
          .map((p) => `<button type="button" class="lbl-num${selLabel.text === `TASK:${p}` ? ' on' : ''}" data-quick-text="TASK:${p}">${p}</button>`)
          .join('')}</div>`
      : '';
    editor = `
    <section class="lbl-editor">
      <h4>${t('label.edit')} <span>${t(LABEL_NAMES[selLabel.preset] || LABEL_NAMES.custom)}</span></h4>
      ${
        isConn
          ? `<div class="field"><label for="lblNum">${t('label.mode')}</label><input id="lblNum" type="number" min="1" max="999" value="${selLabel.num}"></div>`
          : `<div class="field"><label for="lblText">${isTask ? t('label.periodText') : t('label.text')}</label><input id="lblText" type="text" maxlength="40" value="${esc(selLabel.text || '')}"></div>${quickCallNums}${quickTaskPeriods}`
      }
      ${isConn ? `<div class="lbl-mode">
        <div class="lbl-mode-title">${t('label.numberRule')}</div>
        <div class="lbl-segs" role="group" aria-label="${t('label.connRule')}">
          <button type="button" class="lbl-seg${connMode === 'fixed' ? ' on' : ''}" data-mode="fixed" aria-pressed="${connMode === 'fixed'}">${t('label.mode.fixed')}</button>
          <button type="button" class="lbl-seg${connMode === 'renumber' ? ' on' : ''}" data-mode="renumber" aria-pressed="${connMode === 'renumber'}">${t('label.mode.renumber')}</button>
        </div>
      </div>` : ''}
      ${isCall || isFree ? '' : `<div class="field">
        <label for="lblNote">${t('label.optionalNote')}</label>
        <input id="lblNote" type="text" maxlength="80" value="${esc(selLabel.note || '')}">
      </div>`}
      ${isTask ? taskDetection() : ''}
      <details class="lbl-style-more">
        <summary>${t('label.styleMore')}</summary>
        <div class="field">
          <label for="lblBorder">${t('label.border')}</label>
          <div class="lbl-colors">
            <input type="color" id="lblBorder" value="${esc(selLabel.border || LABEL_PRESETS[selLabel.preset]?.border || LABEL_PRESETS.task.border)}"${selLabel.border ? '' : ' disabled'}>
            <label class="chk"><input type="checkbox" id="lblNoBorder"${selLabel.border ? '' : ' checked'}>${t('label.noBorder')}</label>
          </div>
        </div>
        <div class="field">
          <label for="lblColor">${t('label.color')}</label>
          <div class="lbl-colors">
            <input type="color" id="lblColor" value="${esc(selLabel.color)}">
            <span class="lbl-aa" style="color:${esc(selLabel.color)}">Aa</span>
          </div>
        </div>
      </details>
    </section>`;
  }

  const addArea = `<section class="lbl-add-area">
    <h4>${t('label.addTitle')}</h4>
    <div class="lbl-adds">
      <button type="button" class="lbl-add" data-add="call" data-preset="call">${t('label.addCall')}</button>
      <button type="button" class="lbl-add" data-add="task" data-preset="task">${t('label.addTask')}</button>
      <button type="button" class="lbl-add${connPick ? ' on' : ''}" data-add="conn" data-preset="conn" aria-expanded="${Boolean(connPick)}">${t('label.addConn')}</button>
      <button type="button" class="lbl-add" data-add="free" data-preset="free">${t('label.addFree')}</button>
    </div>
    ${connPick ? `<div class="lbl-picknum" role="group" aria-label="${t('label.chooseConn')}">
      ${connChoices(state.view, edge).map((n) => `<button type="button" class="lbl-num" data-num="${n}">${n}</button>`).join('')}
    </div>` : ''}
  </section>`;

  box.innerHTML = head + existing + editor + addArea;
  bindStatusControl(box, edge, true, renderLabelPanel);
  bindTrunkNavigator(box, trunkHits, trunkScrollTop, scrollToTrunkBranch);

  box.querySelector('.lbl-rows')?.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-del]');
    if (remove) { void removeLabel(edge, remove.dataset.del); return; }
    const button = event.target.closest('.lbl-row-summary');
    if (!button) return;
    const id = button.closest('[data-id]').dataset.id;
    const index = Array.from(box.querySelectorAll('.lbl-row-summary')).indexOf(button);
    state.selectedLabel = id === selectedId(edge) ? null : `${edgeKey(edge)}#${id}`;
    connPick = null;
    draw();
    renderLabelPanel();
    box.querySelectorAll('.lbl-row-summary')[index]?.focus({ preventScroll: true });
  });

  if (selLabel) {
    const ensureEditableTarget = () => {
      if (selLabel.auto) {
        const promoted = promoteAutoLabel(edge, selLabel);
        if (promoted) {
          selLabel = promoted;
          state.selectedLabel = `${edgeKey(edge)}#${promoted.id}`;
          return promoted;
        }
      }
      return edgeLabels(edge).find((l) => l.id === selLabel.id);
    };

    const saveEdit = async () => {
      const id = selLabel.id;
      const row = box.querySelector('.lbl-row.on');
      if (!await commit(edge) || !row?.isConnected || state.selectedEdge !== edge || selectedId(edge) !== id) return;
      const saved = edgeLabels(edge).find((label) => label.id === id);
      if (saved) row.outerHTML = labelRow(saved, true);
      else renderLabelPanel();
    };

    box.querySelectorAll('[data-quick-text]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const target = ensureEditableTarget();
        if (!target) return;
        target.text = btn.dataset.quickText;
        draw();
        renderLabelPanel();
        await commit(edge);
      });
    });

    const numEl = box.querySelector('#lblNum');
    if (numEl) {
      numEl.addEventListener('change', () => {
        const n = Math.max(1, Math.min(999, Number(numEl.value) || 1));
        const target = ensureEditableTarget();
        if (!target) return;
        target.num = n;
        target.text = CONN_PREFIX + n;
        draw();
        renderLabelPanel();
        scheduleCommit(edge, 0);
      });
    }

    const textEl = box.querySelector('#lblText');
    if (textEl) {
      textEl.addEventListener('input', () => {
        const target = ensureEditableTarget();
        if (target) {
          target.text = textEl.value;
          draw();
        }
      });
      textEl.addEventListener('change', saveEdit);
    }

    const noteEl = box.querySelector('#lblNote');
    if (noteEl) {
      noteEl.addEventListener('input', () => {
        const target = ensureEditableTarget();
        if (target) {
          target.note = noteEl.value;
          draw();
        }
      });
      noteEl.addEventListener('change', saveEdit);
    }

    const borderEl = box.querySelector('#lblBorder');
    if (borderEl) {
      borderEl.addEventListener('input', () => {
        const target = ensureEditableTarget();
        if (target) {
          target.border = borderEl.value;
          draw();
        }
      });
      borderEl.addEventListener('change', saveEdit);
    }
    const noBorderEl = box.querySelector('#lblNoBorder');
    if (noBorderEl) {
      noBorderEl.addEventListener('change', () => {
        const target = ensureEditableTarget();
        if (!target) return;
        target.border = noBorderEl.checked ? null : LABEL_PRESETS[target.preset]?.border || LABEL_PRESETS.task.border;
        if (borderEl) {
          borderEl.disabled = noBorderEl.checked;
          if (!noBorderEl.checked) borderEl.value = target.border;
        }
        draw();
        void saveEdit();
      });
    }
    const colorEl = box.querySelector('#lblColor');
    if (colorEl) {
      colorEl.addEventListener('input', () => {
        const target = ensureEditableTarget();
        if (target) {
          target.color = colorEl.value;
          const aa = box.querySelector('.lbl-aa');
          if (aa) aa.style.color = colorEl.value;
          draw();
        }
      });
      colorEl.addEventListener('change', saveEdit);
    }
  }
  box.querySelector('#lblBatchCallOrder')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await applyCallerVisibleCallOrders(edge); }
    catch (error) { alert(t('label.ordersPartial', { error: error.message })); }
    finally { button.disabled = false; }
  });

  box.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.add !== 'conn') {
        await addLabel(edge, btn.dataset.add);
        return;
      }
      // 结合点：固定模式先挑编号；重排模式直接给下一个号
      const mode = await ensureMode();
      if (state.selectedEdge !== edge) return;
      if (mode === 'fixed') {
        connPick = connPick ? null : edge;
        state.selectedLabel = null;
        draw();
        renderLabelPanel();
      } else {
        await addLabel(edge, 'conn');
      }
    });
  });
  box.querySelectorAll('[data-num]').forEach((btn) => {
    btn.addEventListener('click', () => addLabel(edge, 'conn', Number(btn.dataset.num)));
  });
  box.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;
      const result = await api.setLabelConfig(mode).catch(() => null);
      if (!result?.ok) return;
      connMode = mode;
      connPick = null;
      renderLabelPanel();
    });
  });
  box.querySelector('#lblDetect')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await runDetect(edge, selLabel.id); }
    finally { button.disabled = false; }
  });
  box.querySelector('#dtApply')?.addEventListener('click', () => applyDetect());
  box.querySelector('#dtCancel')?.addEventListener('click', () => {
    detectResult = null;
    renderLabelPanel();
  });
}

els.labelPanel?.addEventListener('click', (event) => {
  const edge = state.selectedEdge;
  if (edge && event.target.closest('[data-edge-ask-ai]')) {
    document.dispatchEvent(new CustomEvent('cg:ask-ai', { detail: edgeAiDetail(edge) }));
  }
});

/** 面板首次渲染前把编号模式取回来（不阻塞渲染，取到后刷一次） */
ensureMode().then(() => {
  if (state.selectedEdge) renderLabelPanel();
});

/** 删除键：优先删选中的那条标签，其次才是连线（由 app.js 的快捷键分发调用） */
export async function deleteSelectedLabel() {
  const edge = state.selectedEdge;
  const id = edge && selectedId(edge);
  if (!id || !state.view?.edges.includes(edge)) {
    state.selectedLabel = null;
    return false;
  }
  if (!edgeLabels(edge).some((label) => label.id === id)) return true;
  await removeLabel(edge, id);
  return true;
}
