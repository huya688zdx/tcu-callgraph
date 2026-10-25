// 端到端交互测试：双击解锁移动，单击/误拖保持布局，移动节点不重叠
// 用法: node scripts/e2e-interact.mjs [url] [目标 id]
// 不传 url 时自动拉起 src/server.js（端口由系统分配，跑完自动关掉）
// 注意：拖动会把坐标写进布局存档，脚本结束时把动过的那一条还原
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdp } from './lib/cdp.mjs';
import { launchServer } from './lib/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OVERLAY = path.join(ROOT, 'out', 'overlay.json');

const argUrl = process.argv[2] || '';
const server = argUrl ? null : await launchServer({ target: 'samples/tcu' });
const baseUrl = (argUrl || server.baseUrl).replace(/\/+$/, '');
const cdp = await launchCdp({ url: baseUrl + '/', width: 1400, height: 950 });
const { evaluate, waitFor, click, drag } = cdp;
const doubleClick = async (x, y) => {
  await click(x, y);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 2 });
  }
};

const tryWaitFor = async (expression, opts) => {
  try {
    await waitFor(expression, opts);
    return true;
  } catch {
    return false;
  }
};

// 等页面把视图画出来
await waitFor('!!(window.__cg && window.__cg.view)');

const err = await evaluate('document.body.getAttribute("data-err")');
console.log('页面错误:', err || '无');

// 任一项检查失败就返回非零退出码，方便 CI 判断
let ok = true;

// 1) 标题默认锁定，双击后出现可移动选择，视角保持原样。
const wantTarget = process.argv[3] || '';
const info = await evaluate(`(() => {
  const v = window.__cg.view;
  const c = window.__cg.cam;
  const cv = document.getElementById('cv');
  const r = cv.getBoundingClientRect();
  const conts = (v.containers || []).slice().sort((a, b) => b.depth - a.depth);
  const want = ${JSON.stringify(wantTarget)};
  let box;
  let kind;
  if (want) {
    box = (v.containers || []).find((x) => x.id === want);
    if (box) kind = 'dir';
    else {
      box = (v.groups || []).find((x) => x.id === want);
      kind = 'file';
    }
  }
  if (!box) {
    box = conts.length ? conts[0] : v.groups[0];
    kind = conts.length ? 'dir' : 'file';
  }
  const ox = kind === 'dir' ? 12 : 40;
  return {
    k: c.k,
    kind,
    target: box.id,
    tx: r.left + c.x + (box.x + ox) * c.k,
    ty: r.top + c.y + (box.y + 14) * c.k,
  };
})()`);

console.log(`\n[测试1] 双击${info.kind === 'dir' ? '目录层级' : '文件'}标题解锁移动 (${info.target})`);
const positions = 'JSON.stringify(__cg.view.nodes.map(({id,x,y})=>({id,x,y})))';
const beforePositions = await evaluate(positions);
await click(info.tx, info.ty);
await drag(info.tx, info.ty, info.tx + 20, info.ty + 15);
const locked = await evaluate(positions) === beforePositions;
await doubleClick(info.tx, info.ty);
const after = await evaluate(`(async () => {
  const {state}=await import('/lib/state.js');
  return {k:__cg.cam.k,kind:state.moveTarget?.kind,id:state.moveTarget?.item.id};
})()`);
const armed = after.kind === info.kind && after.id === info.target && after.k === info.k;
console.log(`  未双击时不能移动: ${locked}；双击已选中且不跳转: ${armed}`);
if (!locked || !armed) ok = false;

// 2) 把一个节点拖到另一个节点身上 -> 应被挡住，不能重叠
const nodesInfo = await evaluate(`(() => {
  const v = window.__cg.view;
  const c = window.__cg.cam;
  const cv = document.getElementById('cv');
  const r = cv.getBoundingClientRect();
  const toScreen = (n) => ({
    id: n.id,
    x: r.left + c.x + (n.x + n.w / 2) * c.k,
    y: r.top + c.y + (n.y + n.h / 2) * c.k,
    wx: n.x, wy: n.y,
  });
  const byGroup = new Map();
  for (const n of v.nodes) {
    if (!byGroup.has(n.group)) byGroup.set(n.group, []);
    byGroup.get(n.group).push(n);
  }
  let pair = null;
  for (const [, list] of byGroup) {
    const vis = list.filter((n) => {
      const s = toScreen(n);
      return s.x > r.left + 30 && s.x < r.left + r.width - 30 && s.y > r.top + 30 && s.y < r.top + r.height - 30;
    });
    if (vis.length >= 2) { pair = vis; break; }
  }
  if (!pair) return null;
  return {
    a: toScreen(pair[0]),
    b: toScreen(pair[1]),
    before: window.__cg.overlaps(0).length,
  };
})()`);

// 拖动会把坐标写进布局存档：先记下拖动前的存档值，结束时还原
const layoutKey = await evaluate(`(() => {
  const v = window.__cg.view;
  const mode = v.groups && v.groups.length ? 'group' : 'flat';
  // 存档 key 与前端一致（web/lib/history.js 的 layoutRootKey）：入口集合 + 模式
  const roots = v.roots || [];
  return { root: roots.length ? roots.join('+') : (v.root || ''), mode };
})()`);
const slotKey = `${layoutKey.root}::${layoutKey.mode}`;
const readSavedPos = (nodeId) => {
  try {
    const raw = JSON.parse(fs.readFileSync(OVERLAY, 'utf8'));
    const slot = raw?.layout?.[slotKey];
    const p = slot?.nodes?.[nodeId];
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
  } catch {
    return null;
  }
};

if (nodesInfo) {
  const { a, b } = nodesInfo;
  console.log(`\n[测试2] 把节点拖到另一个节点身上`);
  console.log(`  ${a.id} -> ${b.id}`);
  console.log(`  拖动前重叠对数: ${nodesInfo.before}`);

  const savedBefore = readSavedPos(a.id);
  await drag(a.x, a.y, a.x + 20, a.y + 10);
  if (await evaluate(positions) !== beforePositions) { console.log('  ❌ 未双击的节点被移动'); ok = false; }
  await doubleClick(a.x, a.y);
  await drag(a.x, a.y, b.x, b.y);
  // 拖动是同步生效的：等位置真的变了再读结果
  await tryWaitFor(
    `(() => { const n = window.__cg.view.nodes.find(x => x.id === ${JSON.stringify(a.id)});
      return n && (Math.abs(n.x - ${a.wx}) > 1 || Math.abs(n.y - ${a.wy}) > 1); })()`,
    { timeoutMs: 3000 }
  );

  const res = await evaluate(`(() => {
    const v = window.__cg.view;
    const n = v.nodes.find(x => x.id === ${JSON.stringify(a.id)});
    return {
      overlaps: window.__cg.overlaps(0).length,
      pos: n ? { x: n.x, y: n.y } : null,
      err: document.body.getAttribute('data-err'),
    };
  })()`);

  const moved = res.pos && (Math.abs(res.pos.x - a.wx) > 1 || Math.abs(res.pos.y - a.wy) > 1);
  if (!moved) ok = false;
  console.log(`  拖动后位置: (${res.pos?.x?.toFixed(0)}, ${res.pos?.y?.toFixed(0)})  移动过: ${moved ? '是' : '否'}`);
  console.log(`  拖动后重叠对数: ${res.overlaps}`);
  console.log(`  结论: ${res.overlaps === 0 ? '✅ 无重叠' : '❌ 出现重叠'}`);
  if (res.overlaps !== 0) ok = false;
  if (res.err) {
    console.log('  JS错误:', res.err);
    ok = false;
  }

  // 还原拖动写进存档的坐标：原来有存档就写回原值，
  // 原来没有就把坐标置空（服务端遇到非有限坐标会忽略该条目，等于回到自动布局）
  try {
    const body = savedBefore
      ? { root: layoutKey.root, mode: layoutKey.mode, nodes: { [a.id]: savedBefore } }
      : { root: layoutKey.root, mode: layoutKey.mode, nodes: { [a.id]: { x: null, y: null } } };
    const r = await fetch(baseUrl + '/api/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '未知错误');
    console.log(`  已还原 ${a.id} 的布局存档`);
  } catch (err) {
    console.error('  还原布局存档失败：', err.message);
    ok = false;
  }
} else {
  console.log('\n[测试2] 跳过：视野内没有同组的两个节点');
}

try {
  const shot = await cdp.screenshot(path.join(ROOT, 'out', 'interact.png'));
  console.log('\n截图已保存: out/interact.png', shot.size, '字节');
} catch (err) {
  console.error('截图失败：', err.message);
}

await cdp.close();
if (server) await server.close();
process.exitCode = ok ? 0 : 1;
