/** 选中节点的调用 / 被调用 / 数据流关系分类与配色辅助（无 DOM 依赖，GUI 与离线导出共用）。 */
import { edgeDirection } from './edge-flow.js';

export const CALLER_COLOR = '#C26A08';
export const CALLEE_COLOR = '#185FA5';
export const BIDIR_COLOR = '#6D28D9';

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** 将前景色按 ratio 线性混入背景色，生成不透明浅色（避免共线叠加变深）。 */
export function mixHex(bgHex, fgHex, ratio) {
  if (!HEX_RE.test(bgHex || '') || !HEX_RE.test(fgHex || '')) return fgHex || '#D6D4CC';
  const a = parseInt(bgHex.slice(1), 16);
  const b = parseInt(fgHex.slice(1), 16);
  const ch = (shift) => {
    const v0 = (a >> shift) & 255;
    const v1 = (b >> shift) & 255;
    return Math.round(v0 + (v1 - v0) * ratio).toString(16).padStart(2, '0');
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

export function roleColor(role) {
  if (role === 'in') return CALLER_COLOR;
  if (role === 'both') return BIDIR_COLOR;
  return CALLEE_COLOR;
}

/** 详情行是一处真实调用；画布可能将同一对端点的多处调用收在一条线上。 */
export function visibleCallEdge(call, edges) {
  const pair = edges.filter(edge => edge.from === call.from && edge.to === call.to &&
    (!call.change || !edge.change || call.change === edge.change));
  const sameSite = site => site.line === call.line && (!site.kind || !call.kind || site.kind === call.kind) &&
    (!site.col || !call.col || site.col === call.col) &&
    (!site.cond || !call.cond || site.cond === call.cond) &&
    (!site.siteId || !call.siteId || site.siteId === call.siteId);
  const direct = pair.filter(sameSite);
  if (direct.length) return direct.length === 1 ? direct[0] : null;
  const grouped = pair.filter(edge => Array.isArray(edge.calls) && edge.calls.some(sameSite));
  return grouped.length === 1 ? grouped[0] : null;
}

/**
 * 基于当前可见边，计算与选中节点直接相连的边角色、邻居角色与关联容器集合。
 * 方向语义严格复用 edgeDirection：
 *   - forward: from -> to
 *   - reverse (var 读): to -> from
 *   - both: 双向读写
 *   - unknown: 未知方向
 */
export function classifySelectionRelations(view, selId) {
  if (!view || !selId) return null;
  const edgeRoles = new Map();
  const flags = new Map();
  const mark = (peerId, role) => {
    let f = flags.get(peerId);
    if (!f) {
      f = { in: false, out: false, both: false, neutral: false };
      flags.set(peerId, f);
    }
    f[role] = true;
  };

  for (const e of view.edges || []) {
    if (e.from !== selId && e.to !== selId) continue;
    let role;
    if (e.from === selId && e.to === selId) {
      role = 'out';
    } else {
      const dir = edgeDirection(e);
      if (dir === 'both') role = 'both';
      else if (dir === 'unknown') role = 'neutral';
      else if (dir === 'forward') role = e.from === selId ? 'out' : 'in';
      else role = e.from === selId ? 'in' : 'out';
    }
    edgeRoles.set(e, role);
    const peerId = e.from === selId ? e.to : e.from;
    if (peerId !== selId) mark(peerId, role);
  }

  const nodeRoles = new Map();
  for (const [peerId, f] of flags) {
    if (f.both || (f.in && f.out)) nodeRoles.set(peerId, 'both');
    else if (f.in) nodeRoles.set(peerId, 'in');
    else if (f.out) nodeRoles.set(peerId, 'out');
    else nodeRoles.set(peerId, 'neutral');
  }

  const activeBoxes = new Set();
  for (const n of view.nodes || []) {
    if (n.id !== selId && !nodeRoles.has(n.id)) continue;
    if (!n.group) continue;
    activeBoxes.add(n.group);
    const parts = n.group.split('/');
    for (let i = 1; i < parts.length; i++) {
      activeBoxes.add(parts.slice(0, i).join('/'));
    }
  }

  return { edgeRoles, nodeRoles, activeBoxes };
}
