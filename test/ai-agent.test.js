import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  estimateMessagesTokens,
  extractThinkingAndText,
  normalizeAiConfig,
  normalizeBaseUrl,
  parsePromptToolCalls,
  runAiAgent,
} from '../src/core/ai-agent.js';
import { launchServer } from '../scripts/lib/server.mjs';
import { launchCdp, resolveChromePath } from '../scripts/lib/cdp.mjs';

test('runAiAgent：发送多模态图片、估算图片 token 并在 HTTP 400 时降级', async () => {
  const prompt = '查看画布截图';
  const small = 'data:image/png;base64,AAAA';
  const large = 'data:image/webp;base64,' + 'A'.repeat(2_400_000);
  const content = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: small } },
    { type: 'image_url', image_url: { url: large } },
  ];
  const tokens = estimateMessagesTokens([{ role: 'user', content }]);
  assert.ok(tokens >= 1200 && tokens < 1300);
  assert.equal(tokens, estimateMessagesTokens([{
    role: 'user', content: content.map(part => part.image_url ? { ...part, image_url: { url: small } } : part),
  }]));

  for (const rejectsImages of [false, true]) {
    const requests = [], events = [];
    const result = await runAiAgent({
      config: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'mock-vision', toolMode: 'tools' },
      prompt, images: [{ dataUrl: small, label: '画布' }, { dataUrl: large }], maxSteps: 1,
      onEvent: event => events.push(event),
      fetchImpl: async (_url, { body }) => {
        requests.push(JSON.parse(body).messages.at(-1).content);
        if (requests.length === 1 && rejectsImages) {
          return Response.json({ error: { param: 'messages', message: 'Expected message content to be a string' } }, { status: 400 });
        }
        return Response.json({ choices: [{ message: { content: '已查看。' } }] });
      },
    });
    assert.deepEqual(requests, rejectsImages ? [content, prompt] : [content]);
    assert.equal(result.ok, true);
    assert.equal(result.answer, '已查看。');
    assert.ok(result.metrics.contextEstTokens < 10_000);
    assert.deepEqual(events.filter(event => event.type === 'fallback'), rejectsImages ? [{
      type: 'fallback', text: '当前模型接口不支持图片输入，已自动降级为纯文本继续',
    }] : []);
  }
});

test('e2e：AI 对话接收多张图片和混合选区，检查、调整并重置画布布局', async t => {
  const srv = await launchServer();
  t.after(srv.close);
  const get = route => fetch(srv.baseUrl + route, { signal: AbortSignal.timeout(15_000) }).then(res => res.json());
  const post = (route, body) => fetch(srv.baseUrl + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const jsonPost = (route, body) => post(route, body).then(res => res.json());
  const root = 'main.c::main';
  const page = { roots: [root, 'can.c::Can_Init'], up: 0, down: 1 };
  const layoutRoot = page.roots.join('+');
  const query = '/api/view?up=0&down=1';
  const viewUrl = query + '&roots=' + encodeURIComponent(page.roots.join(','));
  const view = await get(viewUrl);
  assert.equal((await jsonPost('/api/page', page)).ok, true);
  assert.ok(view.groups.length && view.containers.length && view.edges.length);
  const other = view.nodes.find(node => node.name === 'Task_10ms');
  const anchor = view.nodes.find(node => node.name === 'Can_Init');
  const liveNodes = view.nodes.map((node, i) => ({
    id: node.id, name: node.name, kind: node.kind, file: node.file,
    x: 1000 + i * 250, y: 1000 + i * 150, w: node.w, h: node.h,
  }));
  const anchorRect = liveNodes.find(node => node.id === anchor.id);
  const liveGroups = view.groups.map(({ id, x, y, w, h }) => ({ id, x: x + 500, y, w, h }));
  const liveContainers = view.containers.map(({ id, x, y, w, h }) => ({ id, x: x + 600, y, w, h }));
  const canvasLayout = { root, mode: 'group', width: 6000, height: 5000,
    nodes: liveNodes, groups: liveGroups, containers: liveContainers };

  const requests = [];
  const steps = [];
  const outputs = [];
  const llm = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks));
    requests.push(request);
    const last = request.messages.at(-1);
    if (last.role === 'tool') outputs.push(JSON.parse(last.content));
    const args = steps.shift();
    const message = args ? { tool_calls: [{
      id: 'arrange-' + requests.length, type: 'function', function: { name: 'arrange_canvas', arguments: JSON.stringify(args) },
    }] } : { content: '已完成。' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => llm.close(resolve)));
  const config = { baseUrl: `http://127.0.0.1:${llm.address().port}/v1`, model: 'mock-layout', toolMode: 'tools' };
  const chat = async (payload = {}) => {
    const response = await post('/api/ai/chat', { prompt: '查看并调整画布', config, ...payload });
    const body = await response.text();
    assert.equal(response.status, 200, body.slice(0, 300));
    const events = body.trim().split('\n').map(JSON.parse);
    assert.ok(events.some(event => event.type === 'done'), body.slice(-500));
    return events;
  };

  const png = 'data:image/png;base64,' + 'A'.repeat(2_150_000);
  const jpeg = 'data:image/jpeg;base64,' + 'A'.repeat(2_150_000);
  await chat({
    images: ['data:image/gif;base64,AAAA', 'data:image/webp;base64,' + 'A'.repeat(3_000_000),
      png, { dataUrl: jpeg, label: '画布' }, 'data:image/webp;base64,AAAA'],
    uiContext: {
      kind: 'file', path: 'legacy.c',
      items: [
        { kind: 'node', id: root, file: 'main.c', line: 42 },
        { kind: 'node', id: root, name: '重复节点' },
        { kind: 'node', id: other.id, file: other.file },
        { kind: 'edge', from: root, to: other.id, labels: [{ text: 'TASK:10ms' }] },
        { kind: 'file', path: anchor.file },
        { kind: 'invalid', id: 'ignored' },
      ],
    },
  });
  const chatMessages = requests[0].messages;
  assert.deepEqual(chatMessages.at(-1).content.map(part => part.image_url?.url), [undefined, png, jpeg]);
  const system = chatMessages[0].content;
  assert.ok(system.includes([
    '用户当前在画布上选中/暂存的对象（共 4 项）：',
    `1. 节点 ${root}，main.c:42`,
    `2. 节点 ${other.id}，${other.file}`,
    `3. 连线 ${root} → ${other.id}，标签 TASK:10ms`,
    `4. 文件 ${anchor.file}`,
  ].join('\n')), system);
  assert.doesNotMatch(system, /重复节点|legacy\.c|ignored/);
  assert.ok(requests[0].tools.some(tool => tool.function.name === 'arrange_canvas'));

  const streamSignal = AbortSignal.timeout(30_000);
  const stream = await fetch(srv.baseUrl + '/api/stream', { signal: streamSignal });
  const reader = stream.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const decoder = new TextDecoder();
  const initial = await reader.read();
  assert.match(decoder.decode(initial.value), /retry:/);

  steps.push(
    { action: 'inspect' },
    { action: 'move', reason: '移到右边', moves: [
      { id: 'main', x: 3400, y: 3200 },
      { id: other.id, relativeTo: anchor.name, placement: 'right', gap: 31 },
    ] },
    { action: 'align', nodes: ['main', other.name], axis: 'x', distribute: true, gap: 35 },
    { action: 'inspect' },
    { action: 'move', moves: [{ id: other.id, dx: other.w + 35 }] },
  );
  const events = await chat({ canvasLayout });
  const [inspect, move, align, aligned, displaced] = outputs;
  assert.deepEqual(inspect.nodes.find(node => node.id === anchor.id), anchorRect);
  assert.deepEqual(inspect.groups, liveGroups);
  assert.deepEqual(inspect.containers, liveContainers);
  assert.deepEqual(inspect.canvas, { width: 6000, height: 5000 });
  assert.deepEqual(inspect.edges, view.edges.map(({ from, to, kind }) => ({ from, to, kind })));
  assert.deepEqual(move.positions, [{ id: root, x: 3400, y: 3200 },
    { id: other.id, x: anchorRect.x + anchorRect.w + 31, y: anchorRect.y }]);
  const [first, second] = align.positions;
  assert.equal(first.y, 3200);
  assert.equal(second.y, first.y);
  assert.equal(second.x - first.x, other.w + 35);
  for (const { id, x, y } of align.positions) {
    const actual = aligned.nodes.find(node => node.id === id);
    assert.deepEqual({ x: actual.x, y: actual.y }, { x, y });
  }
  assert.deepEqual(displaced.positions, [{ id: other.id, x: second.x + view.nodes.find(n => n.id === root).w, y: second.y }],
    '偏移后的目标遇到同一行的节点时沿移动轴避让');
  assert.ok(events.some(event => event.type === 'tool_end' && /action=align/.test(event.digest)));

  const slot = layoutRoot + '::group';
  const arranged = await get(viewUrl);
  const saved = await get('/api/session/export');
  const writes = saved.events.filter(event => event.op === 'layout.save');
  assert.equal(writes.length, 3);
  assert.ok(writes.every(event => event.actor === 'ai' && event.target === slot));
  for (const { id, x, y } of [second, displaced.positions[0]]) {
    const stored = saved.overlay.layout[slot].nodes[id];
    const rendered = arranged.nodes.find(node => node.id === id);
    assert.deepEqual([stored.x, stored.y], [x, y]);
    assert.deepEqual([rendered.x, rendered.y], [x, y]);
  }

  const history = { roots: [anchor.id], up: 0, down: 0 };
  const { eventId: at } = await jsonPost('/api/view-event', { op: 'view.snapshot', view: history });
  assert.equal((await jsonPost('/api/page', { ...history, at })).ok, true);
  steps.push({ action: 'reset', reason: '恢复自动布局' }, { action: 'inspect' });
  await chat({ canvasLayout: { ...canvasLayout, width: 1 } });
  const [reset, resetInspect] = outputs.slice(5);
  assert.equal(reset.updatedWhileReviewing, true);
  assert.equal(reset.root, layoutRoot);
  assert.equal(resetInspect.canvas.width, view.width);
  const cleared = await get('/api/session/export');
  assert.equal(cleared.overlay.layout[slot], undefined);
  assert.ok(cleared.events.some(event => event.op === 'layout.clear' && event.actor === 'ai' &&
    event.target === slot && event.after.reason === '恢复自动布局'));
  const refreshed = await jsonPost(query, { roots: page.roots, previous: arranged, projectId: view.projectId });
  assert.deepEqual(refreshed.nodes.map(({ id, x, y }) => ({ id, x, y })), view.nodes.map(({ id, x, y }) => ({ id, x, y })));
  const movedEvent = writes.find(event => event.after.nodes[other.id]?.x === displaced.positions[0].x);
  const replayed = await get(`/api/view?at=${movedEvent.id}&useSnapshot=1`);
  assert.equal(replayed.nodes.find(node => node.id === other.id).x, displaced.positions[0].x);

  let broadcast = '';
  while ((broadcast.match(/\n\n/g) || []).length < 4) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    broadcast += decoder.decode(value, { stream: true });
  }
  const changes = [...broadcast.matchAll(/^data: (.*)$/gm)].map(([, data]) => JSON.parse(data));
  const layouts = changes.filter(change => change.op.startsWith('layout.'));
  assert.deepEqual(layouts.map(change => change.op), ['layout.save', 'layout.save', 'layout.save', 'layout.clear']);
  assert.ok(layouts.every(change => change.actor === 'ai' && change.projectId === view.projectId));
});

test('normalizeBaseUrl 兼容根地址、/v1 与完整 /chat/completions，并拒绝非法协议', () => {
  assert.deepEqual(normalizeBaseUrl('http://127.0.0.1:11434'), {
    baseUrl: 'http://127.0.0.1:11434',
    chatUrl: 'http://127.0.0.1:11434/v1/chat/completions',
    modelsUrl: 'http://127.0.0.1:11434/v1/models',
  });
  assert.deepEqual(normalizeBaseUrl('http://127.0.0.1:8000/v1/'), {
    baseUrl: 'http://127.0.0.1:8000/v1',
    chatUrl: 'http://127.0.0.1:8000/v1/chat/completions',
    modelsUrl: 'http://127.0.0.1:8000/v1/models',
  });
  assert.deepEqual(normalizeBaseUrl('https://llm.local/api/v1/chat/completions'), {
    baseUrl: 'https://llm.local/api/v1/chat/completions',
    chatUrl: 'https://llm.local/api/v1/chat/completions',
    modelsUrl: 'https://llm.local/api/v1/models',
  });
  assert.throws(() => normalizeBaseUrl('file:///etc/passwd'), /仅支持 http/);
});

test('extractThinkingAndText 与 parsePromptToolCalls 兼容 Qwen <think>、<tool_call> 与代码块', () => {
  const split = extractThinkingAndText('<think>先查改动</think>\n<tool_call>{"name":"get_git_changes","arguments":{}}</tool_call>', '补充推理');
  assert.match(split.thinking, /补充推理/);
  assert.match(split.thinking, /先查改动/);
  assert.deepEqual(parsePromptToolCalls(split.text), [{ name: 'get_git_changes', arguments: {} }]);

  const fenced = '```json\n{"tool":"add_to_canvas","args":{"functions":["range_gather",], "fromGit": true}}\n```';
  assert.deepEqual(parsePromptToolCalls(fenced), [{
    name: 'add_to_canvas',
    arguments: { functions: ['range_gather'], fromGit: true },
  }]);
});

test('runAiAgent：旧版 OpenAI 接口拒绝 tools 时自动降级纯对话模式，绝不再发送 tools 或 role:tool', async () => {
  const requests = [];
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    requests.push(body);
    if (body.tools) {
      return new Response(JSON.stringify({ error: { message: 'Unknown parameter: tools is not supported' } }), { status: 400 });
    }
    assert.ok(body.messages.every(m => ['system', 'user', 'assistant'].includes(m.role)), '降级后只应包含 system/user/assistant');
    if (requests.length === 2) {
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '<think>直接加图</think><tool_call>{"name":"add_to_canvas","arguments":{"functions":["Task_10ms"]}}</tool_call>' } }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '已将 Task_10ms 加入画布。' } }],
    }), { status: 200 });
  };

  const events = [];
  const executed = [];
  const res = await runAiAgent({
    config: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'qwen3.8-27b', toolMode: 'auto' },
    prompt: '把 Task_10ms 加到画布',
    executeTool: async (name, args) => {
      executed.push({ name, args });
      return { ok: true, addedCount: 1, roots: ['main.c::Task_10ms'] };
    },
    onEvent: ev => events.push(ev),
    fetchImpl,
  });

  assert.equal(res.ok, true);
  assert.equal(res.modeUsed, 'prompt');
  assert.equal(res.answer, '已将 Task_10ms 加入画布。');
  assert.equal(res.thinking, '直接加图');
  assert.deepEqual(executed, [{ name: 'add_to_canvas', args: { functions: ['Task_10ms'] } }]);
  assert.ok(events.some(e => e.type === 'fallback'));
});

test('runAiAgent：兼容旧版 OpenAI function_call 字段', async () => {
  let turn = 0;
  const fetchImpl = async () => {
    turn++;
    if (turn === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: null, function_call: { name: 'find_symbols', arguments: '{"query":"Task"}' } } }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '找到 1 个任务。' } }],
    }), { status: 200 });
  };
  const res = await runAiAgent({
    config: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'legacy', toolMode: 'tools' },
    prompt: '查一下 Task',
    executeTool: async () => ({ ok: true, matches: [{ id: 'main.c::Task_10ms', name: 'Task_10ms' }] }),
    fetchImpl,
  });
  assert.equal(res.answer, '找到 1 个任务。');
  assert.equal(res.toolLog.length, 1);
  assert.equal(res.toolLog[0].name, 'find_symbols');
});

test('AI 对话保存按修改顺序上传，失败后继续写入，读取等待待保存快照', async t => {
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => ({ getContext: () => null }) };
  t.after(() => { globalThis.document = originalDocument; });
  const { api } = await import('../web/lib/api.js');
  const { state } = await import('../web/lib/state.js');
  state.view = { projectId: 1 };
  t.after(() => { state.view = null; });
  let releaseFirst;
  const delay = new Promise(resolve => { releaseFirst = resolve; });
  let saved;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/ai/chats');
    if (options?.method !== 'POST') {
      requests.push('GET');
      return Response.json(saved);
    }
    const snapshot = JSON.parse(options.body);
    requests.push(snapshot.activeId);
    if (snapshot.activeId === 'original') await delay;
    if (snapshot.activeId === 'failed') throw new Error('连接断开');
    saved = snapshot;
    return Response.json({ ok: true });
  });
  const payload = { projectId: 1, activeId: 'original', threads: [{ id: 'original', messages: ['原始消息'] }] };
  const first = api.saveAiChats(payload);
  payload.threads[0].messages.push('晚于首次保存');
  const failed = api.saveAiChats({ projectId: 1, activeId: 'failed', threads: [] });
  const checkFailure = assert.rejects(failed, /连接断开/);
  const cleared = api.saveAiChats({ projectId: 1, activeId: '', threads: [] });
  const reload = api.aiChats();
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.deepEqual(requests, ['original']);
  } finally {
    releaseFirst();
  }
  await first;
  assert.deepEqual(saved.threads[0].messages, ['原始消息']);
  await checkFailure;
  await cleared;
  assert.deepEqual(await reload, { projectId: 1, activeId: '', threads: [] });
  assert.deepEqual(requests, ['original', 'failed', '', 'GET']);
});

test('e2e：直连旧版无 tools 本地接口，MCP 关闭时仍可一键把 Git 未提交改动与短函数名加入画布', async t => {
  // 1. 准备一个带未提交修改的临时 Git 仓库
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-direct-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }));
  const git = (...args) => execFileSync('git', ['-C', repoDir, ...args], { windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const code = 'int g_oil;\nvoid verify_range(void) {}\nvoid range_gather(void) { g_oil = 1; }\nvoid task_10ms(void) { range_gather(); }\n';
  fs.writeFileSync(path.join(repoDir, 'app.c'), code);
  git('add', 'app.c');
  git('commit', '-q', '-m', 'init');
  const committed = code.replace('g_oil = 1', 'g_oil = 2');
  fs.writeFileSync(path.join(repoDir, 'app.c'), committed);
  git('commit', '-qam', 'historical change');
  const worktree = committed.replace('g_oil = 2', 'g_oil = 3') + 'void worktree_only(void) {}\n';
  fs.writeFileSync(path.join(repoDir, 'app.c'), worktree);
  const beforeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-directory-before-'));
  const afterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-directory-after-'));
  t.after(() => {
    fs.rmSync(beforeDir, { recursive: true, force: true });
    fs.rmSync(afterDir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(beforeDir, 'app.c'), code);
  fs.writeFileSync(path.join(afterDir, 'app.c'), committed);

  // 2. 起一个模拟旧版 OpenAI 兼容服务（拒绝 tools 字段，只认纯对话）
  let chatTurn = 0;
  let pauseAfterAdd;
  let addArgs = { fromGit: true, vars: ['g_oil'] };
  const mockLlm = http.createServer((req, res) => {
    if (req.url === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
    }
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      if (body.tools) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'tools not supported by legacy backend' } }));
      }
      if (body.max_tokens === 16) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
      }
      chatTurn++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (chatTurn === 1) {
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '<think>读取未提交改动并直接加入画布</think><tool_call>' +
            JSON.stringify({ name: 'add_to_canvas', arguments: addArgs }) + '</tool_call>' } }],
        }));
      }
      if (chatTurn === 2) {
        const reply = () => res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '<tool_call>{"name":"get_git_changes","arguments":{"baseRef":"HEAD~1","targetRef":"HEAD"}}</tool_call>' } }],
        }));
        return pauseAfterAdd ? pauseAfterAdd(reply) : reply();
      }
      return res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '已将改动函数 range_gather、入口 task_10ms 及变量 g_oil 加入画布。' } }],
      }));
    });
  });
  await new Promise(resolve => mockLlm.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => mockLlm.close(resolve)));
  const llmUrl = `http://127.0.0.1:${mockLlm.address().port}/v1`;

  // 3. 启动主服务，并故意把外部 MCP 设为 off，验证内置直连 AI 仍正常工作
  const srv = await launchServer({ target: repoDir });
  t.after(srv.close);
  const post = (p, body) => fetch(srv.baseUrl + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json());

  assert.equal((await post('/api/mcp-config', { level: 'off' })).ok, true);
  const saved = await post('/api/ai/config', { baseUrl: llmUrl, model: 'qwen3.8-27b', apiKey: 'sk-local', toolMode: 'auto' });
  assert.equal(saved.ok, true);
  assert.equal(saved.config.hasApiKey, true);
  assert.equal(saved.config.apiKey, undefined, '响应不回传明文 apiKey');

  const models = await post('/api/ai/models', { baseUrl: llmUrl });
  assert.deepEqual(models.models, ['qwen3.8-27b']);

  const ping = await post('/api/ai/test', {});
  assert.equal(ping.ok, true);

  const get = (route) => fetch(srv.baseUrl + route).then(r => r.json());
  const initial = await post('/api/page', { roots: ['app.c::task_10ms'], vars: ['var::g_oil'], selected: 'app.c::task_10ms' });
  assert.equal(initial.ok, true);
  const baseline = await get('/api/page');
  for (const options of [
    { mode: 'git', baseRef: 'HEAD~1', targetRef: 'HEAD' },
    { mode: 'dir', beforePath: beforeDir, afterPath: afterDir },
  ]) {
    const prepared = await post('/api/compare', options);
    assert.ok(prepared.preview?.id, prepared.error);
    const active = await post('/api/compare/apply', { previewId: prepared.preview.id, selectedIds: ['app.c::range_gather'] });
    assert.ok(active.ok, active.error);
    chatTurn = 0;
    const viewResponse = await fetch(srv.baseUrl + '/api/view');
    const session = viewResponse.headers.get('X-Callgraph-Session');
    await viewResponse.text();

    const chatRes = await fetch(srv.baseUrl + '/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Callgraph-Session': session },
      body: JSON.stringify({ prompt: '把 Git 改动加到画布' }),
    });
    assert.equal(chatRes.status, 200);
    const events = (await chatRes.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(e => e.type === 'fallback'), '旧接口应触发自动降级');
    const toolDone = events.find(e => e.type === 'tool_end' && e.name === 'add_to_canvas');
    assert.equal(toolDone?.ok, true, JSON.stringify(events));
    assert.equal(events.find(e => e.type === 'tool_end' && e.name === 'get_git_changes')?.ok, true, JSON.stringify(events));
    const done = events.find(e => e.type === 'done');
    assert.match(done?.answer || '', /range_gather/);

    const { page } = await get('/api/page');
    assert.notEqual(page.comparisonId, active.comparison.id);
    assert.ok(page.roots.includes('app.c::task_10ms'), '应自动补齐上游 TASK 入口到画布');
    assert.ok(page.vars.includes('var::g_oil'), '应按短变量名自动解析并加入画布');
    const view = await get('/api/view');
    assert.equal(view.comparison.git.targetRef, 'WORKTREE');
    assert.ok(view.nodes.some(n => n.id === 'app.c::worktree_only' && n.change === 'added'));
    assert.equal((await post('/api/compare/exit', {})).comparison, null);
    assert.deepEqual(await get('/api/page'), baseline);
  }

  await t.test('发起比较切换的浏览器收到新画布后继续当前对话', async browserTest => {
    try { resolveChromePath(); } catch (error) { browserTest.skip(error.message); return; }
    const prepared = await post('/api/compare', { mode: 'git', baseRef: 'HEAD~1', targetRef: 'HEAD' });
    assert.ok(prepared.preview?.id, prepared.error);
    const active = await post('/api/compare/apply', { previewId: prepared.preview.id, selectedIds: ['app.c::range_gather'] });
    assert.ok(active.ok, active.error);
    browserTest.after(() => post('/api/compare/exit', {}));
    chatTurn = 0;
    const browser = await launchCdp({ url: srv.baseUrl });
    browserTest.after(() => browser.close());
    const { evaluate, waitFor } = browser;
    await waitFor(`window.__cg?.view?.comparison?.git?.targetRef === 'HEAD'`);
    await evaluate(`document.querySelector('#aiBtn').click()`);
    await waitFor(`document.querySelector('#aiModel').value === 'qwen3.8-27b'`);
    await evaluate(`(() => {
      window.__chatProjectChanges = 0;
      document.addEventListener('cg:project-changed', () => { window.__chatProjectChanges++; });
      document.querySelector('#aiPromptInput').value = '把工作区改动加入比较画布';
      document.querySelector('#aiSendChat').click();
    })()`);
    await waitFor(`window.__cg?.view?.comparison?.git?.targetRef === 'WORKTREE'`);
    await waitFor(`document.querySelector('#aiMessages').textContent.includes('已将改动函数 range_gather')`);
    assert.equal(await evaluate('window.__chatProjectChanges'), 0);
  });

  // 4. 普通模式下调用 AI 组图：应停留在可编辑画布（非只读比较预览），自动标出变更色与 TASK:10ms 线段标签，且流程图带变更色并可缓存
  // 工程已打开，仅在同样的两个函数 ID 之间新增调用，旧模型不应吞掉新增连线。
  fs.writeFileSync(path.join(repoDir, 'app.c'), worktree.replace('g_oil = 3;', 'g_oil = 3; verify_range();'));
  addArgs = { ...addArgs, functions: ['range_gather', 'verify_range'], mode: 'add' };
  chatTurn = 0;
  const root = 'app.c::task_10ms';
  const target = 'app.c::range_gather';
  const oldBookmark = await post('/api/bookmarks', { name: '准备删除', roots: [root] });
  const activeView = await fetch(srv.baseUrl + '/api/view');
  const initialSession = activeView.headers.get('X-Callgraph-Session');
  await activeView.arrayBuffer();
  const reloading = new Promise(resolve => {
    const observe = chunk => {
      if (!chunk.toString().includes('[加载]')) return;
      srv.child.stdout.off('data', observe);
      resolve();
    };
    srv.child.stdout.on('data', observe);
  });
  let resume;
  const prewarming = new Promise(resolve => {
    pauseAfterAdd = reply => { resume = reply; resolve(); };
  });
  const request = fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ prompt: '把 Git 未提交改动加到普通可编辑画布' }),
  });
  const chatText = request.then(response => {
    assert.equal(response.status, 200);
    return response.text();
  });
  void chatText.catch(() => {});
  const whileChatting = async (route, body) => {
    const response = await fetch(srv.baseUrl + route, {
      signal: AbortSignal.timeout(2_000),
      headers: { 'Content-Type': 'application/json', 'X-Callgraph-Session': initialSession },
      ...(body && { method: 'POST', body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(response.status, 200, `${route}：${JSON.stringify(data)}`);
    assert.notEqual(data.ok, false, `${route}：${JSON.stringify(data)}`);
    return data;
  };
  const phase = promise => Promise.race([promise, chatText.then(() => assert.fail('并发操作开始前 AI 流已关闭'))]);
  try {
    await phase(reloading);
    await Promise.all([
      whileChatting('/api/bookmarks/delete', { id: oldBookmark.bookmark.id }),
      whileChatting('/api/bookmarks', { name: 'AI 运行中保存', roots: [root] }),
      whileChatting('/api/bookmarks'),
      whileChatting('/api/overlay', { nodeId: target, data: { note: 'AI 运行中的手工标注' } }),
      whileChatting('/api/layout', { root, mode: 'group', addManual: [{ from: root, to: 'app.c::verify_range' }] }),
    ]);
    await phase(prewarming);
    const [, bookmarks] = await Promise.all([
      whileChatting('/api/flowchart?id=' + encodeURIComponent(target)),
      whileChatting('/api/bookmarks'),
    ]);
    assert.deepEqual(bookmarks.list.map(bookmark => bookmark.name), ['AI 运行中保存']);
  } finally {
    pauseAfterAdd = null;
    resume?.();
  }
  const normalEvents = (await chatText).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(normalEvents.find(e => e.type === 'tool_end' && e.name === 'add_to_canvas')?.ok, true, JSON.stringify(normalEvents));
  assert.equal(normalEvents.find(e => e.type === 'tool_end' && e.name === 'get_git_changes')?.ok, true, JSON.stringify(normalEvents));
  const normalPage = await get('/api/page');
  assert.ok(normalPage.page.roots.includes('app.c::task_10ms'), '应自动补齐上游 TASK 入口到画布');
  assert.ok(normalPage.page.vars.includes('var::g_oil'), '应按短变量名自动解析并加入画布');

  const proj = await get('/api/project');
  assert.equal(proj.comparison, null, '普通模式下 AI 组图后不应卡在只读比较预览状态');
  const expandedView = await get('/api/view?root=app.c%3A%3Atask_10ms&up=0&down=2&group=1');
  const newCall = expandedView.edges.find(e => e.from === 'app.c::range_gather' && e.to === 'app.c::verify_range');
  assert.equal(newCall?.change, 'added', '已存在函数之间的新增调用应进入可编辑画布并标为新增');
  assert.ok(expandedView.edges.some(edge => edge.kind === 'manual' && edge.from === root && edge.to === 'app.c::verify_range'));
  const view = await get('/api/view?root=' + encodeURIComponent('app.c::task_10ms') + '&up=0&down=1&group=1');
  const changedFn = view.nodes.find((n) => n.id === 'app.c::range_gather');
  assert.equal(changedFn?.change, 'modified', '普通可编辑画布应保留 Git 变更颜色');
  assert.equal(changedFn?.note, 'AI 运行中的手工标注');
  const taskEdge = view.edges.find((e) => e.from === 'app.c::task_10ms' && e.to === 'app.c::range_gather');
  assert.ok(taskEdge?.labels?.some((l) => l.preset === 'task' && l.text === 'TASK:10ms'), '应自动用线段标签标出 TASK:10ms');

  const fc = await get('/api/flowchart?id=' + encodeURIComponent('app.c::range_gather') + '&version=after&expandMacros=0&projectId=' + proj.id);
  assert.equal(fc.ok, true);
  assert.ok(fc.nodes.some((n) => n.change === 'modified'), '修改函数的流程图节点应标出修改色');
  const fc2 = await get('/api/flowchart?id=' + encodeURIComponent('app.c::range_gather') + '&version=after&expandMacros=0&projectId=' + proj.id);
  assert.equal(fc2.cached, true, '有变更函数的流程图应持久化保存并命中缓存');

  // 5. 验证 AI 对话管理与不同工程隔离
  const saveChat1 = await post('/api/ai/chats', {
    projectId: proj.id,
    activeId: 't1',
    threads: [{ id: 't1', title: '工程A对话', updatedAt: Date.now(), messages: [{ role: 'user', text: '分析 A' }] }],
  });
  assert.equal(saveChat1.ok, true);
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-other-'));
  t.after(() => fs.rmSync(otherDir, { recursive: true, force: true, maxRetries: 3 }));
  fs.writeFileSync(path.join(otherDir, 'other.c'), 'void Other_Fn(void) {}\n');
  assert.equal((await post('/api/switch', { path: otherDir })).ok, true);
  const chatsB = await get('/api/ai/chats');
  assert.equal(chatsB.threads.length, 0, '切换到新工程后对话列表必须与旧工程隔离');
  // 用旧 projectId 保存必须被 409 拦截
  const staleSave = await fetch(srv.baseUrl + '/api/ai/chats', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: proj.id, activeId: 't1', threads: [] }),
  });
  assert.equal(staleSave.status, 409);
  // 切回原工程后原对话完整恢复
  assert.equal((await post('/api/switch', { path: repoDir })).ok, true);
  const chatsA = await get('/api/ai/chats');
  assert.equal(chatsA.threads.length, 1);
  assert.equal(chatsA.threads[0].title, '工程A对话');
});

test('e2e：回看快照时 AI 持续写入最新画布，退出立即显示最新范围、标签和书签', async t => {
  const srv = await launchServer();
  t.after(srv.close);
  const get = route => fetch(srv.baseUrl + route, { signal: AbortSignal.timeout(10_000) }).then(res => res.json());
  const post = (route, body) => fetch(srv.baseUrl + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const jsonPost = (route, body) => post(route, body).then(res => res.json());
  const head = { roots: ['main.c::main'], up: 0, down: 1 };
  const historical = { roots: ['gear.c::Gear_Apply'], up: 0, down: 0 };
  const { eventId: at } = await jsonPost('/api/view-event', { op: 'view.snapshot', view: historical });
  assert.ok(at > 0);
  assert.equal((await jsonPost('/api/page', head)).ok, true);

  const tools = [
    ['add_to_canvas', { functions: ['main.c::Task_Shift'], includeTasks: false, mode: 'add', bookmarkName: '最新链路' }],
    ['remove_from_canvas', { functions: ['Can_Init'] }],
    ['apply_labels', { autoDetect: true }],
    ['apply_labels', { items: [{ from: 'main.c::main', to: 'main.c::Task_10ms', preset: 'task', text: 'TASK:10ms' }] }],
  ];
  const outputs = [];
  let nextTool = 0;
  const llm = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'mock-review' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { messages } = JSON.parse(raw);
    const results = messages.filter(message => message.role === 'tool');
    const lastOutput = results.at(-1);
    if (lastOutput) outputs.push(JSON.parse(lastOutput.content));
    if (nextTool >= tools.length) {
      res.end(JSON.stringify({ choices: [{ message: { content: '已更新最新画布。' } }] }));
      return;
    }
    const [name, args] = tools[nextTool++];
    const call = { id: 'review-' + nextTool, type: 'function', function: { name, arguments: JSON.stringify(args) } };
    res.end(JSON.stringify({ choices: [{ message: { tool_calls: [call] } }] }));
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => llm.close(resolve)));
  assert.equal((await jsonPost('/api/ai/config', {
    baseUrl: `http://127.0.0.1:${llm.address().port}/v1`, model: 'mock-review', toolMode: 'tools',
  })).ok, true);

  let browser;
  const chrome = (() => { try { return resolveChromePath(); } catch { return null; } })();
  if (chrome) {
    browser = await launchCdp({ url: srv.baseUrl, chromePath: chrome, width: 1050 });
    t.after(() => browser.close());
    await browser.waitFor('window.__cg?.root === "main.c::main"');
    await browser.evaluate('document.querySelector("#timelineBtn").click()');
    await browser.waitFor(`document.querySelector('.ev[data-id="${at}"]')`);
    await browser.evaluate(`document.querySelector('.ev[data-id="${at}"] .ev-review').click()`);
    await browser.waitFor(`window.__cg?.at === ${at} && window.__cg?.root === 'gear.c::Gear_Apply'`);
    await browser.waitFor(`fetch('/api/page').then(r => r.json()).then(r => r.page?.at === ${at})`);
  } else {
    assert.equal((await jsonPost('/api/page', { ...historical, at })).ok, true);
  }
  const preview = (await get('/api/page')).page;
  assert.equal(preview.reviewing, true);
  const chat = await post('/api/ai/chat', { prompt: '更新任务画布和周期标签', at });
  assert.equal(chat.status, 200);
  const events = (await chat.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.type === 'tool_end').map(event => [event.name, event.ok]),
    tools.map(([name]) => [name, true]), JSON.stringify(events));
  assert.equal(outputs.length, tools.length);
  assert.ok(outputs.every(result => result.updatedWhileReviewing && result.reviewNote.includes('最新画布')));
  assert.ok(outputs[2].applied > 0, '自动检测应在最新画布寻找标签候选');
  assert.deepEqual((await get('/api/page')).page, preview);
  const saved = (await get('/api/page?saved=1')).page;
  assert.deepEqual(saved.roots, head.roots);
  assert.equal(saved.at, 0);
  assert.equal(saved.reviewing, false);
  assert.ok(saved.expansions.some(scope => scope.root === 'main.c::Task_Shift'));
  assert.ok(!saved.expansions.some(scope => scope.root.endsWith('::Can_Init')));
  assert.equal((await get('/api/bookmarks')).list[0].name, '最新链路');
  const revisions = (await get('/api/events?detail=1')).events.filter(event => event.actor === 'ai');
  assert.equal(revisions.filter(event => event.op === 'view.compose').length, 2);
  assert.ok(revisions.filter(event => event.op === 'view.compose').every(event => event.before.roots[0] === head.roots[0]));
  assert.ok(revisions.some(event => event.op === 'bookmark.save' && event.after.name === '最新链路'));
  assert.ok(revisions.some(event => event.op === 'edge.annotate' && event.brief.labels.includes('TASK:10ms')));
  const oldView = await get(`/api/view?at=${at}&useSnapshot=1`);
  assert.deepEqual(oldView.roots, historical.roots);
  assert.ok(!oldView.edges.some(edge => edge.labels?.length));

  if (browser) {
    await browser.waitFor(`window.__cg?.at === ${at} && document.querySelector('#reviewText').textContent.includes('AI 已更新最新画布')`);
    assert.equal(await browser.evaluate('window.__cg.root'), historical.roots[0]);
    await browser.evaluate('document.querySelector("#reviewExit").click()');
    await browser.waitFor(`window.__cg?.at === 0 && window.__cg?.view?.nodes?.some(n => n.id === 'main.c::Task_Shift')`);
    assert.ok(await browser.evaluate(`window.__cg.view.edges.some(edge => edge.labels?.some(label => label.text === 'TASK:10ms'))`));
    assert.ok(!await browser.evaluate(`window.__cg.view.nodes.some(node => node.id.endsWith('::Can_Init'))`));
    await browser.evaluate('document.querySelector("#aiBtn").click()');
    await browser.evaluate('document.querySelector("#bookmarkBtn").click()');
    await browser.waitFor(`document.querySelector('#bookmarkList').textContent.includes('最新链路')`);
    const [x, y, hit] = await browser.evaluate(`(() => {
      const button = document.querySelector('#bookmarkList .bm-delete');
      const { x, y, width, height } = button.getBoundingClientRect();
      const px = x + width / 2, py = y + height / 2;
      return [px, py, document.elementFromPoint(px, py) === button];
    })()`);
    assert.equal(hit, true, '展开的 AI 抽屉不能遮住书签删除按钮');
    await browser.click(x, y);
    await browser.waitFor(`!document.querySelector('#bookmarkList').textContent.includes('最新链路')`);
    await browser.waitFor(`fetch('/api/page').then(r => r.json()).then(r => r.page?.at === 0)`);
  } else {
    assert.equal((await jsonPost('/api/page', saved)).ok, true);
  }
  tools.push(['add_to_canvas', { functions: ['gear.c::Gear_Apply'], includeTasks: false, mode: 'add' }]);
  const exited = await post('/api/ai/chat', { prompt: '再加入换挡函数', at });
  const afterExit = (await exited.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(afterExit.find(event => event.type === 'tool_end' && event.name === 'add_to_canvas')?.ok);
  assert.equal(outputs.at(-1).updatedWhileReviewing, undefined);
});

test('normalizeAiConfig 切换 baseUrl 时不继承旧 apiKey；mid-turn 降级不重复执行写工具', async () => {
  const prev = { baseUrl: 'http://127.0.0.1:8000/v1', model: 'm1', apiKey: 'sk-old-secret', toolMode: 'auto' };
  const switched = normalizeAiConfig({ baseUrl: 'http://127.0.0.1:9000/v1', model: 'm2' }, prev);
  assert.equal(switched.apiKey, '', '切换 API 地址时必须清空旧 Key，避免串发给新服务');
  const cleared = normalizeAiConfig({ baseUrl: '', model: 'm2' }, prev);
  assert.equal(cleared.apiKey, '', '清空 API 地址时也必须清空旧 Key');
  const switchedAfterClear = normalizeAiConfig({ baseUrl: 'http://127.0.0.1:9000/v1', model: 'm2' }, cleared);
  assert.equal(switchedAfterClear.apiKey, '', '先清空再填新地址绝不继承旧 Key');
  const sameUrl = normalizeAiConfig({ baseUrl: 'http://127.0.0.1:8000/v1/', model: 'm2' }, prev);
  assert.equal(sameUrl.apiKey, 'sk-old-secret', '同地址未填新 Key 时应保留旧 Key');

  // 第 1 轮接受 tools 返回 tool_call，第 2 轮返回 400 拒绝 role:tool → 降级后保留已执行结果，不重跑写工具
  let callCount = 0;
  let turn = 0;
  const fetchImpl = async (_url, opts) => {
    turn++;
    const body = JSON.parse(opts.body);
    if (turn === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add_to_canvas', arguments: '{"functions":["Task_10ms"]}' } }] } }],
      }), { status: 200 });
    }
    if (turn === 2) {
      assert.ok(body.messages.some(m => m.role === 'tool'));
      return new Response(JSON.stringify({ error: { message: 'role tool is not supported' } }), { status: 400 });
    }
    assert.ok(!body.tools, '降级后不再发 tools');
    assert.ok(body.messages.every(m => ['system', 'user', 'assistant'].includes(m.role)));
    assert.ok(body.messages.some(m => String(m.content).includes('Task_10ms')), '降级后保留已执行工具的上下文结果');
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '已完成。' } }],
    }), { status: 200 });
  };
  const res = await runAiAgent({
    config: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'qwen', toolMode: 'auto' },
    prompt: '加入画布',
    executeTool: async () => {
      callCount++;
      return { ok: true, addedCount: 1, roots: ['a.c::Task_10ms'] };
    },
    fetchImpl,
  });
  assert.equal(res.answer, '已完成。');
  assert.equal(callCount, 1, '已执行的写工具绝不应因第 2 轮降级而重复执行');
});

test('runAiAgent：缺失 tool_calls[].id 时助手与回复成对规范化，超大工具输出保持合法 JSON', async () => {
  const seenRequests = [];
  let turn = 0;
  const fetchImpl = async (_url, opts) => {
    turn++;
    const body = JSON.parse(opts.body);
    seenRequests.push(body);
    if (turn === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'read_function', arguments: '{"name":"big"}' } }] } }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '已读取。' } }],
    }), { status: 200 });
  };
  const res = await runAiAgent({
    config: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'strict-model', toolMode: 'tools' },
    prompt: '读一下 big',
    executeTool: async () => ({ ok: true, name: 'big', source: 'x'.repeat(20000) }),
    fetchImpl,
  });
  assert.equal(res.answer, '已读取。');
  const second = seenRequests[1];
  const assistantMsg = second.messages.find((m) => m.role === 'assistant');
  const toolMsg = second.messages.find((m) => m.role === 'tool');
  assert.ok(assistantMsg.tool_calls[0].id, '助手消息应补齐规范化 id');
  assert.equal(toolMsg.tool_call_id, assistantMsg.tool_calls[0].id, 'tool_call_id 必须与助手声明一致');
  const parsedTool = JSON.parse(toolMsg.content);
  assert.equal(parsedTool.truncated, true, '裁剪后的工具返回必须仍是合法 JSON');
});

test('runAiAgent：支持思考等级参数、旧接口 400 自动降级、实时 thinking 事件与 ask_user 交互提问', async () => {
  const seen = [];
  const events = [];
  let turn = 0;
  const fetchImpl = async (_url, opts) => {
    turn++;
    const body = JSON.parse(opts.body);
    seen.push(body);
    if (turn === 1) {
      assert.equal(body.reasoning_effort, 'high');
      return new Response(JSON.stringify({ error: { message: 'Unknown parameter: reasoning_effort' } }), { status: 400 });
    }
    assert.equal(body.reasoning_effort, undefined, '降级后不应再发 reasoning_effort');
    assert.ok(Array.isArray(body.tools), '思考参数降级不应破坏标准 tools 模式');
    return new Response(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          reasoning: '发现两组隔离改动，先询问用户是否拆书签',
          content: '',
          tool_calls: [{
            id: 'q1',
            type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({
                question: '检测到 2 组互不关联的 Git 改动，要如何生成？',
                options: [
                  { label: '按书签拆分 2 个图', description: '推荐，避免画面杂乱' },
                  { label: '合并到一个图' },
                ],
              }),
            },
          }],
        },
      }],
    }), { status: 200 });
  };
  const res = await runAiAgent({
    config: normalizeAiConfig({ baseUrl: 'http://127.0.0.1:8000/v1', model: 'qwen', toolMode: 'auto', reasoningEffort: 'high' }),
    prompt: '分析 Git 改动',
    executeTool: async () => { throw new Error('ask_user 不应执行普通工具'); },
    onEvent: (ev) => events.push(ev),
    fetchImpl,
  });
  assert.equal(res.ok, true);
  assert.equal(res.awaitingUser, true);
  assert.equal(res.options.length, 2);
  assert.ok(events.some((e) => e.type === 'fallback'), '应发送思考参数降级提示');
  assert.ok(events.some((e) => e.type === 'thinking' && /隔离改动/.test(e.text)), '应实时发送 thinking 事件');
  assert.ok(events.some((e) => e.type === 'question' && e.options.length === 2), '应发送 question 卡片事件');
});

test('流式建议跨帧隐藏标签并校验操作，截断或损坏的建议仍从正文移除', async () => {
  const items = [{ label: '', prompt: '无效' }, { label: '查'.repeat(30), prompt: '追踪 g_xxx' },
    { label: '存书签', draft: '/bookmark 油压' }, { label: '查入口', prompt: '查看 oil_entry' }, { label: '超额', prompt: '忽略' }];
  for (const [suffix, valid] of [[JSON.stringify(items) + '</next_steps>', true], ['{x}</next_steps>', false], [JSON.stringify(items), false]]) {
    const events = [];
    const chunks = ['已找到写入点。', '\n<ne', 'xt_steps>', suffix.slice(0, -4), suffix.slice(-4)];
    const stream = chunks.map(content => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
    const result = await runAiAgent({
      config: normalizeAiConfig({ baseUrl: 'http://localhost/v1', model: 'mock', toolMode: 'tools' }),
      prompt: '分析数据源', onEvent: e => events.push(e),
      fetchImpl: async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
    });
    assert.equal(events.filter(e => e.type === 'text_delta').map(e => e.delta).join(''), '已找到写入点。');
    assert.equal(result.answer, '已找到写入点。');
    assert.deepEqual(result.suggestions, valid ? [{ label: '查'.repeat(28), prompt: '追踪 g_xxx' }, items[2], items[3]] : undefined);
    assert.deepEqual(events.find(e => e.type === 'done').suggestions, result.suggestions);
  }
});

test('e2e：宏引用数据源、自动和自定义分组书签、顺序保存隔离及 TASK 周期', async t => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-groups-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }));
  const git = (...args) => execFileSync('git', ['-C', repoDir, ...args], { windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const modA = [
    'void oil_step1(void) {}',
    'void oil_step2(void) {}',
    '/* 10ms周期処理 */',
    'void oil_entry(void) {',
    '  oil_step1();',
    '  oil_step2();',
    '}',
    '',
  ].join('\n');
  const modB = [
    'void diag_leaf(void) {}',
    '/* 起動周期 : 50ms */',
    'void diag_entry(void) {',
    '  diag_leaf();',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(repoDir, 'oil.c'), modA);
  fs.writeFileSync(path.join(repoDir, 'diag.c'), modB);
  fs.writeFileSync(path.join(repoDir, 'state.h'), '#define XXX_A (g_xxx.field)\n#define GET_XXX() ((int)XXX_A)\n');
  fs.writeFileSync(path.join(repoDir, 'state.c'), 'struct X { int field; } g_xxx;\nvoid writer_fn(void) { g_xxx.field = 1; }\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  // 制造两处完全互不关联的未提交修改
  fs.writeFileSync(path.join(repoDir, 'oil.c'), modA.replace('void oil_step1(void) {}', 'void oil_step1(void) { volatile int a = 1; (void)a; }'));
  fs.writeFileSync(path.join(repoDir, 'diag.c'), '#include "state.h"\n' + modB.replace('void diag_leaf(void) {}', 'void diag_leaf(void) { volatile int b = GET_XXX(); (void)b; }'));

  let mode = 'split';
  let turn = 0;
  let lastToolOutput = null;
  let gitOutput;
  let canvasArgs = [];
  const mockLlm = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const lastTool = [...(body.messages || [])].reverse().find((m) => m.role === 'tool');
      if (lastTool) lastToolOutput = JSON.parse(lastTool.content);
      turn++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (mode === 'canvas') {
        const args = canvasArgs[turn - 1];
        return res.end(JSON.stringify({ choices: [{ message: args ? { tool_calls: [{ id: 'b' + turn, type: 'function',
          function: { name: 'add_to_canvas', arguments: JSON.stringify(args) } }] } : { content: '已保存。' } }] }));
      }
      if (mode === 'split') {
        if (turn === 1) {
          return res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_git_changes', arguments: '{}' } }] } }],
          }));
        }
        if (turn === 2) {
          gitOutput = lastToolOutput;
          return res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'add_to_canvas', arguments: JSON.stringify({ fromGit: true, splitByGroup: true }) } }] } }],
          }));
        }
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '已拆分为 2 个书签图。' } }],
        }));
      }
      if (turn === 1) {
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'l1', type: 'function', function: { name: 'find_symbols', arguments: '{}' } }] } }],
        }));
      }
      if (turn === 2) {
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'l2', type: 'function', function: { name: 'apply_labels', arguments: JSON.stringify({ autoDetect: true }) } }] } }],
        }));
      }
      return res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '已自动补全画布标签。' } }],
      }));
    });
  });
  await new Promise((resolve) => mockLlm.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => mockLlm.close(resolve)));

  const srv = await launchServer({ target: repoDir });
  t.after(srv.close);
  const get = (route) => fetch(srv.baseUrl + route).then((r) => r.json());
  const post = (p, body) => fetch(srv.baseUrl + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

  await post('/api/ai/config', { baseUrl: `http://127.0.0.1:${mockLlm.address().port}/v1`, model: 'mock', toolMode: 'tools' });

  // 1. 测试隔离改动自动拆分为 2 个书签
  const splitRes = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '按书签拆分 Git 改动' }),
  });
  const splitEvents = (await splitRes.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(splitEvents.find((e) => e.type === 'tool_end' && e.name === 'add_to_canvas')?.ok, true, JSON.stringify(splitEvents));
  const bms = await get('/api/bookmarks');
  assert.equal(bms.list.length, 2, '两组互不关联的 Git 改动应拆分为 2 个书签');
  assert.deepEqual(gitOutput.newlyReferencedVars, [{ id: 'var::g_xxx', name: 'g_xxx', file: 'state.c', line: 1,
    via: '读', usedBy: ['diag.c::diag_leaf'], writers: ['state.c::writer_fn'] }]);
  const fnIds = view => [...view.roots, ...view.expansions.map(e => e.root)];
  const checkDataSource = view => {
    assert.ok(fnIds(view).includes('state.c::writer_fn'));
    assert.ok(view.vars.includes('var::g_xxx'));
  };
  checkDataSource(bms.list.find(b => fnIds(b).includes('diag.c::diag_leaf')));
  const callCanvas = async args => {
    mode = 'canvas';
    turn = 0;
    canvasArgs = args;
    const response = await fetch(srv.baseUrl + '/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '保存这些函数为书签' }) });
    const events = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.filter(e => e.type === 'tool_end').map(e => e.ok), args.map(() => true), JSON.stringify(events));
  };
  await callCanvas([{ fromGit: true, groups: [{ name: 'A', functions: ['diag_leaf'] }, { name: 'B', functions: ['oil_step1'] }] }]);
  assert.deepEqual(lastToolOutput.bookmarks.map(b => b.name), ['A', 'B']);
  const activePage = (await get('/api/page')).page;
  checkDataSource(activePage);
  assert.ok(!fnIds(activePage).includes('oil.c::oil_step1'));
  const canvas = await post('/api/view?up=0&down=0', activePage);
  assert.deepEqual(canvas.edges.filter(e => e.to === 'var::g_xxx').map(e => [e.from, e.via]).sort(),
    [['diag.c::diag_leaf', '读'], ['state.c::writer_fn', '写']]);
  assert.notEqual(canvas.nodes.find(n => n.id === 'state.c::writer_fn').change, 'modified');
  const suggestions = [{ label: '追踪写入', prompt: '查看 writer_fn' }];
  await post('/api/ai/chats', { threads: [{ id: 'data', messages: [{ role: 'assistant', text: '已找到数据源', suggestions }] }] });
  assert.deepEqual((await get('/api/ai/chats')).threads[0].messages[0].suggestions, suggestions);
  await callCanvas([{ functions: ['diag_leaf'], bookmarkName: 'A2' }, { functions: ['oil_step1'], bookmarkName: 'B2' }]);
  const bookmarks = (await get('/api/bookmarks')).list;
  for (const [name, own, other] of [['A', 'diag.c::diag_leaf', 'oil.c::oil_step1'], ['B', 'oil.c::oil_step1', 'diag.c::diag_leaf'],
    ['A2', 'diag.c::diag_leaf', 'oil.c::oil_step1'], ['B2', 'oil.c::oil_step1', 'diag.c::diag_leaf']]) {
    const bookmark = bookmarks.find(b => b.name === name);
    assert.ok(fnIds(bookmark).includes(own));
    assert.ok(!fnIds(bookmark).includes(other));
    if (name === 'A') checkDataSource(bookmark);
    if (name === 'B') {
      assert.ok(!fnIds(bookmark).includes('state.c::writer_fn'));
      assert.ok(!bookmark.vars.includes('var::g_xxx'));
    }
  }

  const priorRoots = ['oil.c::oil_entry', 'diag.c::diag_entry'];
  assert.equal((await post('/api/page', { roots: priorRoots, up: 0, down: 1 })).ok, true);
  await callCanvas([{ vars: ['g_xxx'], bookmarkName: '追加变量' }]);
  const appendedPage = (await get('/api/page?saved=1')).page;
  const appendedBookmark = (await get('/api/bookmarks')).list.find(b => b.name === '追加变量');
  for (const view of [appendedPage, appendedBookmark]) {
    assert.deepEqual(view.roots, priorRoots);
    assert.equal(view.down, 1);
    assert.deepEqual(view.vars, ['var::g_xxx']);
  }

  // 2. 测试函数头注释 TASK 周期 + コール順 自动补全写入画布
  await post('/api/page', { roots: ['oil.c::oil_entry'], up: 0, down: 1 });
  mode = 'labels';
  turn = 0;
  lastToolOutput = null;
  const labelRes = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '补全当前画布 TASK 和顺序标签' }),
  });
  const labelEvents = (await labelRes.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(labelEvents.find((e) => e.type === 'tool_end' && e.name === 'apply_labels')?.ok, true, JSON.stringify(labelEvents));
  assert.ok((lastToolOutput?.applied || 0) >= 2, `应实际写入 TASK 与 コール順 标签: ${JSON.stringify(lastToolOutput)}`);
  const oilView = await get('/api/view?root=' + encodeURIComponent('oil.c::oil_entry') + '&up=0&down=1&group=1');
  const e1 = oilView.edges.find((e) => e.from === 'oil.c::oil_entry' && e.to === 'oil.c::oil_step1');
  const e2 = oilView.edges.find((e) => e.from === 'oil.c::oil_entry' && e.to === 'oil.c::oil_step2');
  assert.ok(e1?.labels?.some((l) => l.preset === 'task' && l.text === 'TASK:10ms'), '应从函数上方注释识别并写入 TASK:10ms');
  assert.ok(e1?.labels?.some((l) => l.preset === 'call' && l.text === 'コール順1' && !l.note), 'コール順1 应写入且不带注释');
  assert.ok(e2?.labels?.some((l) => l.preset === 'call' && l.text === 'コール順2' && !l.note), 'コール順2 应写入且不带注释');
});

test('e2e：多车型(z145/z144)共通代码分支检测、按路径过滤入图、局部移除、书签重命名与 /api/ai/compact + SSE 流式指标', async t => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-vehicles-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }));
  const git = (...args) => execFileSync('git', ['-C', repoDir, ...args], { windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');

  fs.mkdirSync(path.join(repoDir, 'common'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'z145'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'z144'), { recursive: true });
  const commonBase = 'void shared_calc(void) { volatile int v = 1; (void)v; }\n';
  fs.writeFileSync(path.join(repoDir, 'common', 'calc.c'), commonBase);
  fs.writeFileSync(path.join(repoDir, 'z145', 'ctrl.c'), 'void shared_calc(void);\nvoid Task_10ms(void) { shared_calc(); }\n');
  fs.writeFileSync(path.join(repoDir, 'z144', 'ctrl.c'), 'void shared_calc(void);\nvoid Task_10ms(void) { shared_calc(); }\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  // 仅修改共通代码
  fs.writeFileSync(path.join(repoDir, 'common', 'calc.c'), commonBase.replace('v = 1', 'v = 9'));

  let scenario = 'filter_z145';
  let turn = 0;
  let observedGitResult = null;
  const mockLlm = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const lastTool = [...(body.messages || [])].reverse().find((m) => m.role === 'tool');
      if (lastTool) {
        const parsed = JSON.parse(lastTool.content);
        if (parsed.pathBranches) observedGitResult = parsed;
      }
      turn++;
      // 使用标准 SSE 流式响应，验证 thinking_delta / text_delta / metrics 链路
      const sendSse = (chunks) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };
      if (scenario === 'filter_z145') {
        if (turn === 1) {
          return sendSse([
            { choices: [{ index: 0, delta: { reasoning_content: '先看改动并检查多车型路径' } }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'g1', type: 'function', function: { name: 'get_git_changes', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
          ]);
        }
        if (turn === 2) {
          return sendSse([
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a1', type: 'function', function: { name: 'add_to_canvas', arguments: JSON.stringify({ fromGit: true, includePaths: ['z145'], bookmarkName: 'z145 油压改动' }) } }] }, finish_reason: 'tool_calls' }] },
          ]);
        }
        return sendSse([
          { choices: [{ index: 0, delta: { reasoning_content: '只保留 z145 已完成' } }] },
          { choices: [{ index: 0, delta: { content: '已只将 ' } }] },
          { choices: [{ index: 0, delta: { content: 'z145 与共通改动加入画布。' }, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 180, completion_tokens: 24, total_tokens: 204 } },
        ]);
      }
      // scenario === 'remove_z144'
      if (turn === 1) {
        return sendSse([
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'r1', type: 'function', function: { name: 'remove_from_canvas', arguments: JSON.stringify({ excludePaths: ['z144'] }) } }] }, finish_reason: 'tool_calls' }] },
        ]);
      }
      return sendSse([
        { choices: [{ index: 0, delta: { content: '已移除 z144 路径函数。' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 } },
      ]);
    });
  });
  await new Promise((resolve) => mockLlm.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => mockLlm.close(resolve)));

  const srv = await launchServer({ target: repoDir });
  t.after(srv.close);
  const get = (route) => fetch(srv.baseUrl + route).then((r) => r.json());
  const post = (p, body) => fetch(srv.baseUrl + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

  await post('/api/ai/config', { baseUrl: `http://127.0.0.1:${mockLlm.address().port}/v1`, model: 'mock-stream', toolMode: 'tools', contextWindow: 32768 });

  // 1. 检测 z145 / z144 两个上游车型分支 + 仅将 z145 加入画布并生成书签 + 验证流式事件与指标
  const res1 = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '只把 z145 的改动链路加入画布' }),
  });
  const ev1 = (await res1.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(observedGitResult?.pathBranches?.some((b) => b.prefix === 'z145'), 'get_git_changes 应识别 z145 分支');
  assert.ok(observedGitResult?.pathBranches?.some((b) => b.prefix === 'z144'), 'get_git_changes 应识别 z144 分支');
  assert.ok(ev1.some((e) => e.type === 'thinking_delta'), 'SSE 流式应发出 thinking_delta');
  assert.ok(ev1.some((e) => e.type === 'text_delta'), 'SSE 流式应发出 text_delta');
  assert.ok(ev1.some((e) => e.type === 'metrics' && e.promptTokens > 0), '应返回 token 用量指标');
  const page1 = (await get('/api/page')).page;
  const shown1 = [...(page1.roots || []), ...(page1.expansions || []).map((s) => s.root)];
  assert.ok(shown1.includes('z145/ctrl.c::Task_10ms'), '画布应包含 z145 入口');
  assert.ok(shown1.includes('common/calc.c::shared_calc'), '画布应保留共通改动函数');
  assert.ok(!shown1.some((id) => id.startsWith('z144/')), '画布绝不应混入被排除的 z144');

  // 2. 验证书签重命名接口 POST /api/bookmarks/rename
  const bms = await get('/api/bookmarks');
  assert.equal(bms.list.length, 1);
  const renamed = await post('/api/bookmarks/rename', { id: bms.list[0].id, name: 'Z145-共通油压审查' });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.bookmark.name, 'Z145-共通油压审查');

  // 3. 验证 remove_from_canvas 能从混合画布中干净移除 z144
  await post('/api/page', {
    roots: ['z145/ctrl.c::Task_10ms', 'z144/ctrl.c::Task_10ms'],
    expansions: [{ root: 'common/calc.c::shared_calc', up: 0, down: 0 }],
    up: 0,
    down: 1,
  });
  scenario = 'remove_z144';
  turn = 0;
  const res2 = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '去掉 z144 车型的函数' }),
  });
  const ev2 = (await res2.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ev2.find((e) => e.type === 'tool_end' && e.name === 'remove_from_canvas')?.ok, true, JSON.stringify(ev2));
  const page2 = (await get('/api/page')).page;
  const shown2 = [...(page2.roots || []), ...(page2.expansions || []).map((s) => s.root)];
  assert.ok(shown2.includes('z145/ctrl.c::Task_10ms'), '移除 z144 后应保留 z145');
  assert.ok(shown2.includes('common/calc.c::shared_calc'), '移除 z144 后应保留共通函数');
  assert.ok(!shown2.some((id) => id.startsWith('z144/')), '移除后画布不应再含 z144');

  // 4. 验证 POST /api/ai/compact 上下文压缩接口
  const compactRes = await post('/api/ai/compact', {
    messages: [
      { role: 'user', text: '查看 Git 改动' },
      { role: 'assistant', text: '发现 z145 和 z144 两个车型分支', tools: [{ name: 'get_git_changes', ok: true, summary: '1 文件', digest: 'pathBranches=z145,z144' }] },
      { role: 'user', text: '只要 z145' },
      { role: 'assistant', text: '已只加入 z145' },
      { role: 'user', text: '补全标签' },
      { role: 'assistant', text: '已写入 TASK:10ms' },
    ],
  });
  assert.equal(compactRes.ok, true);
  assert.equal(compactRes.compacted, true);
  assert.ok(compactRes.messages.length < 6, '压缩后消息条数应减少');
});

test('e2e：嵌套目录多车型强制询问拦截、非 TASK 上级调用者自动入图、对话中并发保存配置不卡顿、画布选中 uiContext 联动', async t => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-nested-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }));
  const git = (...args) => execFileSync('git', ['-C', repoDir, ...args], { windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');

  fs.mkdirSync(path.join(repoDir, 'src', 'common'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'src', 'z145'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'src', 'z144'), { recursive: true });
  const sharedBase = 'void common_step(void) { volatile int x = 1; (void)x; }\n';
  fs.writeFileSync(path.join(repoDir, 'src', 'common', 'step.c'), sharedBase);
  // 故意不命名成 Task_*，验证无正式 TASK 时也能把上级调用者加入画布并识别多车型目录分叉
  fs.writeFileSync(path.join(repoDir, 'src', 'z145', 'flow.c'), 'void common_step(void);\nvoid z145_entry(void) { common_step(); }\n');
  fs.writeFileSync(path.join(repoDir, 'src', 'z144', 'flow.c'), 'void common_step(void);\nvoid z144_entry(void) { common_step(); }\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repoDir, 'src', 'common', 'step.c'), sharedBase.replace('x = 1', 'x = 7'));

  let turn = 0;
  let capturedSystem = '';
  let capturedToolGate = null;
  let releaseStream = null;
  const streamStarted = new Promise((resolve) => { releaseStream = resolve; });
  let finishStream = null;
  const streamCanFinish = new Promise((resolve) => { finishStream = resolve; });

  const mockLlm = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      capturedSystem = body.messages?.[0]?.content || '';
      const lastTool = [...(body.messages || [])].reverse().find((m) => m.role === 'tool');
      if (lastTool) {
        const parsed = JSON.parse(lastTool.content);
        if (parsed.needsVehicleChoice) capturedToolGate = parsed;
      }
      turn++;
      if (turn === 1) {
        // 先故意不带筛选调用 add_to_canvas，验证服务端强制拦截并提示询问用户
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'g1', type: 'function', function: { name: 'add_to_canvas', arguments: JSON.stringify({ fromGit: true }) } }] } }],
        }));
      }
      if (turn === 2) {
        // 第二步按 z145 过滤加入画布，同时模拟流式等待期间并发保存 /api/ai/config
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'g2', type: 'function', function: { name: 'add_to_canvas', arguments: JSON.stringify({ fromGit: true, includePaths: ['src/z145'] }) } }] } }],
        }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '已保留 z145 上级调用链。' } }] })}\n\n`);
      releaseStream();
      await streamCanFinish;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => mockLlm.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => mockLlm.close(resolve)));

  const srv = await launchServer({ target: repoDir });
  t.after(srv.close);
  const get = (route) => fetch(srv.baseUrl + route).then((r) => r.json());
  const post = (p, body) => fetch(srv.baseUrl + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

  await post('/api/ai/config', { baseUrl: `http://127.0.0.1:${mockLlm.address().port}/v1`, model: 'mock-nested', toolMode: 'tools', maxTokens: 8192 });

  const chatPromise = fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: '把改动加到画布并结合我选中的连线分析',
      uiContext: {
        kind: 'edge',
        edgeKey: 'src/z145/flow.c::z145_entry->src/common/step.c::common_step:2',
        from: 'src/z145/flow.c::z145_entry',
        to: 'src/common/step.c::common_step',
        fromName: 'z145_entry',
        toName: 'common_step',
        labels: [{ preset: 'task', text: 'TASK:10ms' }],
      },
    }),
  });

  // 等流式回复进行到一半时并发修改并保存上下文长度，验证绝不互相卡死
  await streamStarted;
  const savedWhileChatting = await post('/api/ai/config', { contextWindow: 128000, maxTokens: 16384 });
  assert.equal(savedWhileChatting.ok, true, '对话流式输出期间保存上下文长度必须立即成功，不可卡死');
  assert.equal(savedWhileChatting.config.contextWindow, 128000);
  assert.equal(savedWhileChatting.config.maxTokens, 16384);
  finishStream();

  const chatRes = await chatPromise;
  assert.equal(chatRes.status, 200);
  const events = (await chatRes.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.type === 'done'), '对话流在并发保存配置后仍应正常结束');
  assert.equal(capturedToolGate?.needsVehicleChoice, true, '嵌套目录 src/z145 与 src/z144 未指定筛选时必须拦截并要求询问');
  assert.ok(capturedToolGate?.pathBranches?.some((b) => b.prefix === 'src/z145'));
  assert.ok(capturedToolGate?.pathBranches?.some((b) => b.prefix === 'src/z144'));
  assert.match(capturedSystem, /z145_entry.*common_step|TASK:10ms/, '画布选中的连线与标签上下文应注入系统提示');

  const page = (await get('/api/page')).page;
  const shown = [...(page.roots || []), ...(page.expansions || []).map((s) => s.root)];
  assert.ok(shown.includes('src/z145/flow.c::z145_entry'), '非 TASK 命名的上级调用者 z145_entry 也应自动加入画布');
  assert.ok(shown.includes('src/common/step.c::common_step'), '被修改的共通函数应保留在画布');
  assert.ok(!shown.some((id) => id.includes('src/z144/')), '被排除的 src/z144 不应加入画布');
});
