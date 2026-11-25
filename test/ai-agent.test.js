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

test('e2e：直连旧版无 tools 本地接口，MCP 关闭时仍可一键把 Git 未提交改动与短函数名加入画布', async t => {
  // 1. 准备一个带未提交修改的临时 Git 仓库
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-direct-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }));
  const git = (...args) => execFileSync('git', ['-C', repoDir, ...args], { windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const code = 'int g_oil;\nvoid range_gather(void) { g_oil = 1; }\nvoid task_10ms(void) { range_gather(); }\n';
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
          choices: [{ message: { role: 'assistant', content: '<think>读取未提交改动并直接加入画布</think><tool_call>{"name":"add_to_canvas","arguments":{"fromGit":true,"vars":["g_oil"]}}</tool_call>' } }],
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

    const chatRes = await fetch(srv.baseUrl + '/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '把 Git 改动加到画布' }),
    });
    assert.equal(chatRes.status, 200);
    const events = (await chatRes.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(e => e.type === 'fallback'), '旧接口应触发自动降级');
    const toolDone = events.find(e => e.type === 'tool_end' && e.name === 'add_to_canvas');
    assert.equal(toolDone?.ok, true, JSON.stringify(events));
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

  // 4. 普通模式下调用 AI 组图：应停留在可编辑画布（非只读比较预览），自动标出变更色与 TASK:10ms 线段标签，且流程图带变更色并可缓存
  chatTurn = 0;
  const normalChat = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '把 Git 未提交改动加到普通可编辑画布' }),
  });
  assert.equal(normalChat.status, 200);
  const normalEvents = (await normalChat.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(normalEvents.find(e => e.type === 'tool_end' && e.name === 'add_to_canvas')?.ok, true, JSON.stringify(normalEvents));
  const normalPage = await get('/api/page');
  assert.ok(normalPage.page.roots.includes('app.c::task_10ms'), '应自动补齐上游 TASK 入口到画布');
  assert.ok(normalPage.page.vars.includes('var::g_oil'), '应按短变量名自动解析并加入画布');

  const proj = await get('/api/project');
  assert.equal(proj.comparison, null, '普通模式下 AI 组图后不应卡在只读比较预览状态');
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
