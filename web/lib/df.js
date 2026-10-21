/**
 * 数据流叠加层
 *
 * 调用图是静态的、扫描时生成的；数据流是**按需**的：
 * 右键某个函数 → 选择方向 → 才去查它的全局变量读写，并把
 * 「写者 → 变量 → 读者」这条链叠加到当前画布上。
 *
 * 这样做的目的就是避免引用爆炸：全工程的共享变量关系不会一次性铺开。
 */

import { t } from '../i18n.js';
import { state, esc } from './state.js';
import { api } from './api.js';
import { draw } from './render.js';
import { collidesWith, rerouteScope, fullReroute } from './geometry.js';

const FN_W = 132;
const FN_H = 44;
const VAR_W = 128;
const VAR_H = 36;
const COL_GAP = 84;
const ROW_GAP = 16;

export const df = {
  active: false,
  root: null,
  dir: 'out',
  nodes: [],
  edges: [],
  result: null,
};

/** 在 (x,y) 附近找一个不与现有节点重叠的位置 */
function freeSlot(x, y, w, h) {
  const v = state.view;
  if (!v) return { x, y, w, h };
  let yy = y;
  for (let i = 0; i < 400; i++) {
    if (!collidesWith({ x, y: yy, w, h })) return { x, y: yy, w, h };
    yy += h + ROW_GAP;
  }
  return { x, y: yy, w, h };
}

let panel = null;

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'dfPanel';
  panel.style.cssText = [
    'position:absolute',
    'left:16px',
    'bottom:44px',
    'max-width:420px',
    'padding:10px 12px',
    'background:#fff',
    'border:1px solid #E8D5B7',
    'border-left:3px solid #C2410C',
    'border-radius:8px',
    'box-shadow:0 6px 20px rgba(0,0,0,.12)',
    'font-size:12px',
    'line-height:1.55',
    'color:#2C2C2A',
    'display:none',
    'z-index:20',
  ].join(';');
  const host = document.getElementById('cv').parentElement || document.body;
  host.appendChild(panel);
  return panel;
}

function showPanel(html) {
  const el = ensurePanel();
  el.innerHTML = html;
  el.style.display = 'block';
}

function hidePanel() {
  if (panel) panel.style.display = 'none';
}

function summaryHtml(res) {
  const head = `${t('df.title')} · <b>${esc(res.fn?.name || '')}</b> · ${
    res.dir === 'in' ? t('df.upstream') : t('df.downstream')
  }`;
  if (!res.vars || !res.vars.length) {
    return `${head}<div style="color:#888780;margin-top:4px">${t('df.empty')}</div>
      <div style="margin-top:6px"><button class="link" data-df="clear">${t('df.clearShort')}</button></div>`;
  }
  const rows = res.vars
    .map((v) => {
      const arrow = v.mode === 'write' ? t('df.write') : t('df.read');
      const peers = v.peers.map((p) => esc(p.name)).join('、');
      const extra = v.indirect ? ` <span style="color:#B4B2A9">${t('df.viaPtr')}</span>` : '';
      return `<div style="margin-top:5px"><code style="background:#FAF6EF;padding:1px 4px;border-radius:3px">${esc(
        v.name
      )}</code> ${arrow}${extra} → <span style="color:#0C447C">${peers}</span>${
        v.truncated ? ' …' : ''
      }</div>`;
    })
    .join('');
  return `${head}${rows}
    <div style="margin-top:8px;color:#888780">${t('df.summary', { n: res.vars.length })}</div>
    <div style="margin-top:6px"><button class="link" data-df="clear">${t('df.clear')}</button></div>`;
}

/** 清除叠加：把这次加进来的节点/边从视图里摘掉 */
export function clearDataflow(redraw = true) {
  const v = state.view;
  if (v && df.active) {
    // 按标记删，不按对象身份：history.applySnapshot 会重建所有节点/边对象，
    // 引用比对必然失配，会留下指向已删节点的幽灵边
    v.nodes = v.nodes.filter((n) => !(n.dfVar || n.dfPeer));
    v.edges = v.edges.filter((e) => e.df !== true);
  }
  df.active = false;
  state.dfFocus = null;
  df.root = null;
  df.nodes = [];
  df.edges = [];
  df.result = null;
  hidePanel();
  if (redraw && v) {
    fullReroute();
    draw();
  }
}

/**
 * 展开某个函数的数据流
 * @param {string} fnId
 * @param {'out'|'in'} dir
 */
export async function expandDataflow(fnId, dir = 'out') {
  const v = state.view;
  if (!v) return;
  const anchor = v.nodes.find((n) => n.id === fnId);
  if (!anchor) return;

  if (df.active && df.root === fnId && df.dir === dir) {
    clearDataflow();
    return;
  }
  clearDataflow(false);

  showPanel(t('df.loading'));
  let res;
  try {
    res = await api.dataflow(fnId, dir);
  } catch (err) {
    showPanel(
      `<b style="color:#A32D2D">${t('df.failed')}</b><div style="margin-top:4px">${esc(String(err))}</div>`
    );
    return;
  }
  if (!res || res.ok === false) {
    showPanel(
      `<b style="color:#A32D2D">${t('df.failed')}</b><div style="margin-top:4px">${esc(
        res?.error || t('df.unknownError')
      )}</div>`
    );
    return;
  }

  df.active = true;
  df.root = fnId;
  df.dir = dir;
  df.result = res;

  const byId = new Map(v.nodes.map((n) => [n.id, n]));

  // 摆放：优先放在入口函数右侧；右侧放不下（会超出当前内容很多）就翻到左侧，
  // 避免节点被推到视野外看不见
  const rightEdge = v.nodes.reduce((m, n) => Math.max(m, n.x + n.w), 0);
  const clusterW = VAR_W + COL_GAP + FN_W;
  let varCol = anchor.x + anchor.w + COL_GAP;
  let peerCol = varCol + VAR_W + COL_GAP;
  if (varCol + clusterW > rightEdge + 140) {
    varCol = Math.max(40, anchor.x - COL_GAP - VAR_W);
    peerCol = Math.max(40, varCol - COL_GAP - FN_W);
  }
  let varY = Math.max(30, anchor.y - 30);
  let peerY = Math.max(30, anchor.y - 30);

  // 1) 变量节点：已存在就复用（调用图里本来就有变量节点）
  for (const item of res.vars) {
    let node = byId.get(item.id);
    if (!node) {
      const slot = freeSlot(varCol, varY, VAR_W, VAR_H);
      node = {
        id: item.id,
        name: item.name,
        kind: 'var',
        file: item.file,
        line: item.line,
        typeText: item.typeText,
        w: VAR_W,
        h: VAR_H,
        x: slot.x,
        y: slot.y,
        group: null,
        change: 'existing',
        dfVar: true,
        dfMode: item.mode,
      };
      v.nodes.push(node);
      byId.set(node.id, node);
      df.nodes.push(node);
      varY = slot.y + VAR_H + ROW_GAP;
    }
  }

  // 2) 对端函数节点
  for (const n of res.nodes) {
    if (n.id === fnId || byId.has(n.id)) continue;
    const slot = freeSlot(peerCol, peerY, FN_W, FN_H);
    const node = {
      ...n,
      w: FN_W,
      h: FN_H,
      group: null,
      change: 'existing',
      dfPeer: true,
      x: slot.x,
      y: slot.y,
    };
    v.nodes.push(node);
    byId.set(node.id, node);
    df.nodes.push(node);
    peerY = slot.y + FN_H + ROW_GAP;
  }

  // 3) 连线
  const fresh = [];
  for (const e of res.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    const edge = {
      from: e.from,
      to: e.to,
      callee: e.via,
      kind: e.kind,
      line: e.line,
      via: e.via,
      df: true,
      change: 'existing',
    };
    v.edges.push(edge);
    fresh.push(edge);
    df.edges.push(edge);
  }
  // 高亮范围：入口 + 变量 + 对端函数，其余节点淡出，避免叠加层被主图淹没
  const focus = new Set([fnId]);
  for (const e of res.edges) {
    focus.add(e.from);
    focus.add(e.to);
  }
  state.dfFocus = focus;

  if (fresh.length) rerouteScope(fresh);
  draw();
  showPanel(summaryHtml(res));
}

/** 面板上的「清除」按钮 */
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-df="clear"]');
  if (!btn) return;
  clearDataflow();
});
