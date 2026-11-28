import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { getLang, setLang, SUPPORTED_LANGS, t as translate } from '../web/i18n.js';
import { aiTranslator } from '../src/core/ai-messages.js';
import { compactConversation, runAiAgent, SUBAGENT_READONLY_TOOLS } from '../src/core/ai-agent.js';
import { launchServer } from '../scripts/lib/server.mjs';
import { launchCdp, resolveChromePath } from '../scripts/lib/cdp.mjs';

const web = new URL('../web/', import.meta.url);
const source = path => fs.readFileSync(new URL(path, web), 'utf8');
const placeholders = text => [...new Set(Array.from(text.matchAll(/\{(\w+)\}/g), match => match[1]))].sort();

test('三语词条键集合及占位符一致，前端静态引用均可翻译', t => {
  assert.deepEqual(SUPPORTED_LANGS, ['zh-CN', 'ja', 'en']);
  t.after(() => setLang('zh-CN'));
  const dictionaryRows = Array.from(source('i18n.js').matchAll(/^  (\["[^"]+", .*\]),$/gm), match => JSON.parse(match[1]));
  assert.ok(dictionaryRows.length > 300);
  const keys = new Set(dictionaryRows.map(([key]) => key));
  assert.equal(keys.size, dictionaryRows.length, '词条键不能重复');
  for (const [key, ...translations] of dictionaryRows) {
    assert.equal(translations.length, SUPPORTED_LANGS.length, key);
    for (const [index, text] of translations.entries()) {
      assert.ok(text?.trim(), key);
      assert.deepEqual(placeholders(text), placeholders(translations[0]), key);
      setLang(SUPPORTED_LANGS[index]);
      assert.equal(translate(key), text, key);
    }
  }

  const files = ['app.js', ...fs.readdirSync(new URL('lib/', web)).filter(file => file.endsWith('.js')).map(file => 'lib/' + file)];
  const references = [
    ...Array.from(source('index.html').matchAll(/\bdata-i18n(?:-[\w-]+)?=["']([\w.-]+)["']/g), match => ['index.html', match[1]]),
    ...files.flatMap(file => Array.from(source(file).matchAll(/\bt\(\s*['"]([\w.-]+)['"]\s*(?=[,)]|\s*:)/g), match => [file, match[1]])),
  ];
  for (const [file, key] of references) assert.ok(keys.has(key), `${file}: ${key}`);
});

test('切换语言写入本地存储并立即更新文案与语言事件', t => {
  const stored = new Map();
  const doc = new EventTarget();
  const entry = { dataset: { i18n: 'style.language' } };
  doc.documentElement = { lang: 'zh-CN' };
  doc.querySelectorAll = selector => selector === '[data-i18n]' ? [entry] : [];
  for (const [key, value] of [
    ['document', doc],
    ['localStorage', { setItem: (name, value) => stored.set(name, value) }],
  ]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  const events = [];
  doc.addEventListener('callgraph:langchange', event => events.push(event.detail.lang));
  setLang('ja');
  assert.equal(entry.textContent, '表示言語');
  setLang('en');
  assert.equal(stored.get('callgraph.language'), 'en');
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(entry.textContent, 'Interface language');
  assert.equal(translate('compare.point.affected', { n: 5 }), '5 affected');
  setLang('unknown');
  assert.equal(getLang(), 'en');
  assert.deepEqual(events, ['ja', 'en']);
});

test('画布时间轴的动态类型和回看提示在三种语言下均可显示', t => {
  t.after(() => setLang('zh-CN'));
  for (const lang of SUPPORTED_LANGS) {
    setLang(lang);
    for (const key of ['timeline.kindCanvas', 'timeline.kindClearCanvas']) {
      assert.notEqual(translate(key), key);
    }
    for (const key of ['timeline.reviewSnapshot', 'timeline.reviewOverlay']) {
      const message = translate(key, { time: '10:20:30', n: 123 });
      assert.match(message, /10:20:30/);
      assert.match(message, /123/);
      assert.doesNotMatch(message, /\{\w+\}/);
    }
  }
});

test('模型请求、旧版工具回退和摘要逐请求使用所选语言，并保留源码和对话原文', async () => {
  const rows = Array.from(source('../src/core/ai-messages.js').matchAll(/^  (\["[^"]+", .*\]),$/gm), m => JSON.parse(m[1]));
  const keys = new Set(rows.map(([key]) => key));
  assert.equal(keys.size, rows.length);
  for (const file of ['../src/core/ai-agent.js', '../src/server.js']) {
    for (const [, key] of source(file).matchAll(/\btr\(\s*'([\w.-]+)'\s*[,)]/g)) {
      assert.ok(keys.has(key), file + ' ' + key);
    }
  }
  for (const [key, chinese, ...others] of rows) {
    assert.equal(others.length, 2, key);
    for (const text of others) {
      assert.ok(text.trim(), key);
      assert.deepEqual(placeholders(text), placeholders(chinese), key);
    }
  }
  // 并行发送不同语言，防止服务端把一种语言串到另一条对话。
  await Promise.all(SUPPORTED_LANGS.map(async language => {
    const tr = aiTranslator(language);
    const config = { baseUrl: 'http://localhost', model: 'test', toolMode: 'auto' };
    const requests = [];
    const done = () => Response.json({ choices: [{ message: { content: '原样返回' } }] });
    const run = await runAiAgent({
      config, prompt: '我的原文', context: { language, uiContext: { kind: 'node', id: 'demo.c::main' } },
      attachments: [{ name: 'demo.c', content: 'int main(void);' }],
      fetchImpl: async (_url, { body }) => {
        requests.push(JSON.parse(body));
        return requests.length === 1 ? new Response('tools not supported', { status: 400 }) : done();
      },
    });
    assert.equal(run.answer, '原样返回');
    assert.equal(requests.length, 2);
    const [standard, legacy] = requests;
    for (const req of requests) {
      assert.ok(req.messages[0].content.includes(tr('language')));
      const question = req.messages.at(-1).content;
      assert.ok(question.includes(tr('contextSingle')));
      assert.ok(question.includes(tr('attachmentHeader')));
      assert.match(question, /demo\.c::main/);
      assert.match(question, /int main\(void\);/);
      assert.ok(question.endsWith('我的原文'));
    }
    const tool = standard.tools.find(item => item.function.name === 'get_git_changes').function;
    assert.equal(tool.description, tr('tool.get_git_changes'));
    assert.equal(tool.parameters.properties.baseRef.description, tr('tool.get_git_changes.baseRef'));
    assert.equal(legacy.tools, undefined);
    assert.ok(legacy.messages[0].content.includes(tool.description));
    assert.ok(legacy.messages[0].content.includes(tr('toolFormat')));
    const messages = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '原文 ' + i }));
    let summaryRequest;
    const compacted = await compactConversation({ language, config, messages, fetchImpl: async (_url, { body }) => {
      summaryRequest = JSON.parse(body);
      return done();
    } });
    assert.equal(summaryRequest.messages[0].content, tr('compact'));
    assert.ok(compacted.messages[0].text.startsWith(tr('summaryHeader') + '\n'));
    assert.deepEqual(compacted.messages.slice(1), messages.slice(-4));
  }));
  assert.equal(aiTranslator('unknown')('role'), aiTranslator('zh-CN')('role'));
});

test('AI 侧栏切换三语后保留候选、已附加上下文与草稿，窄面板内的操作完整可见', async t => {
  let chromePath;
  try { chromePath = resolveChromePath(); } catch { return t.skip('未安装 Chrome'); }
  const srv = await launchServer();
  t.after(srv.close);
  const browser = await launchCdp({ url: srv.baseUrl, chromePath });
  t.after(() => browser.close());
  await browser.waitFor('window.__cg?.view && document.getElementById("aiBtn")');
  await browser.evaluate("document.getElementById('aiBtn').click()");
  await browser.waitFor('aiChatSelect.options.length && aiQuickModel.options.length');
  await browser.evaluate(`(() => {
    document.querySelector('[data-ai-tab="chat"]').click();
    for (const id of ['ecu.c::left', 'ecu.c::right']) {
      document.dispatchEvent(new CustomEvent('cg:selection-changed', { detail: { kind: 'node', id, name: id.split('::')[1] } }));
      aiPinSelection.click();
    }
    aiPromptInput.value = '保留我的问题';
    aiPromptInput.dispatchEvent(new Event('input'));
    aiBaseUrl.value = 'https://draft.example/v1';
  })()`);
  for (const [width, drawerWidth] of [[320, 296], [390, 366], [575, 551], [1024, 340]]) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 840, deviceScaleFactor: 1, mobile: false });
    await browser.evaluate('aiDrawer.style.width = ' + JSON.stringify(drawerWidth + 'px'));
    for (const lang of ['ja', 'en', 'zh-CN']) {
      await browser.evaluate(`import('/i18n.js').then(({ setLang }) => setLang('${lang}'))`);
      const info = await browser.evaluate(`(() => {
        document.querySelector('[data-ai-tab="chat"]').click();
        return {
          status: aiChatStatus.textContent, candidate: aiSelectionText.textContent,
          pins: document.querySelectorAll('.ai-pinned-chip').length,
          chat: aiChatSelect.selectedOptions[0].textContent,
          text: aiPromptInput.value, url: aiBaseUrl.value, send: aiSendChat.textContent,
        };
      })()`);
      const tr = await browser.evaluate(`import('/i18n.js').then(({ t }) => [t('ai.pin.added', { n: 2 }), t('ai.thread.new'), t('ai.send')])`);
      assert.deepEqual([info.status, info.chat, info.send], [tr[0], tr[1] + ' (0)', tr[2]]);
      assert.deepEqual([info.pins, info.text, info.url], [2, '保留我的问题', 'https://draft.example/v1']);
      assert.match(info.candidate, /right/);
      for (const pane of ['chat', 'api', 'mcp', 'guide']) {
        const issues = await browser.evaluate(`(() => {
          document.querySelector('[data-ai-tab="${pane}"]').click();
          const drawer = aiDrawer.getBoundingClientRect();
          const controls = aiDrawer.querySelectorAll('button, .ai-form label, .ai-tabs, .fsel-btn > span, .ai-chat-status, .ai-guide-card');
          return [...controls].filter(el => {
            if (!el.offsetWidth || !el.offsetHeight) return false;
            const r = el.getBoundingClientRect();
            return r.left < drawer.left - 1 || r.right > drawer.right + 1 ||
              el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2;
          }).map(el => el.id || el.textContent);
        })()`);
        assert.deepEqual(issues, [], [lang, width, drawerWidth, pane].join(' '));
      }
      assert.ok(await browser.evaluate("document.querySelectorAll('#aiPaneGuide [data-i18n-rich] code').length > 0"));
    }
  }
});

test('浏览器三语输入、快捷指令、只读子调查、压缩和错误后的撤销共用本轮语言', async t => {
  try { resolveChromePath(); } catch (err) { return t.skip(err.message); }
  const srv = await launchServer();
  t.after(srv.close);
  const requests = [];
  const replies = [];
  const mock = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify({ data: [{ id: 'local' }] }));
    let raw = '';
    for await (const part of req) raw += part;
    requests.push(JSON.parse(raw));
    const reply = replies.shift();
    res.statusCode = reply?.status ?? (reply ? 200 : 500);
    res.end(JSON.stringify(reply?.error ? { error: { message: reply.error } } : { choices: [{ message: reply?.message }] }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => mock.close(resolve)));
  const post = (route, data) => fetch(srv.baseUrl + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  assert.ok((await post('/api/ai/config', { baseUrl: 'http://127.0.0.1:' + mock.address().port, model: 'local', toolMode: 'auto', subagentEnabled: true })).ok);
  const browser = await launchCdp({ url: srv.baseUrl });
  t.after(() => browser.close());
  await browser.waitFor('Boolean(window.__cg?.view?.projectId)');
  await browser.evaluate('aiBtn.click()');
  await browser.waitFor("aiModel.value === 'local' && aiChatSelect.options.length > 0");
  const answer = content => ({ message: { content } });
  const tool = (name, args) => ({ message: { tool_calls: [{
    id: 'read-or-save', type: 'function', function: { name, arguments: JSON.stringify(args) },
  }] } });
  const input = text => browser.evaluate("aiPromptInput.value = " + JSON.stringify(text) +
    "; aiPromptInput.dispatchEvent(new Event('input', {bubbles:true})); aiSendChat.click()");
  const finished = text => browser.waitFor("!aiSendChat.classList.contains('steering') && document.querySelector('.ai-msg.assistant:last-child .ai-msg-text')?.textContent.includes(" + JSON.stringify(text) + ")");
  for (const language of SUPPORTED_LANGS) await t.test(language, async () => {
    const tr = aiTranslator(language);
    await browser.evaluate('styleBtn.click()');
    await browser.waitFor("document.querySelector('#styleModal.show [data-language]')");
    await browser.evaluate("document.querySelector('[data-language=\"" + language + "\"]').click(); document.querySelector('[data-close=\"styleModal\"]').click(); aiNewChat.click()");
    assert.equal(await browser.evaluate('document.documentElement.lang'), language);
    const prompt = { 'zh-CN': '请查看 gear.c::Gear_Init 的调用者。', ja: 'gear.c::Gear_Init の呼び出し元を確認してください。', en: 'Check the callers of gear.c::Gear_Init.' }[language];
    const goal = 'Read gear.c::Gear_Init';
    const result = 'Result ' + language;
    replies.push(tool('run_subagent', { tasks: [{ title: 'Gear', goal }] }), { status: 400, error: 'tools not supported' }, answer('Gear OK'), answer(result));
    await input(prompt);
    await finished(result);
    assert.equal(requests.length, 4);
    const [main, sub, legacy, resumed] = requests.splice(0);
    assert.ok(main.messages[0].content.includes(tr('language')));
    assert.equal(main.messages.at(-1).content, prompt);
    const schema = main.tools.find(item => item.function.name === 'present_logic').function;
    assert.equal(schema.parameters.properties.direction.description, tr('tool.present_logic.direction'));
    assert.equal(resumed.messages.at(-1).role, 'tool');
    assert.ok(sub.messages[0].content.includes(tr('subRole')));
    assert.ok(sub.messages.at(-1).content.includes(goal));
    assert.deepEqual(sub.tools.map(item => item.function.name).sort(), [...SUBAGENT_READONLY_TOOLS].sort());
    assert.ok(legacy.messages[0].content.includes(tr('subRole')) && legacy.messages[0].content.includes(tr('toolFormat')));
    assert.ok(legacy.messages[0].content.includes(tr('tool.read_source')));
    assert.ok(!legacy.messages[0].content.includes(tr('tool.manage_bookmarks')));
    assert.equal(legacy.tools, undefined);

    replies.push(answer('Quick ' + language));
    await browser.evaluate("document.querySelector('[data-ai-quick=\"build\"]').click()");
    await finished('Quick ' + language);
    assert.equal(requests.length, 1);
    const [quick] = requests.splice(0);
    assert.equal(quick.messages.at(-1).content, await browser.evaluate("import('/i18n.js').then(m => m.t('ai.quickPrompt.build'))"));
    replies.push(answer('Follow-up ' + language));
    await input('gear.c?');
    await finished('Follow-up ' + language);
    requests.splice(0);
    replies.push(answer('Summary ' + language));
    await browser.evaluate('aiCompactChat.click()');
    await browser.waitFor("document.querySelector('#aiMessages')?.textContent.includes(" + JSON.stringify('Summary ' + language) + ")");
    assert.equal(requests.length, 1);
    const [compact] = requests.splice(0);
    assert.equal(compact.messages[0].content, tr('compact'));
    assert.ok(compact.messages.at(-1).content.includes(prompt));

    const name = 'Gear-' + language;
    replies.push(tool('manage_bookmarks', { action: 'save', name }), { status: 500, error: 'fixture model error' });
    await input({ 'zh-CN': '请保存书签 ', ja: '次のブックマークを保存してください：', en: 'Save bookmark ' }[language] + name);
    await finished('500');
    assert.equal(requests.splice(0).length, 2);
    const list = () => fetch(srv.baseUrl + '/api/bookmarks').then(r => r.json()).then(r => r.list);
    const bookmark = (await list()).find(b => b.name === name);
    assert.ok(bookmark);
    assert.ok((await post('/api/bookmarks/update', { id: bookmark.id, expectedRevision: bookmark.revision, down: 7 })).ok);
    const edited = await list();
    await browser.evaluate("document.querySelector('.ai-msg.error:last-child .ai-undo-btn').click()");
    await browser.waitFor("aiChatStatus.textContent.includes(" + JSON.stringify(tr('undo.conflict')) + ")");
    assert.deepEqual(await list(), edited);
    assert.equal(replies.length, 0);
  });
});
