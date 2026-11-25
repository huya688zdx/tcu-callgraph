import { t } from '../i18n.js';
import { api } from './api.js';
import { closeModal, esc, openModal } from './modal.js';
import { saveExport } from './export.js';
import { state, THEME } from './state.js';
import { deletedEdgeMarkSvg } from '/core/labels.js';

const branchColors = { ON: ['#dcfce7', '#15803d'], OFF: ['#fef3c7', '#b45309'] };

let ui, context, graph, trail = [], expand = false, request = 0, drag, suppressNextClick = false;
let camera = { x: 0, y: 0, zoom: 1, fitting: true };

export const canOpenFlowchart = node => !!ui && !node.external && !node.manual && node.kind !== 'var' && !node.headerSymbol;

function macroText(macro) {
  const params = macro.params ? `(${macro.params.join(', ')})` : '';
  return `#define ${macro.name}${params}${macro.raw ? ' ' + macro.raw : ''}`;
}

function nodeColors(node) {
  // 与调用关系图共享同一套变更分类颜色（既存绿 / 变更黄 / 追加粉 / 删除灰）和描边色
  const fill = THEME.fill[node.change] || THEME.fill.existing;
  const stroke = THEME.node.border;
  return [fill, stroke];
}

function svgFor(data, interactive) {
  const nodes = data.nodes.map(node => {
    const { id, kind, w, h, x, y } = node;
    const [fill, stroke] = nodeColors(node);
    const definition = kind === 'preproc_decision';
    const diamond = definition || kind === 'decision' || kind === 'switch';
    const terminal = ['start', 'end', 'return'].includes(kind);
    const call = kind === 'call';
    const dash = definition ? ' stroke-dasharray="6 4"' : (!diamond && !terminal && THEME.node.fnDash ? ' stroke-dasharray="5 3"' : '');
    const shape = diamond
      ? `<polygon points="${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}"${dash}/>`
      : `<rect width="${w}" height="${h}" rx="${terminal ? h / 2 : 8}"${dash}/>`;
    const title = [`${data.fn.file}:${node.line}${node.endLine > node.line ? '–' + node.endLine : ''}`,
      node.code, ...node.macros.map(macroText),
      ...(call ? [t('flowchart.callees') + ' ' + node.callees.map(item => item.name).join(', ')] : []),
    ].filter(Boolean).join('\n\n');
    const lines = node.lines.map((line, i) => `<text x="${w / 2}" y="${h / 2 + (i - (node.lines.length - 1) / 2) * 18}"${terminal ? ' font-weight="700"' : ''}>${esc(line)}</text>`).join('');
    const badge = definition ? `<text x="${w / 2}" y="18" fill="${stroke}">#</text>`
      : call ? `<text x="${w - 13}" y="12" fill="${THEME.node.selected}">↗</text>` : '';
    const action = interactive && call ? ` data-call="${id}" tabindex="0" role="button" aria-label="${esc(title)}"` : '';
    return `<g transform="translate(${x} ${y})"${action}><title>${esc(title)}</title>
      <g fill="${fill}" stroke="${stroke}" stroke-width="1.3">${shape}</g>${lines}${badge}</g>`;
  }).join('');
  const paths = data.edges.map(edge => {
    const added = edge.change === 'added';
    const color = added ? THEME.edge.added : THEME.edge.call;
    const mk = added ? 'flowchart-arrow-added' : 'flowchart-arrow';
    const line = `<polyline points="${edge.points.map(pos => pos.join(',')).join(' ')}" stroke="${color}" marker-end="url(#${mk})"/>`;
    return edge.change === 'deleted' ? line + deletedEdgeMarkSvg(edge.points, color) : line;
  }).join('');
  const labels = data.edges.filter(edge => edge.label).map(({ label, branch, labelX, labelY }) => {
    const [fill, stroke] = branchColors[branch] || ['#f1f5f9', '#475569'];
    const w = Math.max(36, label.length * 8 + 12);
    return `<g transform="translate(${labelX} ${labelY})"><rect x="${-w / 2}" y="-10" width="${w}" height="20" rx="10" fill="${fill}" stroke="#fff" stroke-width="1.5"/>
      <text fill="${stroke}" font-size="12" font-weight="700">${esc(label)}</text></g>`;
  }).join('');
  const frame = interactive ? '' : ` width="${data.width}" height="${data.height}"`;
  const background = interactive ? '' : `<rect width="${data.width}" height="${data.height}" fill="${THEME.bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg"${frame} viewBox="0 0 ${data.width} ${data.height}" preserveAspectRatio="none">
    <title>${esc(data.fn.name)} · ${esc(t('flowchart.title'))}</title>
    <defs>
      <marker id="flowchart-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M 0 0 L 10 5 L 0 10 Z" fill="${THEME.edge.call}"/></marker>
      <marker id="flowchart-arrow-added" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M 0 0 L 10 5 L 0 10 Z" fill="${THEME.edge.added}"/></marker>
    </defs>
    ${background}
    <g fill="none" stroke="${THEME.edge.call}" stroke-width="1.5" stroke-linejoin="round">${paths}</g>
    <g fill="#2C2C2A" font-family="Consolas, monospace" font-size="13" text-anchor="middle" dominant-baseline="central">${nodes}${labels}</g>
  </svg>`;
}

function visible() {
  return ui.modal.classList.contains('show');
}

function setStatus(message) {
  ui.status.textContent = message;
  ui.status.hidden = !message;
}

function refreshControls() {
  const ready = !!graph;
  ui.expandLabel.textContent = t('flowchart.expand', { n: graph?.macrosUsed.length ?? 0 });
  ui.versionLabel.hidden = !(graph?.fn.hasBefore && graph?.fn.hasAfter);
  ui.version.value = trail.at(-1).version;
  ui.back.hidden = trail.length < 2;
  ui.macros.hidden = !graph?.macrosUsed.length;
  ui.expand.disabled = !ready;
  for (const button of [ui.fit, ui.zoomIn, ui.zoomOut, ui.export]) button.disabled = !ready;
  ui.crumbs.replaceChildren();
  for (const [index, item] of trail.entries()) {
    const current = index === trail.length - 1;
    const part = document.createElement(current ? 'span' : 'button');
    part.textContent = (item.name || item.id) + '()';
    if (index > 0) ui.crumbs.append('›');
    if (current) part.setAttribute('aria-current', 'page');
    else {
      part.type = 'button';
      part.addEventListener('click', () => backTo(index));
    }
    ui.crumbs.append(part);
  }
}

async function loadChart() {
  const current = trail.at(-1);
  const ticket = ++request;
  graph = null;
  ui.canvas.replaceChildren();
  ui.calls.hidden = true;
  refreshControls();
  setStatus(t('flowchart.loading'));
  try {
    const result = await api.flowchart(current.id, { ...context, expandMacros: expand, version: current.version });
    if (ticket !== request || !visible()) return;
    if (state.view?.projectId !== context.projectId || state.view?.comparison?.id !== context.comparisonId) {
      closeModal();
      return;
    }
    if (!result.ok) throw new Error(result.error);
    graph = result;
    current.name = graph.fn.name;
    ui.macroList.replaceChildren(...graph.macrosUsed.map(macro => {
      const row = document.createElement('div');
      const location = document.createElement('small');
      const code = document.createElement('pre');
      location.textContent = `${macro.file}:${macro.line}`;
      code.textContent = macroText(macro);
      row.append(location, code);
      return row;
    }));
    ui.viewport.style.background = THEME.bg;
    ui.canvas.innerHTML = svgFor(graph, true);
    setStatus('');
    refreshControls();
    fit();
  } catch (error) {
    if (ticket === request && visible()) setStatus(`${t('flowchart.error')} ${error.message}`);
  }
}

export function openFlowchart(id) {
  const view = state.view;
  if (!ui || !view) return;
  const current = view.nodes.find(node => node.id === id);
  const version = view.comparison && current?.locations?.before && !current.locations.after ? 'before' : 'after';
  context = { projectId: view.projectId, comparisonId: view.comparison?.id };
  trail = [{ id, name: current?.name, version }];
  expand = ui.expand.checked = false;
  ui.macros.open = false;
  openModal('flowchartModal');
  ui.modal.querySelector('.modal-close').focus();
  return loadChart();
}

export function syncFlowchart() {
  if (ui && visible() &&
      (state.view?.projectId !== context.projectId || state.view?.comparison?.id !== context.comparisonId)) closeModal();
}

function backTo(index) {
  trail = trail.slice(0, index + 1);
  return loadChart();
}

function drawCamera() {
  const svg = ui.canvas.firstElementChild;
  if (!svg) return;
  const { x, y, zoom } = camera;
  svg.setAttribute('viewBox', [-x / zoom, -y / zoom, ui.viewport.clientWidth / zoom,
    ui.viewport.clientHeight / zoom].join(' '));
}

function fit() {
  if (!graph) return;
  const { clientWidth: w, clientHeight: h } = ui.viewport;
  if (w <= 0 || h <= 0) return;
  const zoom = Math.min(1.25, w / graph.width, h / graph.height);
  camera = { zoom, x: (w - graph.width * zoom) / 2, y: (h - graph.height * zoom) / 2, fitting: true };
  drawCamera();
}

function zoomAt(factor, x = ui.viewport.clientWidth / 2, y = ui.viewport.clientHeight / 2) {
  if (!graph) return;
  const zoom = Math.max(Math.min(camera.zoom, 0.025), Math.min(4, camera.zoom * factor));
  const ratio = zoom / camera.zoom;
  camera = { zoom, x: x - (x - camera.x) * ratio, y: y - (y - camera.y) * ratio, fitting: false };
  drawCamera();
}

function followCall(event) {
  const target = event.target.closest('[data-call]');
  if (!target || !graph) return;
  const node = graph.nodes.find(item => item.id === target.dataset.call);
  const follow = callee => {
    trail.push({ ...callee, version: graph.version });
    loadChart();
  };
  if (node.callees.length === 1) return follow(node.callees[0]);
  const heading = document.createElement('div');
  heading.textContent = t('flowchart.callees');
  ui.calls.replaceChildren(heading, ...node.callees.map(callee => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = callee.name;
    button.addEventListener('click', () => follow(callee));
    return button;
  }));
  ui.calls.hidden = false;
  ui.calls.querySelector('button').focus();
}

export function wireFlowchart() {
  const get = name => document.getElementById('flowchart' + name);
  if (ui || !get('Modal')) return;
  ui = Object.fromEntries(['Modal', 'Crumbs', 'Back', 'Expand', 'ExpandLabel', 'Version', 'VersionLabel', 'Macros',
    'MacroList', 'Viewport', 'Status', 'Calls', 'Canvas', 'Fit', 'ZoomIn', 'ZoomOut', 'Export']
    .map(name => [name[0].toLowerCase() + name.slice(1), get(name)]));

  ui.back.addEventListener('click', () => backTo(trail.length - 2));
  ui.expand.addEventListener('change', () => {
    expand = ui.expand.checked;
    loadChart();
  });
  ui.version.addEventListener('change', () => {
    trail.at(-1).version = ui.version.value;
    loadChart();
  });
  ui.fit.addEventListener('click', fit);
  ui.zoomIn.addEventListener('click', () => zoomAt(1.25));
  ui.zoomOut.addEventListener('click', () => zoomAt(0.8));
  ui.export.addEventListener('click', async () => {
    try {
      await saveExport('svg', new Blob([svgFor(graph, false)], { type: 'image/svg+xml' }),
        `${graph.fn.name}_${t('flowchart.title')}`);
    } catch (error) {
      if (visible()) setStatus(`${t('flowchart.exportError')} ${error.message}`);
    }
  });
  ui.canvas.addEventListener('click', (event) => {
    if (suppressNextClick) { suppressNextClick = false; return; }
    followCall(event);
  });
  ui.canvas.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('[data-call]')) {
      event.preventDefault();
      followCall(event);
    }
  });
  // 与主画布操作完全一致：滚轮上下平移、Shift+滚轮左右平移、Ctrl+滚轮以鼠标为中心缩放、左键拖动平移、F 适应窗口。
  ui.viewport.addEventListener('wheel', event => {
    event.preventDefault();
    if (!graph) return;
    const rect = ui.viewport.getBoundingClientRect();
    if (!event.ctrlKey && !event.metaKey) {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (event.shiftKey ? rect.width : rect.height) : 1;
      if (event.shiftKey) {
        camera = { ...camera, x: camera.x - (event.deltaY || event.deltaX) * unit, fitting: false };
      } else {
        camera = { ...camera, x: camera.x - event.deltaX * unit, y: camera.y - event.deltaY * unit, fitting: false };
      }
      drawCamera();
      return;
    }
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
    const factor = Math.exp(-event.deltaY * unit * 0.0022);
    zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  ui.viewport.addEventListener('pointerdown', event => {
    if (!graph || event.button !== 0 || event.target.closest('#flowchartCalls')) return;
    ui.calls.hidden = true;
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX - camera.x, y: event.clientY - camera.y, moved: false };
  });
  ui.viewport.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) {
      drag.moved = true;
      try { ui.viewport.setPointerCapture(drag.id); } catch { /* ignore */ }
      ui.viewport.classList.add('panning');
    }
    if (!drag.moved) return;
    camera = { ...camera, x: event.clientX - drag.x, y: event.clientY - drag.y, fitting: false };
    drawCamera();
  });
  const endDrag = () => {
    if (drag?.moved) suppressNextClick = true;
    drag = null;
    ui.viewport.classList.remove('panning');
  };
  ui.viewport.addEventListener('pointerup', endDrag);
  ui.viewport.addEventListener('pointercancel', endDrag);
  ui.viewport.addEventListener('lostpointercapture', endDrag);
  document.addEventListener('keydown', (event) => {
    if (!visible() || !graph) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)) return;
    if (event.key === 'f' || event.key === 'F' || event.key === '0') { event.preventDefault(); fit(); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomAt(1.25); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomAt(0.8); }
  });
  new ResizeObserver(() => {
    if (!visible()) return;
    if (camera.fitting) fit();
    else drawCamera();
  }).observe(ui.viewport);
  document.addEventListener('callgraph:langchange', () => {
    if (visible()) refreshControls();
  });
}
