import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  extractThinkingAndText,
  normalizeAiConfig,
  normalizeBaseUrl,
  parsePromptToolCalls,
  runAiAgent,
} from '../src/core/ai-agent.js';
import { launchServer } from '../scripts/lib/server.mjs';
import { launchCdp, resolveChromePath } from '../scripts/lib/cdp.mjs';

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
  let releaseFirst;
  const delay = new Promise(resolve => { releaseFirst = resolve; });
  let saved;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/ai/chats');
    if (!options) {
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
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '<tool_call>{"name":"get_git_changes","arguments":{"baseRef":"HEAD~1","targetRef":"HEAD"}}</tool_call>' } }],
        }));
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
  const normalChat = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '把 Git 未提交改动加到普通可编辑画布' }),
  });
  assert.equal(normalChat.status, 200);
  const normalEvents = (await normalChat.text()).trim().split('\n').map(line => JSON.parse(line));
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
  const view = await get('/api/view?root=' + encodeURIComponent('app.c::task_10ms') + '&up=0&down=1&group=1');
  const changedFn = view.nodes.find((n) => n.id === 'app.c::range_gather');
  assert.equal(changedFn?.change, 'modified', '普通可编辑画布应保留 Git 变更颜色');
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

test('e2e：函数头注释 TASK 周期自动补全写入画布 + 相互隔离的 Git 改动自动拆分书签', async t => {
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
  git('add', 'oil.c', 'diag.c');
  git('commit', '-q', '-m', 'init');
  // 制造两处完全互不关联的未提交修改
  fs.writeFileSync(path.join(repoDir, 'oil.c'), modA.replace('void oil_step1(void) {}', 'void oil_step1(void) { volatile int a = 1; (void)a; }'));
  fs.writeFileSync(path.join(repoDir, 'diag.c'), modB.replace('void diag_leaf(void) {}', 'void diag_leaf(void) { volatile int b = 2; (void)b; }'));

  let mode = 'split';
  let turn = 0;
  let lastToolOutput = null;
  const mockLlm = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const lastTool = [...(body.messages || [])].reverse().find((m) => m.role === 'tool');
      if (lastTool) lastToolOutput = JSON.parse(lastTool.content);
      turn++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (mode === 'split') {
        if (turn === 1) {
          return res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_git_changes', arguments: '{}' } }] } }],
          }));
        }
        if (turn === 2) {
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
