// 端到端交互测试：点击标题聚焦 + 拖动节点不重叠
// 用法: node scripts/test-interact.mjs [url]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:5173/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cdp-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-proxy-server',
    '--hide-scrollbars',
    '--window-size=1400,950',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    URL_,
  ],
  { stdio: 'ignore' }
);

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || ''));
  }
  return r.result?.result?.value;
};

const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

const drag = async (x0, y0, x1, y1, steps = 12) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x0 + (x1 - x0) * t,
      y: y0 + (y1 - y0) * t,
      button: 'left',
      buttons: 1,
    });
    await sleep(16);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
  await sleep(120);
};

// 等页面画出来
for (let i = 0; i < 60; i++) {
  const ok = await evaluate('!!document.body.getAttribute("data-draw")');
  if (ok) break;
  await sleep(250);
}

const err = await evaluate('document.body.getAttribute("data-err")');
console.log('页面错误:', err || '无');

// 1) 点击标题 -> 视角应放大聚焦（可用第 3 个参数指定目标 id）
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

console.log(`\n[测试1] 点击${info.kind === 'dir' ? '目录层级' : '文件'}标题聚焦 (${info.target})`);
console.log(`  点击前缩放 ${Math.round(info.k * 100)}%  位置 (${info.tx.toFixed(0)}, ${info.ty.toFixed(0)})`);
await click(info.tx, info.ty);
const flashId = await evaluate('window.__cg.flash');
await sleep(700);
const after = await evaluate(`(() => ({
  k: window.__cg.cam.k,
  err: document.body.getAttribute('data-err'),
}))()`);
console.log(`  点击后缩放 ${Math.round(after.k * 100)}%  高亮框: ${flashId || '无'}`);
const focused = after.k > info.k * 1.15;
const flashed = flashId === info.target;
if (focused) console.log('  结论: ✅ 已聚焦放大');
else if (flashed) console.log('  结论: ✅ 目标已占满视野（缩放无需变化），高亮已触发');
else console.log('  结论: ❌ 点击未生效');
if (after.err) console.log('  JS错误:', after.err);

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

if (nodesInfo) {
  const { a, b } = nodesInfo;
  console.log(`\n[测试2] 把节点拖到另一个节点身上`);
  console.log(`  ${a.id} -> ${b.id}`);
  console.log(`  拖动前重叠对数: ${nodesInfo.before}`);

  await drag(a.x, a.y, b.x, b.y);
  await sleep(400);

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
  console.log(`  拖动后位置: (${res.pos?.x?.toFixed(0)}, ${res.pos?.y?.toFixed(0)})  移动过: ${moved ? '是' : '否'}`);
  console.log(`  拖动后重叠对数: ${res.overlaps}`);
  console.log(`  结论: ${res.overlaps === 0 ? '✅ 无重叠' : '❌ 出现重叠'}`);
  if (res.err) console.log('  JS错误:', res.err);
} else {
  console.log('\n[测试2] 跳过：视野内没有同组的两个节点');
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  fs.writeFileSync('out/interact.png', Buffer.from(shot.result.data, 'base64'));
  console.log('\n截图已保存: out/interact.png');
}

ws.close();
chrome.kill();
await sleep(300);
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* ignore */
}
