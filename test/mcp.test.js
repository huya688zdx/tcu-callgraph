/**
 * MCP 服务器测试：
 * 1. 协议层单元测试——mock fetch，验证 JSON-RPC、权限矩阵、通知、批量、路径越界
 * 2. 端到端——launchServer 起真实服务，走完 initialize → tools/list → tools/call 全链路，
 *    并验证写操作在时间轴里带 actor=ai、SVG 导出落盘、/api/mcp-config 的权限来源
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMcpServer } from '../src/mcp.js';
import { launchServer } from '../scripts/lib/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 单元：mock 桥接
// ---------------------------------------------------------------------------

/** 记录调用的假 fetch：GET /api/stats → 统计；POST /api/overlay → ok */
function mockFetch() {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const body = {
      json: async () => {
        if (url.endsWith('/api/stats')) return { stats: { functions: 42 } };
        if (url.includes('/api/overlay')) return { ok: true };
        if (url.includes('/api/export/svg')) return { ok: true, path: 'out/x.svg', bytes: 10 };
        return { ok: true };
      },
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(4),
      text: async () => '',
    };
    return body;
  };
  return { fetchImpl, calls };
}

function makeServer(level, fetchImpl) {
  return createMcpServer({
    baseUrl: 'http://127.0.0.1:5999',
    getAccess: () => level,
    writeOut: async (name) => path.join(ROOT, 'out', name),
    fetchImpl,
  });
}

const rpc = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

test('initialize 返回协议版本与当前权限', async () => {
  const { fetchImpl } = mockFetch();
  const mcp = makeServer('readonly', fetchImpl);
  const r = await mcp.handlePost(rpc('initialize', { protocolVersion: '2025-03-26' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.result.protocolVersion, '2025-06-18');
  assert.equal(r.body.result.serverInfo.name, 'tcu-callgraph');
  assert.match(r.body.result.instructions, /readonly/);
});

test('tools/list 按权限过滤：readonly 不含写工具，readwrite 全量，off 为空', async () => {
  const { fetchImpl } = mockFetch();
  const names = (level) =>
    mcpLevel(level)
      .result.tools.map((t) => t.name)
      .sort();

  const mcpLevel = (level) => makeServer(level, fetchImpl);

  const ro = await mcpLevel('readonly').handlePost(rpc('tools/list', {}));
  assert.ok(!ro.body.result.tools.some((t) => t.name === 'cg_annotate'), 'readonly 不应有写工具');
  assert.ok(ro.body.result.tools.some((t) => t.name === 'cg_export_svg'), 'readonly 应有导出工具');
  assert.ok(ro.body.result.tools.some((t) => t.name === 'cg_view'), 'readonly 应有读工具');

  const rw = await mcpLevel('readwrite').handlePost(rpc('tools/list', {}));
  assert.ok(rw.body.result.tools.some((t) => t.name === 'cg_annotate'), 'readwrite 应有写工具');

  const off = await mcpLevel('off').handlePost(rpc('tools/list', {}));
  assert.equal(off.body.result.tools.length, 0, 'off 时工具列表为空');
  assert.equal(off.body.result._disabled, true);
});

test('tools/call：readonly 调写工具被拒，readwrite 桥接成功且带 actor=ai', async () => {
  const { fetchImpl, calls } = mockFetch();

  const ro = makeServer('readonly', fetchImpl);
  const denied = await ro.handlePost(
    rpc('tools/call', { name: 'cg_annotate', arguments: { nodeId: 'main.c::main', data: { note: 'x' } } })
  );
  assert.equal(denied.body.error.code, -32000);
  assert.match(denied.body.error.message, /readwrite/);

  const rw = makeServer('readwrite', fetchImpl);
  const ok = await rw.handlePost(
    rpc('tools/call', { name: 'cg_annotate', arguments: { nodeId: 'main.c::main', data: { note: 'x' } } })
  );
  assert.equal(ok.body.result.isError, undefined);
  const payload = JSON.parse(ok.body.result.content[0].text);
  assert.equal(payload.ok, true);
  // 桥接的 POST 必须带 actor=ai，时间轴才能区分 AI 改动
  const call = calls.find((c) => c.url.includes('/api/overlay'));
  assert.equal(JSON.parse(call.opts.body).actor, 'ai');
});

test('通知不回包（202），非法 JSON 报 -32700，批量请求逐条处理', async () => {
  const { fetchImpl } = mockFetch();
  const mcp = makeServer('readonly', fetchImpl);

  const note = await mcp.handlePost(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(note.status, 202);
  assert.equal(note.body, null);

  const bad = await mcp.handlePost('{oops');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, -32700);

  const batch = await mcp.handlePost(
    JSON.stringify([{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }])
  );
  assert.equal(batch.status, 200);
  assert.ok(Array.isArray(batch.body));
  assert.equal(batch.body.length, 1, '批量里只有 ping 需要回包');
  assert.deepEqual(batch.body[0].result, {});
});

test('未知方法 / 未知工具报错；工具执行异常不炸协议层', async () => {
  const { fetchImpl } = mockFetch();
  const mcp = makeServer('readwrite', fetchImpl);

  const unknownMethod = await mcp.handlePost(rpc('resources/list', {}));
  assert.equal(unknownMethod.body.error.code, -32601);

  const unknownTool = await mcp.handlePost(rpc('tools/call', { name: 'nope', arguments: {} }));
  assert.equal(unknownTool.body.error.code, -32602);

  // fetch 抛异常 → isError 结果而不是协议错误
  const broken = makeServer('readwrite', async () => {
    throw new Error('boom');
  });
  const r = await broken.handlePost(rpc('tools/call', { name: 'cg_stats', arguments: {} }));
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /boom/);
});

test('导出工具的 outPath 只允许 out/ 下的文件名', async () => {
  const { fetchImpl } = mockFetch();
  const mcp = makeServer('readonly', fetchImpl);

  for (const evil of ['../evil.svg', 'c:/x.svg', 'a/b.svg']) {
    const r = await mcp.handlePost(rpc('tools/call', { name: 'cg_export_svg', arguments: { out: evil } }));
    const payload = JSON.parse(r.body.result.content[0].text);
    assert.equal(payload.ok, false, `${evil} 应被拒绝`);
  }
  const fine = await mcp.handlePost(
    rpc('tools/call', { name: 'cg_export_svg', arguments: { root: 'main.c::main', out: 'ok.svg' } })
  );
  const payload = JSON.parse(fine.body.result.content[0].text);
  assert.equal(payload.ok, true);
});

// ---------------------------------------------------------------------------
// 端到端：真实服务 + 真实库
// ---------------------------------------------------------------------------

test('e2e：initialize → tools/call 全链路，写操作带 actor=ai，SVG 导出落盘', async () => {
  const prevEnv = process.env.CALLGRAPH_MCP;
  process.env.CALLGRAPH_MCP = 'readwrite';
  const srv = await launchServer({ target: 'samples/tcu' });
  try {
    const base = srv.baseUrl;

    // GET /mcp 不支持
    const get405 = await fetch(base + '/mcp');
    assert.equal(get405.status, 405);

    // initialize
    const init = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rpc('initialize', {}, 1),
    });
    assert.equal(init.status, 200);
    assert.equal((await init.json()).result.serverInfo.name, 'tcu-callgraph');

    // 权限来源：环境变量锁定
    const cfg = await (await fetch(base + '/api/mcp-config')).json();
    assert.equal(cfg.level, 'readwrite');
    assert.equal(cfg.source, 'env');

    // 环境变量锁定时界面写设置应被拒绝
    const blocked = await fetch(base + '/api/mcp-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'off' }),
    });
    assert.equal((await blocked.json()).ok, false);

    // 搜索 → 标注全链路
    const search = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rpc('tools/call', { name: 'cg_search', arguments: { q: 'main' } }, 2),
    });
    const searchPayload = JSON.parse((await search.json()).result.content[0].text);
    assert.ok(Array.isArray(searchPayload) && searchPayload.length > 0, '应搜到 main');
    const mainId = searchPayload.find((f) => f.name === 'main')?.id || searchPayload[0].id;

    const ann = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rpc('tools/call', { name: 'cg_annotate', arguments: { nodeId: mainId, data: { note: 'MCP 测试' } } }, 3),
    });
    assert.equal((await ann.json()).result.isError, undefined, '标注应成功');

    // 时间轴里应出现 actor=ai 的标注事件
    const events = await (await fetch(base + '/api/events?limit=20')).json();
    const aiEvent = events.events.find((e) => e.actor === 'ai' && e.op === 'node.annotate');
    assert.ok(aiEvent, '时间轴应记录 actor=ai 的标注');
    assert.equal(aiEvent.target, mainId);

    // 标注确实生效（cg_node 能读到）
    const node = JSON.parse(
      (
        await (
          await fetch(base + '/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: rpc('tools/call', { name: 'cg_node', arguments: { id: mainId } }, 4),
          })
        ).json()
      ).result.content[0].text
    );
    assert.equal(node.overlay.note, 'MCP 测试');

    // SVG 导出（HTTP 直连 + MCP 工具两条路都通）
    const svgName = `mcp-test-${Date.now()}.svg`;
    const viaTool = JSON.parse(
      (
        await (
          await fetch(base + '/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: rpc('tools/call', { name: 'cg_export_svg', arguments: { root: mainId, out: svgName } }, 5),
          })
        ).json()
      ).result.content[0].text
    );
    assert.equal(viaTool.ok, true, 'MCP 导出 SVG 应成功');
    const svgFile = path.join(ROOT, 'out', svgName);
    try {
      const svg = fs.readFileSync(svgFile, 'utf8');
      assert.ok(svg.startsWith('<svg'), '产物应是 SVG');
      assert.ok(svg.includes('MCP 测试') || svg.includes(mainId.split('::').pop()), 'SVG 应含节点内容');
    } finally {
      fs.rmSync(svgFile, { force: true });
    }
  } finally {
    if (prevEnv === undefined) delete process.env.CALLGRAPH_MCP;
    else process.env.CALLGRAPH_MCP = prevEnv;
    await srv.close();
  }
});

test('e2e：cg_annotate 框色受固定四色约束（非法拒、大小写归一、null 清除、导入清洗）', async () => {
  const prevEnv = process.env.CALLGRAPH_MCP;
  process.env.CALLGRAPH_MCP = 'readwrite';
  const srv = await launchServer({ target: 'samples/tcu' });
  try {
    const base = srv.baseUrl;
    const call = async (name, args, id) =>
      await (
        await fetch(base + '/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: rpc('tools/call', { name, arguments: args }, id),
        })
      ).json();
    const nodeColor = async () => {
      const v = await (await fetch(base + '/api/view?root=main.c::main')).json();
      const n = v.nodes.find((x) => x.id === 'main.c::main');
      return n ? n.color ?? null : 'missing';
    };

    // 1) 规则外的颜色被拒，报错里给出四色清单
    const denied = await call('cg_annotate', { nodeId: 'main.c::main', data: { color: '#FF0000' } }, 1);
    assert.equal(denied.result.isError, true, '非法颜色应返回错误');
    assert.match(denied.result.content[0].text, /#CCFFCC/);
    assert.equal(await nodeColor(), null, '被拒的写入不该落库');

    // 2) 合法颜色（小写）归一成白名单大写
    const ok = await call('cg_annotate', { nodeId: 'main.c::main', data: { color: '#ffff99' } }, 2);
    assert.equal(ok.result.isError, undefined);
    assert.equal(await nodeColor(), '#FFFF99');

    // 3) null 清除，回落 change 分类色
    const clear = await call('cg_annotate', { nodeId: 'main.c::main', data: { color: null } }, 3);
    assert.equal(clear.result.isError, undefined);
    assert.equal(await nodeColor(), null);

    // 4) .cgx 会话导入：规则外的颜色丢弃，合法的保留
    const imp = await (
      await fetch(base + '/api/session/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: 'tcu-callgraph-session',
          version: 1,
          overlay: { nodes: { 'main.c::main': { color: 'rebeccapurple', note: 'x' } } },
          bookmarks: [],
        }),
      })
    ).json();
    assert.equal(imp.ok, true, '单条脏色不该让整个导入失败');
    assert.equal(await nodeColor(), null, '导入的非法颜色应被丢弃');
  } finally {
    if (prevEnv === undefined) delete process.env.CALLGRAPH_MCP;
    else process.env.CALLGRAPH_MCP = prevEnv;
    await srv.close();
  }
});

test('e2e：默认权限 readonly——写工具被拒、读与导出可用', async () => {
  const prevEnv = process.env.CALLGRAPH_MCP;
  delete process.env.CALLGRAPH_MCP;
  const srv = await launchServer({ target: 'samples/tcu' });
  try {
    const base = srv.baseUrl;
    const cfg = await (await fetch(base + '/api/mcp-config')).json();
    assert.equal(cfg.level, 'readonly');
    assert.equal(cfg.source, 'default');

    // 返回整个响应对象：权限拒绝时错误在 .error，成功时结果在 .result
    const call = async (name, args, id) =>
      await (
        await fetch(base + '/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: rpc('tools/call', { name, arguments: args }, id),
        })
      ).json();

    const denied = await call('cg_annotate', { nodeId: 'main.c::main', data: { note: 'x' } }, 1);
    assert.ok(denied.error, '写工具应被拒绝');
    assert.match(denied.error.message, /readwrite/);

    const stats = await call('cg_stats', {}, 2);
    const payload = JSON.parse(stats.result.content[0].text);
    assert.ok(payload.stats.functions > 0, '读工具应可用');

    const svgName = `mcp-ro-${Date.now()}.svg`;
    const exp = await call('cg_export_svg', { out: svgName }, 3);
    const expPayload = JSON.parse(exp.result.content[0].text);
    assert.equal(expPayload.ok, true, '导出在 readonly 下应可用');
    fs.rmSync(path.join(ROOT, 'out', svgName), { force: true });

    // 界面设置改成 readwrite 后立即生效（每个请求都重读权限）
    const set = await fetch(base + '/api/mcp-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'readwrite' }),
    });
    assert.equal((await set.json()).ok, true);
    const allowed = await call('cg_delete', { nodes: ['no-such-fn'], restore: true }, 4);
    assert.ok(!allowed.error, '切到 readwrite 后写工具应放行');
  } finally {
    if (prevEnv === undefined) delete process.env.CALLGRAPH_MCP;
    else process.env.CALLGRAPH_MCP = prevEnv;
    await srv.close();
  }
});

test('e2e：/mcp 与其他写端点同一道跨站守卫（CSRF 回归）', async () => {
  const srv = await launchServer({ target: 'samples/tcu' });
  try {
    const base = srv.baseUrl;
    const body = rpc('tools/call', { name: 'cg_stats', arguments: {} }, 1);

    // 1) 伪造外站 Origin：必须 403。浏览器发的跨站请求一定带 Origin，
    //    挡在这里，恶意页面就无法借用户的 localhost 服务改图。
    const evil = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body,
    });
    assert.equal(evil.status, 403, '跨站 Origin 必须被拒');

    // 2) text/plain 的「简单请求」不触发预检，靠 Content-Type 兜住
    const form = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body,
    });
    assert.equal(form.status, 415, '非 JSON 的 Content-Type 必须被拒');

    // 3) 正常客户端（无 Origin + application/json）不受影响
    const ok = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(ok.status, 200, '正常 MCP 客户端应放行');
    assert.ok((await ok.json()).result, '正常客户端应拿到结果');

    // 4) 本机来源也放行（Electron / 浏览器内的 MCP 面板）
    const local = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body,
    });
    assert.equal(local.status, 200, '本机来源应放行');
  } finally {
    await srv.close();
  }
});
