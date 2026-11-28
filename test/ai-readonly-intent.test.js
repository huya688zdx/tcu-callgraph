import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { aiTranslator } from '../src/core/ai-messages.js';
import { runAiAgent } from '../src/core/ai-agent.js';
import { launchCdp, resolveChromePath } from '../scripts/lib/cdp.mjs';
import { launchServer } from '../scripts/lib/server.mjs';
import { SUPPORTED_LANGS, setLang, t as translate } from '../web/i18n.js';

test('只读意图在工具执行前生效，仍可查询；明确操作沿用已有策略', async t => {
  const writes = [
    ['add_to_canvas', {}], ['remove_from_canvas', {}], ['apply_labels', {}], ['add_call_edge', {}],
    ['arrange_canvas', { action: 'tidy' }], ['manage_bookmarks', { action: 'save' }],
    ['present_logic', {}],
  ];
  const reads = [
    ['manage_bookmarks', { action: 'list' }],
    ['arrange_canvas', { action: 'inspect' }], ['present_logic', { addToCanvas: false }],
  ];
  const run = async (language, prompt, readOnly, calls) => {
    let sent = false;
    const invoked = [];
    const blocked = [];
    await runAiAgent({
      config: { baseUrl: 'http://localhost', model: 'fixture' }, prompt,
      context: { language, readOnly },
      executeTool: async (name, args) => { invoked.push([name, args]); return { ok: true }; },
      onEvent: ev => { if (ev.type === 'tool_end' && ev.blocked) blocked.push(ev.name); },
      fetchImpl: async () => {
        const message = sent ? { content: 'Done' } : { tool_calls: calls.map(([name, args], i) => ({
          id: 'fixture-' + i, type: 'function', function: { name, arguments: JSON.stringify(args) },
        })) };
        sent = true;
        return Response.json({ choices: [{ message }] });
      },
    });
    return { invoked, blocked };
  };
  t.after(() => setLang('zh-CN'));
  for (const language of SUPPORTED_LANGS) await t.test(language, async () => {
    setLang(language);
    const id = 'remove_from_canvas';
    const question = translate('ai.prompt.function', { id });
    for (const [name, args] of writes) {
      assert.deepEqual(await run(language, question, true, [[name, args]]), { invoked: [], blocked: [name] });
    }
    for (const action of reads) {
      assert.deepEqual(await run(language, question, true, [action]), { invoked: [action], blocked: [] });
    }
    const edit = writes[0];
    assert.deepEqual(await run(language, translate('ai.action.functions'), undefined, [edit]), { invoked: [edit], blocked: [] });
  });
  assert.deepEqual(await run('en', 'Explain the purpose of sample.', false, [writes[0]]),
    { invoked: [], blocked: ['add_to_canvas'] });
});

test('Chromium 三语解释按钮、追问与草稿把本次意图传到本地模拟模型', async t => {
  try { resolveChromePath(); } catch (error) { return t.skip(error.message); }
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-intent-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture, 'fixture.c'), 'int remove_from_canvas(void) { return 1; }\n');
  const srv = await launchServer({ target: fixture });
  t.after(srv.close);
  const requests = [];
  const model = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
    let raw = '';
    for await (const part of req) raw += part;
    requests.push(JSON.parse(raw));
    res.end(JSON.stringify({ choices: [{ message: { content: 'fixture answer' } }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => model.close(resolve)));
  assert.ok((await fetch(srv.baseUrl + '/api/ai/config', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:' + model.address().port, model: 'fixture' }),
  })).ok);
  const browser = await launchCdp({ url: srv.baseUrl });
  t.after(() => browser.close());
  await browser.waitFor('Boolean(window.__cg?.view?.projectId)');
  await browser.evaluate('aiBtn.click()');
  await browser.waitFor("aiModel.value === 'fixture' && aiChatSelect.options.length > 0");
  await browser.evaluate(`import('/lib/api.js').then(({api}) => {
    const send = api.aiChat;
    window.intentRequests = [];
    api.aiChat = (body, signal) => {
      if (body.prompt === 'hold fixture turn') {
        window.waitingForSteer = true;
        return new Promise((_, reject) => signal.addEventListener('abort', () => {
          window.waitingForSteer = false;
          reject(signal.reason);
        }, { once: true }));
      }
      if (body.prompt === 'show fixture followups') {
        const event = { type: 'done', answer: 'fixture card', toolLog: [{ name: 'read_function', ok: true }] };
        return Promise.resolve(new Response(JSON.stringify(event)));
      }
      window.intentRequests.push(body);
      return send(body, signal);
    };
  })`);
  const select = detail => browser.evaluate("document.dispatchEvent(new CustomEvent('cg:selection-changed', {detail:" + JSON.stringify(detail) + '}))');
  const typePrompt = text => 'aiPromptInput.value = ' + JSON.stringify(text) +
    "; aiPromptInput.dispatchEvent(new Event('input')); aiSendChat.click()";
  const click = i => 'aiSelectionQuestions.children[' + i + '].click()';
  const node = { kind: 'node', id: 'remove_from_canvas' };
  const pair = { kind: 'pair', fromId: 'a', toId: 'b' };
  const flow = { kind: 'dataflow', targetId: 'a' };
  for (const language of SUPPORTED_LANGS) await t.test(language, async () => {
    await browser.evaluate("import('/i18n.js').then(({setLang}) => setLang(" + JSON.stringify(language) + '))');
    await browser.evaluate('aiNewChat.click()');
    const check = async (action, readOnly) => {
      const index = requests.length;
      await browser.evaluate(action);
      await browser.waitFor('window.intentRequests.length === ' + (index + 1) +
        " && !aiSendChat.classList.contains('steering') && aiMessages.lastElementChild?.textContent.includes('fixture answer')");
      const body = await browser.evaluate('window.intentRequests.at(-1)');
      assert.equal(body.language, language);
      assert.equal(body.readOnly === true, readOnly, body.prompt);
      const system = requests[index].messages[0].content;
      assert.equal(system.includes(aiTranslator(language)('readOnlyTurn')), readOnly, body.prompt);
    };
    for (const [selection, expected] of [
      [node, [true, true]], [{ kind: 'node', nodeKind: 'var', id: 'v' }, [true, true]],
      [{ kind: 'edge', edgeKey: 'a-b', from: 'a', to: 'b' }, [true, true]],
      [{ kind: 'file', path: 'fixture.c' }, [true, true]], [{ kind: 'file', containerKind: 'dir', path: 'src' }, [true, true]],
      [{ ...pair, pathCount: 1 }, [true, true]], [pair, [true, false]], [flow, [true, false]],
    ]) {
      for (const [i, flag] of expected.entries()) { await select(selection); await check(click(i), flag); }
    }
    await select(node);
    await check(click(0), true);
    await check("aiMessages.lastElementChild.querySelector('.ai-followups button').click()", true);
    await browser.evaluate('aiNewChat.click()');
    await select(node);
    await check('aiGhostTabHint.click(); aiSendChat.click()', true);
    await browser.evaluate('aiNewChat.click()');
    await select(node);
    await check("aiGhostTabHint.click(); aiPromptInput.value = '/present'; aiPromptInput.dispatchEvent(new Event('input')); aiSendChat.click()", false);
    await browser.evaluate(typePrompt('hold fixture turn'));
    await browser.waitFor('window.waitingForSteer');
    await select(node);
    await check(click(0), true);

    for (const [i, readOnly] of [[0, true], [1, true], [2, false]]) {
      await browser.evaluate(typePrompt('show fixture followups'));
      await browser.waitFor("!aiSendChat.classList.contains('steering') && aiMessages.lastElementChild?.textContent.includes('fixture card')");
      await check("aiMessages.lastElementChild.querySelectorAll('.ai-followups button')[" + i + "].click()", readOnly);
    }
    for (const [quick, readOnly] of [['build', true], ['git', false], ['labels', false]]) {
      await check('document.querySelector(' + JSON.stringify('[data-ai-quick="' + quick + '"]') + ').click()', readOnly);
    }
    for (const [cmd, readOnly] of [['/flow', true], ['/impact', true], ['/subagent', true], ['/check', true], ['/check fix', false], ['/impact sample and add it to the canvas', false]]) {
      await check(typePrompt(cmd), readOnly);
    }
  });
});
