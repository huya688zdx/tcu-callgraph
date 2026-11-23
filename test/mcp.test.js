/**
 * MCP 服务器测试：
 * 1. 协议层单元测试——mock fetch，验证 JSON-RPC、权限矩阵、通知、批量、路径越界
 * 2. 端到端——launchServer 起真实服务，走完 initialize → tools/list → tools/call 全链路，
 *    并验证写操作在时间轴里带 actor=ai、SVG 导出落盘、/api/mcp-config 的权限来源
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
  assert.match(r.body.result.instructions, /cg_source.*C 源码/);
  assert.match(r.body.result.instructions, /コール順1/);
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
  assert.ok(ro.body.result.tools.some((t) => t.name === 'cg_source'));
  assert.ok(!ro.body.result.tools.some((t) => ['cg_compose_view', 'cg_apply_task_labels'].includes(t.name)));

  const rw = await mcpLevel('readwrite').handlePost(rpc('tools/list', {}));
  assert.ok(rw.body.result.tools.some((t) => t.name === 'cg_annotate'), 'readwrite 应有写工具');
  assert.ok(rw.body.result.tools.some((t) => t.name === 'cg_compose_view'));
  assert.ok(rw.body.result.tools.some((t) => t.name === 'cg_apply_task_labels'));

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

async function callTool(base, name, args) {
  const response = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rpc('tools/call', { name, arguments: args }),
  });
  const { result, error } = await response.json();
  assert.ok(result, error?.message);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(Boolean(result.isError), payload.ok === false);
  return payload;
}

async function postJson(base, route, body) {
  const response = await fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return response.json();
}

test('e2e：cg_source 返回函数定义和分析信息，按行读源码时拒绝越界路径', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(srv.close);
  const base = srv.baseUrl;
  const source = await callTool(base, 'cg_source', { id: 'main.c::SysTick_Handler' });
  assert.equal(source.ok, true);
  assert.match(source.source, /^void SysTick_Handler\(void\)/);
  assert.match(source.source, /g_tick % 10u/);
  assert.match(source.source, /\n}$/);
  assert.equal(source.truncated, false);
  assert.ok(Array.isArray(source.taskPeriods));
  assert.ok(source.calls.some((edge) => edge.to === 'main.c::Task_10ms' && edge.edgeKey.endsWith(':' + edge.line)));
  assert.ok(source.varAccess.some((access) => access.name === 'g_tick'));

  const range = await callTool(base, 'cg_source', { file: 'main.c', startLine: 1, endLine: 900 });
  assert.equal(range.ok, true);
  assert.equal(range.truncated, true);
  assert.match(range.source, /^#include "gear.h"/);
  assert.equal(range.source.split('\n').length, range.endLine);
  for (const file of ['../demo/main.c', path.join(ROOT, 'samples', 'tcu', 'main.c')]) {
    const denied = await callTool(base, 'cg_source', { file, startLine: 1, endLine: 2 });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /工程内/);
  }
  assert.equal((await callTool(base, 'cg_source', { file: 'main.c', startLine: 5, endLine: 2 })).ok, false);
  assert.equal((await callTool(base, 'cg_source', { id: 'ext::missing' })).ok, false);
});

test('e2e：比较模式的 cg_source 读取映射后的修改和新增源码', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-compare-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const [project, beforePath, afterPath] = ['project', 'before', 'after'].map(dir => path.join(temp, dir));
  for (const dir of [beforePath, afterPath]) fs.mkdirSync(dir);
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  const old = 'int work(void) { return 1; }';
  const updated = 'int work(void) { return 2; }';
  const added = 'int added(void) { return 3; }';
  fs.writeFileSync(path.join(project, 'src', 'work.c'), old);
  fs.writeFileSync(path.join(beforePath, 'work.c'), old);
  fs.writeFileSync(path.join(afterPath, 'work.c'), '\n\n' + updated);
  fs.writeFileSync(path.join(afterPath, 'added.c'), added);

  const srv = await launchServer({ target: project });
  t.after(srv.close);
  const base = srv.baseUrl;
  const preview = await postJson(base, '/api/compare', { beforePath, afterPath });
  assert.equal(preview.ok, true, preview.error);
  const applied = await postJson(base, '/api/compare/apply', {
    previewId: preview.preview.id, selectedIds: ['src/work.c::work', 'added.c::added'],
  });
  assert.equal(applied.ok, true, applied.error);
  const source = await callTool(base, 'cg_source', { id: 'src/work.c::work' });
  assert.equal(source.source, updated, source.error);
  assert.equal(source.startLine, 3);
  const range = await callTool(base, 'cg_source', { file: 'added.c', startLine: 1, endLine: 1 });
  assert.equal(range.source, added, range.error);
});

test('e2e：追加入口独立展开，原入口保留原深度', async (t) => {
  const { baseUrl: base, close } = await launchServer({ target: 'samples/tcu' });
  t.after(close);
  assert.equal((await postJson(base, '/api/mcp-config', { level: 'readwrite' })).ok, true);
  const compose = (mode, root, down) => callTool(base, 'cg_compose_view', { mode, roots: [root], up: 0, down });
  const view = (page) => postJson(base, `/api/view?up=${page.up}&down=${page.down}`, page);
  const main = 'main.c::main';
  const tick = 'main.c::SysTick_Handler';
  const task = 'main.c::Task_10ms';
  const picked = await callTool(base, 'cg_compose_view', { mode: 'replace', functionIds: [main], up: 2, down: 2 });
  assert.equal(picked.ok, true, picked.error);
  assert.deepEqual((await view(picked.page)).nodes.map(node => node.id), [main]);
  for (const [oldDepth, newDepth, hasTask, hasInit] of [[0, 2, true, false], [1, 0, true, true]]) {
    assert.equal((await compose('replace', main, oldDepth)).ok, true);
    const added = await compose('add', tick, newDepth);
    assert.equal(added.ok, true, added.error);
    const ids = new Set((await view(added.page)).nodes.map(node => node.id));
    assert.ok(ids.has(main) && ids.has(tick));
    assert.equal(ids.has(task), hasTask);
    assert.equal([...ids].some(id => id.endsWith('::Can_Init')), hasInit);
    assert.equal(ids.has('main.c::Task_Shift'), newDepth === 2);
  }
});

test('e2e：已保存的手工连线可以标注并写入 TASK 标签', async (t) => {
  const { baseUrl: base, close } = await launchServer({ target: 'samples/tcu' });
  t.after(close);
  assert.equal((await postJson(base, '/api/mcp-config', { level: 'readwrite' })).ok, true);
  const root = 'main.c::main', to = 'main.c::SysTick_Handler';
  const roots = [root, to], edgeKey = `${root}->${to}:0`;
  const view = () => callTool(base, 'cg_view', { roots, up: 0, down: 0 });
  const data = { note: '手工调度关系' };
  assert.equal((await callTool(base, 'cg_annotate', { edgeKey, data })).ok, false);
  assert.equal((await callTool(base, 'cg_save_layout', { root: roots.join('+'), manual: [{ from: root, to }] })).ok, true);
  assert.ok((await view()).edges.some(edge => edge.from === root && edge.to === to && edge.manual && edge.line === 0));
  const annotation = await callTool(base, 'cg_annotate', { edgeKey, data });
  assert.equal(annotation.ok, true, annotation.error);
  const applied = await callTool(base, 'cg_apply_task_labels', { items: [{ edgeKey, preset: 'task', text: '10ms TASK' }] });
  assert.equal(applied.ok, true, applied.error);
  assert.deepEqual(applied.edgeKeys, [edgeKey]);
  assert.equal((await view()).edges.find(edge => edge.from === root && edge.to === to && edge.manual).label.text, '10ms TASK');
  const events = await (await fetch(base + '/api/events?detail=1')).json();
  assert.ok(events.events.some(event => event.target === edgeKey && event.after?.note === data.note));
});

test('e2e：cg_apply_task_labels 解析简写边键，合并预设并拒绝批内和库内重号', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(srv.close);
  const base = srv.baseUrl;
  await fetch(base + '/api/mcp-config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'readwrite' }),
  });
  const caller = 'main.c::main';
  const source = await callTool(base, 'cg_source', { id: caller });
  const first = source.calls.find((edge) => edge.callee === 'Can_Init');
  const second = source.calls.find((edge) => edge.callee === 'Adc_Init');
  const taskEdge = 'main.c::SysTick_Handler->main.c::Task_10ms';
  const shortKey = `${caller}->${first.to}`;
  const firstCall = { edgeKey: shortKey, preset: 'call', order: 1 };
  const secondCall = { edgeKey: second.edgeKey, preset: 'call', text: 'コール順1' };
  const apply = (items, options) => callTool(base, 'cg_apply_task_labels', { items, ...options });
  const events = async () => (await (await fetch(base + '/api/events?detail=1')).json()).events;
  const duplicate = await apply([firstCall, secondCall]);
  assert.match(duplicate.error, /コール順1.*重复/);
  assert.match((await apply([firstCall, { edgeKey: 'missing->edge', preset: 'conn' }])).error, /missing->edge/);
  assert.match((await apply([{ ...firstCall, order: 0 }])).error, /正整数/);
  assert.ok(!(await events()).some((e) => e.actor === 'ai'));

  assert.deepEqual((await apply([firstCall])).edgeKeys, [first.edgeKey]);
  assert.match((await apply([secondCall])).error, /コール順1.*已用于/);
  const lowLevel = await callTool(base, 'cg_annotate', {
    edgeKey: second.edgeKey, data: { labels: [{ preset: 'call', text: 'コール順1' }] },
  });
  assert.match(lowLevel.error, /コール順1.*已用于/);
  assert.ok((await apply([{ ...secondCall, text: 'コール順2' }, { edgeKey: shortKey, preset: 'conn' }])).ok);
  assert.match((await apply([{ edgeKey: taskEdge, preset: 'task', text: ' ' }])).error, /非空文字/);
  assert.ok((await apply([{ edgeKey: taskEdge, preset: 'task', text: '10ms TASK', note: 'main.c:16 每 10 次 tick 调度' }])).ok);

  const list = await events();
  const merged = list.find((event) => event.target === first.edgeKey);
  assert.deepEqual(merged.after.labels.map((label) => label.preset), ['call', 'conn']);
  assert.deepEqual(merged.brief.labels, ['コール順1', '結合点：1']);
  assert.ok(list.find((event) => event.target.startsWith(taskEdge + ':')).after.labels[0].border);
  assert.equal(merged.actor, 'ai');
  assert.ok((await apply([{ edgeKey: shortKey, preset: 'conn' }], { merge: false })).ok);
  assert.deepEqual((await events()).find((event) => event.target === first.edgeKey).after.labels.map((label) => label.preset), ['conn']);
});

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
