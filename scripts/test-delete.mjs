// 端到端测试：删除函数 / 删除连线 / 层级自动消失 / Ctrl+Z 恢复
// 用法: node scripts/test-delete.mjs [url]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:5173/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9224;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-del-'));
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

const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(80);
};

const pressKey = async (key, code, vk) => {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
  await sleep(450);
};

for (let i = 0; i < 60; i++) {
  if (await evaluate('!!window.__cg && !!window.__cg.view')) break;
  await sleep(250);
}

const snapshot = () =>
  evaluate(`(() => {
    const v = window.__cg.view;
    return {
      nodes: v.nodes.length,
      edges: v.edges.length,
      files: (v.groups || []).map(g => g.id),
      containers: (v.containers || []).map(c => c.id),
      err: document.body.getAttribute('data-err'),
    };
  })()`);

/** 把某个节点滚到视野内并点击它 */
const clickNode = async (nodeId) => {
  const pos = await evaluate(`(() => {
    const v = window.__cg.view;
    const c = window.__cg.cam;
    const n = v.nodes.find(x => x.id === ${JSON.stringify(nodeId)});
    if (!n) return null;
    const r = document.getElementById('cv').getBoundingClientRect();
    return { x: r.left + c.x + (n.x + n.w/2) * c.k, y: r.top + c.y + (n.y + n.h/2) * c.k };
  })()`);
  if (!pos) return false;
  await click(pos.x, pos.y);
  return true;
};

const before = await snapshot();
console.log('初始:', before.nodes, '节点 /', before.edges, '边 /', before.files.length, '文件框');
if (before.err) console.log('页面错误:', before.err);

// ---- 测试1：删掉某个文件里的全部函数，该文件框应自动消失 ----
const target = await evaluate(`(() => {
  const v = window.__cg.view;
  const byFile = new Map();
  for (const n of v.nodes) {
    if (!byFile.has(n.group)) byFile.set(n.group, []);
    byFile.get(n.group).push(n.id);
  }
  // 找函数最少（但非空）的文件，删起来快
  let best = null;
  for (const [f, ids] of byFile) if (!best || ids.length < best.ids.length) best = { file: f, ids };
  return best;
})()`);

console.log(`\n[测试1] 删光文件 ${target.file} 的 ${target.ids.length} 个函数`);
for (const nid of target.ids) {
  if (!(await clickNode(nid))) {
    console.log('  节点已不在视图中，跳过', nid);
    continue;
  }
  await pressKey('Delete', 'Delete', 46);
}
const after1 = await snapshot();
const fileGone = !after1.files.includes(target.file);
console.log(`  剩余: ${after1.nodes} 节点 / ${after1.files.length} 文件框`);
console.log(`  文件框 ${target.file} 已消失: ${fileGone ? '✅' : '❌'}`);
if (after1.err) console.log('  页面错误:', after1.err);

// ---- 测试2：Ctrl+Z 逐次恢复 ----
console.log(`\n[测试2] 连按 ${target.ids.length} 次 Ctrl+Z 恢复删除`);
for (let i = 0; i < target.ids.length; i++) {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'z',
    code: 'KeyZ',
    windowsVirtualKeyCode: 90,
    nativeVirtualKeyCode: 90,
    modifiers: 2,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'z',
    code: 'KeyZ',
    windowsVirtualKeyCode: 90,
    nativeVirtualKeyCode: 90,
    modifiers: 2,
  });
  await sleep(600);
}
const after2 = await snapshot();
console.log(`  恢复后: ${after2.nodes} 节点 / ${after2.files.length} 文件框`);
console.log(`  结论: ${after2.nodes === before.nodes ? '✅ 全部恢复' : '❌ 未完全恢复'}`);

// ---- 测试3：删除一条连线 ----
const edgeInfo = await evaluate(`(() => {
  const v = window.__cg.view;
  const c = window.__cg.cam;
  const e = v.edges.find(x => Array.isArray(x.points) && x.points.length >= 2);
  if (!e) return null;
  const p = e.points[Math.floor(e.points.length / 2)];
  const r = document.getElementById('cv').getBoundingClientRect();
  return {
    key: e.from + '->' + e.to + ':' + e.line,
    x: r.left + c.x + p[0] * c.k,
    y: r.top + c.y + p[1] * c.k,
    edges: v.edges.length,
  };
})()`);

if (edgeInfo) {
  console.log(`\n[测试3] 删除一条连线 (${edgeInfo.key})`);
  await click(edgeInfo.x, edgeInfo.y);
  await sleep(150);
  const sel = await evaluate('!!document.body && true');
  await pressKey('Delete', 'Delete', 46);
  const after3 = await snapshot();
  console.log(`  边数: ${edgeInfo.edges} -> ${after3.edges}`);
  console.log(`  结论: ${after3.edges === edgeInfo.edges - 1 ? '✅ 已删除' : '⚠️ 边数未按预期减少'}`);
} else {
  console.log('\n[测试3] 跳过：没有可点击的连线');
}

// 清理：清空所有删除记录
await evaluate(`fetch('/api/delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ clear: true }) }).then(r=>r.json())`);
console.log('\n已清空测试产生的删除记录');

ws.close();
chrome.kill();
await sleep(300);
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* ignore */
}
