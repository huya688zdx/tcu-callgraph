/**
 * 实时同步链路测试（SSE + cg_page）：
 * 1. SSE 流本身：握手头、方法/来源守卫
 * 2. 写操作 → 广播：AI（经 MCP 桥接，actor=ai）与用户（直连 HTTP，actor=user）两种来源
 * 3. 页面状态上报 /api/page 与 cg_page 工具读取
 * 4. 切工程广播 project.switch
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMcpServer } from '../src/mcp.js';
import { launchServer } from '../scripts/lib/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const rpc = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

const postJson = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then((r) => r.json());

// ---------------------------------------------------------------------------
// SSE 读取端夹具：解析 text/event-stream，按块回调
// ---------------------------------------------------------------------------

async function openStream(base) {
  const ac = new AbortController();
  const res = await fetch(base + '/api/stream', { signal: ac.signal });
  const events = [];
  const waiters = new Set();

  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = { event: 'message', data: '' };
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) ev.data += line.slice(5).trim();
          }
          if (!ev.data) continue; // 注释行 / 心跳
          try {
            ev.json = JSON.parse(ev.data);
          } catch {
            /* 非 JSON 数据位：跳过 */
          }
          events.push(ev);
          for (const w of waiters) w();
        }
      }
    } catch {
      /* close() 触发的 abort 会走到这里，正常 */
    }
  })();

  return {
    res,
    events,
    /** 等到第一条满足条件的事件；超时把已收到的都打出来，方便定位 */
    waitFor(predicate, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const hit = () => events.find(predicate);
        if (hit()) return resolve(hit());
        const w = () => {
          const h = hit();
          if (h) {
            cleanup();
            resolve(h);
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`等待 SSE 事件超时，已收到：${JSON.stringify(events)}`));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          waiters.delete(w);
        };
        waiters.add(w);
      });
    },
    close() {
      ac.abort();
    },
  };
}

// ---------------------------------------------------------------------------
// 单元：cg_page 工具与权限
// ---------------------------------------------------------------------------

test('tools/list 含 cg_page，readonly 即可用', async () => {
  const mcp = createMcpServer({
    baseUrl: 'http://127.0.0.1:5999',
    getAccess: () => 'readonly',
    writeOut: async (name) => path.join(ROOT, 'out', name),
    fetchImpl: async () => ({ json: async () => ({ page: null }) }),
  });
  const r = await mcp.handlePost(rpc('tools/list', {}));
  const names = r.body.result.tools.map((t) => t.name);
  assert.ok(names.includes('cg_page'), 'readonly 工具表应含 cg_page');
});

// ---------------------------------------------------------------------------
// 端到端
// ---------------------------------------------------------------------------

test('e2e：/api/stream 握手与守卫（405 / 跨站 Origin 403）', async () => {
  const srv = await launchServer({ target: 'samples/tcu' });
  try {
    const base = srv.baseUrl;

    const post = await fetch(base + '/api/stream', { method: 'POST' });
    assert.equal(post.status, 405);

    const evil = await fetch(base + '/api/stream', { headers: { Origin: 'http://evil.example' } });
    assert.equal(evil.status, 403);
  } finally {
    await srv.close();
  }
});

test('e2e：页面状态上报 → /api/page 与 cg_page 工具都能读到', async () => {
  const srv = await launchServer({ target: 'samples/tcu' });
  try {
    const base = srv.baseUrl;

    // 没有页面上报过：page 为 null，带 hint 而不是报错
    const empty = await (await fetch(base + '/api/page')).json();
    assert.equal(empty.page, null);
    assert.ok(empty.hint, '未上报时应给提示而不是裸 null');

    // 模拟页面上报（与 web/lib/live.js 的载荷一致）
    const rep = await postJson(base + '/api/page', {
      roots: ['a.c::main'],
      up: 0,
      down: 3,
      group: true,
      vars: [],
      selected: 'a.c::main',
      selectedEdge: null,
      at: 0,
    });
    assert.equal(rep.ok, true);

    const page = await (await fetch(base + '/api/page')).json();
    assert.deepEqual(page.page.roots, ['a.c::main']);
    assert.equal(page.page.selected, 'a.c::main');
    assert.equal(page.page.reviewing, false);
    assert.ok(page.project && page.project.name, '应带当前工程身份');

    // AI 侧：cg_page 工具读到同一份状态
    const viaTool = await (await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rpc('tools/call', { name: 'cg_page', arguments: {} }, 1),
    })).json();
    const payload = JSON.parse(viaTool.result.content[0].text);
    assert.deepEqual(payload.page.roots, ['a.c::main']);

    // 脏字段直接丢掉，不落进内存状态
    await postJson(base + '/api/page', { roots: '不是数组', selected: 42, at: -1 });
    const dirty = await (await fetch(base + '/api/page')).json();
    assert.deepEqual(dirty.page.roots, []);
    assert.equal(dirty.page.selected, null);
    assert.equal(dirty.page.reviewing, false);
  } finally {
    await srv.close();
  }
});

test('e2e：AI 经 MCP 写标注 → SSE 广播 actor=ai；用户直连写 → actor=user', async () => {
  const prevEnv = process.env.CALLGRAPH_MCP;
  process.env.CALLGRAPH_MCP = 'readwrite';
  const srv = await launchServer({ target: 'samples/tcu' });
  const stream = await openStream(srv.baseUrl);
  try {
    const base = srv.baseUrl;
    assert.equal(stream.res.status, 200);
    assert.match(stream.res.headers.get('content-type') || '', /text\/event-stream/);

    // 找一个真实函数 id
    const found = await (await fetch(base + '/api/search?q=main')).json();
    assert.ok(found.length > 0, 'samples/tcu 应有函数');
    const fnId = (found.find((f) => f.name === 'main') || found[0]).id;

    // 1) AI 写：走 MCP 桥接
    const ann = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rpc('tools/call', { name: 'cg_annotate', arguments: { nodeId: fnId, data: { note: 'live 同步测试' } } }, 1),
    });
    assert.equal((await ann.json()).result.isError, undefined, 'cg_annotate 应成功');
    const aiEv = await stream.waitFor((e) => e.json && e.json.actor === 'ai' && e.json.op === 'node.annotate');
    assert.equal(aiEv.event, 'change');
    assert.equal(aiEv.json.target, fnId);

    // 2) 用户写：直连 HTTP（不带 actor）
    await postJson(base + '/api/overlay', { nodeId: fnId, data: { note: '用户手改' } });
    const userEv = await stream.waitFor((e) => e.json && e.json.actor === 'user' && e.json.op === 'node.annotate');
    assert.ok(userEv.json.ts > 0);
  } finally {
    stream.close();
    if (prevEnv === undefined) delete process.env.CALLGRAPH_MCP;
    else process.env.CALLGRAPH_MCP = prevEnv;
    await srv.close();
  }
});

test('e2e：删除 / 布局写操作也广播；切工程广播 project.switch', async () => {
  const prevEnv = process.env.CALLGRAPH_MCP;
  process.env.CALLGRAPH_MCP = 'readwrite';
  const srv = await launchServer({ target: 'samples/tcu' });
  const stream = await openStream(srv.baseUrl);
  try {
    const base = srv.baseUrl;

    await postJson(base + '/api/delete', { nodes: ['no-such-fn'], actor: 'ai' });
    const delEv = await stream.waitFor((e) => e.json && e.json.op === 'delete');
    assert.equal(delEv.json.actor, 'ai');

    await postJson(base + '/api/layout', { root: '', nodes: { 'a.c::x': { x: 1, y: 2 } }, actor: 'ai' });
    const layoutEv = await stream.waitFor((e) => e.json && e.json.op === 'layout.save');
    assert.equal(layoutEv.json.actor, 'ai');

    // 切工程：广播带新工程名
    const sw = await postJson(base + '/api/switch', { path: path.join(ROOT, 'samples', 'demo'), actor: 'ai' });
    assert.equal(sw.ok, true, '切到 samples/demo 应成功');
    const swEv = await stream.waitFor((e) => e.json && e.json.op === 'project.switch');
    assert.equal(swEv.json.actor, 'ai');
    assert.ok(swEv.json.project, '广播应带工程名');

    // 切工程后页面状态作废（前端重载后会重新上报）
    const page = await (await fetch(base + '/api/page')).json();
    assert.equal(page.page, null);
  } finally {
    stream.close();
    if (prevEnv === undefined) delete process.env.CALLGRAPH_MCP;
    else process.env.CALLGRAPH_MCP = prevEnv;
    await srv.close();
  }
});
