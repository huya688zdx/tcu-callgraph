import { t } from '../i18n.js';
import { edgeDirection } from './edge-flow.js';
import { state, cam, els, esc } from './state.js';
import { draw } from './render.js';
import { focusBox } from './camera.js';
import { traceVisiblePaths, visibleGraphKey, pathEdgeColors } from './visible-paths.js';

let panel;
function focusPath(force = false) {
  const result = state.pairFlow?.result, view = state.view;
  if (!result?.paths.length) return;
  const ids = new Set(result.paths.flatMap(p => p.nodes));
  let x = Infinity, y = Infinity, maxX = -Infinity, maxY = -Infinity, visible = true;
  const include = ([px, py]) => {
    x = Math.min(x, px); y = Math.min(y, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
    visible &&= px * cam.k + cam.x >= 55 && px * cam.k + cam.x <= els.cv.clientWidth - 55 &&
      py * cam.k + cam.y >= 55 && py * cam.k + cam.y <= els.cv.clientHeight - 55;
  };
  for (const n of view.nodes) if (ids.has(n.id)) { include([n.x, n.y]); include([n.x + n.w, n.y + n.h]); }
  for (const index of result.edgeIndices) for (const point of view.edges[index].points || []) include(point);
  if (force || !visible) focusBox({ x, y, w: maxX - x, h: maxY - y }, 80, { keepZoom: !force });
}

function stepArrow(step) {
  const direction = edgeDirection(state.view.edges[step.edge]);
  if (direction === 'both') return ' ↔ ';
  if (direction === 'unknown') return ' — ';
  return step.forward ? ' → ' : ' ← ';
}

function renderPanel() {
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'pairFlowBar';
    panel.className = 'sec pair-flow-bar';
    panel.setAttribute('role', 'status');
    document.getElementById('right').prepend(panel);
    panel.addEventListener('click', e => {
      if (e.target.closest('[data-pair-clear]')) clearPairFlow();
      if (e.target.closest('[data-pair-focus]')) focusPath(true);
    });
  }
  const pair = state.pairFlow;
  panel.hidden = !pair;
  if (!pair) { panel.textContent = ''; return; }
  const labels = new Map([...(pair.result?.nodes || []), ...state.view.nodes].map(n => [n.id, n.name || n.id]));
  const names = pair.ids.map(id => esc(labels.get(id) || id));
  let message = pair.ids.length === 1 ? t('pair.selected', { name: names[0] }) : names.join(' ↔ ');
  let details = '';
  if (pair.result) {
    const r = pair.result;
    const directed = r.paths.filter(p => !p.mixed).length, related = r.paths.length - directed;
    message = [names.join(' ↔ '), r.paths.length ? t('pair.directed', { n: directed }) : t('pair.empty'),
      related ? t('pair.static', { n: related }) : ''].filter(Boolean).join(' · ');
    details = `<div class="pair-flow-hint">${r.paths.length ? t('pair.colorHint') : t('pair.scopeHint')}${r.truncated ? t('pair.truncated') : ''}</div>`;
    if (r.paths.length) details += `<details open><summary>${t('pair.show')}</summary>${r.paths.map((p, index) => `<div class="pair-flow-path"><strong>${t('pair.number', { n: index + 1 })}</strong><div>${p.nodes.map((id, i) => `${i ? `<span class="pair-flow-arrow" style="color:${pair.colors.get(p.steps[i - 1].edge)}">${stepArrow(p.steps[i - 1])}</span>` : ''}${esc(labels.get(id) || id)}`).join('')}</div><small>${p.mixed ? t('pair.staticHint') : t('pair.directedHint')}</small>${p.versions ? ` <small>${p.versions.length ? p.versions.map(v => v === 'before' ? t('compare.version.before') : t('compare.version.after')).join(' / ') : t('pair.crossVersion')}</small>` : ''}</div>`).join('')}</details>`;
  }
  panel.innerHTML = `<h3>${t('pair.title')}</h3><div class="pair-flow-heading">${message}</div><div class="pair-flow-actions">${pair.result?.paths.length ? `<button type="button" data-pair-focus>${t('pair.focus')}</button>` : ''}<button type="button" data-pair-clear>${t('pair.clear')} <kbd>Esc</kbd></button></div>${details}`;
}

document.addEventListener('callgraph:langchange', renderPanel);

export function clearPairFlow({ paint = true } = {}) {
  state.pairFlow = null;
  state.hoverRelation = null;
  if (panel) { panel.hidden = true; panel.textContent = ''; }
  if (paint) draw();
}

export function pickPairFlow(id) {
  const view = state.view;
  if (!view?.nodes.some(n => n.id === id)) return;
  const prior = state.pairFlow;
  state.selected = null; state.selectedEdge = null; state.selectedLabel = null;
  state.moveTarget = null; state.multiSelection = null;
  if (prior?.ids.length === 1 && prior.ids[0] === id) { clearPairFlow(); return; }
  const ids = prior?.ids.length === 1 ? [...prior.ids, id] : [id];
  const pair = { ids, result: null, view };
  state.pairFlow = pair;
  state.hoverRelation = null;
  state.recent = null; state.flash = null;
  let signature;
  pair.refresh = current => {
    if (current !== view || !ids.every(id => current.nodes.some(n => n.id === id))) {
      state.pairFlow = null; renderPanel(); return;
    }
    if (ids.length !== 2) return;
    const next = visibleGraphKey(current);
    if (signature === next) return;
    signature = next;
    pair.result = traceVisiblePaths(current, ...ids);
    pair.colors = pathEdgeColors(pair.result.paths);
    renderPanel();
  };
  pair.refresh(view);
  focusPath();
  renderPanel(); draw();
}
