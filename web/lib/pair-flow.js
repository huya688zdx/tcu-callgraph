import { t } from '../i18n.js';
import { api } from './api.js';
import { edgeDirection } from './edge-flow.js';
import { state, cam, els, esc } from './state.js';
import { draw, pulseAdded } from './render.js';
import { focusBox } from './camera.js';
import { traceVisiblePaths, visibleGraphKey, resolvePairDisplay } from './visible-paths.js';
import { askAi, nodeAiDetail, publishAiSelection } from './panels.js';
import { edgeAiDetail } from './label-panel.js';

let panel;
let floatBar;
let rwAbort = null;
let rwSeq = 0;

function rwLabelMap(pair) {
  return new Map([
    ...(pair?.result?.nodes || []),
    ...(pair?.rwResult?.nodes || []),
    ...(state.view?.nodes || []),
  ].map((n) => [n.id, n]));
}

function summarizeRwPaths(pair) {
  const rw = pair?.rwResult;
  if (!rw || !Array.isArray(rw.paths) || !rw.paths.length) return { rwPaths: [], sharedVars: [] };
  const byId = rwLabelMap(pair);
  const sharedVarNames = new Set();
  const summaries = [];
  for (const p of rw.paths.slice(0, 8)) {
    const parts = [];
    for (let i = 0; i < (p.nodes || []).length; i++) {
      const id = p.nodes[i];
      const n = byId.get(id);
      const name = n?.name || id.split('::').pop();
      if (id.startsWith('var::') || n?.kind === 'var') sharedVarNames.add(name);
      if (i > 0) {
        const e = p.edges?.[i - 1];
        const fields = e?.fields?.length ? `.{${e.fields.join(',')}}` : '';
        const ln = e?.line ? `:${e.line}` : '';
        parts.push(` -[${e?.kind || 'rw'}${fields}${ln}]-> `);
      }
      parts.push(name);
    }
    const ver = Array.isArray(p.versions) && p.versions.length ? ` [${p.versions.join('/')}]` : '';
    summaries.push(parts.join('') + ver);
  }
  return { rwPaths: summaries, sharedVars: [...sharedVarNames].slice(0, 12) };
}

function buildPairAiDetail(pair) {
  const view = state.view;
  if (!pair || !view) return null;
  const nodes = pair.ids
    .map((id) => view.nodes.find((n) => n.id === id) || rwLabelMap(pair).get(id))
    .filter(Boolean)
    .map(nodeAiDetail);
  if (!nodes.length) return null;
  if (nodes.length === 1) return nodes[0];
  const seenEdges = new Set();
  const edges = [];
  const pathSummaries = [];
  const labelOf = (id) => rwLabelMap(pair).get(id)?.name || id.split('::').pop();
  for (const p of pair.result?.paths || []) {
    pathSummaries.push(p.nodes.map((id, i) => `${i ? stepArrow(p.steps[i - 1]) : ''}${labelOf(id)}`).join(''));
    for (const step of p.steps || []) {
      if (seenEdges.has(step.edge)) continue;
      seenEdges.add(step.edge);
      const e = view.edges[step.edge];
      if (e) edges.push(edgeAiDetail(e));
    }
  }
  const { rwPaths, sharedVars } = summarizeRwPaths(pair);
  const fromName = labelOf(pair.ids[0]);
  const toName = labelOf(pair.ids[1]);
  return {
    kind: 'pair',
    id: `pair:${pair.ids[0]}->${pair.ids[1]}`,
    label: `${fromName} ↔ ${toName}`,
    fromId: pair.ids[0],
    fromName,
    toId: pair.ids[1],
    toName,
    ids: pair.ids.slice(),
    nodes,
    edges: edges.slice(0, 12),
    pathCount: pair.result?.paths?.length || 0,
    visiblePathCount: pair.result?.paths?.length || 0,
    pathSummaries: pathSummaries.slice(0, 6),
    visiblePaths: pathSummaries.slice(0, 6),
    rwLoading: !!pair.rwLoading,
    rwPathCount: pair.rwResult?.paths?.length || 0,
    rwPaths,
    sharedVars,
    rwTruncated: !!pair.rwResult?.truncated,
    ...(pair.rwError ? { rwError: pair.rwError } : {}),
  };
}

function syncPairDisplay(pair) {
  if (!pair?.result) {
    if (pair) {
      pair.display = null;
      pair.colors = new Map();
    }
    return null;
  }
  const display = resolvePairDisplay(pair.result, {
    showStatic: Boolean(pair.showStatic),
    selectedPathIndex: pair.selectedPathIndex,
  });
  pair.display = display;
  pair.colors = display.colors;
  return display;
}

function togglePairStatic() {
  const pair = state.pairFlow;
  if (!pair) return;
  pair.showStatic = !pair.showStatic;
  pair.selectedPathIndex = null;
  syncPairDisplay(pair);
  renderPanel();
  draw();
  if (pair.showStatic) focusPath(false);
}

function focusSinglePath(index) {
  const pair = state.pairFlow, view = state.view;
  const path = pair?.result?.paths?.[index];
  if (!path || !view) return;
  pair.selectedPathIndex = pair.selectedPathIndex === index ? null : index;
  syncPairDisplay(pair);
  renderPanel();
  draw();
  if (pair.selectedPathIndex === null) return;
  const pathNodes = view.nodes.filter((n) => path.nodes.includes(n.id));
  const pathEdges = path.steps.map((s) => view.edges[s.edge]).filter(Boolean);
  if (!pathNodes.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of pathNodes) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h);
  }
  focusBox({ x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }, 80, { keepZoom: false });
  pulseAdded(pathNodes, pathEdges, { highlightMs: 3200, rippleMs: 1200 });
}

function renderFloatBar(pair, names) {
  if (!floatBar) {
    floatBar = document.createElement('div');
    floatBar.id = 'pairFlowFloat';
    floatBar.className = 'pair-flow-float';
    floatBar.setAttribute('role', 'status');
    floatBar.hidden = true;
    (els.cv?.parentElement || document.body).appendChild(floatBar);
    floatBar.addEventListener('click', (e) => {
      if (e.target.closest('[data-pair-clear]')) clearPairFlow();
      else if (e.target.closest('[data-pair-focus]')) focusPath(true);
      else if (e.target.closest('[data-pair-toggle-static]')) togglePairStatic();
      else if (e.target.closest('[data-pair-ai]')) {
        const detail = buildPairAiDetail(state.pairFlow);
        if (detail) askAi(detail);
      }
    });
  }
  if (!pair) {
    floatBar.hidden = true;
    floatBar.textContent = '';
    return;
  }
  floatBar.hidden = false;
  if (pair.ids.length === 1) {
    floatBar.innerHTML = `<span class="pair-float-txt">${t('pair.startHint', { name: `<strong>${names[0]}</strong>`, key: '<kbd>Ctrl</kbd>' })}</span>` +
      `<button type="button" data-pair-clear title="${t('pair.cancelSelection')}">${t('common.cancel')}</button>`;
    return;
  }
  const d = pair.display || {};
  const directed = d.directedCount ?? (pair.result?.paths?.filter(p => !p.mixed).length || 0);
  const staticCount = d.staticCount ?? ((pair.result?.paths?.length || 0) - directed);
  const hiddenStatic = d.hiddenStaticCount || 0;
  const showingStatic = Boolean(d.showingStatic);
  const minStaticHops = d.minStaticHops ?? Infinity;
  const visibleCount = d.visiblePaths?.length ?? (pair.result?.paths?.length || 0);
  const rwCount = pair.rwResult?.paths?.length || 0;
  const rwTag = pair.rwLoading ? t('pair.readWriteQuery') : rwCount ? t('pair.readWrites', { n: rwCount }) : '';
  const summary = directed > 0
    ? `${names[0]} ↔ ${names[1]} · ${[t('pair.directed', { n: directed }), rwTag].filter(Boolean).join(' · ')}`
    : rwCount > 0
      ? `${names[0]} ↔ ${names[1]} · ${t('pair.sharedOnly', { n: rwCount })}`
      : staticCount > 0 && minStaticHops <= 2
        ? `${names[0]} ↔ ${names[1]} · ${t('pair.sharedStatic', { n: staticCount })}`
        : staticCount > 0
          ? `${names[0]} ↔ ${names[1]} · ${t('pair.indirectOnly', { n: staticCount })}`
          : `${names[0]} ↔ ${names[1]} · ${pair.rwLoading ? t('pair.searchShared') : t('pair.noFlow')}`;
  const toggleBtn = directed === 0 && staticCount > 0 && (hiddenStatic > 0 || (showingStatic && minStaticHops > 2))
    ? `<button type="button" data-pair-toggle-static>${showingStatic ? t('pair.hideIndirect') : t('pair.showIndirect', { n: hiddenStatic })}</button>`
    : '';
  floatBar.innerHTML = `<span class="pair-float-txt"><strong>${summary}</strong></span>` +
    `<button type="button" data-pair-focus>${visibleCount ? t('pair.focusShort') : t('pair.focusEnds')}</button>` +
    toggleBtn +
    (window.__EXPORT ? '' : `<button type="button" class="primary" data-pair-ai>${t('ai.addToChat')}</button>`) +
    `<button type="button" data-pair-clear title="${t('pair.exit')}">×</button>`;
}
function focusPath(force = false) {
  const pair = state.pairFlow, view = state.view;
  if (!pair || !view) return;
  const display = pair.display;
  const paths = display ? display.visiblePaths : (pair.result?.paths || []);
  const edgeIndices = display ? display.edgeIndices : (pair.result?.edgeIndices || []);
  let x = Infinity, y = Infinity, maxX = -Infinity, maxY = -Infinity, visible = true;
  const include = ([px, py]) => {
    x = Math.min(x, px); y = Math.min(y, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
    visible &&= px * cam.k + cam.x >= 55 && px * cam.k + cam.x <= els.cv.clientWidth - 55 &&
      py * cam.k + cam.y >= 55 && py * cam.k + cam.y <= els.cv.clientHeight - 55;
  };
  if (paths.length) {
    const ids = new Set(paths.flatMap((p) => p.nodes));
    for (const n of view.nodes) if (ids.has(n.id)) { include([n.x, n.y]); include([n.x + n.w, n.y + n.h]); }
    for (const index of edgeIndices) for (const point of view.edges[index]?.points || []) include(point);
    if ((force || (!display?.muted && !visible)) && Number.isFinite(x)) {
      focusBox({ x, y, w: maxX - x, h: maxY - y }, 80, { keepZoom: !force });
    }
    return;
  }
  if (force && pair.ids?.length === 2) {
    for (const n of view.nodes) if (pair.ids.includes(n.id)) { include([n.x, n.y]); include([n.x + n.w, n.y + n.h]); }
    if (Number.isFinite(x)) focusBox({ x, y, w: maxX - x, h: maxY - y }, 80, { keepZoom: false });
  }
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
      else if (e.target.closest('[data-pair-focus]')) focusPath(true);
      else if (e.target.closest('[data-pair-toggle-static]')) togglePairStatic();
      else if (e.target.closest('[data-pair-ai]')) {
        const detail = buildPairAiDetail(state.pairFlow);
        if (detail) askAi(detail);
      } else {
        const row = e.target.closest('[data-pair-path-idx]');
        if (row) focusSinglePath(Number(row.dataset.pairPathIdx));
      }
    });
  }
  const pair = state.pairFlow;
  panel.hidden = !pair;
  if (!pair) {
    panel.textContent = '';
    renderFloatBar(null, []);
    return;
  }
  const labels = new Map([...(pair.result?.nodes || []), ...state.view.nodes].map(n => [n.id, n.name || n.id]));
  const names = pair.ids.map(id => esc(labels.get(id) || id));
  let message = pair.ids.length === 1 ? t('pair.selected', { name: names[0] }) : names.join(' ↔ ');
  let details = '';
  const d = pair.display || {};
  const directedCount = d.directedCount ?? 0;
  const staticCount = d.staticCount ?? 0;
  const hiddenStatic = d.hiddenStaticCount ?? 0;
  const showingStatic = Boolean(d.showingStatic);
  const minStaticHops = d.minStaticHops ?? Infinity;
  if (pair.result) {
    const r = pair.result;
    const directed = r.paths.filter(p => !p.mixed).length, related = r.paths.length - directed;
    const rwCount = pair.rwResult?.paths?.length || 0;
    message = [
      names.join(' ↔ '),
      directed ? t('pair.directed', { n: directed }) : (related && minStaticHops > 2 ? t('pair.noCall') : t('pair.empty')),
      related ? t('pair.static', { n: related }) : '',
      pair.rwLoading ? t('pair.rwLoading') : rwCount ? t('pair.rwCount', { n: rwCount }) : '',
    ].filter(Boolean).join(' · ');
    const hintText = directed
      ? t('pair.colorHint')
      : related && minStaticHops > 2
        ? t('pair.indirectHint')
        : r.paths.length
          ? t('pair.colorHint')
          : t('pair.scopeHint');
    details = `<div class="pair-flow-hint">${hintText}${r.truncated ? t('pair.truncated') : ''}</div>`;
    const openByDefault = directed > 0 || (related > 0 && minStaticHops <= 2) || Boolean(pair.showStatic) || pair.selectedPathIndex != null;
    if (r.paths.length) details += `<details${openByDefault ? ' open' : ''}><summary>${t('pair.show')} (${r.paths.length})</summary>${r.paths.map((p, index) => `<div class="pair-flow-path${pair.selectedPathIndex === index ? ' on' : ''}" data-pair-path-idx="${index}" title="${t('pair.highlightPath')}" style="cursor:pointer"><strong>${t('pair.number', { n: index + 1 })}</strong><div>${p.nodes.map((id, i) => `${i ? `<span class="pair-flow-arrow" style="color:${pair.colors?.get(p.steps[i - 1].edge) || (p.steps[i - 1].forward ? '#2563EB' : '#C26A08')}">${stepArrow(p.steps[i - 1])}</span>` : ''}${esc(labels.get(id) || id)}`).join('')}</div><small>${p.mixed ? t('pair.staticHint') : t('pair.directedHint')}</small>${p.versions ? ` <small>${p.versions.length ? p.versions.map(v => v === 'before' ? t('compare.version.before') : t('compare.version.after')).join(' / ') : t('pair.crossVersion')}</small>` : ''}</div>`).join('')}</details>`;
    if (pair.rwLoading) {
      details += `<div class="pair-flow-hint">${t('pair.searchingSource')}</div>`;
    } else if (pair.rwError) {
      details += `<div class="pair-flow-hint">${esc(t('pair.sourceError', { error: pair.rwError }))}</div>`;
    } else if (pair.rwResult?.paths?.length) {
      const { rwPaths } = summarizeRwPaths(pair);
      details += `<details open><summary>${t('pair.sourceChains', { n: pair.rwResult.paths.length })}</summary>${rwPaths.map((line, i) => `<div class="pair-flow-path"><strong>${t('pair.rwNumber', { n: i + 1 })}</strong><div>${esc(line)}</div></div>`).join('')}</details>`;
    }
  }
  const toggleBtn = directedCount === 0 && staticCount > 0 && (hiddenStatic > 0 || (showingStatic && minStaticHops > 2))
    ? `<button type="button" data-pair-toggle-static>${showingStatic ? t('pair.hideIndirect') : t('pair.showIndirect', { n: hiddenStatic })}</button>`
    : '';
  const aiBtn = !window.__EXPORT && pair.ids.length === 2
    ? `<button type="button" data-pair-ai>${t('ai.addToChat')}</button>`
    : '';
  panel.innerHTML = `<h3>${t('pair.title')}</h3><div class="pair-flow-heading">${message}</div><div class="pair-flow-actions">${pair.ids.length === 2 ? `<button type="button" data-pair-focus>${d.visiblePaths?.length ? t('pair.focus') : t('pair.focusEnds')}</button>` : ''}${toggleBtn}${aiBtn}<button type="button" data-pair-clear>${t('pair.clear')} <kbd>Esc</kbd></button></div>${details}`;
  renderFloatBar(pair, names);
}

document.addEventListener('callgraph:langchange', renderPanel);

export function clearPairFlow({ paint = true } = {}) {
  const pair = state.pairFlow;
  rwSeq++;
  rwAbort?.abort();
  rwAbort = null;
  state.pairFlow = null;
  state.hoverRelation = null;
  if (panel) { panel.hidden = true; panel.textContent = ''; }
  renderFloatBar(null, []);
  if (pair) document.dispatchEvent(new CustomEvent('cg:pair-flow-cleared', { detail: pair.ids }));
  if (paint) draw();
}

async function fetchRwDataflow(pair) {
  if (window.__EXPORT || pair.ids.length !== 2) return;
  rwAbort?.abort();
  const controller = new AbortController();
  rwAbort = controller;
  const seq = ++rwSeq;
  pair.rwLoading = true;
  pair.rwError = '';
  renderPanel();
  try {
    const res = await api.pairDataflow(pair.ids[0], pair.ids[1], { signal: controller.signal });
    if (seq !== rwSeq || state.pairFlow !== pair) return;
    pair.rwLoading = false;
    if (res?.ok) {
      pair.rwResult = res;
    } else if (res?.error) {
      pair.rwError = res.error;
    }
  } catch (err) {
    if (err?.name === 'AbortError' || seq !== rwSeq || state.pairFlow !== pair) return;
    pair.rwLoading = false;
    pair.rwError = err?.message || t('common.requestFailed');
  }
  if (state.pairFlow !== pair) return;
  renderPanel();
  const detail = buildPairAiDetail(pair);
  if (detail) publishAiSelection(detail);
}

export function pickPairFlow(id) {
  const view = state.view;
  if (!view?.nodes.some(n => n.id === id)) return;
  const prior = state.pairFlow;
  state.selected = null; state.selectedEdge = null; state.selectedLabel = null;
  state.moveTarget = null; state.multiSelection = null;
  if (prior?.ids.length === 1 && prior.ids[0] === id) { clearPairFlow(); return; }
  const ids = prior?.ids.length === 1 ? [...prior.ids, id] : [id];
  const pair = { ids, result: null, display: null, showStatic: false, selectedPathIndex: null, colors: new Map(), rwResult: null, rwLoading: false, rwError: '', view };
  state.pairFlow = pair;
  state.hoverRelation = null;
  state.recent = null; state.flash = null;
  let signature;
  pair.refresh = current => {
    if (current !== view || !ids.every(id => current.nodes.some(n => n.id === id))) {
      clearPairFlow({ paint: false });
      return;
    }
    if (ids.length !== 2) return;
    const next = visibleGraphKey(current);
    if (signature === next) return;
    signature = next;
    pair.result = traceVisiblePaths(current, ...ids);
    pair.selectedPathIndex = null;
    syncPairDisplay(pair);
    renderPanel();
    const detail = buildPairAiDetail(pair);
    if (detail) publishAiSelection(detail);
  };
  pair.refresh(view);
  if (ids.length === 2) void fetchRwDataflow(pair);
  focusPath();
  renderPanel();
  const detail = buildPairAiDetail(pair);
  if (detail) publishAiSelection(detail);
  draw();
}
