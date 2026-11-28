/** 公共变量关系只在右侧查询和选择，正式加入时沿用服务端 ELK 排版。 */
import { t } from '../i18n.js';
import { state, esc, edgeKey } from './state.js';
import { api } from './api.js';
import { hooks } from './hooks.js';
import { periodCaption, periodText } from './period-text.js';

export const df = { root: null, result: null, selected: 0, query: '' };
let querySeq = 0;
let updating = false;
let detailOpener = null;
let sourceView = null;

const relations = (res) => ['read', 'write'].flatMap((mode) =>
  res.vars.filter((v) => v.mode === mode).flatMap((v) => v.peers.map((peer) => ({ v, peer }))));
const versionLabel = (version) => version ? t(`compare.version.${version}`) : '';
const comparisonInfo = () => state.compareInfo?.active ? state.compareInfo : state.view?.comparison;
const periodNode = (node) => Array.isArray(node.periods) ? { ...node, periods: { after: node.periods } } : node;

function knownPeriods(node, version) {
  const before = version === 'before';
  const labels = Array.isArray(node.periods) ? node.periods : before
    ? node.periodBefore ?? node.periods?.before
    : node.periodAfter ?? node.periods?.after;
  const contexts = before ? node.previousTaskPeriods ?? node.taskPeriods : node.taskPeriods;
  return new Set((labels ?? periodText(contexts).split(' / ')).map((label) => label.trim())
    .filter((label) => /^\d+(?:\.\d+)?\s*(?:s|ms|µs|μs|us)$/i.test(label))
    .map((label) => label.replace(/\s+/g, '').replace(/μs|us/gi, 'µs')));
}

function timingSummary(fn, entries, comparison) {
  const crossPeriods = new Set();
  const byParticipant = new Map();
  let changed = false;
  for (const entry of entries) {
    const version = entry.version;
    const target = entry.fnTaskPeriods ? { id: fn.id, taskPeriods: entry.fnTaskPeriods } : fn;
    const rootPeriods = knownPeriods(target, version);
    const peerPeriods = new Set(entry.peers.flatMap((peer) => [...knownPeriods(peer, version)]));
    const periods = new Set([...rootPeriods, ...peerPeriods]);
    if (rootPeriods.size && peerPeriods.size && periods.size > 1) {
      periods.forEach((period) => crossPeriods.add(period));
    }
    for (const node of [target, ...entry.peers]) {
      if (periodCaption(periodNode(node), comparison).includes('→')) changed = true;
      if (!version) continue;
      if (!byParticipant.has(node.id)) byParticipant.set(node.id, {});
      byParticipant.get(node.id)[version] = [...knownPeriods(node, version)].sort().join(',');
    }
  }
  changed ||= [...byParticipant.values()].some(({ before, after }) => before != null && after != null && before !== after);
  const badges = [
    crossPeriods.size > 1 && t('df.crossPeriod', { periods: [...crossPeriods].join(' ↔ ') }),
    changed && t('df.periodImpact'),
  ].filter(Boolean);
  return badges.map((label) => `<span class="compare-badge period">${esc(label)}</span>`).join(' ');
}

function relationInView({ v, peer }, res = df.result) {
  const ids = new Set((state.view?.nodes || []).map((n) => n.id));
  const links = new Set((state.view?.edges || []).filter((e) => e.kind === 'var' && (!v.version || e.versions?.includes(v.version))).map((e) => `${e.from}|${e.to}`));
  return !!res && [res.fn.id, v.id, peer.id].every((id) => ids.has(id)) &&
    links.has(`${res.fn.id}|${v.id}`) && links.has(`${peer.id}|${v.id}`);
}

function showPanel(html) {
  document.getElementById('dataflow').innerHTML = html;
  document.getElementById('secDataflow').hidden = false;
  document.getElementById('right').dataset.mode = 'dataflow';
}

function syncBackButton() {
  const button = document.querySelector('#secDataflow [data-df="close"]');
  const key = sourceView ? 'df.backList' : detailOpener ? 'df.backFunction' : 'df.close';
  button.dataset.i18n = key;
  button.textContent = t(key);
}

function accessLabel(kind, site) {
  return t(site?.indirect ? `df.possible.${kind}` : `df.access.${kind}`);
}

function evidenceLinks(edgesByVersion, res, { v, peer }, index) {
  const writer = v.mode === 'read' ? peer.id : res.fn.id;
  const reader = v.mode === 'read' ? res.fn.id : peer.id;
  const edges = edgesByVersion.get(v.version);
  const link = (kind, from, to) => {
    const site = edges?.get(JSON.stringify([from, to]))?.site;
    const label = accessLabel(kind, site);
    if (!site) return `<span class="detail-meta">${esc(t('df.noSite', { access: label }))}</span>`;
    const title = `${versionLabel(v.version)} · ${label} · ${site.file}:${site.line}`;
    return `<button type="button" class="df-site" data-df-site="${index}-${kind}" data-version="${v.version}"
      data-file="${esc(site.file)}" data-line="${site.line}" data-indirect="${site.indirect === true}"
      title="${esc(title)}" aria-label="${esc(title)}">${esc(label)} :${site.line}</button>`;
  };
  return `<div class="df-sites"><span class="df-version">${esc(versionLabel(v.version))}</span>
    ${link('write', writer, v.id)} ${link('read', v.id, reader)}</div>`;
}

function renderSource() {
  const view = sourceView;
  if (!view) return;
  const list = document.querySelector('#dataflow [data-df-list]');
  const output = document.querySelector('#dataflow [data-df-source]');
  if (!output) return;
  list.hidden = true;
  output.hidden = false;
  syncBackButton();
  const title = `${versionLabel(view.version)} · ${accessLabel(view.kind, view)}`;
  let body = `<div class="detail-meta" role="status">${t('df.loadingSource')}</div>`;
  if (view.error) body = `<div class="df-error" role="alert">${t(view.error)}</div>`;
  if (view.data) {
    const { source, startLine } = view.data;
    body = `<div class="df-code">${source.split('\n').map((text, index) => {
      const line = startLine + index;
      return `<div ${line === view.line ? 'aria-current="location" tabindex="-1"' : ''}><span>${line}</span><code>${esc(text)}</code></div>`;
    }).join('')}</div>`;
  }
  output.innerHTML = `<h4>${esc(title)}</h4><div class="df-source-path">${esc(view.file)}:${view.line}</div>${body}`;
}

async function openSource(button) {
  const scope = df.result;
  if (!scope?.comparisonId || scope.projectId == null || scope.sessionRevision == null || !currentDataflowScope(scope)) return;
  const { dfSite, version, file, line, indirect } = button.dataset;
  sourceView?.controller.abort();
  const view = { key: dfSite, kind: dfSite.split('-')[1], version, file, line: Number(line), indirect: indirect === 'true',
    scroll: document.getElementById('right').scrollTop, controller: new AbortController() };
  sourceView = view;
  renderSource();
  const back = document.querySelector('#secDataflow [data-df="close"]');
  back.focus();
  try {
    const data = await api.dataflowSource(scope, version, view, view.controller.signal);
    if (sourceView !== view || df.result !== scope || !currentDataflowScope(scope)) return;
    if (data?.ok && data.traceVersion === version && data.file === file && typeof data.source === 'string' &&
        data.startLine <= view.line && data.endLine >= view.line && data.source.split('\n').length === data.endLine - data.startLine + 1) {
      view.data = data;
    } else {
      view.error = data?.status === 403 ? 'df.sourceDenied' : 'df.sourceUnavailable';
    }
  } catch {
    if (sourceView !== view || df.result !== scope || !currentDataflowScope(scope)) return;
    view.error = 'df.sourceUnavailable';
  }
  renderSource();
  if (document.activeElement === back) document.querySelector('#dataflow [aria-current="location"]')?.focus();
}

function goBack() {
  if (sourceView) {
    const { key, scroll, controller } = sourceView;
    controller.abort();
    sourceView = null;
    document.querySelector('[data-df-source]').hidden = true;
    document.querySelector('[data-df-list]').hidden = false;
    syncBackButton();
    document.getElementById('right').scrollTop = scroll;
    document.querySelector(`[data-df-site="${key}"]`)?.focus({ preventScroll: true });
    return;
  }
  const opener = detailOpener;
  clearDataflow();
  if (opener?.isConnected) opener.focus();
}

function renderDataflowResult(error = '') {
  const res = df.result;
  if (!res) return;
  const rows = relations(res);
  const edgesByVersion = new Map();
  for (const edge of res.edges) {
    if (!edgesByVersion.has(edge.version)) edgesByVersion.set(edge.version, new Map());
    edgesByVersion.get(edge.version).set(JSON.stringify([edge.from, edge.to]), edge);
  }
  const varsById = new Map();
  for (const v of res.vars) {
    if (!varsById.has(v.id)) varsById.set(v.id, []);
    varsById.get(v.id).push(v);
  }
  const comparison = comparisonInfo();
  const group = (mode, title) => {
    const byVariable = new Map();
    let count = 0;
    rows.forEach((row, index) => {
      const { v, peer } = row;
      if (v.mode !== mode) return;
      count++;
      const endpoints = mode === 'read' ? [peer.id, v.id] : [v.id, peer.id];
      const access = edgesByVersion.get(v.version)?.get(JSON.stringify(endpoints));
      const evidence = !window.__EXPORT && comparison?.git && v.version && res.fn.id !== v.id;
      const line = access?.line;
      const present = relationInView(row, res);
      const hash = [...v.id].reduce((value, ch) => (value * 31 + ch.charCodeAt(0)) >>> 0, 0);
      const hue = Math.round((hash * 137.508) % 360);
      const search = `${v.name} ${v.file} ${peer.name} ${peer.file}`.toLowerCase();
      const variableVersion = versionLabel(v.version);
      const peerVersion = versionLabel(peer.version);
      const period = periodCaption(periodNode(peer), comparison);
      const hint = comparison ? t('common.relAdd') : t('df.toggleHint');
      const html = `<div class="edge-item df-relation${df.selected === index ? ' selected' : ''}" data-search="${esc(search)}" data-added="${present}"><label class="df-choice" title="${esc(peer.file)}${line && !evidence ? `:${line}` : ''} · ${hint}">
        <input type="radio" name="dfRelation" value="${index}" ${df.selected === index ? 'checked' : ''}>
        <span>${mode === 'read' ? '←' : '→'}</span> <b class="df-peer-name">${esc(peer.name)}</b>${peerVersion && !evidence ? `<span class="chip">${esc(peerVersion)}</span>` : ''}
        ${period ? `<span class="compare-badge period" title="${t('df.period')}">${esc(period)}</span>` : ''}
        ${line && !evidence ? `<span class="df-access-line">:${line}</span>` : ''}
        <span class="chip df-via" data-var="${esc(v.id)}" style="--df-var-hue:${hue}" title="${esc(t('df.via', { name: v.name }))} · ${esc(v.file)}:${v.line}${v.indirect ? ` · ${t('df.viaPtr')}` : ''}">${esc(v.name)}</span>${variableVersion && !evidence ? `<span class="chip">${esc(variableVersion)}</span>` : ''}
        ${present ? `<span class="df-present" title="${t('df.added')}">✓</span>` : ''}
      </label>${evidence ? evidenceLinks(edgesByVersion, res, row, index) : ''}</div>`;
      if (!byVariable.has(v.id)) byVariable.set(v.id, { name: v.name, rows: [] });
      byVariable.get(v.id).rows.push(html);
    });
    const entries = [...byVariable].map(([id, variable]) => {
      const timing = timingSummary(res.fn, varsById.get(id), comparison);
      return `<div data-df-variable><div class="detail-meta"><b>${esc(variable.name)}</b> ${timing}</div>${variable.rows.join('')}</div>`;
    }).join('');
    const truncated = res.vars.some((v) => v.mode === mode && v.truncated);
    return entries ? `<div class="df-group"><h4>${t(title)} (${count})</h4>${entries}
      ${truncated ? `<div class="detail-meta">${t('df.truncated')}</div>` : ''}</div>`
      : '';
  };
  showPanel(`<div data-df-list><div class="detail-title" title="${esc(res.fn.file || '')}:${res.fn.line || ''}">${esc(res.fn.name)}</div>
    <div class="df-tools"><input id="dfFilter" type="search" aria-label="${t('df.filter')}" placeholder="${t('df.filter')}" value="${esc(df.query)}">
    <div class="df-actions"><button class="primary" data-df="toggle">${t('common.relAdd')}</button>
      ${window.__EXPORT ? '' : `<button type="button" data-df="askAi">${t('df.addToChat')}</button>`}
      <span data-df-total>${t('df.summary', { n: rows.length })}</span></div></div>
    ${error ? `<div class="df-error" role="alert">${esc(error)}</div>` : ''}
    ${group('read', 'df.upstream')}${group('write', 'df.downstream')}
    <div class="empty" data-df-empty hidden>${t('df.noMatch')}</div>
    ${res.truncated ? `<div class="detail-meta">${t('df.truncated')}</div>` : ''}</div><div data-df-source hidden></div>`);
  filterResults();
  syncBackButton();
  renderSource();
}

document.addEventListener('callgraph:langchange', () => renderDataflowResult());

/** 原地筛选，不改变输入焦点或画布。 */
function filterResults() {
  const query = df.query.trim().toLowerCase();
  const panel = document.getElementById('dataflow');
  const labels = [...panel.querySelectorAll('.df-relation')];
  for (const label of labels) label.hidden = !label.dataset.search.includes(query);
  for (const group of panel.querySelectorAll('.df-group, [data-df-variable]')) {
    group.hidden = ![...group.querySelectorAll('.df-relation')].some((label) => !label.hidden);
  }
  const visible = labels.filter((label) => !label.hidden);
  if (!visible.some((label) => Number(label.querySelector('input').value) === df.selected)) {
    df.selected = visible.length ? Number(visible[0].querySelector('input').value) : -1;
  }
  for (const label of labels) {
    const selected = Number(label.querySelector('input').value) === df.selected;
    label.classList.toggle('selected', selected);
    label.querySelector('input').checked = selected;
  }
  const chosen = visible.find((label) => label.querySelector('input').checked);
  const present = chosen?.dataset.added === 'true';
  const button = panel.querySelector('[data-df="toggle"]');
  const comparing = Boolean(comparisonInfo());
  button.disabled = updating || !chosen || (comparing && present);
  button.textContent = present ? t(comparing ? 'compare.inCanvas' : 'df.remove') : t('common.relAdd');
  panel.querySelector('[data-df-total]').textContent = query ? `${visible.length}/${labels.length}` : t('df.summary', { n: labels.length });
  panel.querySelector('[data-df-empty]').hidden = !!visible.length;
}

/** 清除查询结果，不改动画布节点、连线或坐标。 */
export function clearDataflow() {
  querySeq++;
  sourceView?.controller.abort();
  sourceView = null;
  detailOpener = null;
  syncBackButton();
  df.root = null;
  df.result = null;
  df.selected = 0;
  df.query = '';
  document.getElementById('secDataflow').hidden = true;
  document.getElementById('dataflow').innerHTML = '';
  delete document.getElementById('right').dataset.mode;
}

/** 函数可以来自文件树，不要求它已经在画布中。 */
export async function analyseDataflow(fnId, opener = null) {
  clearDataflow();
  detailOpener = opener;
  syncBackButton();
  const seq = querySeq;
  const projectId = state.view?.projectId;
  df.root = fnId;
  showPanel(`<div class="empty">${t('df.loading')}</div>`);
  document.getElementById('secDataflow').scrollIntoView({ block: 'start' });
  try {
    const res = await api.dataflow(fnId, 'both');
    if (seq !== querySeq || projectId !== state.view?.projectId) return;
    if (!res || res.error || res.ok === false) throw new Error(res?.error || t('df.unknownError'));
    if (!currentDataflowScope(res)) return clearDataflow();
    df.result = res;
    renderDataflowResult();
    if (opener) document.getElementById('dfFilter')?.focus();
  } catch (err) {
    if (seq !== querySeq || projectId !== state.view?.projectId) return;
    showPanel(`<div class="df-error" role="alert">${t('df.failed')}：${esc(String(err))}</div>`);
  }
}

async function toggleSelectedRelation() {
  const res = df.result;
  const selected = df.selected;
  const query = df.query;
  const chosen = res && relations(res)[selected];
  if (updating || !chosen) return;
  const comparing = Boolean(comparisonInfo());
  if (comparing && relationInView(chosen, res)) return;
  const removing = document.querySelector('#dataflow input:checked')?.closest('.df-relation').dataset.added === 'true';
  updating = true;
  const projectId = state.view?.projectId;
  renderDataflowResult();
  let roots = [...state.roots];
  let error = '';
  try {
    if (comparing) {
      state.vars.add(chosen.v.id);
      state.hiddenVars.delete(chosen.v.id);
      roots = [...new Set([...roots, res.fn.id, chosen.peer.id])];
      await hooks.loadView(roots, { incremental: true });
      if (!currentDataflowScope(res)) return;
      df.root = res.fn.id;
      df.result = res;
      df.selected = selected;
      df.query = query;
      return;
    }
    // 只切换所选函数对该变量的引用，保留共用的函数、变量和其他引用。
    const targets = removing ? [chosen.peer.id] : [res.fn.id, chosen.peer.id];
    const records = await Promise.all(targets.map((id) => api.node(id)));
    if (state.view?.projectId !== projectId) return;
    const edges = [...new Set(targets.flatMap((id, index) => [
      `${id}->${chosen.v.id}:0`,
      ...(records[index].outEdges || []).filter((e) => e.kind === 'var' && e.to === chosen.v.id).map(edgeKey),
      ...(state.view.edges || []).filter((e) => e.kind === 'var' && e.from === id && e.to === chosen.v.id).map(edgeKey),
    ]))];
    const result = await api.del({ edges, restore: !removing, projectId });
    if (!result?.ok) throw new Error(result?.error || t('df.updateFailed'));
    if (state.view?.projectId !== projectId) return;
    if (!removing) {
      state.vars.add(chosen.v.id);
      state.hiddenVars.delete(chosen.v.id);
      roots = [...new Set([...roots, res.fn.id, chosen.peer.id])];
    }
    await hooks.loadView(roots, { incremental: true });
    if (state.view?.projectId !== projectId || df.root) return;
    df.root = res.fn.id;
    df.result = res;
    df.selected = selected;
    df.query = query;
  } catch (err) {
    if (!currentDataflowScope(res)) return;
    df.root = res.fn.id;
    df.result = res;
    df.selected = selected;
    df.query = query;
    error = `${t('df.updateFailed')}：${String(err)}`;
  } finally {
    updating = false;
    if (df.result === res) renderDataflowResult(error);
  }
}

document.addEventListener('change', (e) => {
  if (!e.target.matches('#dataflow input[name="dfRelation"]')) return;
  df.selected = Number(e.target.value);
  filterResults();
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'dfFilter') return;
  df.query = e.target.value;
  filterResults();
});

document.addEventListener('dblclick', (e) => {
  const row = e.target.closest?.('#dataflow .df-relation');
  if (!row || row.hidden || updating || !e.target.closest('.df-choice')) return;
  e.preventDefault();
  df.selected = Number(row.querySelector('input').value);
  filterResults();
  void toggleSelectedRelation();
});

function currentDataflowScope(res) {
  return (res.projectId == null || res.projectId === state.view?.projectId) &&
    (!Object.hasOwn(res, 'comparisonId') || res.comparisonId === (state.view?.comparison?.id ?? null)) &&
    (res.sessionRevision == null || res.sessionRevision === state.view?.sessionRevision);
}

function buildDataflowAiDetail() {
  const res = df.result;
  if (!res?.fn || !currentDataflowScope(res)) return null;
  const rows = relations(res);
  const chosen = rows[df.selected];
  return {
    kind: 'dataflow',
    id: `dataflow:${res.fn.id}`,
    targetId: res.fn.id,
    targetName: res.fn.name,
    dir: 'both',
    file: res.fn.file || '',
    line: res.fn.line || 0,
    label: `数据流 · ${res.fn.name} (${rows.length})`,
    relationCount: rows.length,
    projectId: res.projectId,
    comparisonId: res.comparisonId,
    sessionRevision: res.sessionRevision,
    ...(chosen ? {
      focused: {
        varId: chosen.v.id,
        varName: chosen.v.name,
        mode: chosen.v.mode,
        peerId: chosen.peer.id,
        peerName: chosen.peer.name,
        version: chosen.v.version,
      },
    } : {}),
  };
}

document.getElementById('secDataflow').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (sourceView || detailOpener)) {
    e.preventDefault();
    e.stopPropagation();
    goBack();
  }
});

document.addEventListener('click', (e) => {
  const site = e.target.closest?.('#dataflow [data-df-site]');
  if (site) return void openSource(site);
  const button = e.target.closest?.('#secDataflow [data-df]');
  if (!button || button.disabled) return;
  if (button.dataset.df === 'toggle') void toggleSelectedRelation();
  if (button.dataset.df === 'close') goBack();
  if (button.dataset.df === 'askAi') {
    const detail = buildDataflowAiDetail();
    if (detail) document.dispatchEvent(new CustomEvent('cg:ask-ai', { detail }));
  }
});
