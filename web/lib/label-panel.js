/**
 * 右侧「连线标签」面板：只在选中连线时出现。
 *
 * 一条连线可以挂多条标签（任务 / 結合点 / コール順并存）：
 *   - 列表区：每条一行（预设样式演示 + 摘要 + 删除），点击行选中（画布上虚线框）；
 *   - 编辑区：只渲染选中那条（预设切换 / 文字 / 结合点编号 / 说明行 / 边框与文字色）；
 *   - 添加区：按预设添加；结合点在「固定编号」模式下先挑编号（空缺号 + 下一号）；
 *   - 编号模式：固定 / 自动重排，重排模式下删除结合点会自动紧凑成 1..n；
 *   - 自动检测：服务端扫源码给出 TASK 建议；コール順 从函数右键查找。
 *
 * 与画布的分工不变：这里只负责表单与落库（edge-labels 的 save 系）；
 * 位置、避让、命中都在 edge-labels / core/labels 里，面板不碰几何。
 */
import { t } from '../i18n.js';
import { els, state, esc, edgeKey } from './state.js';
import { draw } from './render.js';
import { pushHistory } from './history.js';
import { api } from './api.js';
import { CONN_PREFIX, LABEL_PRESETS, LABELS_MAX } from '/core/labels.js';
import {
  edgeLabels,
  applyLabels,
  persistLabels,
  makeLabel,
  switchPreset,
  connChoices,
  connEntries,
  afterConnDelete,
} from './edge-labels.js';
import { hooks } from './hooks.js';
import { statusControl, bindStatusControl } from './change-status.js';

/** 预设演示：和画布上的实际样式保持一致（黑框 / 红框 / 无框） */
const PRESET_UI = [
  { id: 'task', demo: LABEL_PRESETS.task.text, cls: 'task', desc: 'label.preset.task' },
  { id: 'conn', demo: CONN_PREFIX + '1', cls: 'conn', desc: 'label.preset.conn' },
  { id: 'call', demo: LABEL_PRESETS.call.text, cls: 'call', desc: 'label.preset.call' },
];

const selectedId = () => {
  const s = state.selectedLabel || '';
  const i = s.lastIndexOf('#');
  return i > 0 ? s.slice(i + 1) : null;
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

/** 保存后统一收尾：重绘 + 记一步撤销（标签不在布局存档里，但快照里带着） */
async function commit(edge, projectId = state.view?.projectId) {
  applyLabels(edge, edge.labels);
  draw();
  await persistLabels(edge, projectId);
  if (state.view?.projectId === projectId) pushHistory();
}

/** 删一条标签；结合点删除后按编号模式收尾（重排 → 紧凑） */
async function removeLabel(edge, id) {
  const target = edgeLabels(edge).find((l) => l.id === id);
  const wasConn = target && target.preset === 'conn';
  applyLabels(edge, edgeLabels(edge).filter((l) => l.id !== id));
  if (state.selectedLabel === `${edgeKey(edge)}#${id}`) {
    state.selectedLabel = edgeLabels(edge).length ? `${edgeKey(edge)}#${edgeLabels(edge)[0].id}` : null;
  }
  draw();
  renderLabelPanel();
  await persistLabels(edge);
  pushHistory();
  if (wasConn) {
    const changes = await afterConnDelete();
    if (changes.length) {
      await api.renumberConns(changes);
      if (hooks.reloadKeepCam) hooks.reloadKeepCam();
    }
  }
}

/** 添加一条：固定模式下结合点先挑编号（connPick 状态） */
let connPick = false; // 展开编号选择
async function addLabel(edge, preset, num) {
  if (edgeLabels(edge).length >= LABELS_MAX) return;
  const label = makeLabel(preset, edge, num !== undefined ? { num } : {});
  if (!label) return;
  applyLabels(edge, [...edgeLabels(edge), label]);
  state.selectedLabel = `${edgeKey(edge)}#${label.id}`;
  connPick = false;
  draw();
  renderLabelPanel();
  await persistLabels(edge);
  pushHistory();
}

// ---- 自动检测 ----
let detectResult = null; // {suggestions, inView, offView} | null
let applyingDetect = false;

async function runDetect() {
  const from = state.selectedEdge?.from;
  const projectId = state.view?.projectId;
  const r = await api.detectTasks(from).catch(() => null);
  if (state.selectedEdge?.from !== from || state.view?.projectId !== projectId) return;
  if (!r || !r.ok) {
    detectResult = { suggestions: [], inView: [], offView: [], error: true };
    renderLabelPanel();
    return;
  }
  const byKey = new Map((state.view?.edges || []).map((e) => [edgeKey(e), e]));
  const inView = [];
  const offView = [];
  for (const s of (r.suggestions || []).filter((s) => s.kind === 'task')) {
    (byKey.has(s.edgeKey) ? inView : offView).push(s);
  }
  detectResult = { inView, offView };
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
      if (s.preset === 'task' && labels.some((l) => l.preset === 'task')) continue;
      const label = makeLabel(s.preset, target, { num: s.num });
      if (s.text) label.text = s.text;
      if (s.note) label.note = s.note;
      applyLabels(target, [...labels, label]);
      try { await persistLabels(target, projectId); }
      catch (error) { applyLabels(target, labels); throw error; }
      applied++;
    }
    if (state.view !== view) return;
    detectResult = null;
    if (applied && hooks.reloadKeepCam) await hooks.reloadKeepCam();
    else renderLabelPanel();
    if (state.view?.projectId === projectId && applied) pushHistory();
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

export function renderLabelPanel() {
  const sec = els.secLabel;
  const box = els.labelPanel;
  if (!sec || !box) return;
  if (state.view?.comparison) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    pendingEdge = null;
    pendingProjectId = null;
  } else flushPendingSave();
  connPick = connPick && connMode === 'fixed';

  const edge = state.selectedEdge;
  if (!edge) {
    sec.style.display = 'none';
    box.innerHTML = '';
    detectResult = null;
    connPick = false;
    // 选中的是连线时右侧栏只留标签面板（变量区块对连线没意义）；
    // 离开连线选择后恢复
    if (els.secVars) els.secVars.style.display = '';
    return;
  }
  sec.style.display = '';
  if (els.secVars) els.secVars.style.display = 'none';

  const labels = edgeLabels(edge);
  const sel = selectedId();
  const selLabel = labels.find((l) => l.id === sel) || null;
  if (sel && labels.length && !selLabel) state.selectedLabel = `${edgeKey(edge)}#${labels[0].id}`;

  const head = `<div class="lbl-head">${esc(nodeName(edge.from))} → ${esc(nodeName(edge.to))}</div>${statusControl(edge, true)}`;

  if (state.view?.comparison) {
    const rows = labels.map((l) => `<div class="lbl-row"><span class="lbl-demo ${l.preset}">${esc(l.preset === 'conn' ? l.text : l.text || l.preset)}</span><span class="lbl-row-txt">${esc(l.note || '')}</span></div>`).join('');
    box.innerHTML = head + (rows ? `<div class="lbl-rows">${rows}</div>` : `<div class="lbl-note">${t('compare.readOnly')}</div>`);
    bindStatusControl(box, edge, true, renderLabelPanel);
    return;
  }

  // ---- 标签列表：一行一条，点击选中 ----
  const rows = labels.length
    ? labels
        .map(
          (l) => `
      <div class="lbl-row${sel === l.id ? ' on' : ''}" data-id="${esc(l.id)}">
        <span class="lbl-demo ${l.preset}">${esc(l.preset === 'conn' ? l.text : l.text || l.preset)}</span>
        <span class="lbl-row-txt">${esc(l.note ? l.note : l.preset === 'conn' ? t('label.num') + ' ' + l.num : '')}</span>
        <button class="lbl-row-del" data-del="${esc(l.id)}" title="${t('label.delete')}">✕</button>
      </div>`
        )
        .join('')
    : `<div class="lbl-note">${t('label.addHint')}</div>`;

  // ---- 选中条的编辑区 ----
  let editor = '';
  if (selLabel) {
    const isConn = selLabel.preset === 'conn';
    const seg = PRESET_UI.map(
      (p) => `<button class="lbl-seg${selLabel.preset === p.id ? ' on' : ''}" data-preset="${p.id}" title="${esc(t(p.desc))}">${p.id === 'conn' ? '結合点' : p.id === 'call' ? 'コール順' : 'TASK'}</button>`
    ).join('');
    editor = `
    <div class="lbl-editor">
      <div class="lbl-segs">${seg}</div>
      ${
        isConn
          ? `<div class="field"><label>${t('label.num')}</label><input id="lblNum" type="number" min="1" max="999" value="${selLabel.num}"></div>`
          : `<div class="field"><label>${t('label.text')}</label><input id="lblText" type="text" maxlength="40" value="${esc(selLabel.text || '')}"></div>`
      }
      <div class="field">
        <label>${t('label.note')}</label>
        <input id="lblNote" type="text" maxlength="80" value="${esc(selLabel.note || '')}" placeholder="${t('label.note')}">
      </div>
      <div class="field">
        <label>${t('label.border')}</label>
        <div class="lbl-colors">
          <input type="color" id="lblBorder" value="${esc(selLabel.border || LABEL_PRESETS.task.border)}"${selLabel.border ? '' : ' disabled'}>
          <label class="chk"><input type="checkbox" id="lblNoBorder"${selLabel.border ? '' : ' checked'}>${t('label.noBorder')}</label>
        </div>
      </div>
      <div class="field">
        <label>${t('label.color')}</label>
        <div class="lbl-colors">
          <input type="color" id="lblColor" value="${esc(selLabel.color)}">
          <span class="lbl-aa" style="color:${esc(selLabel.color)}">Aa</span>
        </div>
      </div>
      <div class="lbl-actions">
        <button id="lblDelete">${t('label.delete')}</button>
      </div>
    </div>`;
  }

  // ---- 添加区：结合点在固定模式下先挑编号 ----
  let addArea = `
    <div class="lbl-adds">
      <button class="lbl-add" data-add="task">+ TASK</button>
      <button class="lbl-add" data-add="call">+ コール順</button>
      <button class="lbl-add${connPick ? ' on' : ''}" data-add="conn">+ 結合点</button>
    </div>`;
  if (connPick && connMode === 'fixed') {
    const nums = connChoices(state.view, edge);
    addArea += `<div class="lbl-picknum">${nums
      .map((n) => `<button class="lbl-num" data-num="${n}">${n}</button>`)
      .join('')}</div>`;
  }

  // ---- 编号模式 ----
  const modeArea = `
    <div class="field lbl-mode">
      <label>${t('label.mode')}</label>
      <div class="lbl-segs">
        <button class="lbl-seg${connMode === 'fixed' ? ' on' : ''}" data-mode="fixed">${t('label.mode.fixed')}</button>
        <button class="lbl-seg${connMode === 'renumber' ? ' on' : ''}" data-mode="renumber">${t('label.mode.renumber')}</button>
      </div>
      <div class="lbl-note">${t('label.mode.hint')}</div>
    </div>`;

  // ---- 自动检测 ----
  let detectArea = `<button class="lbl-add lbl-detect" id="lblDetect">${t('label.detect')}</button>`;
  if (detectResult) {
    if (!detectResult.inView.length && !detectResult.offView.length) {
      detectArea += `<div class="lbl-note">${t('label.detect.none')}</div>`;
    } else {
      const items = detectResult.inView
        .map(
          (s, i) => `
        <label class="dt-item">
          <input type="checkbox" class="dt-check" data-idx="${i}" checked>
          <span class="lbl-demo ${s.preset}">${esc(s.text)}</span>
          <span class="dt-ev">${esc(s.evidence || '')}</span>
        </label>`
        )
        .join('');
      detectArea =
        `<div class="lbl-note">${t('label.detect.title')}</div>` +
        `<div class="dt-list">${items}</div>` +
        (detectResult.offView.length
          ? `<div class="lbl-note">${detectResult.offView.length} ${t('label.detect.offview')}</div>`
          : '') +
        `<div class="lbl-actions">
          <button id="dtApply">${t('label.detect.apply')}</button>
          <button id="dtCancel">✕</button>
        </div>`;
    }
  }

  box.innerHTML = head + `<div class="lbl-rows">${rows}</div>` + editor + addArea + modeArea + detectArea;
  bindStatusControl(box, edge, true, renderLabelPanel);

  // ---- 事件 ----
  box.querySelectorAll('.lbl-row').forEach((row) => {
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-del]')) return;
      state.selectedLabel = `${edgeKey(edge)}#${row.dataset.id}`;
      connPick = false;
      draw();
      renderLabelPanel();
    });
  });
  box.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => removeLabel(edge, btn.dataset.del));
  });

  if (selLabel) {
    box.querySelectorAll('.lbl-segs [data-preset]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const next = switchPreset(selLabel, btn.dataset.preset, edge);
        if (!next) return;
        const labels2 = edgeLabels(edge).map((l) => (l.id === selLabel.id ? next : l));
        applyLabels(edge, labels2);
        draw();
        renderLabelPanel();
        await persistLabels(edge);
        pushHistory();
      });
    });

    const numEl = box.querySelector('#lblNum');
    if (numEl) {
      numEl.addEventListener('change', () => {
        const n = Math.max(1, Math.min(999, Number(numEl.value) || 1));
        const target = edgeLabels(edge).find((l) => l.id === selLabel.id);
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
        const target = edgeLabels(edge).find((l) => l.id === selLabel.id);
        if (target) {
          target.text = textEl.value;
          draw();
        }
      });
      textEl.addEventListener('change', () => commit(edge));
    }

    const noteEl = box.querySelector('#lblNote');
    if (noteEl) {
      noteEl.addEventListener('input', () => {
        const target = edgeLabels(edge).find((l) => l.id === selLabel.id);
        if (target) {
          target.note = noteEl.value;
          draw();
        }
      });
      noteEl.addEventListener('change', () => commit(edge));
    }

    const borderEl = box.querySelector('#lblBorder');
    if (borderEl) {
      borderEl.addEventListener('input', () => {
        const target = edgeLabels(edge).find((l) => l.id === selLabel.id);
        if (target) {
          target.border = borderEl.value;
          draw();
        }
      });
      borderEl.addEventListener('change', () => commit(edge));
    }
    const noBorderEl = box.querySelector('#lblNoBorder');
    if (noBorderEl) {
      noBorderEl.addEventListener('change', () => {
        const target = edgeLabels(edge).find((l) => l.id === selLabel.id);
        if (!target) return;
        target.border = noBorderEl.checked ? null : LABEL_PRESETS.task.border;
        if (borderEl) {
          borderEl.disabled = noBorderEl.checked;
          if (!noBorderEl.checked) borderEl.value = target.border;
        }
        draw();
        scheduleCommit(edge, 0);
      });
    }
    const colorEl = box.querySelector('#lblColor');
    if (colorEl) {
      colorEl.addEventListener('input', () => {
        const target = edgeLabels(edge).find((l) => l.id === selLabel.id);
        if (target) {
          target.color = colorEl.value;
          const aa = box.querySelector('.lbl-aa');
          if (aa) aa.style.color = colorEl.value;
          draw();
        }
      });
      colorEl.addEventListener('change', () => commit(edge));
    }
    box.querySelector('#lblDelete')?.addEventListener('click', () => removeLabel(edge, selLabel.id));
  }

  box.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.add !== 'conn') {
        await addLabel(edge, btn.dataset.add);
        return;
      }
      // 结合点：固定模式先挑编号；重排模式直接给下一个号
      const mode = await ensureMode();
      if (mode === 'fixed') {
        connPick = !connPick;
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
      connPick = false;
      renderLabelPanel();
    });
  });
  box.querySelector('#lblDetect')?.addEventListener('click', () => runDetect());
  box.querySelector('#dtApply')?.addEventListener('click', () => applyDetect());
  box.querySelector('#dtCancel')?.addEventListener('click', () => {
    detectResult = null;
    renderLabelPanel();
  });
}

/** 面板首次渲染前把编号模式取回来（不阻塞渲染，取到后刷一次） */
ensureMode().then(() => {
  if (state.selectedEdge) renderLabelPanel();
});

/** 删除键：优先删选中的那条标签，其次才是连线（由 app.js 的快捷键分发调用） */
export async function deleteSelectedLabel() {
  const s = state.selectedLabel;
  if (!s) return false;
  const i = s.lastIndexOf('#');
  const key = i > 0 ? s.slice(0, i) : s;
  const id = i > 0 ? s.slice(i + 1) : null;
  const edge = (state.view?.edges || []).find((e) => edgeKey(e) === key);
  if (!edge || !id) {
    state.selectedLabel = null;
    return false;
  }
  await removeLabel(edge, id);
  return true;
}
