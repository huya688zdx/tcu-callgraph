// 分组布局回归测试：验证「拖动节点后切换入口，节点不会脱离文件框」
//
// 用法：
//   node scripts/verify-fix.mjs [url]
// 不传 url 时自动拉起 src/server.js（端口由系统分配，跑完自动关掉）
//
// 检查项：
//   1. 在某视图拖动节点并保存后，切换到其它入口视图，节点仍被文件框包住
//   2. 回到原视图，恢复 ELK 自动位置
//   3. 同一入口调整调用深度，节点仍被文件框包住
//
// 清理策略：改动前记下该节点的旧存档坐标，结束时逐个写回；
// 绝不使用 clear:true（那会把该入口下用户手工拖的其它布局一起清掉）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchServer } from './lib/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY = path.resolve(__dirname, '../out/overlay.json');

const argUrl = process.argv[2] || '';
const server = argUrl ? null : await launchServer({ target: 'samples/tcu' });
const BASE = (argUrl || server.baseUrl).replace(/\/+$/, '');

const j = async (p, opt) => (await fetch(BASE + p, opt)).json();
const post = (p, body) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

function collectFns(tree, out = []) {
  if (tree.functions) for (const f of tree.functions) out.push(f);
  if (tree.children) for (const c of tree.children) collectFns(c, out);
  return out;
}

function violations(v) {
  const gmap = new Map((v.groups || []).map((g) => [g.id, g]));
  const outs = [];
  for (const n of v.nodes || []) {
    const g = gmap.get(n.group);
    if (!g) continue;
    if (
      n.x < g.x - 0.5 ||
      n.y < g.y - 0.5 ||
      n.x + n.w > g.x + g.w + 0.5 ||
      n.y + n.h > g.y + g.h + 0.5
    ) {
      outs.push(n.id);
    }
  }
  return outs;
}

/** 读 out/overlay.json 里某个存档槽位里某节点的旧坐标（没有就返回 null） */
function readSavedPos(slotKey, nodeId) {
  try {
    const raw = JSON.parse(fs.readFileSync(OVERLAY, 'utf8'));
    const p = raw?.layout?.[slotKey]?.nodes?.[nodeId];
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
  } catch {
    return null;
  }
}

let exitCode = 0;
let A = null;
let draggedId = null;
let slotKey = '';
let savedBefore = null;

try {
  const tree = await j('/api/tree');
  const fns = collectFns(tree);

  // ---- 场景1：视图A 拖动节点（模拟前端 clampToGroup：只能在文件框内移动）----
  A = (await j('/api/view?group=1&down=3')).root;
  slotKey = `${A}::group`;
  const va = await j(`/api/view?group=1&down=3&root=${encodeURIComponent(A)}`);
  const dragged = va.nodes[Math.floor(va.nodes.length / 2)];
  draggedId = dragged.id;
  // 改动前先记下旧存档值，结束时逐条写回
  savedBefore = readSavedPos(slotKey, draggedId);
  const box = va.groups.find((g) => g.id === dragged.group);
  const pad = 8;
  const left = box.x + pad;
  const right = box.x + box.w - dragged.w - pad;
  const top = box.y + 32;
  const bottom = box.y + box.h - dragged.h - pad;
  const newPos = {
    x: Math.round(Math.max(left, Math.min(right, dragged.x + 60))),
    y: Math.round(Math.max(top, Math.min(bottom, dragged.y + 40))),
  };

  await post('/api/layout', {
    root: A,
    mode: 'group',
    nodes: { [dragged.id]: newPos },
  });
  console.log(`视图A(root=${A}) 拖动节点 ${dragged.id} -> (${newPos.x},${newPos.y})`);

  // ---- 场景2：进入其它视图，检查是否越界 ----
  let bad = 0;
  let checked = 0;
  const samples = [];
  for (const f of fns.slice(0, 120)) {
    if (f.id === A) continue;
    const v = await j(`/api/view?group=1&down=3&root=${encodeURIComponent(f.id)}`);
    checked++;
    const outs = violations(v);
    if (outs.length) {
      bad++;
      if (samples.length < 3) samples.push({ root: f.id, count: outs.length, total: v.nodes.length, ex: outs[0] });
    }
  }

  console.log(`\n切换视图检查 ${checked} 个，越界视图 ${bad} 个`);
  for (const s of samples) console.log(`  ❌ ${s.root}: ${s.count}/${s.total} 例:${s.ex}`);

  // ---- 场景3：回到视图A，旧坐标不覆盖 ELK 位置 ----
  const va2 = await j(`/api/view?group=1&down=3&root=${encodeURIComponent(A)}`);
  const back = va2.nodes.find((n) => n.id === dragged.id);
  const kept = back && Math.abs(back.x - dragged.x) < 1.5 && Math.abs(back.y - dragged.y) < 1.5;
  console.log(`\n回到视图A，ELK 位置恢复: ${kept ? '✓' : '✗'} (${back && back.x},${back && back.y})`);

  // ---- 场景4：同一 root 改变深度，不应越界 ----
  let deepBad = 0;
  for (const down of [1, 2, 3, 4]) {
    const v = await j(`/api/view?group=1&down=${down}&root=${encodeURIComponent(A)}`);
    if (violations(v).length) deepBad++;
  }
  console.log(`视图A 各深度越界视图数: ${deepBad}`);

  console.log('\n结论:', bad === 0 && kept && deepBad === 0 ? '✅ 修复生效' : '❌ 仍有问题');
  exitCode = bad === 0 && kept && deepBad === 0 ? 0 : 1;
} finally {
  // 只回滚本脚本动过的那一条：原来有存档就写回原值，
  // 原来没有就把坐标置空（服务端遇到非有限坐标会忽略该条目，等价于回到自动布局）
  if (A && draggedId) {
    try {
      const nodes = { [draggedId]: savedBefore || { x: null, y: null } };
      const r = await post('/api/layout', { root: A, mode: 'group', nodes });
      if (r && r.ok) {
        console.log(
          savedBefore
            ? `已还原节点 ${draggedId} 的存档坐标 (${savedBefore.x},${savedBefore.y})`
            : `已清除节点 ${draggedId} 本次写入的存档坐标`
        );
      } else {
        console.error('还原布局存档失败：', r && r.error);
        exitCode = 1;
      }
    } catch (err) {
      console.error('还原布局存档失败：', err.message);
      exitCode = 1;
    }
  }
  if (server) await server.close();
  process.exitCode = exitCode;
}
