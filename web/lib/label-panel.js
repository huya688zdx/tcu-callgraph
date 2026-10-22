/**
 * 右侧「连线标签」面板：只在选中连线时出现。
 *
 * 与画布的分工：
 *   - 这里只负责表单与落库（调用 edge-labels 的 save/remove）；
 *   - 位置、避让、命中都在 edge-labels / core/labels 里，面板不碰几何。
 */
import { t } from '../i18n.js';
import { els, state, esc, edgeKey } from './state.js';
import { draw } from './render.js';
import { pushHistory } from './history.js';
import { CONN_PREFIX, LABEL_PRESETS } from '/core/labels.js';
import { makeLabel, switchPreset, applyLabel, persistLabel } from './edge-labels.js';

/** 预设演示：和画布上的实际样式保持一致（黑框 / 红框 / 无框） */
const PRESET_UI = [
  { id: 'task', demo: LABEL_PRESETS.task.text, cls: 'task', desc: 'label.preset.task' },
  { id: 'conn', demo: CONN_PREFIX + '1', cls: 'conn', desc: 'label.preset.conn' },
  { id: 'call', demo: LABEL_PRESETS.call.text, cls: 'call', desc: 'label.preset.call' },
];

let saveTimer = null;

function nodeName(id) {
  const n = state.view?.nodes.find((x) => x.id === id);
  return n ? n.name || n.id : id;
}

/** 保存后统一收尾：重绘 + 记一步撤销（标签本身不在布局存档里，但快照里带着） */
async function commit(edge) {
  applyLabel(edge, edge.label); // 规整文字 / 颜色
  draw();
  await persistLabel(edge);
  pushHistory();
}

function scheduleCommit(edge, delay = 160) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    commit(edge);
  }, delay);
}

export function renderLabelPanel() {
  const sec = els.secLabel;
  const box = els.labelPanel;
  if (!sec || !box) return;
  clearTimeout(saveTimer);
  saveTimer = null;

  const edge = state.selectedEdge;
  if (!edge) {
    sec.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  sec.style.display = '';

  const label = edge.label || null;
  const isConn = !!label && label.preset === 'conn';
  const active = label ? label.preset : '';
  const presets = PRESET_UI.map(
    (p) => `<button class="lbl-preset${active === p.id ? ' on' : ''}" data-preset="${p.id}">
      <span class="lbl-demo ${p.cls}">${esc(p.demo)}</span>
      <em>${esc(t(p.desc))}</em>
    </button>`
  ).join('');

  const head = `<div class="lbl-head">${esc(nodeName(edge.from))} → ${esc(nodeName(edge.to))}</div>`;

  const body = label
    ? `
    <div class="field">
      <label>${t('label.text')}</label>
      <input id="lblText" type="text" maxlength="40" value="${esc(isConn ? label.text : label.text || '')}"${
        isConn ? ' disabled' : ''
      }>
      ${isConn ? `<div class="lbl-note">${t('label.connAuto')}</div>` : ''}
    </div>
    <div class="field">
      <label>${t('label.border')}</label>
      <div class="lbl-colors">
        <input type="color" id="lblBorder" value="${esc(label.border || LABEL_PRESETS.task.border)}"${
          label.border ? '' : ' disabled'
        }>
        <label class="chk"><input type="checkbox" id="lblNoBorder"${
          label.border ? '' : ' checked'
        }>${t('label.noBorder')}</label>
      </div>
    </div>
    <div class="field">
      <label>${t('label.color')}</label>
      <div class="lbl-colors">
        <input type="color" id="lblColor" value="${esc(label.color)}">
        <span class="lbl-aa" style="color:${esc(label.color)}">Aa</span>
      </div>
    </div>
    <div class="lbl-actions">
      <button id="lblDelete">${t('label.delete')}</button>
    </div>
    <div class="lbl-note">${t('label.bound')}</div>`
    : `<div class="lbl-note">${t('label.addHint')}</div>`;

  box.innerHTML = head + `<div class="lbl-presets">${presets}</div>` + body;

  box.querySelectorAll('.lbl-preset').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const next = edge.label ? switchPreset(edge, btn.dataset.preset) : makeLabel(btn.dataset.preset, edge);
      if (!next) return;
      applyLabel(edge, next); // 先让画布立刻变，再落库
      draw();
      renderLabelPanel();
      await persistLabel(edge);
      pushHistory();
    });
  });

  if (!label) return;

  const textEl = box.querySelector('#lblText');
  if (textEl && !isConn) {
    textEl.addEventListener('input', () => {
      if (!edge.label) return;
      edge.label.text = textEl.value;
      draw(); // 边打边看效果，落库留到 change（失焦 / 回车）
    });
    textEl.addEventListener('change', () => {
      if (!edge.label) return;
      if (!textEl.value.trim()) {
        // 空标签等于没有标签：直接删掉，并回到「选预设」的状态
        applyLabel(edge, null);
        draw();
        renderLabelPanel();
        persistLabel(edge).then(() => pushHistory());
        return;
      }
      commit(edge);
    });
  }

  const borderEl = box.querySelector('#lblBorder');
  if (borderEl) {
    borderEl.addEventListener('input', () => {
      if (!edge.label) return;
      edge.label.border = borderEl.value;
      draw();
    });
    borderEl.addEventListener('change', () => commit(edge));
  }

  const noBorderEl = box.querySelector('#lblNoBorder');
  if (noBorderEl) {
    noBorderEl.addEventListener('change', () => {
      if (!edge.label) return;
      edge.label.border = noBorderEl.checked ? null : LABEL_PRESETS.task.border;
      if (borderEl) {
        borderEl.disabled = noBorderEl.checked;
        if (!noBorderEl.checked) borderEl.value = edge.label.border;
      }
      scheduleCommit(edge, 0);
    });
  }

  const colorEl = box.querySelector('#lblColor');
  if (colorEl) {
    colorEl.addEventListener('input', () => {
      if (!edge.label) return;
      edge.label.color = colorEl.value;
      const aa = box.querySelector('.lbl-aa');
      if (aa) aa.style.color = colorEl.value;
      draw();
    });
    colorEl.addEventListener('change', () => commit(edge));
  }

  const delEl = box.querySelector('#lblDelete');
  if (delEl) {
    delEl.addEventListener('click', async () => {
      applyLabel(edge, null);
      state.selectedLabel = null;
      draw();
      renderLabelPanel();
      await persistLabel(edge);
      pushHistory();
    });
  }
}

/** 删除键：优先删标签，其次才是连线（由 app.js 的快捷键分发调用） */
export async function deleteSelectedLabel() {
  const key = state.selectedLabel;
  if (!key) return false;
  const edge = (state.view?.edges || []).find((e) => edgeKey(e) === key);
  if (!edge || !edge.label) {
    state.selectedLabel = null;
    return false;
  }
  applyLabel(edge, null);
  state.selectedLabel = null;
  draw();
  renderLabelPanel();
  await persistLabel(edge);
  pushHistory();
  return true;
}
