// 端到端测试：右键菜单标记函数变更分类 / 连线状态
// 用法: node scripts/test-menu.mjs [url]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:5173/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9225;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-menu-'));
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

async function getPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await r.json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch {
      /* wait */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

const page = await getPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
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
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

const rightClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
  await sleep(250);
};

for (let i = 0; i < 60; i++) {
  if (await evaluate('!!window.__cg && !!window.__cg.view')) break;
  await sleep(250);
}

const err0 = await evaluate('document.body.getAttribute("data-err")');
console.log('页面错误:', err0 || '无');

// ---- 测试1：右键函数节点 → 选「追加モジュール」----
const nodeInfo = await evaluate(`(() => {
  const v = window.__cg.view;
  const c = window.__cg.cam;
  const n = v.nodes.find(x => x.kind !== 'var');
  if (!n) return null;
  const r = document.getElementById('cv').getBoundingClientRect();
  return {
    id: n.id, name: n.name, change: n.change,
    x: r.left + c.x + (n.x + n.w / 2) * c.k,
    y: r.top + c.y + (n.y + n.h / 2) * c.k,
  };
})()`);

if (!nodeInfo) {
  console.log('没有可测试的函数节点');
} else {
  console.log(`\n[测试1] 右键函数 ${nodeInfo.name}()，标记为「追加モジュール」`);
  await rightClick(nodeInfo.x, nodeInfo.y);
  const menuShown = await evaluate(`(() => {
    const el = document.getElementById('ctxMenu');
    if (!el || !el.classList.contains('show')) return null;
    return { items: [...el.querySelectorAll('button')].map(b => b.textContent.trim()), title: el.querySelector('.title')?.textContent };
  })()`);
  if (!menuShown) {
    console.log('  ❌ 右键菜单未出现');
  } else {
    console.log(`  菜单标题: ${menuShown.title}`);
    console.log(`  菜单项: ${menuShown.items.join(' | ')}`);
    // 第 3 项 = 追加モジュール
    await evaluate(`document.querySelectorAll('#ctxMenu button')[2].click()`);
    await sleep(500);
    const after = await evaluate(`(() => {
      const n = window.__cg.view.nodes.find(x => x.id === ${JSON.stringify(nodeInfo.id)});
      return { change: n && n.change, menuOpen: document.getElementById('ctxMenu').classList.contains('show') };
    })()`);
    console.log(`  change: ${nodeInfo.change} -> ${after.change}`);
    console.log(`  结论: ${after.change === 'added' ? '✅ 已标记为追加' : '❌ 状态未更新'}`);
    console.log(`  菜单已关闭: ${after.menuOpen ? '❌' : '✅'}`);
  }
}

// ---- 测试2：右键连线 → 选「新增」----
const edgeInfo = await evaluate(`(() => {
  const v = window.__cg.view;
  const c = window.__cg.cam;
  const r = document.getElementById('cv').getBoundingClientRect();
  for (const e of v.edges) {
    const pts = e.points || [];
    for (let i = 0; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i+1][0]) / 2;
      const my = (pts[i][1] + pts[i+1][1]) / 2;
      const onNode = v.nodes.some(n => mx >= n.x && mx <= n.x + n.w && my >= n.y && my <= n.y + n.h);
      if (onNode) continue;
      return {
        key: e.from + '->' + e.to + ':' + e.line, change: e.change,
        x: r.left + c.x + mx * c.k, y: r.top + c.y + my * c.k,
      };
    }
  }
  return null;
})()`);

if (!edgeInfo) {
  console.log('\n[测试2] 跳过：没有可点的连线');
} else {
  console.log(`\n[测试2] 右键连线，标记为「新增」`);
  await rightClick(edgeInfo.x, edgeInfo.y);
  const shown = await evaluate(`document.getElementById('ctxMenu').classList.contains('show')`);
  if (!shown) {
    console.log('  ❌ 菜单未出现');
  } else {
    await evaluate(`document.querySelectorAll('#ctxMenu button')[1].click()`);
    await sleep(500);
    const after = await evaluate(`(() => {
      const v = window.__cg.view;
      const e = v.edges.find(x => (x.from + '->' + x.to + ':' + x.line) === ${JSON.stringify(edgeInfo.key)});
      return { change: e && e.change };
    })()`);
    console.log(`  change: ${edgeInfo.change} -> ${after.change}`);
    console.log(`  结论: ${after.change === 'added' ? '✅ 已标记为新增' : '❌ 状态未更新'}`);
  }
}

// 清理：把测试改动恢复为 existing
await evaluate(`(async () => {
  const v = window.__cg.view;
  for (const n of v.nodes) {
    if (n.change && n.change !== 'existing') {
      await fetch('/api/overlay', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ nodeId: n.id, data: { change: 'existing' } }) });
    }
  }
  for (const e of v.edges) {
    if (e.change && e.change !== 'existing') {
      await fetch('/api/overlay', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ edgeKey: e.from + '->' + e.to + ':' + e.line, data: { change: 'existing' } }) });
    }
  }
})()`);
console.log('\n已恢复测试产生的状态标记');

ws.close();
chrome.kill();
await sleep(300);
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* ignore */
}
