// 分组布局回归测试：验证「拖动节点后切换入口，节点不会脱离文件框」
//
// 用法：先启动服务，再执行
//   node src/server.js samples/tcu 5180
//   node scripts/verify-fix.mjs http://localhost:5180
//
// 检查项：
//   1. 在某视图拖动节点并保存后，切换到其它入口视图，节点仍被文件框包住
//   2. 回到原视图，拖动位置被保留
//   3. 同一入口调整调用深度，节点仍被文件框包住
const BASE = process.argv[2] || 'http://localhost:5180';

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

const tree = await j('/api/tree');
const fns = collectFns(tree);

// ---- 场景1：视图A 拖动节点（模拟前端 clampToGroup：只能在文件框内移动）----
const A = (await j('/api/view?group=1&down=3')).root;
const va = await j(`/api/view?group=1&down=3&root=${encodeURIComponent(A)}`);
const dragged = va.nodes[Math.floor(va.nodes.length / 2)];
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

// ---- 场景3：回到视图A，拖动位置应保留 ----
const va2 = await j(`/api/view?group=1&down=3&root=${encodeURIComponent(A)}`);
const back = va2.nodes.find((n) => n.id === dragged.id);
const kept = back && Math.abs(back.x - newPos.x) < 1.5 && Math.abs(back.y - newPos.y) < 1.5;
console.log(`\n回到视图A，拖动位置保留: ${kept ? '✓' : '✗'} (${back && back.x},${back && back.y})`);

// ---- 场景4：同一 root 改变深度，不应越界 ----
let deepBad = 0;
for (const down of [1, 2, 3, 4]) {
  const v = await j(`/api/view?group=1&down=${down}&root=${encodeURIComponent(A)}`);
  if (violations(v).length) deepBad++;
}
console.log(`视图A 各深度越界视图数: ${deepBad}`);

// 清理测试数据
await post('/api/layout', { clear: true, root: A, mode: 'group' });
console.log('\n结论:', bad === 0 && kept && deepBad === 0 ? '✅ 修复生效' : '❌ 仍有问题');
