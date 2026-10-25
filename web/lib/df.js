/** 公共变量关系只在右侧查询和选择，正式加入时沿用服务端 ELK 排版。 */
import { t } from '../i18n.js';
import { state, esc, edgeKey } from './state.js';
import { api } from './api.js';
import { hooks } from './hooks.js';

export const df = { root: null, result: null, selected: 0, query: '' };
let querySeq = 0;
let updating = false;

const relations = (res) => ['read', 'write'].flatMap((mode) =>
  res.vars.filter((v) => v.mode === mode).flatMap((v) => v.peers.map((peer) => ({ v, peer }))));
const versionLabel = (version) => version ? t(`compare.version.${version}`) : '';

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

function renderResults(error = '') {
  const res = df.result;
  if (!res) return;
  const rows = relations(res);
  const group = (mode, title) => {
    let count = 0;
    const entries = rows.map((row, index) => {
      const { v, peer } = row;
      if (v.mode !== mode) return '';
      count++;
      const access = res.edges.filter((e) => !v.version || e.version === v.version).find((e) => mode === 'read'
        ? e.from === peer.id && e.to === v.id && e.kind === 'df-write'
        : e.from === v.id && e.to === peer.id && e.kind === 'df-read');
      const line = access?.line;
      const present = relationInView(row, res);
      const hash = [...v.id].reduce((value, ch) => (value * 31 + ch.charCodeAt(0)) >>> 0, 0);
      const hue = Math.round((hash * 137.508) % 360);
      const search = `${v.name} ${v.file} ${peer.name} ${peer.file}`.toLowerCase();
      const variableVersion = versionLabel(v.version);
      const peerVersion = versionLabel(peer.version);
      const hint = state.view?.comparison ? t('compare.addToCanvas') : t('df.toggleHint');
      return `<label class="edge-item df-relation${df.selected === index ? ' selected' : ''}" data-search="${esc(search)}" data-added="${present}" title="${esc(peer.file)}${line ? `:${line}` : ''} · ${hint}">
        <input type="radio" name="dfRelation" value="${index}" ${df.selected === index ? 'checked' : ''}>
        <span>${mode === 'read' ? '←' : '→'}</span> <b class="df-peer-name">${esc(peer.name)}</b>${peerVersion ? `<span class="chip">${esc(peerVersion)}</span>` : ''}
        ${line ? `<span class="df-access-line">:${line}</span>` : ''}
        <span class="chip df-via" data-var="${esc(v.id)}" style="--df-var-hue:${hue}" title="${esc(t('df.via', { name: v.name }))} · ${esc(v.file)}:${v.line}${v.indirect ? ` · ${t('df.viaPtr')}` : ''}">${esc(v.name)}</span>${variableVersion ? `<span class="chip">${esc(variableVersion)}</span>` : ''}
        ${present ? `<span class="df-present" title="${t('df.added')}">✓</span>` : ''}
      </label>`;
    }).join('');
    const truncated = res.vars.some((v) => v.mode === mode && v.truncated);
    return entries ? `<div class="df-group"><h4>${t(title)} (${count})</h4>${entries}
      ${truncated ? `<div class="detail-meta">${t('df.truncated')}</div>` : ''}</div>`
      : '';
  };
  showPanel(`<div class="detail-title" title="${esc(res.fn.file || '')}:${res.fn.line || ''}">${esc(res.fn.name)}</div>
    <div class="df-tools"><input id="dfFilter" type="search" aria-label="${t('df.filter')}" placeholder="${t('df.filter')}" value="${esc(df.query)}">
    <div class="df-actions"><button class="primary" data-df="toggle">${state.view?.comparison ? t('compare.addToCanvas') : t('df.add')}</button>
      <span data-df-total>${t('df.summary', { n: rows.length })}</span></div></div>
    ${error ? `<div class="df-error" role="alert">${esc(error)}</div>` : ''}
    ${group('read', 'df.upstream')}${group('write', 'df.downstream')}
    <div class="empty" data-df-empty hidden>${t('df.noMatch')}</div>
    ${res.truncated ? `<div class="detail-meta">${t('df.truncated')}</div>` : ''}`);
  filterResults();
}

/** 原地筛选，不改变输入焦点或画布。 */
function filterResults() {
  const query = df.query.trim().toLowerCase();
  const panel = document.getElementById('dataflow');
  const labels = [...panel.querySelectorAll('.df-relation')];
  for (const label of labels) label.hidden = !label.dataset.search.includes(query);
  for (const group of panel.querySelectorAll('.df-group')) {
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
  const comparing = Boolean(state.view?.comparison);
  button.disabled = updating || !chosen || (comparing && present);
  button.textContent = comparing ? t(present ? 'compare.inCanvas' : 'compare.addToCanvas') : t(present ? 'df.remove' : 'df.add');
  panel.querySelector('[data-df-total]').textContent = query ? `${visible.length}/${labels.length}` : t('df.summary', { n: labels.length });
  panel.querySelector('[data-df-empty]').hidden = !!visible.length;
}

/** 清除查询结果，不改动画布节点、连线或坐标。 */
export function clearDataflow() {
  querySeq++;
  df.root = null;
  df.result = null;
  df.selected = 0;
  df.query = '';
  document.getElementById('secDataflow').hidden = true;
  document.getElementById('dataflow').innerHTML = '';
  delete document.getElementById('right').dataset.mode;
}

/** 函数可以来自文件树，不要求它已经在画布中。 */
export async function analyseDataflow(fnId) {
  clearDataflow();
  const seq = querySeq;
  const projectId = state.view?.projectId;
  df.root = fnId;
  showPanel(`<div class="empty">${t('df.loading')}</div>`);
  document.getElementById('secDataflow').scrollIntoView({ block: 'start' });
  try {
    const res = await api.dataflow(fnId, 'both');
    if (seq !== querySeq || projectId !== state.view?.projectId) return;
    if (!res || res.error || res.ok === false) throw new Error(res?.error || t('df.unknownError'));
    df.result = res;
    renderResults();
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
  const comparing = Boolean(state.view?.comparison);
  if (comparing && relationInView(chosen, res)) return;
  const removing = document.querySelector('#dataflow input:checked')?.closest('.df-relation').dataset.added === 'true';
  updating = true;
  const projectId = state.view?.projectId;
  renderResults();
  let roots = [...state.roots];
  let error = '';
  try {
    if (comparing) {
      state.vars.add(chosen.v.id);
      state.hiddenVars.delete(chosen.v.id);
      roots = [...new Set([...roots, res.fn.id, chosen.peer.id])];
      await hooks.loadView(roots, { incremental: true });
      if (state.view?.projectId !== projectId) return;
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
    if (state.view?.projectId !== projectId) return;
    df.root = res.fn.id;
    df.result = res;
    df.selected = selected;
    df.query = query;
    error = `${t('df.updateFailed')}：${String(err)}`;
  } finally {
    updating = false;
    if (df.result === res) renderResults(error);
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
  if (!row || row.hidden || updating) return;
  e.preventDefault();
  df.selected = Number(row.querySelector('input').value);
  filterResults();
  void toggleSelectedRelation();
});

document.addEventListener('click', (e) => {
  const button = e.target.closest?.('#secDataflow [data-df]');
  if (!button || button.disabled) return;
  if (button.dataset.df === 'toggle') void toggleSelectedRelation();
  if (button.dataset.df === 'close') clearDataflow();
});
