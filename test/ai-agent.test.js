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

test('runAiAgent：当前附件超过输入预算时提示缩小行范围，并在发送前停止', async () => {
  const content = 'int work(void);\n'.repeat(1600).slice(0, 24_000);
  const attachments = Array.from({ length: 4 }, (_, i) => ({ name: i + '.c', content }));
  let sent = 0;
  await assert.rejects(runAiAgent({
    config: { baseUrl: 'http://localhost', model: 'mock' },
    prompt: '分析代码', attachments,
    fetchImpl: () => { sent++; throw new Error('超限请求不应发送'); },
  }), /预计需要.*24576.*附件/);
  assert.equal(sent, 0);
});

test('runAiAgent：附件全文优先于旧历史，每次请求都给输出和工具结果留出空间', async () => {
  const config = { baseUrl: 'http://localhost', model: 'mock', toolMode: 'tools', maxTokens: 8192 };
  const content = 'int sensor(void);\n'.repeat(100);
  const turn = { config, prompt: '查看相关函数', attachments: [{ name: 'sensor.c', content }] };
  const done = () => Response.json({ choices: [{ message: { content: '已查看。' } }] });
  const baseline = await runAiAgent({ ...turn, fetchImpl: done });
  config.contextWindow = baseline.metrics.contextEstTokens + config.maxTokens + 1450;
  const requests = [];
  const result = await runAiAgent({
    ...turn,
    history: [
      { role: 'user', text: '旧的问题：' + '温'.repeat(3500) },
      { role: 'assistant', text: '旧的回答' },
      { role: 'user', text: '最近的问题' },
      { role: 'assistant', text: '最近的说明：' + '温'.repeat(550) },
    ],
    executeTool: async () => ({ ok: true, name: 'sensor', file: 'sensor.c', startLine: 1, endLine: 1, source: '温'.repeat(950) }),
    fetchImpl: async (_url, { body }) => {
      const req = JSON.parse(body);
      requests.push(req);
      assert.ok(estimateMessagesTokens(req.messages, !!req.tools) + req.max_tokens <= config.contextWindow);
      if (requests.length > 1) return done();
      return Response.json({ choices: [{ message: { tool_calls: [{
        id: 'read', type: 'function', function: { name: 'read_function', arguments: '{"name":"sensor"}' },
      }] } }] });
    },
  });
  assert.equal(result.answer, '已查看。');
  assert.equal(requests.length, 2);
  assert.ok(requests[0].messages.some(m => m.content?.includes('最近的说明')));
  assert.ok(!requests[0].messages.some(m => m.content?.includes('旧的问题')));
  assert.ok(!requests[0].messages.some(m => m.content?.includes('旧的回答')));
  assert.equal(requests[0].messages[1].role, 'user');
  assert.ok(!requests[1].messages.some(m => m.content?.includes('最近的说明')));
  assert.deepEqual(requests[1].messages.slice(-2).map(m => m.role), ['assistant', 'tool']);
  for (const req of requests) assert.ok(req.messages.some(m => m.role === 'user' && m.content.includes(content)));
});

test('runAiAgent：按历史 token 或条数限制裁剪时，完整保留最近的问答', async () => {
  for (const byCount of [false, true]) {
    const history = Array.from({ length: byCount ? 21 : 6 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      text: '历史' + i + (byCount || i === 5 ? '' : '温'.repeat(3900)),
    }));
    await runAiAgent({
      config: { baseUrl: 'http://localhost', model: 'mock', maxTokens: 1024, contextWindow: 32768 },
      prompt: '继续核对', history,
      fetchImpl: async (_url, { body }) => {
        const { messages } = JSON.parse(body);
        assert.equal(messages[1].role, 'user');
        assert.ok(messages[1].content.startsWith('历史2'));
        return Response.json({ choices: [{ message: { content: '已核对。' } }] });
      },
    });
  }
});

test('runAiAgent：工具结果撑满窗口后保留操作记录，后续请求和步数上限总结都遵守预算', async () => {
  const config = { baseUrl: 'http://localhost', model: 'mock', toolMode: 'prompt', maxTokens: 4096 };
  const turn = { config, prompt: '查看函数', attachments: [{ name: 'entry.c', content: 'int sensor(void);' }] };
  const initial = await runAiAgent({ ...turn, fetchImpl: async () => Response.json({ choices: [{ message: { content: '好' } }] }) });
  config.contextWindow = initial.metrics.contextEstTokens + config.maxTokens + 40;
  for (const maxSteps of [1, 2]) {
    let sent = 0;
    const result = await runAiAgent({
      ...turn, maxSteps,
      executeTool: async () => ({ ok: true, name: 'sensor', file: 'entry.c', startLine: 1, endLine: 1, source: '字'.repeat(1000) }),
      fetchImpl: async () => {
        sent++;
        return Response.json({ choices: [{ message: { content: '<tool_call>{"name":"read_function","arguments":{"name":"sensor"}}</tool_call>' } }] });
      },
    });
    assert.equal(sent, 1);
    assert.equal(result.toolLog.length, 1);
    assert.equal(result.toolLog[0].name, 'read_function');
    assert.ok(result.answer.includes(result.toolLog[0].summary));
  }
});

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

test('e2e：窄窗口下 AI 助手的停止和引导按钮完整可点击', async t => {
  try { resolveChromePath(); } catch (error) { t.skip(error.message); return; }
  const srv = await launchServer();
  t.after(srv.close);
  const browser = await launchCdp({ url: srv.baseUrl });
  t.after(() => browser.close());
  await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await browser.waitFor('Boolean(window.__cg?.view)');
  await browser.evaluate(`(async () => {
    document.getElementById('aiBtn').click();
    document.querySelector('[data-ai-tab="chat"]').click();
    await document.fonts.ready;
  })()`);

  const cases = [];
  for (const [width, height, streaming] of [[1024, 700, true], [420, 600, false], [360, 600, true], [320, 360, true]]) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const clipped = await browser.evaluate(`(() => {
      const model = document.getElementById('aiQuickModel');
      model.replaceChildren(new Option('organization/very-long-model-name-for-code-analysis', 'test-model'));
      model.value = 'test-model';
      const stop = document.getElementById('aiStopChat');
      const send = document.getElementById('aiSendChat');
      stop.hidden = ${!streaming};
      send.textContent = ${JSON.stringify(streaming ? '引导' : '发送')};
      if (${height} === 360) {
        for (let i = 0; i < 16; i++) {
          const path = 'src/a-long-folder-name/model-context-' + i + '.c';
          document.dispatchEvent(new CustomEvent('cg:selection-changed', { detail: { kind: 'file', path } }));
          document.getElementById('aiPinSelection').click();
        }
      }
      const drawer = document.getElementById('aiDrawer').getBoundingClientRect();
      const ids = ['aiQuickModel', 'aiQuickReasoning', 'aiAttachShot', 'aiSendChat'];
      if (!stop.hidden) ids.push('aiStopChat');
      return ids.flatMap(id => {
        const control = document.getElementById(id);
        const element = control.closest('.fsel')?.querySelector('.fsel-btn') ?? control;
        const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
        const hit = document.elementFromPoint(left + width / 2, top + height / 2);
        return left >= drawer.left && top >= drawer.top && right <= drawer.right && bottom <= drawer.bottom &&
          element.contains(hit) ? [] : [{ id, top, bottom, left, right, hit: hit?.id }];
      });
    })()`);
    cases.push({ width, height, streaming, clipped });
  }
  assert.ok(cases.every(({ clipped }) => clipped.length === 0), JSON.stringify(cases));
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
  const page = { roots: [root, 'can.c::Can_Init'], up: 0, down: 1, groupMode: 'flat' };
  const layoutRoot = page.roots.join('+');
  const query = '/api/view?up=0&down=1&groupMode=flat';
  const viewUrl = query + '&roots=' + encodeURIComponent(page.roots.join(','));
  const manual = { from: 'main.c::Task_10ms', to: 'main.c::Task_100ms' };
  assert.equal((await jsonPost('/api/layout', { root: layoutRoot, mode: 'flat', addManual: [manual] })).ok, true);
  const view = await get(viewUrl);
  assert.equal((await jsonPost('/api/page', page)).ok, true);
  assert.ok(view.edges.length);
  const other = view.nodes.find(node => node.name === 'Task_10ms');
  const anchor = view.nodes.find(node => node.name === 'Can_Init');
  const liveNodes = view.nodes.map((node, i) => ({
    id: node.id, name: node.name, kind: node.kind, file: node.file,
    x: 1000 + i * 250, y: 1000 + i * 150, w: node.w, h: node.h,
  }));
  const anchorRect = liveNodes.find(node => node.id === anchor.id);
  const liveGroups = view.groups.map(({ id, x, y, w, h }) => ({ id, x: x + 500, y, w, h }));
  const liveContainers = view.containers.map(({ id, x, y, w, h }) => ({ id, x: x + 600, y, w, h }));
  const canvasLayout = { root, mode: 'flat', width: 6000, height: 5000,
    nodes: liveNodes, groups: liveGroups, containers: liveContainers };

  const requests = [];
  const steps = [];
  const outputs = [];
  const llm = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'mock-layout' }] }));
      return;
    }
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
  const userTurnText = chatMessages.at(-1).content[0].text;
  assert.match(userTurnText, /<current_turn_context scope="this-turn-only">/);
  assert.ok(userTurnText.includes([
    '[本轮画布当前选中/暂存对象（共 4 项，指代最高优先级）]',
    `1. 节点 ${root}，main.c:42`,
    `2. 节点 ${other.id}，${other.file}`,
    `3. 连线 ${root} → ${other.id}，标签 TASK:10ms`,
    `4. 文件 ${anchor.file}`,
  ].join('\n')), userTurnText);
  assert.doesNotMatch(system, /用户当前在画布上选中\/暂存的对象/);
  assert.doesNotMatch(userTurnText, /重复节点|legacy\.c|ignored/);
  assert.ok(requests[0].tools.some(tool => tool.function.name === 'arrange_canvas'));

  const streamSignal = AbortSignal.timeout(30_000);
  const stream = await fetch(srv.baseUrl + '/api/stream', { signal: streamSignal });
  const reader = stream.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const decoder = new TextDecoder();
  const initial = await reader.read();
  assert.match(decoder.decode(initial.value), /retry:/);

  assert.equal((await jsonPost('/api/page', { ...page, groupMode: 'file' })).ok, true);
  const grouped = await get(viewUrl.replace('groupMode=flat', 'groupMode=file'));
  const foreign = grouped.nodes.find(node => node.name === 'Can_Init');
  const below = Math.max(...grouped.groups.map(box => box.y + box.h)) + 50;
  steps.push({ action: 'move', moves: [{ id: root, x: foreign.x, y: below }] });
  await chat();
  assert.match(outputs.pop().error, /容器会重叠/);
  assert.equal((await get('/api/session/export')).overlay.layout[layoutRoot + '::group'], undefined);
  assert.equal((await jsonPost('/api/page', page)).ok, true);

  steps.push(
    { action: 'inspect' },
    { action: 'move', reason: '移到右边', moves: [
      { id: 'main', x: 3400, y: 3200 },
      { id: other.id, relativeTo: anchor.name, placement: 'right', gap: 31 },
    ] },
    { action: 'align', nodes: ['main', other.name], axis: 'x', distribute: true, gap: 35 },
    { action: 'inspect' },
    { action: 'move', moves: [{ id: other.id, dx: other.w + 35, dy: 12 }] },
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
  assert.deepEqual(displaced.positions, [{ id: other.id, x: second.x + view.nodes.find(n => n.id === root).w, y: second.y + 12 }],
    '偏移后的目标遇到同一行的节点时沿移动轴避让');
  assert.ok(events.some(event => event.type === 'tool_end' && /action=align/.test(event.digest)));

  const slot = layoutRoot + '::flat';
  const arranged = await get(viewUrl);
  const saved = await get('/api/session/export');
  const writes = saved.events.filter(event => event.op === 'layout.save' && event.actor === 'ai');
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
  assert.deepEqual(cleared.overlay.layout[slot].nodes, {});
  assert.deepEqual(cleared.overlay.layout[slot].manual, [manual]);
  const resetEvent = cleared.events.find(event => event.op === 'layout.clear' && event.actor === 'ai' && event.target === slot);
  assert.equal(resetEvent?.after.resetPositions, 'flat');
  assert.equal(resetEvent?.after.reason, '恢复自动布局');
  const refreshed = await jsonPost(query, { roots: page.roots, previous: arranged, projectId: view.projectId });
  assert.ok(refreshed.nodes, refreshed.error);
  assert.deepEqual(refreshed.nodes.map(({ id, x, y }) => ({ id, x, y })), view.nodes.map(({ id, x, y }) => ({ id, x, y })));
  const movedEvent = writes.find(event => event.after.nodes[other.id]?.x === displaced.positions[0].x);
  const replayed = await get(`/api/view?at=${movedEvent.id}&useSnapshot=1`);
  assert.equal(replayed.nodes.find(node => node.id === other.id).x, displaced.positions[0].x);
  const manualVisible = canvas => canvas.edges.some(edge => edge.manual && edge.from === manual.from && edge.to === manual.to);
  assert.ok(manualVisible(refreshed));
  assert.ok(manualVisible(await get(`/api/view?at=${resetEvent.id}&useSnapshot=1`)));

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

  await t.test('工具栏重新排版会持久清除 AI 坐标并保留手工连线', async browserTest => {
    try { resolveChromePath(); } catch (error) { browserTest.skip(error.message); return; }
    assert.equal((await jsonPost('/api/page', page)).ok, true);
    const { x, y } = view.nodes.find(node => node.id === root);
    assert.equal((await jsonPost('/api/layout', { root: layoutRoot, mode: 'flat',
      nodes: { [root]: { x: x + 500, y, arrangedFor: 'flat' } },
    })).ok, true);
    const browser = await launchCdp({ url: srv.baseUrl });
    browserTest.after(() => browser.close());
    const rootX = `window.__cg?.view?.nodes.find(node => node.id === ${JSON.stringify(root)})?.x`;
    await browser.waitFor(`${rootX} === ${x + 500}`);
    await browser.evaluate("document.getElementById('resetLayout').click()");
    await browser.waitFor(`${rootX} === ${x}`);
    const afterToolbar = await get(viewUrl);
    assert.equal(afterToolbar.nodes.find(node => node.id === root).x, x);
    assert.ok(manualVisible(afterToolbar));
  });

  await t.test('自动布局扩展后跳过冲突坐标，并保留其他安全的 AI 坐标', async () => {
    const shallowUrl = viewUrl.replace('down=1', 'down=0');
    const shallow = await get(shallowUrl);
    const wide = await get(viewUrl);
    const newcomer = wide.nodes.find(node => !shallow.nodes.some(old => old.id === node.id));
    assert.ok(newcomer);
    const secondRoot = page.roots[1];
    const safe = { x: 5000, y: 5000, arrangedFor: 'flat' };
    assert.equal((await jsonPost('/api/layout', { root: layoutRoot, mode: 'flat', nodes: {
      [root]: { x: newcomer.x, y: newcomer.y, arrangedFor: 'flat' }, [secondRoot]: safe,
    } })).ok, true);
    const xy = (canvas, id) => {
      const { x, y } = canvas.nodes.find(node => node.id === id);
      return [x, y];
    };
    assert.deepEqual(xy(await get(shallowUrl), root), [newcomer.x, newcomer.y]);
    const expanded = await get(viewUrl);
    assert.deepEqual(xy(expanded, root), xy(wide, root));
    assert.deepEqual(xy(expanded, newcomer.id), [newcomer.x, newcomer.y]);
    assert.deepEqual(xy(expanded, secondRoot), [safe.x, safe.y]);
    assert.equal((await jsonPost('/api/layout', { root: layoutRoot, mode: 'flat', resetPositions: 'flat' })).ok, true);
  });

  await t.test('增量刷新保留手动位置，后续 AI 坐标仍可生效', async () => {
    const savePosition = async (x, y) => assert.equal((await jsonPost('/api/layout', {
      root: layoutRoot, mode: 'flat', nodes: { [root]: { x, y, arrangedFor: 'flat' } },
    })).ok, true);
    await savePosition(1400, 900);
    const previous = await get(viewUrl);
    const moved = previous.nodes.find(node => node.id === root);
    assert.deepEqual([moved.x, moved.y], [1400, 900]);
    Object.assign(moved, { x: 1700, y: 800 });
    const refresh = () => jsonPost(query.replace('down=1', 'down=0'), { roots: page.roots, previous, projectId: view.projectId });
    const preserved = await refresh();
    assert.ok(preserved.nodes, preserved.error);
    assert.equal(preserved.nodes.length, 2, '增量刷新已移除外围节点');
    const retained = preserved.nodes.find(node => node.id === root);
    assert.deepEqual([retained.x, retained.y], [1700, 800]);
    await savePosition(1800, 700);
    const updated = (await refresh()).nodes.find(node => node.id === root);
    assert.deepEqual([updated.x, updated.y], [1800, 700]);
  });

  await t.test('退出两点链路会清除当前上下文并保留暂存对象', async browserTest => {
    try { resolveChromePath(); } catch (error) { browserTest.skip(error.message); return; }
    assert.equal((await jsonPost('/api/ai/config', config)).ok, true);
    const browser = await launchCdp({ url: srv.baseUrl });
    browserTest.after(() => browser.close());
    await browser.waitFor('Boolean(window.__cg?.view?.nodes.length)');
    await browser.evaluate("document.getElementById('aiBtn').click()");
    await browser.waitFor("document.getElementById('aiModel').value === 'mock-layout'");
    const countBefore = requests.length;
    await browser.evaluate(`(async () => {
      const { pickPairFlow } = await import('/lib/pair-flow.js');
      const main = ${JSON.stringify(root)};
      const task = ${JSON.stringify(other.id)};
      const selectFile = path => document.dispatchEvent(new CustomEvent('cg:selection-changed', {
        detail: { kind: 'file', path },
      }));
      document.querySelector('[data-ai-tab="chat"]').click();
      selectFile('can.c');
      document.getElementById('aiPinSelection').click();
      pickPairFlow(main);
      pickPairFlow(task);
      const row = document.getElementById('aiSelectionRow');
      if (row.hidden || document.getElementById('pairFlowFloat').hidden) {
        throw new Error('两点链路未设置当前上下文');
      }
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (!row.hidden) throw new Error('Escape 未清除两点链路上下文');
      pickPairFlow(main);
      pickPairFlow(task);
      selectFile('adc.c');
      document.querySelector('#pairFlowFloat [data-pair-clear]').click();
      if (row.hidden || !document.getElementById('aiSelectionText').textContent.includes('adc.c')) {
        throw new Error('关闭两点链路时清除了后续选中的文件');
      }
      pickPairFlow(main);
      pickPairFlow(task);
      document.querySelector('#pairFlowFloat [data-pair-clear]').click();
      if (!row.hidden) throw new Error('取消按钮未清除两点链路上下文');
      document.getElementById('aiPromptInput').value = '请解释暂存的文件';
      document.getElementById('aiSendChat').click();
    })()`);
    await browser.waitFor("document.getElementById('aiMessages').textContent.includes('已完成。')");
    assert.equal(requests.length, countBefore + 1);
    const prompt = requests.at(-1).messages.at(-1).content;
    const text = typeof prompt === 'string' ? prompt : prompt[0].text;
    assert.match(text, /文件 can\.c/);
    assert.doesNotMatch(text, /节点 |连线 |文件 adc\.c/);
  });

  await t.test('暂存满 16 项保留已有上下文且被动候选不擅自注入模型', async browserTest => {
    try { resolveChromePath(); } catch (error) { browserTest.skip(error.message); return; }
    assert.equal((await jsonPost('/api/ai/config', config)).ok, true);
    const browser = await launchCdp({ url: srv.baseUrl });
    browserTest.after(() => browser.close());
    await browser.waitFor('Boolean(window.__cg?.view)');
    await browser.evaluate("document.getElementById('aiBtn').click()");
    await browser.waitFor("document.getElementById('aiModel').value === 'mock-layout'");
    const countBefore = requests.length;
    await browser.evaluate(`(() => {
      const pick = (id, file) => document.dispatchEvent(new CustomEvent('cg:selection-changed', {
        detail: { kind: 'node', id, file },
      }));
      document.querySelector('[data-ai-tab="chat"]').click();
      document.getElementById('aiNewChat').click();
      pick(${JSON.stringify(root)}, 'main.c');
      document.getElementById('aiPromptInput').value = '未附着前直接提问';
      document.getElementById('aiSendChat').click();
    })()`);
    await browser.waitFor("document.getElementById('aiMessages').textContent.includes('已完成。') && document.getElementById('aiStopChat').hidden");
    assert.equal(requests.length, countBefore + 1);
    const passivePrompt = requests.at(-1).messages.at(-1).content;
    const passiveText = typeof passivePrompt === 'string' ? passivePrompt : passivePrompt[0].text;
    assert.doesNotMatch(passiveText, /main\.c::main/, '仅点选画布生成候选而不按 + 时，不得注入模型请求');

    const fullState = await browser.evaluate(`(() => {
      const pick = (id, file) => document.dispatchEvent(new CustomEvent('cg:selection-changed', {
        detail: { kind: 'node', id, file },
      }));
      for (let i = 0; i < 16; i++) {
        pick('pinned.c::f' + i, 'pinned.c');
        document.getElementById('aiPinSelection').click();
      }
      pick(${JSON.stringify(root)}, 'main.c');
      const pinDisabled = document.getElementById('aiPinSelection').disabled;
      const chipCount = document.querySelectorAll('#aiPinnedList .ai-pinned-chip').length;
      document.getElementById('aiPromptInput').value = '请对比已暂存函数';
      document.getElementById('aiSendChat').click();
      return { pinDisabled, chipCount };
    })()`);
    assert.equal(fullState.pinDisabled, true);
    assert.equal(fullState.chipCount, 16);
    await browser.waitFor("document.querySelectorAll('#aiMessages .ai-msg.assistant .ai-msg-text').length >= 2 && document.getElementById('aiStopChat').hidden");
    assert.equal(requests.length, countBefore + 2);
    const prompt = requests.at(-1).messages.at(-1).content;
    const text = typeof prompt === 'string' ? prompt : prompt[0].text;
    assert.match(text, /共 16 项/);
    assert.match(text, /pinned\.c::f0\b/);
    assert.match(text, /pinned\.c::f15\b/);
    assert.doesNotMatch(text, /main\.c::main/, '暂存满 16 项后，被动候选不得挤掉已附着的芯片');
  });

  await t.test('外部代码选段在重载对话后仍可用于追问', async browserTest => {
    try { resolveChromePath(); } catch (error) { browserTest.skip(error.message); return; }
    const browser = await launchCdp({ url: srv.baseUrl });
    browserTest.after(() => browser.close());
    const openChat = async () => {
      await browser.waitFor("Boolean(window.__cg?.view) && !document.getElementById('aiDrawer').classList.contains('show')");
      await browser.evaluate("document.getElementById('aiBtn').click()");
      await browser.waitFor("document.getElementById('aiModel').value === 'mock-layout'");
      await browser.evaluate(`document.querySelector('[data-ai-tab="chat"]').click()`);
    };
    const countBefore = requests.length;
    await openChat();
    await browser.evaluate(`(() => {
      document.getElementById('aiNewChat').click();
      const input = document.getElementById('aiTextFileInput');
      const files = new DataTransfer();
      files.items.add(new File(['outside_first\\nint saved_excerpt(void) { return 37; }\\noutside_last'], 'external.c'));
      input.files = files.files;
      input.dispatchEvent(new Event('change'));
    })()`);
    await browser.waitFor("document.querySelectorAll('.ai-att-range input').length === 2");
    await browser.evaluate(`(() => {
      const [start, end] = document.querySelectorAll('.ai-att-range input');
      start.value = end.value = '2';
      start.dispatchEvent(new Event('change'));
      document.getElementById('aiPromptInput').value = '请读一下这段代码';
      document.getElementById('aiSendChat').click();
    })()`);
    await browser.waitFor("document.getElementById('aiMessages').textContent.includes('已完成。')");
    const saved = await get('/api/ai/chats');
    const thread = saved.threads.find(item => item.id === saved.activeId);
    assert.deepEqual(thread.messages[0].attachedFiles, [{ name: 'external.c', startLine: 2, endLine: 2, totalLines: 3,
      content: 'int saved_excerpt(void) { return 37; }' }]);
    await browser.send('Page.reload');
    await openChat();
    await browser.waitFor("document.querySelector('.ai-msg-att-file')?.textContent.includes('external.c')");
    await browser.evaluate(`(() => {
      document.getElementById('aiPromptInput').value = '上面附件中的函数返回什么？';
      document.getElementById('aiSendChat').click();
    })()`);
    await browser.waitFor("document.querySelectorAll('#aiMessages .ai-msg.assistant .ai-msg-text').length >= 2 && document.getElementById('aiStopChat').hidden");
    assert.equal(requests.length, countBefore + 2);
    const priorTurn = requests.at(-1).messages.find(m => m.role === 'user' && m.content.includes('请读一下这段代码'));
    assert.match(priorTurn?.content || '', /external\.c \(L2-L2.*\)[\s\S]*saved_excerpt\(void\) \{ return 37; \}/);
    assert.doesNotMatch(priorTurn.content, /outside_first|outside_last/);
  });
});

test('e2e：AI 向上移动后为文件和每层目录留出标题空间', async t => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-layout-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 }));
  const directory = path.join(target, 'src', 'deep');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'unit.c'), 'int entry(void) { return 1; }\n');
  const srv = await launchServer({ target });
  t.after(srv.close);
  const root = 'src/deep/unit.c::entry';
  const viewUrl = srv.baseUrl + '/api/view?groupMode=file&up=0&down=0&roots=' + encodeURIComponent(root);
  const getView = () => fetch(viewUrl).then(response => response.json());
  const initial = await getView();
  const node = initial.nodes.find(node => node.id === root);
  const targetY = node.y - 6;
  const savePosition = async y => {
    const response = await fetch(srv.baseUrl + '/api/layout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, mode: 'group', nodes: { [root]: { x: node.x, y, arrangedFor: 'file' } } }),
    });
    assert.equal((await response.json()).ok, true);
  };
  await savePosition(targetY);
  const arranged = await getView();
  const placed = arranged.nodes.find(node => node.id === root);
  assert.equal(placed.y, targetY);
  const childToParents = [placed, arranged.groups.find(box => box.id === placed.group),
    ...['src/deep', 'src'].map(id => arranged.containers.find(box => box.id === id))];
  for (let i = 1; i < childToParents.length; i++) {
    const child = childToParents[i - 1];
    const parent = childToParents[i];
    assert.ok(child.y - parent.y >= 32, `${parent.id} 标题与子项重叠`);
    assert.ok(parent.y < [...initial.groups, ...initial.containers].find(box => box.id === parent.id).y);
  }
  await savePosition(0);
  const invalid = await getView();
  assert.equal(invalid.nodes.find(node => node.id === root).y, node.y);
});

test('e2e：移动嵌套目录时按外框定位，并保留参照目录下方的间隔', async t => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-move-directories-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 }));
  const roots = [];
  for (const [directory, name] of [['alpha/deep', 'entry'], ['beta', 'worker']]) {
    fs.mkdirSync(path.join(target, directory), { recursive: true });
    fs.writeFileSync(path.join(target, directory, 'unit.c'), `void ${name}(void) {}\n`);
    roots.push(`${directory}/unit.c::${name}`);
  }
  const moves = [
    { id: 'alpha', x: 720, y: 640 },
    { id: 'beta', relativeTo: 'alpha', placement: 'below', gap: 36 },
  ];
  let result;
  const llm = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const last = JSON.parse(Buffer.concat(chunks)).messages.at(-1);
    if (last.role === 'tool') result = JSON.parse(last.content);
    const message = result ? { content: '已移动。' } : { tool_calls: [{
      id: 'move', type: 'function', function: { name: 'arrange_canvas', arguments: JSON.stringify({ action: 'move_group', moves }) },
    }] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => llm.close(resolve)));
  const srv = await launchServer({ target });
  t.after(srv.close);
  const post = (route, body) => fetch(srv.baseUrl + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  await post('/api/page', { roots, up: 0, down: 0, groupMode: 'file' });
  const chat = await post('/api/ai/chat', { prompt: '移动这两个目录', config: {
    model: 'mock-layout', baseUrl: `http://127.0.0.1:${llm.address().port}/v1`, toolMode: 'tools',
  } });
  assert.match(await chat.text(), /"type":"done"/);
  assert.equal(result?.ok, true, JSON.stringify(result));
  const view = await fetch(srv.baseUrl + '/api/view?groupMode=file&up=0&down=0&roots=' +
    encodeURIComponent(roots.join(','))).then(res => res.json());
  const alpha = view.containers.find(box => box.id === 'alpha');
  const beta = view.containers.find(box => box.id === 'beta');
  assert.deepEqual([alpha.x, alpha.y], [720, 640]);
  assert.deepEqual([beta.x, beta.y], [alpha.x, alpha.y + alpha.h + 36]);
});

test('解释连接或未指定修复目标时阻止写工具，目标明确时允许执行', async () => {
  for (const [prompt, allowed] of [
    ['Can you add Task_10ms to the canvas?', true], ['Why is Task_10ms missing?', false],
    ['为什么 A 和 B 连接在一起？', false], ['请解释一下 A 和 B 的连接关系', false],
    ['A 和 B 的连接关系是什么？', false], ['A 和 B 怎么没连上？', false],
    ['请把 A 和 B 连接起来', true], ['为什么没有连接？然后把 A 和 B 连起来', true],
    ['这个函数漏了上游，补齐一下', false], ['Task_10ms 漏了上游，补齐一下', true],
  ]) {
    const executed = [];
    let step = 0;
    const result = await runAiAgent({
      config: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'mock', toolMode: 'tools' },
      prompt,
      executeTool: async name => { executed.push(name); return { ok: true }; },
      fetchImpl: async () => Response.json({ choices: [{ message: step++ === 0 ? { tool_calls: [{
        id: 'add', type: 'function', function: { name: 'add_to_canvas', arguments: '{"functions":["Task_10ms"]}' },
      }] } : { content: '已处理。' } }] }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(executed, allowed ? ['add_to_canvas'] : []);
  }
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

for (const toolMode of ['prompt', 'auto']) {
  test(`只读子调查在 ${toolMode} 模式获得专属角色、调用格式及允许工具的参数`, async () => {
    const role = '只读子调查：查证给定函数。';
    const calls = [];
    const result = await runAiAgent({
      config: { baseUrl: 'http://localhost', model: 'mock', toolMode },
      prompt: '核对 sample.c::first', context: { canvasRoots: ['unrelated.c::parent'] },
      systemPromptOverride: role, isSubagent: true, allowedTools: ['read_function'],
      executeTool: async (name, args) => { calls.push([name, args]); return { ok: true }; },
      fetchImpl: async (_url, { body }) => {
        const req = JSON.parse(body);
        const system = req.messages[0].content;
        if (req.tools) {
          assert.equal(toolMode, 'auto');
          assert.equal(system, role);
          assert.deepEqual(req.tools.map(t => t.function.name), ['read_function']);
          return Response.json({ error: { message: 'tools is not supported' } }, { status: 400 });
        }
        assert.ok(system.startsWith(role));
        assert.match(system, /<tool_call>.*"arguments".*<\/tool_call>/);
        assert.match(system, /read_function.*"encoding"/);
        assert.doesNotMatch(system, /add_to_canvas|run_subagent|unrelated\.c::parent/);
        const content = calls.length ? '已核实。' : '<tool_call>{"name":"read_function","arguments":{"name":"sample.c::first"}}</tool_call>';
        return Response.json({ choices: [{ message: { content } }] });
      },
    });
    assert.equal(result.answer, '已核实。');
    assert.deepEqual(calls, [['read_function', { name: 'sample.c::first' }]]);
  });
}

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
  let capturedUser = '';
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
      if (body.messages?.at(-1)?.role === 'user') capturedUser = body.messages.at(-1).content || '';
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
  assert.match(capturedUser, /z145_entry.*common_step|TASK:10ms/, '画布选中的连线与标签上下文应单点注入本轮用户消息');
  assert.doesNotMatch(capturedSystem, /z145_entry.*common_step/, '系统提示不应重复注入当前选中上下文');

  const page = (await get('/api/page')).page;
  const shown = [...(page.roots || []), ...(page.expansions || []).map((s) => s.root)];
  assert.ok(shown.includes('src/z145/flow.c::z145_entry'), '非 TASK 命名的上级调用者 z145_entry 也应自动加入画布');
  assert.ok(shown.includes('src/common/step.c::common_step'), '被修改的共通函数应保留在画布');
  assert.ok(!shown.some((id) => id.includes('src/z144/')), '被排除的 src/z144 不应加入画布');
});

test('指代锚定防近因偏差、解释类提问禁止擅自改画布、多车型同名文件/函数强制询问', async (t) => {
  // 1. 单元测试：turnUserText 紧贴当前提问锚定选中函数 a，历史轮次保留上轮选中 b，且解释提问拦截写工具
  const seenRequests = [];
  let executedWrite = false;
  let step = 0;
  const mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seenRequests.push(body);
    step++;
    if (step === 1) {
      // 模型企图在用户问“为什么没有上游调用链”时擅自调用 add_to_canvas
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'tc_write', type: 'function', function: { name: 'add_to_canvas', arguments: '{"functions":["func_b"]}' } }],
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '已核查 `a.c::func_a`，它没有直接调用者。' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const agentRes = await runAiAgent({
    config: { baseUrl: 'http://127.0.0.1:1/v1', model: 'mock-local', toolMode: 'tools', maxTokens: 1024 },
    prompt: '这个函数为什么没有上游的调用链条',
    history: [
      { role: 'user', text: '看一下这个函数', selectionSummary: '节点 b.c::func_b' },
      { role: 'assistant', text: 'func_b 由 task_10ms 调用，另外还存在 extra_x -> extra_y 的链路。' },
    ],
    context: {
      projectName: 'demo',
      uiContext: { kind: 'node', id: 'a.c::func_a', name: 'func_a', file: 'a.c', line: 12 },
    },
    executeTool: async (name) => {
      if (name === 'add_to_canvas') executedWrite = true;
      return { ok: true };
    },
    fetchImpl: mockFetch,
  });
  assert.equal(executedWrite, false, '用户仅问“为什么没有上游调用链”时，运行时必须拦截写工具 add_to_canvas');
  assert.equal(agentRes.toolLog[0].ok, false);
  assert.match(agentRes.toolLog[0].summary, /排查\/解释类提问/);
  const firstReqMsgs = seenRequests[0].messages;
  assert.match(firstReqMsgs[1].content, /\[当时画布选中：节点 b\.c::func_b\]/, '历史用户轮次应保留当时的选中锚点');
  assert.match(firstReqMsgs.at(-1).content, /\[本轮画布当前选中对象（指代最高优先级）\]/, '本轮用户消息必须紧贴注入当前选中对象');
  assert.match(firstReqMsgs.at(-1).content, /节点 a\.c::func_a，a\.c:12/);
  assert.match(firstReqMsgs.at(-1).content, /这个函数为什么没有上游的调用链条/);
  assert.match(firstReqMsgs[0].content, /指代锚定规则|严格作用域边界/);

  // 2. 端到端：多车型不同路径同名文件同名函数（z144/ctrl.c::calc_gear 与 z145/ctrl.c::calc_gear），模型无论猜选单个还是全选都必须拦截要求询问
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-dup-vehicle-'));
  fs.mkdirSync(path.join(dir, 'z144'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'z145'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'z144', 'ctrl.c'), 'void calc_gear(void) {}\nvoid z144_run(void) { calc_gear(); }\n');
  fs.writeFileSync(path.join(dir, 'z145', 'ctrl.c'), 'void calc_gear(void) {}\nvoid z145_run(void) { calc_gear(); }\n');

  const capturedToolOutputs = [];
  let llmTurn = 0;
  const mockLlm = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const lastTool = body.messages.findLast((m) => m.role === 'tool');
      if (lastTool) capturedToolOutputs.push(JSON.parse(lastTool.content));
      llmTurn++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (llmTurn === 1) {
        // 情况 A：模型直接同时传入两个车型的同名函数且设 includeTasks: false
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add_to_canvas', arguments: JSON.stringify({ functions: ['z144/ctrl.c::calc_gear', 'z145/ctrl.c::calc_gear'], includeTasks: false }) } }],
            },
          }],
        }));
      } else if (llmTurn === 2) {
        // 情况 B：模型不问用户，私自猜选 z144/ctrl.c::calc_gear 单个加入
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'c2', type: 'function', function: { name: 'add_to_canvas', arguments: JSON.stringify({ functions: ['z144/ctrl.c::calc_gear'], includeTasks: false }) } }],
            },
          }],
        }));
      } else {
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'c3',
                type: 'function',
                function: {
                  name: 'ask_user',
                  arguments: JSON.stringify({ question: 'calc_gear 存在多个车型版本，需要加入哪一个？', options: [{ label: 'z144' }, { label: 'z145' }, { label: '全部保留' }] }),
                },
              }],
            },
          }],
        }));
      }
    });
  });
  await new Promise((r) => mockLlm.listen(0, '127.0.0.1', r));
  const srv = await launchServer({ target: dir });
  t.after(async () => {
    await new Promise((r) => mockLlm.close(r));
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const post = (p, body) => fetch(srv.baseUrl + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  await post('/api/ai/config', { baseUrl: `http://127.0.0.1:${mockLlm.address().port}/v1`, model: 'mock-dup', toolMode: 'tools', maxTokens: 4096 });
  const chatRes = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '把 calc_gear 加入画布' }),
  });
  assert.equal(chatRes.status, 200);
  const events = (await chatRes.text()).trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.type === 'question'), '多车型同名函数拦截后应转向 ask_user 询问');
  assert.equal(capturedToolOutputs.length, 2);
  assert.equal(capturedToolOutputs[0].needsVehicleChoice, true, '同时传入多车型同名函数必须拦截并要求询问');
  assert.equal(capturedToolOutputs[1].needsVehicleChoice, true, '用户未指定车型时私自猜选单个车型版本也必须拦截');
  assert.deepEqual(capturedToolOutputs[1].pathBranches.map((b) => b.prefix).sort(), ['z144', 'z145']);
});

test('e2e：LLM 查证二维函数指针表并用 add_call_edge 精准补边，以及 tidy/move_group 整理分组画布', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-indirect-tidy-'));
  fs.writeFileSync(path.join(dir, 'dispatch.c'), [
    'typedef void (*fn_t)(void);',
    'void vvv(void) {}',
    'void ggg(void) {}',
    'void jjj(void) {}',
    'void ghh(void) {}',
    'void jkk(void) {}',
    'void kkk(void) {}',
    'const fn_t e[2][3] = { { vvv, ggg, jjj }, { ghh, jkk, 1 ? jkk : kkk } };',
    '/* 10ms周期 */',
    'void dispatch_x(int mode) {',
    '  int row = mode ? 1 : 0;',
    '  e[row][0]();',
    '}',
    'void Task10ms(void) { dispatch_x(1); }',
  ].join('\n'));
  const cp932Text = new TextDecoder('shift_jis').decode(Uint8Array.of(0xc2, 0xa9));
  fs.writeFileSync(path.join(dir, 'worker.c'), Buffer.concat([Buffer.from([
    'void ghh(void);',
    'void worker_step(void) { ghh(); }',
    '/* ',
  ].join('\n')), Buffer.from([0xc2, 0xa9]), Buffer.from(' */\n')]));
  for (const folder of ['Src/Dispatch', 'Src/DispatchExtra', 'Backup/Src/Dispatch']) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, folder, 'bom.h'), '\uFEFF/* 周期 */\n');
  }

  const toolResults = [];
  let turn = 0;
  const mockLlm = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const last = body.messages?.at(-1);
      if (last?.role === 'tool') toolResults.push({ name: last.name, data: JSON.parse(last.content) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      turn++;
      const reply = (name, args) => res.end(JSON.stringify({
        choices: [{ message: { content: '', tool_calls: [{ id: `t_${turn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
      }));
      if (turn === 1) return reply('inspect_indirect_calls', { function: 'ghh' });
      if (turn === 2) return reply('read_source', { file: 'dispatch.c', startLine: 8, endLine: 13 });
      if (turn === 3) return reply('read_source', { query: cp932Text, file: 'worker.c', encoding: 'cp932' });
      if (turn === 4) return reply('read_source', { query: '周期', paths: ['sRC\\Dispatch/'], file: 'bom.h', encoding: 'cp932' });
      if (turn === 5) return reply('apply_labels', {
        items: [{ from: 'worker_step', to: 'ghh', line: 2, preset: 'task', text: 'TASK:10ms' }],
      });
      if (turn === 6) return reply('add_call_edge', {
        edges: [{ from: 'dispatch_x', to: 'ghh', line: 12, via: 'e[1][0]', reason: 'mode!=0 时调用 e[1][0] 即 ghh' }],
        addToCanvas: true,
      });
      if (turn === 7) return reply('apply_labels', {
        items: [{ from: 'dispatch_x', to: 'ghh', line: 12, preset: 'task', text: 'TASK:10ms' }],
      });
      if (turn === 8) return reply('trace_upstream', { functions: ['ghh'] });
      if (turn === 9) return reply('arrange_canvas', { action: 'tidy', direction: 'LR' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: '已补全 dispatch_x → ghh 间接调用边并整理画布。\n<next_steps>\n```json\n[{"label":"检查另一分支","prompt":"查看 dispatch_x 的 vvv 分支"}]\n```\n</next_steps>',
          },
        }],
      }));
    });
  });
  await new Promise((r) => mockLlm.listen(0, '127.0.0.1', r));
  const srv = await launchServer({ target: dir });
  t.after(async () => {
    await new Promise((r) => mockLlm.close(r));
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const post = (p, body) => fetch(srv.baseUrl + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  await post('/api/ai/config', { baseUrl: `http://127.0.0.1:${mockLlm.address().port}/v1`, model: 'mock-2d', toolMode: 'tools', maxTokens: 4096 });
  await post('/api/page', { roots: ['dispatch.c::dispatch_x', 'worker.c::worker_step'], up: 0, down: 0, groupMode: 'file' });
  const targetPeriods = async () => {
    const response = await fetch(srv.baseUrl + '/api/source?id=dispatch.c::ghh');
    assert.equal(response.status, 200);
    return (await response.json()).taskPeriods.map(context => context.us);
  };
  assert.ok(Array.isArray(await targetPeriods()));

  const chatRes = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: '请查明 dispatch_x 如何调用 ghh 并补全这条调用边，加上 TASK 标签，再整理画布',
      attachments: [{ name: 'notes.txt', startLine: 1, endLine: 2, totalLines: 2, content: 'mode=1 -> row=1 -> ghh' }],
    }),
  });
  assert.equal(chatRes.status, 200);
  const events = (await chatRes.text()).trim().split('\n').map(JSON.parse);
  const done = events.find((e) => e.type === 'done');
  assert.ok(done, '应正常完成对话');
  assert.equal(done.suggestions?.[0]?.label, '检查另一分支', '应兼容带 ```json 代码块的 <next_steps>');

  const inspectRes = toolResults.find((r) => r.name === 'inspect_indirect_calls')?.data;
  assert.ok(inspectRes?.tables?.some((tb) => tb.name === 'e' && tb.slots.some((s) => s.slot === '[1][0]' && s.target === 'ghh')));
  assert.ok(inspectRes.tables.find(tb => tb.name === 'e'), '应检索到二维函数指针表 e');
  const srcRes = toolResults.find((r) => r.name === 'read_source')?.data;
  assert.match(srcRes?.source || '', /e\[row\]\[0\]\(\)/);
  const searches = toolResults.filter(r => r.name === 'read_source').slice(1).map(r => r.data);
  assert.deepEqual(searches[0]?.matches?.map(({ line, text }) => [line, text]), [[3, `/* ${cp932Text} */`]], JSON.stringify(searches));
  assert.deepEqual(searches[1]?.matches?.map(({ file, line, text }) => [file, line, text]),
    [['Src/Dispatch/bom.h', 1, '/* 周期 */']], JSON.stringify(searches));
  const addRes = toolResults.find((r) => r.name === 'add_call_edge')?.data;
  assert.equal(addRes?.ok, true);
  assert.equal(addRes?.addedCount, 1);
  const labels = toolResults.filter(r => r.name === 'apply_labels').map(r => r.data);
  assert.deepEqual(labels.map(r => r.edgeKeys), [
    ['worker.c::worker_step->dispatch.c::ghh:2'], ['dispatch.c::dispatch_x->dispatch.c::ghh:12'],
  ]);
  const traceRes = toolResults.find((r) => r.name === 'trace_upstream')?.data;
  assert.ok(JSON.stringify(traceRes).includes('dispatch_x'), '补边后 trace_upstream 应立刻追踪到 dispatch_x');
  assert.ok(!JSON.stringify(traceRes).includes('vvv'), '无关槽位 vvv 不应被误连');
  assert.deepEqual(await targetPeriods(), [10000], '补边后再次查看源码应显示新增的 10ms 上游任务');
  const tidyRes = toolResults.find((r) => r.name === 'arrange_canvas')?.data;
  assert.equal(tidyRes?.ok, true, JSON.stringify(tidyRes));
  assert.ok(tidyRes?.updatedCount >= 2, '分组模式下 tidy 应成功重排全部节点而不报容器重叠');
});

test('e2e：双击已选两点连线不误切其他共线、输入框动态建议 Tab 补全与分层截图可见缩略图', async (t) => {
  try { resolveChromePath(); } catch (error) { t.skip(error.message); return; }
  const srv = await launchServer();
  t.after(srv.close);
  await fetch(srv.baseUrl + '/api/page', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roots: ['main.c::main'], up: 0, down: 1, groupMode: 'file' }),
  });
  const browser = await launchCdp({ url: srv.baseUrl });
  t.after(() => browser.close());
  await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await browser.waitFor('Boolean(window.__cg?.view?.nodes?.length)');

  // 1. 测试双击已选中的直连边不会切换到同一共线干线上的其他边
  const dblResult = await browser.evaluate(`(async () => {
    const { state, edgeKey } = await import('/lib/state.js');
    const { hooks } = await import('/lib/hooks.js');
    const edges = state.view.edges;
    if (edges.length < 2) return { skipped: true };
    const e0 = edges[0], e1 = edges[1];
    // 构造两条共享同一水平干线的边，先通过 directPair 选中 e1
    // 使用文件框下方的画布留白，避免正常的布局调整把模拟点击落在节点或标题栏上。
    const trunkY = Math.max(...state.view.groups.map(g => g.y + g.h), ...state.view.nodes.map(n => n.y + n.h)) + 12;
    const trunkX = state.view.width / 2;
    const sharedPts = [[trunkX - 70, trunkY], [trunkX + 140, trunkY]];
    e0.points = sharedPts.map(p => [...p]);
    e1.points = sharedPts.map(p => [...p]);
    hooks.selectEdge(e1, { directPair: true });
    const cv = document.getElementById('cv');
    const rect = cv.parentElement.getBoundingClientRect();
    const { x, y, k } = window.__cg.cam;
    const cx = rect.left + x + trunkX * k;
    const cy = rect.top + y + trunkY * k;
    cv.dispatchEvent(new PointerEvent('pointerdown', { button: 0, detail: 1, clientX: cx, clientY: cy, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointerup', { button: 0, detail: 1, clientX: cx, clientY: cy, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointerdown', { button: 0, detail: 2, clientX: cx, clientY: cy, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointerup', { button: 0, detail: 2, clientX: cx, clientY: cy, bubbles: true }));
    cv.dispatchEvent(new MouseEvent('dblclick', { button: 0, detail: 2, clientX: cx, clientY: cy, bubbles: true }));
    return {
      expected: edgeKey(e1),
      selected: state.selectedEdge ? edgeKey(state.selectedEdge) : null,
      moveKind: state.moveTarget?.kind || null,
      moveItem: state.moveTarget?.item ? edgeKey(state.moveTarget.item) : null,
    };
  })()`);
  if (!dblResult.skipped) {
    assert.equal(dblResult.selected, dblResult.expected, '双击已选连线不应切换到共线上的其他边');
    assert.equal(dblResult.moveKind, 'edge');
    assert.equal(dblResult.moveItem, dblResult.expected, '解锁编辑的目标必须是原选中连线');
  }

  // 2. 测试动态建议 placeholder + Tab 补全 + 分层/视图截图缩略图预览
  const uiResult = await browser.evaluate(`(async () => {
    document.getElementById('aiBtn').click();
    document.querySelector('[data-ai-tab="chat"]').click();
    const input = document.getElementById('aiPromptInput');
    const tabHint = document.getElementById('aiGhostTabHint');
    const placeholderBefore = input.placeholder;
    const hintVisibleBefore = !tabHint.hidden;
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const filledAfterTab = input.value;
    const hintHiddenAfter = tabHint.hidden;

    // 打开截图/附件菜单，截取当前画布并验证缩略图真实可见且可点击放大
    document.getElementById('aiAttachShot').click();
    const menu = document.getElementById('aiAttachMenu');
    const menuOpen = !menu.hidden;
    const firstBtn = menu.querySelector('button:not(:disabled)');
    firstBtn.click();
    const tray = document.getElementById('aiAttachments');
    const thumb = tray.querySelector('img.ai-att-thumb');
    const thumbSrc = thumb?.getAttribute('src') || '';
    thumb?.click();
    const lightboxOpen = !document.getElementById('aiImageLightbox').hidden;
    document.getElementById('aiLightboxClose').click();
    return {
      placeholderBefore,
      hintVisibleBefore,
      filledAfterTab,
      hintHiddenAfter,
      menuOpen,
      trayVisible: !tray.hidden,
      hasDataUrl: thumbSrc.startsWith('data:image/'),
      lightboxOpen,
    };
  })()`);
  assert.ok(uiResult.placeholderBefore.length > 0 && !uiResult.placeholderBefore.includes('油压控制'), '输入框应使用动态上下文建议而非固定示例文案');
  assert.equal(uiResult.hintVisibleBefore, true);
  assert.equal(uiResult.filledAfterTab, uiResult.placeholderBefore, '按 Tab 应补全当前建议提问');
  assert.equal(uiResult.hintHiddenAfter, true);
  assert.equal(uiResult.menuOpen, true);
  assert.equal(uiResult.trayVisible, true, '截图后应显示可见附件预览区');
  assert.equal(uiResult.hasDataUrl, true, '缩略图应包含真实图片 DataURL');
  assert.equal(uiResult.lightboxOpen, true, '点击缩略图应弹出大图预览');
});

async function mockAiTurn(t, baseUrl, nextCalls) {
  const llm = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const tools = await nextCalls(body.messages.at(-1), body);
    const message = !tools.length ? { content: '已完成。' } : {
      tool_calls: tools.map(([name, args], i) => ({ id: 'call' + i, type: 'function',
        function: { name, arguments: JSON.stringify(args) } })),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => llm.close(resolve)));
  const post = (route, body) => fetch(baseUrl + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  await post('/api/ai/config', { baseUrl: 'http://127.0.0.1:' + llm.address().port, model: 'mock', toolMode: 'tools' });
  const run = async (prompt, options = {}) => {
    const chat = await post('/api/ai/chat', { prompt, ...options });
    return (await chat.text()).trim().split('\n').map(JSON.parse);
  };
  return { post, run };
}

test('AI 上下游调用链与导览卡保留每个调用点的行号', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-chain-sites-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'logic.c'), [
    'void leaf(void) {}', 'void Task_10ms(void) {', '  leaf();', '  leaf();', '}',
  ].join('\n'));
  const srv = await launchServer({ target: dir });
  t.after(srv.close);
  const { run } = await mockAiTurn(t, srv.baseUrl, last => last.role === 'tool' ? [] : [
    ['trace_upstream', { functions: ['Task_10ms'], direction: 'down' }],
    ['trace_upstream', { functions: ['leaf'], direction: 'up' }],
    ['present_logic', { root: 'Task_10ms', direction: 'down', includeDataflow: false, addToCanvas: false }],
  ]);
  const events = await run('请呈现调用链');
  const key = 'logic.c::Task_10ms->logic.c::leaf:';
  const chains = events.filter(e => e.type === 'chains').map(e => e.chains.map(c => c.edgeKeys));
  assert.deepEqual(chains, [[[key + '3'], [key + '4']], [[key + '3']], [[key + '3'], [key + '4']]]);
});

test('撤销整轮同名书签保存保留原作用域，并检测独立写入', async t => {
  const srv = await launchServer();
  t.after(srv.close);
  let nextCalls;
  const { post, run } = await mockAiTurn(t, srv.baseUrl, last => nextCalls(last));
  const list = async () => (await (await fetch(srv.baseUrl + '/api/bookmarks')).json()).list;
  const save = name => ['manage_bookmarks', { action: 'save', name }];
  for (const conflict of [null, 'existing', 'created']) {
    await t.test(conflict ? '并发修改 ' + conflict + ' 时整轮撤销返回冲突' : '已有书签恢复，新增书签移除', async () => {
      const names = ['原书签-' + conflict, '新书签-' + conflict];
      nextCalls = last => last.role === 'tool' ? [] : names.flatMap(name => [save(name), save(name)]);
      const scope = { roots: ['main.c::main'], up: 2, down: 3, groupMode: 'period',
        vars: ['var::speed'], hiddenVars: ['var::gear'], expansions: [{ root: 'app.c::tick', up: 1, down: 2 }] };
      const original = (await (await post('/api/bookmarks', { ...scope, name: names[0] })).json()).bookmark;
      const events = await run('请保存当前画布为指定的两个书签');
      assert.deepEqual(events.filter(e => e.type === 'tool_end').map(e => e.ok), [true, true, true, true]);
      const { changesetId } = events.find(e => e.type === 'changeset');
      const saved = (await list()).filter(b => names.includes(b.name));
      assert.equal(saved.find(b => b.name === original.name).revision, original.revision + 2);
      if (conflict) {
        const edited = saved.find(b => b.name === names[conflict === 'created' ? 1 : 0]);
        await post('/api/bookmarks/update', { id: edited.id, expectedRevision: edited.revision, down: 7 });
        const beforeUndo = await list();
        assert.equal((await post('/api/ai/undo-changeset', { changesetId })).status, 409);
        assert.deepEqual(await list(), beforeUndo);
        return;
      }
      await post('/api/page', { roots: ['main.c::main'], up: 2, down: 0, group: false });
      const currentPage = await (await fetch(srv.baseUrl + '/api/page?saved=1')).json();
      assert.equal((await post('/api/ai/undo-changeset', { changesetId })).status, 200);
      assert.deepEqual((await (await fetch(srv.baseUrl + '/api/page?saved=1')).json()).page, currentPage.page);
      const remaining = (await list()).filter(b => names.includes(b.name));
      assert.equal(remaining.length, 1);
      const [restored] = remaining;
      assert.deepEqual({ ...restored, revision: original.revision, updatedAt: original.updatedAt }, original);
      assert.ok(restored.revision > original.revision + 2);
    });
  }
  await t.test('在两次 AI 保存之间插入的用户编辑可恢复', async () => {
    const name = '交错写入';
    let edit;
    nextCalls = async last => {
      if (last.role !== 'tool') return [save(name)];
      if (edit) return [];
      const { bookmark } = JSON.parse(last.content);
      edit = (await (await post('/api/bookmarks/update', { id: bookmark.id, expectedRevision: bookmark.revision, down: 9 })).json()).bookmark;
      return [save(name)];
    };
    const events = await run('请保存当前画布书签');
    const { changesetId } = events.find(e => e.type === 'changeset');
    assert.equal((await post('/api/ai/undo-changeset', { changesetId })).status, 200);
    const restored = (await list()).find(b => b.id === edit.id);
    assert.equal(restored.down, 9);
    assert.ok(restored.revision > edit.revision);
  });
});

test('AI 新能力：pair/dataflow 上下文服务端证据补全、present_logic/diagnose_canvas/canvas_visual、并行只读子调查、撤销改图与独立 ? 指南', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-newcaps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  fs.writeFileSync(path.join(dir, 'logic.c'), [
    'int g_shared = 0;',
    'void leaf_read(void) { volatile int v = g_shared; (void)v; }',
    'void mid_write(void) { g_shared = 42; leaf_read(); }',
    'void Task_10ms(void) { mid_write(); }',
  ].join('\n'));

  let step = 0;
  const capturedReqs = [];
  const toolOutputs = [];
  const llm = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      capturedReqs.push(body);
      const last = body.messages?.at(-1);
      if (last?.role === 'tool') toolOutputs.push({ name: last.name, data: JSON.parse(last.content) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const isSub = String(body.messages?.[0]?.content || '').includes('只读子调查代理');
      if (isSub) {
        // 验证子调查只允许只读工具，不允许 run_subagent / add_to_canvas
        assert.ok(body.tools.every(tl => tl.function.name !== 'run_subagent' && tl.function.name !== 'add_to_canvas'));
        if (last?.role === 'user') {
          return res.end(JSON.stringify({
            choices: [{ message: { tool_calls: [{ id: 's1', type: 'function', function: { name: 'inspect_dataflow', arguments: '{"target":"logic.c::mid_write","peer":"logic.c::leaf_read"}' } }] } }],
          }));
        }
        return res.end(JSON.stringify({
          choices: [{ message: { content: '子调查核实：mid_write 写入 g_shared，leaf_read 读取 g_shared。' } }],
        }));
      }
      step++;
      if (step === 1) {
        return res.end(JSON.stringify({
          choices: [{ message: { tool_calls: [{ id: 't1', type: 'function', function: { name: 'run_subagent', arguments: JSON.stringify({ tasks: [{ title: '核实读写链', goal: '检查 g_shared 读写方', seedSymbols: ['mid_write', 'leaf_read'] }] }) } }] } }],
        }));
      }
      if (step === 2) {
        return res.end(JSON.stringify({
          choices: [{ message: { tool_calls: [{ id: 't2', type: 'function', function: { name: 'present_logic', arguments: JSON.stringify({ root: 'mid_write', title: '共享变量呈现' }) } }] } }],
        }));
      }
      if (step === 3) {
        return res.end(JSON.stringify({
          choices: [{ message: { tool_calls: [{ id: 't3', type: 'function', function: { name: 'diagnose_canvas', arguments: JSON.stringify({ check: 'all' }) } }] } }],
        }));
      }
      if (step === 4) {
        return res.end(JSON.stringify({
          choices: [{ message: { tool_calls: [{ id: 't4', type: 'function', function: { name: 'canvas_visual', arguments: JSON.stringify({ action: 'play_flow', edgeKeys: ['logic.c::mid_write->logic.c::leaf_read'] }) } }] } }],
        }));
      }
      return res.end(JSON.stringify({
        choices: [{ message: { content: '已呈现 mid_write ↔ leaf_read 调用及 g_shared 数据流。' } }],
      }));
    });
  });
  await new Promise(r => llm.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => llm.close(r)));

  const srv = await launchServer({ target: dir });
  t.after(srv.close);
  const get = p => fetch(srv.baseUrl + p).then(r => r.json());
  const post = (p, body) => fetch(srv.baseUrl + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json());

  const cfgRes = await post('/api/ai/config', {
    baseUrl: `http://127.0.0.1:${llm.address().port}/v1`,
    model: 'mock-new',
    toolMode: 'tools',
    subagentEnabled: true,
    subagentMaxConcurrency: 3,
    subagentMaxSteps: 5,
  });
  assert.equal(cfgRes.config.subagentEnabled, true);
  assert.equal(cfgRes.config.subagentMaxConcurrency, 3);
  assert.equal(cfgRes.config.subagentMaxSteps, 5);

  // 检查初始空画布后再让 AI present_logic 构图，然后撤销恢复为空
  const pageBefore = (await get('/api/page')).page;
  const chatRes = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: '请帮我呈示这两者的调用与共享变量数据流',
      uiContext: {
        relationIntent: 'dataflow',
        items: [{
          kind: 'pair',
          fromId: 'logic.c::mid_write',
          fromName: 'mid_write',
          toId: 'logic.c::leaf_read',
          toName: 'leaf_read',
          visiblePaths: [],
          rwPaths: [{ direction: 'out', varId: 'var::g_shared', varName: 'g_shared', writer: 'logic.c::mid_write', reader: 'logic.c::leaf_read', line: 3 }],
          sharedVars: [{ id: 'var::g_shared', name: 'g_shared' }],
        }],
      },
    }),
  });
  assert.equal(chatRes.status, 200);
  const evs = (await chatRes.text()).trim().split('\n').map(JSON.parse);
  const firstUserMsg = capturedReqs[0].messages.at(-1).content;
  assert.match(firstUserMsg, /<current_turn_context scope="this-turn-only">/);
  assert.match(firstUserMsg, /g_shared/);
  assert.match(firstUserMsg, /\[图谱证据摘要\]/);
  assert.doesNotMatch(capturedReqs[0].messages[0].content, /mid_write/, 'system 提示不应重复包含选中实例');

  assert.ok(evs.some(e => e.type === 'subagent_start'));
  assert.ok(evs.some(e => e.type === 'subagent_end' && e.ok));
  assert.ok(evs.some(e => e.type === 'presentation' && e.presentation?.steps?.length > 0));
  assert.ok(evs.some(e => e.type === 'health_report' && Number.isFinite(e.report?.score)));
  assert.ok(evs.some(e => e.type === 'canvas_overlay' && e.action === 'play_flow'));
  const changesetEv = evs.find(e => e.type === 'changeset');
  assert.ok(changesetEv?.changesetId, 'AI 修改画布后应返回可撤销的 changesetId');

  const pageAfterAi = (await get('/api/page')).page;
  assert.ok((pageAfterAi.roots || []).length > 0, 'present_logic 应已将逻辑链推上画布');

  const undoRes = await post('/api/ai/undo-changeset', { changesetId: changesetEv.changesetId });
  assert.equal(undoRes.ok, true);
  const pageAfterUndo = (await get('/api/page')).page;
  assert.deepEqual(pageAfterUndo?.roots || [], pageBefore?.roots || [], '撤销后应恢复 AI 改图前的入口集合');

  // 检查独立 ? 指南容器存在于 #aiDrawer 内且完全不混入 #helpMenu
  const html = fs.readFileSync(path.join(process.cwd(), 'web', 'index.html'), 'utf8');
  const guideIdx = html.indexOf('id="aiPaneGuide"');
  const helpIdx = html.indexOf('id="helpMenu"');
  assert.ok(guideIdx > 0 && helpIdx > 0);
  const helpSlice = html.slice(helpIdx, html.indexOf('</details>', helpIdx));
  assert.doesNotMatch(helpSlice, /present_logic|subagent|aiPaneGuide|AI 助手/, '独立画布 #helpMenu 不应混入 AI 功能指南');
});

test('AI 查询按真实的读写边报告变量、两点证据与不支持的透镜', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ai-dataflow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'flow.c'), [
    'int shared;', 'void writer(void) { shared = 7; }', 'int reader(void) { return shared; }',
  ].join('\n'));
  const srv = await launchServer({ target: dir });
  t.after(srv.close);
  let job, request, output;
  const { run } = await mockAiTurn(t, srv.baseUrl, (last, body) => {
    if (last.role === 'tool') { output = JSON.parse(last.content); return []; }
    request = body;
    return [job];
  });
  const v = 'var::shared', writer = 'flow.c::writer', reader = 'flow.c::reader';
  for (const dir of ['out', 'in', 'both']) {
    await t.test('全局变量 ' + dir, async () => {
      job = ['inspect_dataflow', { target: v, dir }];
      await run('查询 shared 的数据流');
      const expected = [];
      if (dir !== 'out') expected.push([writer, v, 'df-write', 2]);
      if (dir !== 'in') expected.push([v, reader, 'df-read', 3]);
      assert.equal(output.ok, true);
      assert.deepEqual(output.edges.map(e => [e.from, e.to, e.kind, e.line]).sort(), expected.sort());
      assert.deepEqual(output.peers.map(n => n.id).sort(), expected.map(([a, b]) => a === v ? b : a).sort());
      assert.deepEqual(output.chains.map(c => c.steps.map(n => n.id)).sort(), expected.map(e => e.slice(0, 2)).sort());
    });
  }
  await t.test('两点上下文包含变量与每一次读写的位置', async () => {
    job = ['inspect_dataflow', { target: reader, peer: writer }];
    await run('说明这两个函数的数据流', { uiContext: { items: [{ kind: 'pair', fromId: reader, toId: writer }] } });
    const firstUser = request.messages.at(-1).content;
    assert.doesNotMatch(firstUser, /undefined/);
    assert.match(firstUser, /writer.*W.*flow\.c:2.*shared.*R.*flow\.c:3.*reader/);
    assert.deepEqual(output.sharedVars.map(x => x.id), [v]);
    assert.deepEqual(output.chains[0].steps.map(s => s.id), [writer, v, reader]);
  });
  await t.test('不宣告未实现的 lens，也不发出视觉成功事件', async () => {
    job = ['canvas_visual', { action: 'lens', lens: 'dataflow' }];
    const events = await run('切换画布透镜');
    const schema = request.tools.find(x => x.function.name === 'canvas_visual').function.parameters.properties;
    assert.equal(output.ok, false);
    assert.equal(schema.action.enum.includes('lens'), false);
    assert.match(output.error, /不支持/);
    assert.equal(events.some(e => e.type === 'canvas_overlay'), false);
  });
});

test('撤销对整个画布做并发校验，冲突时保留画布和书签', async t => {
  for (const edit of ['标注', '布局', '页面', '另一轮推断边', '页面改后改回', '两次 AI 写入之间', '等待最终答复时']) {
    await t.test(edit, async t => {
      const srv = await launchServer();
      t.after(srv.close);
      const target = 'gear.c::Gear_Init', bookmarkName = 'AI 将保存';
      const compose = ['add_to_canvas', { functions: [target], includeTasks: false, bookmarkName }];
      const saveLabel = () => post('/api/overlay', { nodeId: target, data: { note: '用户标注' } });
      let step = 0, otherTurn = false;
      const { run, post } = await mockAiTurn(t, srv.baseUrl, async last => {
        if (otherTurn) return last.role === 'user'
          ? [['add_call_edge', { edges: [{ from: 'main.c::main', to: target, line: 321 }], includeTasks: false, addToCanvas: false }]] : [];
        if (last.role === 'user') return [compose];
        if (step++ === 0 && ['两次 AI 写入之间', '等待最终答复时'].includes(edit)) {
          if (!(await saveLabel()).ok) throw Error('标注未写入');
          if (edit === '两次 AI 写入之间') return [compose];
        }
        return [];
      });
      const events = await run('请将函数加入画布并保存书签');
      const id = events.find(e => e.type === 'changeset')?.changesetId;
      assert.ok(id);
      if (edit === '标注') assert.ok((await saveLabel()).ok);
      if (edit === '布局') assert.ok((await post('/api/layout', { root: target, mode: 'flat', nodes: { [target]: { x: 50, y: 80 } } })).ok);
      if (edit === '页面') assert.ok((await post('/api/page', { roots: ['main.c::main'], up: 3, down: 1 })).ok);
      if (edit === '页面改后改回') {
        const original = (await (await fetch(srv.baseUrl + '/api/page?saved=1')).json()).page;
        assert.ok((await post('/api/page', { ...original, down: original.down + 1 })).ok);
        assert.ok((await post('/api/page', original)).ok);
      }
      if (edit === '另一轮推断边') {
        otherTurn = true;
        const second = await run('请存下这条推断边');
        assert.ok(second.some(e => e.type === 'tool_end' && e.ok));
      }
      const read = async () => {
        const session = await (await fetch(srv.baseUrl + '/api/session/export')).json();
        return { overlay: session.overlay, page: session.lastView, marks: session.bookmarks, events: session.eventsTotal };
      };
      const before = await read();
      assert.ok(before.marks.some(b => b.name === bookmarkName));
      assert.equal((await post('/api/ai/undo-changeset', { changesetId: id })).status, 409);
      assert.deepEqual(await read(), before);
    });
  }
});

test('撤销书签删除保留原 ID、作用域与后来取得同名的记录', async t => {
  for (const mode of ['删除已有', '覆盖后删除', '删除后同名重建', '新建后删除', '独立同名冲突']) {
    await t.test(mode, async t => {
      const srv = await launchServer();
      t.after(srv.close);
      const name = '保存的入口';
      const save = ['manage_bookmarks', { action: 'save', name }];
      const remove = id => ['manage_bookmarks', { action: 'delete', id }];
      let original, step = 0, newId;
      const { run, post } = await mockAiTurn(t, srv.baseUrl, last => {
        if (last.role === 'user') return [['覆盖后删除', '新建后删除'].includes(mode) ? save : remove(original.id)];
        if (step++ === 0) {
          if (['覆盖后删除', '新建后删除'].includes(mode)) return [remove(JSON.parse(last.content).bookmark.id)];
          if (mode === '删除后同名重建') return [save];
        } else if (mode === '删除后同名重建') newId = JSON.parse(last.content).bookmark.id;
        return [];
      });
      const list = async () => (await (await fetch(srv.baseUrl + '/api/bookmarks')).json()).list;
      if (mode !== '新建后删除') original = (await (await post('/api/bookmarks', { name, roots: ['main.c::main'], up: 3, down: 2,
        vars: ['var::x'], groupMode: 'period', hiddenVars: ['var::y'], expansions: [{ root: 'a.c::f', up: 1, down: 2 }] })).json()).bookmark;
      const events = await run('按指定顺序管理书签');
      assert.ok(events.filter(e => e.type === 'tool_end').every(e => e.ok));
      const id = events.find(e => e.type === 'changeset')?.changesetId;
      if (mode === '新建后删除') {
        if (id) assert.equal((await post('/api/ai/undo-changeset', { changesetId: id })).status, 200);
        assert.deepEqual(await list(), []);
        return;
      }
      assert.ok(id);
      if (mode === '独立同名冲突') {
        const newer = (await (await post('/api/bookmarks', { name, roots: ['other.c::new'] })).json()).bookmark;
        assert.equal((await post('/api/ai/undo-changeset', { changesetId: id })).status, 409);
        assert.deepEqual(await list(), [newer]);
        return;
      }
      if (mode === '删除后同名重建') assert.notEqual(newId, original.id);
      assert.equal((await post('/api/ai/undo-changeset', { changesetId: id })).status, 200);
      const [restored] = await list();
      assert.ok(restored);
      assert.deepEqual({ ...restored, revision: original.revision, updatedAt: original.updatedAt }, original);
      assert.ok(restored.revision > original.revision + (mode === '覆盖后删除' ? 1 : 0));
    });
  }
});

test('浏览器撤销旧画布时显示冲突并保留新标注', async t => {
  try { resolveChromePath(); } catch (err) { t.skip(err.message); return; }
  const srv = await launchServer();
  t.after(srv.close);
  const target = 'gear.c::Gear_Init';
  const { run, post } = await mockAiTurn(t, srv.baseUrl, last => last.role === 'user' ?
    [['add_to_canvas', { functions: [target], includeTasks: false }]] : []);
  const events = await run('请将 Gear_Init 加入画布');
  const change = events.find(e => e.type === 'changeset');
  assert.ok(change);
  await post('/api/ai/chats', { activeId: 'undo', threads: [{ id: 'undo', messages: [
    { role: 'assistant', text: '已加入画布。', changeset: { id: change.changesetId, ops: change.ops } },
  ] }] });
  const browser = await launchCdp({ url: srv.baseUrl });
  t.after(() => browser.close());
  await browser.waitFor('Boolean(window.__cg?.view)');
  await browser.evaluate("document.getElementById('aiBtn').click()");
  await browser.waitFor("Boolean(document.querySelector('.ai-undo-btn'))");
  await post('/api/overlay', { nodeId: target, data: { note: '保留我的新标注' } });
  await browser.evaluate("document.querySelector('.ai-undo-btn').click()");
  await browser.waitFor("!document.querySelector('.ai-undo-btn').disabled || document.querySelector('.ai-undo-btn').textContent.includes('已撤销')");
  assert.match(await browser.evaluate("document.getElementById('aiChatStatus').textContent"), /撤销失败.*修改/);
  const session = await (await fetch(srv.baseUrl + '/api/session/export')).json();
  assert.equal(session.overlay.nodes[target].note, '保留我的新标注');
});

test('未过期的画布撤销保留独立书签和后来的视口', async t => {
  const srv = await launchServer();
  t.after(srv.close);
  const { run, post } = await mockAiTurn(t, srv.baseUrl, last => last.role === 'user' ?
    [['add_to_canvas', { functions: ['gear.c::Gear_Init'], mode: 'replace', includeTasks: false }]] : []);
  const page = async () => (await (await fetch(srv.baseUrl + '/api/page?saved=1')).json()).page;
  await post('/api/page', { roots: ['main.c::main'], up: 1, down: 0, cam: { x: 1, y: 2, k: 1 } });
  const events = await run('替换画布');
  const id = events.find(e => e.type === 'changeset')?.changesetId;
  assert.ok(id);
  const cam = { x: 11, y: 22, k: 0.8 };
  await post('/api/page', { ...await page(), cam });
  const independent = (await (await post('/api/bookmarks', { name: '另一个书签', roots: ['adc.c::Adc_Init'] })).json()).bookmark;
  assert.equal((await post('/api/ai/undo-changeset', { changesetId: id })).status, 200);
  const restored = await page();
  assert.deepEqual(restored.roots, ['main.c::main']);
  assert.deepEqual(restored.cam, cam);
  assert.deepEqual((await (await fetch(srv.baseUrl + '/api/bookmarks')).json()).list, [independent]);
});

test('画布工具按真实变量根和间接调用点返回可操作的结果', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-present-var-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'logic.c'), [
    'int shared; int unused = 7;',
    'void writer(void) { shared = 1; }', 'int reader(void) { return shared; }',
    'typedef void (*Fn)(void); extern Fn callbacks[];',
    'void unknown(int i) { callbacks[i](); }', 'void unrelated(int i) { callbacks[i](); }',
    'void other(void) {} static Fn const known[] = { writer, other };',
    'void possible(int i) { known[i](); } void single(void) { known[0](); }',
    ...Array.from({ length: 81 }, (_, i) => 'void f' + i + '(void) {}'),
  ].join('\n'));
  const srv = await launchServer({ target: dir });
  t.after(srv.close);
  let job, result;
  const { run, post } = await mockAiTurn(t, srv.baseUrl, last => {
    if (last.role === 'tool') { result = JSON.parse(last.content); return []; }
    return [job];
  });
  const page = async () => (await (await fetch(srv.baseUrl + '/api/page?saved=1')).json()).page;
  const v = 'var::shared', writer = 'logic.c::writer', reader = 'logic.c::reader';
  for (const [direction, peers] of [['both', [writer, reader]], ['up', [writer]], ['down', [reader]]]) {
    await t.test('以变量为根构图 ' + direction, async () => {
      job = ['present_logic', { root: v, direction, depth: 1, mode: 'replace' }];
      await run('呈现 shared 的读写者');
      assert.equal(result.ok, true, result.error);
      const saved = await page();
      assert.deepEqual(saved?.vars, [v]);
      assert.deepEqual([...saved.roots, ...saved.expansions.map(s => s.root)].sort(), peers.slice().sort());
      assert.deepEqual(result.chains.map(c => [c.kind, ...c.steps.map(s => s.id)]).sort(),
        peers.map(id => ['dataflow', ...(id === writer ? [id, v] : [v, id])]).sort());
      const view = await (await post('/api/view?up=0&down=0', saved)).json();
      const visibleEdges = view.edges.filter(e => e.kind === 'var').map(e => e.from + '->' + e.to + ':' + e.line);
      assert.deepEqual(result.canvasOverlay.edgeKeys.toSorted(), visibleEdges.sort());
      assert.equal(result.addedToCanvas, true);
    });
  }
  await t.test('预览混合目标不改变画布或发送高亮', async () => {
    const before = await page();
    job = ['present_logic', { targets: [writer, v], direction: 'down', depth: 1, includeDataflow: false, addToCanvas: false }];
    const events = await run('只生成这两个目标的导览');
    assert.equal(result.ok, true, result.error);
    assert.equal(result.addedToCanvas, false);
    const ids = result.presentation.steps.flatMap(s => s.nodeIds);
    for (const id of [writer, reader, v]) assert.ok(ids.includes(id), id);
    assert.equal(events.some(e => e.type === 'canvas_overlay' || e.type === 'changeset'), false);
    assert.deepEqual(await page(), before);
  });
  await t.test('无读写者的变量返回明确结果，保留已有页面', async () => {
    const before = await page();
    job = ['present_logic', { root: 'var::unused', mode: 'replace' }];
    const events = await run('呈现 unused');
    assert.equal(result.ok, false);
    assert.match(result.error, /读写|函数/);
    assert.equal(events.some(e => ['presentation', 'canvas_overlay', 'changeset'].includes(e.type)), false);
    assert.deepEqual(await page(), before);
    job = ['present_logic', { root: 'var::unused', addToCanvas: false }];
    const preview = await run('只读导览 unused');
    assert.equal(result.ok, true);
    assert.deepEqual(result.presentation.steps.flatMap(s => s.nodeIds), ['var::unused']);
    assert.deepEqual(result.chains, []);
    assert.equal(preview.some(e => e.type === 'canvas_overlay'), false);
  });
  await t.test('组图校验失败时返回失败，不发送导览或改变页面', async () => {
    const before = await page();
    job = ['present_logic', { targets: Array.from({ length: 81 }, (_, i) => 'logic.c::f' + i), mode: 'replace' }];
    const events = await run('呈现指定函数');
    assert.equal(result.ok, false);
    assert.match(result.error, /80/);
    assert.equal(events.some(e => ['presentation', 'canvas_overlay', 'changeset'].includes(e.type)), false);
    assert.deepEqual(await page(), before);
  });
  await t.test('只诊断可见调用方，包含没有候选项的未解析调用点', async () => {
    const id = 'logic.c::unknown';
    job = ['inspect_indirect_calls', { function: id }];
    await run('核实 unknown 的间接调用');
    const site = result.indirectCalls.find(s => s.caller === id);
    assert.equal(site.resolution, 'unresolved');
    assert.deepEqual(site.candidates, []);
    await post('/api/page', { roots: [id], up: 0, down: 0 });
    for (const check of ['indirect', 'all']) {
      job = ['diagnose_canvas', { check }];
      await run('诊断当前画布');
      const issue = result.healthReport.issues.find(i => i.category === 'indirect');
      assert.deepEqual(issue?.nodeIds, [id]);
      assert.match(issue.detail, /callbacks/);
    }
    await post('/api/page', { roots: [writer], up: 0, down: 0 });
    job = ['diagnose_canvas', { check: 'indirect' }];
    await run('诊断新的画布');
    assert.deepEqual(result.healthReport.issues, []);
    const possible = 'logic.c::possible';
    await post('/api/page', { roots: [possible], up: 0, down: 0 });
    await run('诊断未展开的候选项');
    assert.deepEqual(result.healthReport.issues[0]?.nodeIds, [possible]);
    await post('/api/page', { roots: [possible, writer, 'logic.c::other', 'logic.c::single'], up: 0, down: 0 });
    await run('诊断候选已显示的调用点和精确调用');
    assert.deepEqual(result.healthReport.issues, []);
  });
  await t.test('比较模式明确区分只读导览和组图请求', async () => {
    const versions = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-present-versions-'));
    t.after(() => fs.rmSync(versions, { recursive: true, force: true }));
    const beforePath = path.join(versions, 'before'), afterPath = path.join(versions, 'after');
    fs.mkdirSync(beforePath);
    fs.mkdirSync(afterPath);
    const source = fs.readFileSync(path.join(dir, 'logic.c'), 'utf8');
    fs.writeFileSync(path.join(beforePath, 'logic.c'), source);
    fs.writeFileSync(path.join(afterPath, 'logic.c'), source.replace('shared = 1', 'shared = 2'));
    const prep = await (await post('/api/compare', { beforePath, afterPath })).json();
    assert.ok(prep.ok, prep.error);
    const applied = await (await post('/api/compare/apply', { previewId: prep.preview.id, selectedIds: [writer, v] })).json();
    assert.ok(applied.ok, applied.error);
    job = ['present_logic', { root: v }];
    const events = await run('呈现比较图的 shared');
    assert.equal(result.ok, false);
    assert.match(result.error, /比较/);
    assert.equal(events.some(e => e.type === 'canvas_overlay' || e.type === 'presentation'), false);
    job = ['present_logic', { root: v, direction: 'up', depth: 1, addToCanvas: false }];
    await run('只读导览比较图的 shared');
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.chains.map(c => c.steps.map(s => s.id)), [[writer, v]]);
    const view = await (await fetch(srv.baseUrl + '/api/view')).json();
    const edge = view.edges.find(e => e.kind === 'var' && e.from === writer && e.to === v);
    assert.deepEqual(result.chains[0].edgeKeys, [edge.from + '->' + edge.to + ':' + edge.line]);
  });
});

test('浏览器在发起 AI 删除的窗口解除书签，再用 Ctrl+S 另存当前画布', async t => {
  try { resolveChromePath(); } catch (err) { t.skip(err.message); return; }
  const srv = await launchServer();
  t.after(srv.close);
  const root = 'gear.c::Gear_Init';
  let id, toolResult, action = 'update';
  const { post } = await mockAiTurn(t, srv.baseUrl, last => {
    if (last.role === 'tool') { toolResult = JSON.parse(last.content); return []; }
    return [['manage_bookmarks', { action, id }]];
  });
  const created = await (await post('/api/bookmarks', { name: '原书签', roots: [root] })).json();
  id = created.bookmark.id;
  const browser = await launchCdp({ url: srv.baseUrl });
  t.after(() => browser.close());
  await browser.waitFor('Boolean(window.__cg?.view)');
  await browser.evaluate("document.getElementById('bookmarkBtn').click()");
  await browser.waitFor("Boolean(document.querySelector('.bm-open'))");
  await browser.evaluate("document.querySelector('.bm-open').click()");
  const active = "(await import('/lib/state.js')).state.activeBookmark";
  await browser.waitFor(`(async () => (${active})?.id === ${id} && !document.querySelector('.modal.show'))()`);
  await browser.evaluate("window.bookmarkEvents = []; window.addEventListener('cg:bookmark-changed', e => window.bookmarkEvents.push(e.detail.bookmark?.id ?? null))");
  const chat = prompt => browser.evaluate(`(async () => {
    const { api } = await import('/lib/api.js');
    return (await api.aiChat({ prompt: ${JSON.stringify(prompt)} })).text();
  })()`);
  await chat('请更新原书签');
  assert.equal(toolResult.bookmark.revision, created.bookmark.revision + 1);
  assert.equal(await browser.evaluate(`(async () => (${active}).revision)()`), created.bookmark.revision);
  action = 'delete';
  await chat('请删除原书签');
  assert.equal(toolResult.ok, true);
  await browser.waitFor(`(async () => (${active}) === null)()`, { timeoutMs: 3000 });
  assert.deepEqual(await browser.evaluate("window.bookmarkEvents"), [id, null]);
  await browser.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }))");
  await browser.waitFor("Boolean(document.querySelector('#bookmarkModal.show'))");
  await browser.evaluate("document.getElementById('bookmarkName').value = '新书签'; document.getElementById('bookmarkSave').click()");
  await browser.waitFor(`(async () => (${active})?.name === '新书签')()`);
  const { list } = await (await fetch(srv.baseUrl + '/api/bookmarks')).json();
  assert.deepEqual(list.map(b => [b.name, b.roots]), [['新书签', [root]]]);
  assert.notEqual(list[0].id, id);
});

test('浏览器成功撤销 AI 标签和范围后立即刷新，保留视口、书签和回看位置', async t => {
  try { resolveChromePath(); } catch (err) { t.skip(err.message); return; }
  for (const mode of ['仅标签', '标签及范围', '历史回看', '刷新失败']) {
    await t.test(mode, async t => {
      const srv = await launchServer(); t.after(srv.close);
      const from = 'main.c::main', to = 'main.c::Task_10ms', extra = 'gear.c::Gear_Apply';
      const calls = [['apply_labels', { items: [{ from, to, preset: 'task', text: 'TASK:10ms' }] }]];
      if (mode !== '仅标签') calls.unshift(['add_to_canvas', { functions: [extra], includeTasks: false }]);
      const { post, run } = await mockAiTurn(t, srv.baseUrl, last => last.role === 'user' ? calls : []);
      const jsonPost = (url, p) => post(url,p).then(r=>r.json());
      const { eventId: at } = await jsonPost('/api/view-event', { op: 'view.checkpoint', ctx: { checkpointName: '历史基线' }, view: { roots: [extra], down: 0 } });
      const page = { roots: [from], up: 0, down: 1, groupMode: 'flat' };
      const { bookmark } = await jsonPost('/api/bookmarks', { ...page, name: '保留绑定' });
      await jsonPost('/api/page', { ...page, activeBookmark: bookmark });
      const events = await run('请应用周期标签并按要求组图');
      const change = events.find(e=>e.type === 'changeset');
      assert.ok(change);
      await jsonPost('/api/ai/chats', { activeId: 'undo', threads: [{ id: 'undo', messages: [
        { role: 'assistant', text: '已完成。', changeset: { id: change.changesetId, ops: change.ops } },
      ] }] });
      const saved = (await (await fetch(srv.baseUrl + '/api/page?saved=1')).json()).page;
      await jsonPost('/api/page', { ...saved, activeBookmark: bookmark });
      const br = await launchCdp({ url: srv.baseUrl }); t.after(()=>br.close());
      const labeled = 'window.__cg?.view?.edges.some(e => e.labels?.some(l => l.text === "TASK:10ms"))';
      await br.waitFor(labeled);
      const hasExtra = 'window.__cg.view.nodes.some(n => n.id === ' + JSON.stringify(extra) + ')';
      assert.equal(await br.evaluate(hasExtra), mode !== '仅标签');
      if (mode === '历史回看') {
        await br.evaluate("document.getElementById('timelineBtn').click()");
        const row = '.ev[data-id="' + at + '"] .ev-review';
        await br.waitFor('Boolean(document.querySelector(' + JSON.stringify(row) + '))');
        await br.evaluate('document.querySelector(' + JSON.stringify(row) + ').click()');
        await br.waitFor('window.__cg.at === ' + at + ' && window.__cg.root === ' + JSON.stringify(extra));
      }
      await br.evaluate("document.getElementById('aiBtn').click()");
      await br.waitFor("Boolean(document.querySelector('.ai-undo-btn'))");
      const cam = await br.evaluate("(async () => { const { cam } = await import('/lib/state.js'); Object.assign(cam, {x:31,y:49,k:.85}); return window.__cg.cam; })()");
      if (mode === '刷新失败') await br.evaluate("(async () => { const { api } = await import('/lib/api.js'); api.view = async () => { throw new Error('view unavailable'); }; })()");
      await br.evaluate("document.querySelector('.ai-undo-btn').click()");
      if (mode === '刷新失败') {
        await br.waitFor("document.querySelector('.ai-undo-btn').textContent.includes('已撤销')");
        assert.match(await br.evaluate("document.getElementById('aiChatStatus').textContent"), /撤销已完成.*刷新.*失败/);
        assert.equal(await br.evaluate("document.querySelector('.ai-undo-btn').disabled"), true);
        const session = await (await fetch(srv.baseUrl + '/api/session/export')).json();
        assert.ok(!Object.values(session.overlay.edges).some(e => e.labels?.some(l => l.text === 'TASK:10ms')));
        return;
      }
      await br.waitFor("document.querySelector('.ai-undo-btn').textContent.includes('已撤销')");
      if (mode === '历史回看') {
        assert.equal(await br.evaluate('window.__cg.at'), at);
        assert.equal(await br.evaluate('window.__cg.root'), extra);
        await br.evaluate("document.getElementById('reviewExit').click()");
        await br.waitFor('window.__cg.at === 0 && window.__cg.root === ' + JSON.stringify(from));
      } else assert.deepEqual(await br.evaluate('window.__cg.cam'), cam);
      assert.equal(await br.evaluate(labeled), false);
      assert.equal(await br.evaluate(hasExtra), false);
      assert.equal(await br.evaluate("(async () => (await import('/lib/state.js')).state.activeBookmark?.id)()"), bookmark.id);
      const session = await (await fetch(srv.baseUrl + '/api/session/export')).json();
      assert.ok(!Object.values(session.overlay.edges).some(e => e.labels?.some(l => l.text === 'TASK:10ms')));
    });
  }
});

test('成功撤销 AI 首次组图时空画布的新版本也能回看', async t => {
  const srv = await launchServer(); t.after(srv.close);
  const { run, post } = await mockAiTurn(t, srv.baseUrl, last => last.role === 'user' ?
    [['add_to_canvas', { functions: ['gear.c::Gear_Init'], includeTasks: false }]] : []);
  const get = route => fetch(srv.baseUrl + route).then(r => r.json());
  assert.equal((await get('/api/page?saved=1')).page == null, true);
  const events = await run('将 Gear_Init 加入空画布');
  const composed = (await get('/api/page?saved=1')).page;
  const result = await (await post('/api/ai/undo-changeset', { changesetId: events.find(e => e.type === 'changeset').changesetId })).json();
  assert.equal(result.ok, true);
  const page = (await get('/api/page?saved=1')).page;
  assert.equal(page?.empty, true);
  assert.equal(page.revision, result.eventId);
  const history = await get('/api/view?at=' + result.eventId + '&useSnapshot=1');
  assert.deepEqual(history.nodes, []);
  assert.equal((await post('/api/page', { ...composed, roots: ['main.c::main'] })).status, 409);
});

test('成功撤销 AI 组图后，较早发出的组图请求不能再覆盖页面', async t => {
  try { resolveChromePath(); } catch (err) { t.skip(err.message); return; }
  const srv = await launchServer(); t.after(srv.close);
  const root = 'main.c::main', extra = 'gear.c::Gear_Apply';
  const { post } = await mockAiTurn(t, srv.baseUrl, last => last.role === 'user' ?
    [['add_to_canvas', { functions: [extra], includeTasks: false }]] : []);
  await post('/api/page', { roots: [root], up: 0, down: 0 });
  const br = await launchCdp({ url: srv.baseUrl }); t.after(() => br.close());
  await br.waitFor('window.__cg?.root === ' + JSON.stringify(root));
  await br.evaluate(`(async () => {
    const { api } = await import('/lib/api.js');
    const view = api.view;
    window.oldViewRequests = 0;
    api.view = async opts => {
      if (opts.expansions?.some(s => s.root === ${JSON.stringify(extra)}) && ++window.oldViewRequests === 1) {
        await new Promise(resolve => { window.releaseOldView = resolve; });
      }
      return view(opts);
    };
    document.getElementById('aiBtn').click();
  })()`);
  await br.waitFor("document.getElementById('aiModel').value === 'mock'");
  await br.evaluate(`(() => {
    const prompt = document.getElementById('aiPromptInput');
    prompt.value = '请把 Gear_Apply 加入当前画布';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('aiSendChat').click();
  })()`);
  await br.waitFor("Boolean(window.releaseOldView && document.querySelector('.ai-undo-btn'))");
  await br.evaluate("document.querySelector('.ai-undo-btn').click()");
  await br.waitFor("document.querySelector('.ai-undo-btn').textContent.includes('已撤销')");
  await br.evaluate("window.releaseOldView(); new Promise(resolve => setTimeout(resolve, 2400))");
  assert.equal(await br.evaluate('window.oldViewRequests'), 1);
  assert.equal(await br.evaluate('window.__cg.view.nodes.some(n=>n.id === ' + JSON.stringify(extra) + ')'), false);
});
