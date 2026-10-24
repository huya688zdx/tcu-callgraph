/** 旧 JSON 存档的快照与还原工具；当前界面不再持久化固定坐标。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
export const OVERLAY_PATH = path.join(ROOT, 'out', 'overlay.json');

/** 读出存档里的全部布局槽位：{ 槽位key: { nodes: { 节点id: {x, y} } } } */
export function snapshotLayout() {
  try {
    const raw = JSON.parse(fs.readFileSync(OVERLAY_PATH, 'utf8'));
    const layout = raw?.layout;
    if (!layout || typeof layout !== 'object') return {};
    const out = {};
    for (const [key, slot] of Object.entries(layout)) {
      out[key] = { nodes: { ...(slot?.nodes || {}) } };
    }
    return out;
  } catch {
    return {}; // 存档还不存在或读不了：没有需要还原的东西
  }
}

/**
 * 槽位 key 是 `${入口id}::${模式}`，入口 id 本身也可能带 '::'
 * （函数 id 形如 'main.c::main'），所以只能从右边切模式。
 */
function splitKey(key) {
  if (key.endsWith('::group')) return { root: key.slice(0, -'::group'.length), mode: 'group' };
  if (key.endsWith('::flat')) return { root: key.slice(0, -'::flat'.length), mode: 'flat' };
  return { root: key, mode: 'flat' };
}

/**
 * 把布局存档还原成快照的样子。
 * @param {object} snap  snapshotLayout() 的结果
 * @param {string} baseUrl 服务地址
 */
export async function restoreLayout(snap, baseUrl) {
  const before = snap || {};
  const after = snapshotLayout();
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let restored = 0;
  for (const key of keys) {
    const was = before[key]?.nodes || {};
    const now = after[key]?.nodes || {};
    const nodes = {};
    // 快照里有的：写回原值
    for (const [id, pos] of Object.entries(was)) {
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) nodes[id] = { x: pos.x, y: pos.y };
    }
    // 快照里没有、现在多出来的：坐标置空
    // （服务端遇到非有限坐标会忽略该条目，等价于「没有这条存档」）
    for (const id of Object.keys(now)) {
      if (!(id in was)) nodes[id] = { x: null, y: null };
    }
    if (!Object.keys(nodes).length) continue;
    const { root, mode } = splitKey(key);
    const r = await fetch(baseUrl + '/api/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, mode, nodes }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '还原布局存档失败');
    restored++;
  }
  return restored;
}
