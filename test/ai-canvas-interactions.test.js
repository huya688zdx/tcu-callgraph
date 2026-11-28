import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchServer } from '../scripts/lib/server.mjs';
import { launchCdp, resolveChromePath } from '../scripts/lib/cdp.mjs';

test('浏览器中的 AI 链路、数据流上下文与跨窗口书签', async t => {
  try { resolveChromePath(); } catch (err) { t.skip(err.message); return; }
  const srv = await launchServer();
  t.after(srv.close);
  const post = async (route, data) => (await fetch(srv.baseUrl + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })).json();
  const from = 'logic.c::dispatch', to = 'logic.c::worker';
  const pair = from + '->' + to;
  const steps = [{ id: from }, { id: to }];
  const chains = [
    { id: 'down:example', title: '精确路径', steps, edgeKeys: [pair + ':20'] },
    { id: 'pres_edge:' + pair + ':10', title: '旧调用点', steps },
    { id: 'legacy-path', title: '旧端点路径', steps },
  ];
  const presentation = { title: '顺序', steps: [
    { title: '第一次', nodeIds: [from], edgeKeys: [pair + ':10'] },
    { title: '第二次', nodeIds: [to], edgeKeys: [pair + ':20'] },
  ] };
  await post('/api/ai/config', { baseUrl: srv.baseUrl + '/v1', model: 'fixture' });
  await post('/api/ai/chats', { activeId: 'history', threads: [{ id: 'history', messages: [
    { role: 'assistant', text: '调用位置', chains, presentation },
  ] }] });
  const browser = await launchCdp({ url: srv.baseUrl });
  t.after(() => browser.close());
  await browser.waitFor('Boolean(window.__cg?.view)');
  await browser.evaluate("document.getElementById('aiBtn').click()");
  await browser.waitFor("document.querySelectorAll('.ai-chain-card').length === 3");

  await t.test('高亮和动画区分相同端点的两处调用，切换导览后清除上一步', async () => {
    const result = await browser.evaluate(`(async () => {
      const { state, cam, els } = await import('/lib/state.js');
      const { draw } = await import('/lib/render.js');
      const { stopCamAnim } = await import('/lib/camera.js');
      // 分开两条线，直接采样描边外圈，避免共线路由掩盖误高亮。
      const ids = ${JSON.stringify([from, to])};
      Object.assign(state.view, {
        nodes: ids.map((id, i) => ({ id, name: id.split('::')[1], x: i * 200, y: 40, w: 80, h: 32 })),
        edges: [10, 20].map((line, i) => ({ from: ids[0], to: ids[1], kind: 'direct', line,
          points: [[80, 80 + i * 40], [200, 80 + i * 40]] })),
        groups: [], containers: [], width: 320, height: 180,
      });
      const colors = () => {
        stopCamAnim();
        Object.assign(cam, { x: 0, y: 0, k: 1 });
        draw();
        return [80, 120].map(y => {
          const [r, g, b, a] = els.ctx.getImageData(140 * devicePixelRatio, (y + 2) * devicePixelRatio, 1, 1).data;
          return a > 100 && b > r && b > g;
        });
      };
      const cards = [...document.querySelectorAll('.ai-chain-card')];
      const click = (title, button) => {
        const card = cards.find(el => el.querySelector('.ai-chain-title').textContent.endsWith(title));
        card.querySelectorAll('.ai-chain-actions button')[button].click();
        return colors();
      };
      const exact = click('精确路径', 0), animated = click('精确路径', 1);
      const action = state.aiOverlay.action;
      const oldSite = click('旧调用点', 0), oldPath = click('旧端点路径', 0);
      document.querySelector('.ai-pres-card button').click();
      const first = colors();
      document.getElementById('aiPresNext').click();
      const second = colors();
      const counter = document.getElementById('aiPresHudCounter').textContent;
      document.getElementById('aiPresClose').click();
      return { exact, animated, action, oldSite, oldPath, first, second, counter };
    })()`);
    assert.deepEqual(result, {
      exact: [false, true], animated: [false, true], action: 'play_flow',
      oldSite: [true, false], oldPath: [true, true], first: [true, false], second: [false, true], counter: '2/2',
    });
  });

  await t.test('从数据流面板加入对话后，快捷问题和发出的上下文使用真实函数 ID', async () => {
    const sent = await browser.evaluate(`(async () => {
      const { api } = await import('/lib/api.js');
      const { analyseDataflow } = await import('/lib/df.js');
      const id = ${JSON.stringify(to)};
      // 固定查询结果和模型传输，仅考察用户从面板到快捷问题的交互。
      api.dataflow = async () => ({ fn: { id, name: 'worker', file: 'logic.c' }, vars: [], edges: [] });
      await analyseDataflow(id);
      document.querySelector('#secDataflow [data-df="askAi"]').click();
      const send = new Promise(resolve => {
        api.aiChat = async payload => {
          resolve(payload);
          return new Response(JSON.stringify({ type: 'done', answer: '已处理。' }) + '\\n');
        };
      });
      [...document.querySelectorAll('#aiSelectionQuestions button')].find(b => b.textContent === '呈示交互大图').click();
      return await send;
    })()`);
    assert.ok(sent.prompt.includes('「' + to + '」'), sent.prompt);
    assert.deepEqual(sent.uiContext.items.map(({ targetId, targetName, dir }) => [targetId, targetName, dir]),
      [[to, 'worker', 'both']]);
  });

  await t.test('远端更新后再改名，当前窗口保存旧作用域时收到冲突', async () => {
    const { bookmark } = await post('/api/bookmarks', { name: '基线', roots: [from] });
    await browser.evaluate(`(async () => {
      const { state, scopeFingerprint } = await import('/lib/state.js');
      const bm = ${JSON.stringify(bookmark)};
      state.roots = bm.roots;
      state.activeBookmark = { id: bm.id, name: bm.name, revision: bm.revision, baseFingerprint: scopeFingerprint(bm) };
    })()`);
    const revision = "(await import('/lib/state.js')).state.activeBookmark";
    await post('/api/bookmarks/rename', { id: bookmark.id, name: '纯改名' });
    await browser.waitFor(`(async () => (${revision}).revision === 2)()`);
    await post('/api/bookmarks/update', { id: bookmark.id, expectedRevision: 2, roots: [to] });
    await post('/api/bookmarks/rename', { id: bookmark.id, name: '已改范围' });
    await browser.waitFor(`(async () => (${revision}).name === '已改范围')()`);
    assert.equal(await browser.evaluate(`(async () => (${revision}).revision)()`), 2);
    await browser.evaluate("document.getElementById('bookmarkBtn').click()");
    await browser.waitFor("Boolean(document.querySelector('.bm.is-active .bm-update'))");
    await browser.evaluate("document.querySelector('.bm.is-active .bm-update').click()");
    await browser.waitFor("Boolean(document.querySelector('#bookmarkFeedback.error'))");
    const { list } = await (await fetch(srv.baseUrl + '/api/bookmarks')).json();
    assert.deepEqual(list.find(b => b.id === bookmark.id).roots, [to]);
  });
});

test('浏览器悬停 AI 链路节点时只为对应画布节点描边，离开和切换工程会清除', async t => {
  try { resolveChromePath(); } catch (err) { t.skip(err.message); return; }
  const srv = await launchServer();
  t.after(srv.close);
  const post = async (route, data) => {
    const res = await fetch(srv.baseUrl + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.ok(res.ok, route);
    return res.json();
  };
  const main = 'main.c::main', gear = 'gear.c::Gear_Init';
  const scope = { roots: [main], up: 0, down: 1, group: false };
  // 两个真实工程都有 main.c::main。旧工程的悬停若泄漏，会在新工程的同名框上出现。
  const next = await post('/api/switch', { path: path.resolve('samples/demo') });
  await post('/api/page', scope);
  await post('/api/switch', { path: path.resolve('samples/tcu') });
  await post('/api/page', scope);
  await post('/api/ai/config', { baseUrl: srv.baseUrl + '/v1', model: 'fixture' });
  await post('/api/ai/chats', { activeId: 'hover', threads: [{ id: 'hover', messages: [{
    role: 'assistant', text: '调用链', chains: [{ id: 'start', steps: [{ id: main }, { id: gear }] }],
  }] }] });

  const br = await launchCdp({ url: srv.baseUrl });
  t.after(() => br.close());
  await br.waitFor('window.__cg?.view?.nodes.some(n => n.id === ' + JSON.stringify(gear) + ')');
  await br.evaluate("document.getElementById('aiBtn').click()");
  await br.waitFor("document.querySelectorAll('.ai-chain-node').length === 2");
  await br.evaluate("Promise.all(document.getElementById('aiDrawer').getAnimations().map(a => a.finished))");
  const moveTo = async selector => {
    const pos = await br.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({block:'nearest'});
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await br.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pos });
    assert.ok(await br.evaluate("document.querySelector(" + JSON.stringify(selector) + ").matches(':hover')"), selector);
  };
  const outlines = (...ids) => br.evaluate(`(() => {
    const { view, cam } = window.__cg;
    const ctx = document.getElementById('cv').getContext('2d');
    return ${JSON.stringify(ids)}.map(id => {
      const n = view.nodes.find(n => n.id === id), d = devicePixelRatio;
      const x = Math.round((cam.x + (n.x + n.w / 2) * cam.k) * d);
      const y = Math.round((cam.y + n.y * cam.k) * d);
      // 取节点上边框中央的一段像素，避开圆角、连线和文本。
      const pixels = ctx.getImageData(x - 8, y - 3, 16, 7).data;
      let painted = false;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] <= 200) continue;
        painted = true;
        if (pixels[i + 2] - pixels[i] > 100 && pixels[i + 2] - pixels[i + 1] > 100) return true;
      }
      if (!painted) throw new Error('看不到节点边框 ' + id);
      return false;
    });
  })()`);
  const first = '.ai-chain-node:first-child', last = '.ai-chain-node:last-child';
  assert.deepEqual(await outlines(main, gear), [false, false]);
  await moveTo(first);
  assert.deepEqual(await outlines(main, gear), [true, false], '只高亮第一步的画布边框');
  await moveTo(last);
  assert.deepEqual(await outlines(main, gear), [false, true], '悬停转移到第二步');
  await moveTo('.ai-chain-title');
  assert.deepEqual(await outlines(main, gear), [false, false], '离开芯片后两处恢复原描边');
  await moveTo(first);
  assert.deepEqual(await outlines(main), [true]);
  // 切换对话会移除芯片，即使指针不动也不能遗留高亮。
  await br.evaluate("document.getElementById('aiNewChat').click()");
  await br.waitFor("!document.querySelector('.ai-chain-node')");
  assert.deepEqual(await outlines(main), [false]);
  await br.evaluate("const sel = document.getElementById('aiChatSelect'); sel.value = 'hover'; sel.dispatchEvent(new Event('change'))");
  await moveTo('.ai-chain-title');
  await moveTo(first);
  assert.deepEqual(await outlines(main), [true]);
  // 用工程选择器切换而不移动指针，避免 mouseleave 代替工程清理。
  await br.evaluate(`document.getElementById('projectBtn').click();
    document.getElementById('projectPath').value = ${JSON.stringify(path.resolve('samples/demo'))};
    document.getElementById('projectOpen').click();`);
  await br.waitFor('window.__cg.view?.projectId === ' + next.project.id + ' && window.__cg.view.nodes.some(n => n.id === ' + JSON.stringify(main) + ')');
  assert.deepEqual(await outlines(main), [false], '新工程中同 ID 节点使用普通描边');
});

test('浏览器延迟书签保存回复时保留当前画布绑定', async t => {
  try { resolveChromePath(); } catch (error) { t.skip(error.message); return; }
  const modes = ['快速保存', '版本冲突', '切换工程', '面板更新', '另存书签', '重开同一书签', '原绑定的版本冲突',
    '保存期间继续编辑', '连续两次快速保存', '面板更新期间继续编辑', '排队保存后切换书签'];
  for (const mode of modes) await t.test(mode, async t => {
    const conflict = mode.includes('冲突');
    const panelUpdate = mode.startsWith('面板更新');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bookmark-reply-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const [one, two] = ['one','two'].map(name => {
      const root = path.join(dir, name);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'main.c'), ['a','a_edit','b','b_edit'].map(n => 'void ' + n + '(void) {}').join('\n'));
      return root;
    });
    const srv = await launchServer({ target: one }); t.after(srv.close);
    const get = route => fetch(srv.baseUrl + route).then(r => r.json());
    const post = (route, data) => fetch(srv.baseUrl + route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data) }).then(r => r.json());
    const scope = n => ({ roots: ['main.c::' + n], up: 0, down: 0 });
    const create = (name, n) => post('/api/bookmarks', { name, ...scope(n) }).then(r => r.bookmark);
    const find = async name => (await get('/api/bookmarks')).list.find(b => b.name === name);
    const a = await create('A','a');
    let b = mode === '切换工程' ? null : await create('B','b');
    await post('/api/page', scope('a'));
    const br = await launchCdp({ url: srv.baseUrl }); t.after(() => br.close());
    await br.waitFor('window.__cg?.root === "main.c::a"');
    await br.evaluate("(async () => { window.bmState = (await import('/lib/state.js')).state; })()");
    const row = name => `[...document.querySelectorAll('.bm')].find(r => r.querySelector('.nm').firstChild.textContent.trim() === ${JSON.stringify(name)})`;
    const open = async bookmark => {
      await br.evaluate("document.getElementById('bookmarkBtn').click()");
      await br.waitFor(`Boolean(${row(bookmark.name)})`);
      await br.evaluate(`${row(bookmark.name)}.querySelector('.bm-open').click()`);
      await br.waitFor(`window.bmState.activeBookmark?.id === ${bookmark.id} && !document.querySelector('.modal.show')`);
    };
    const navigate = async n => {
      await br.evaluate(`(async () => { await (await import('/lib/hooks.js')).hooks.openFunctionAlone(${JSON.stringify(scope(n).roots[0])}); })()`);
      await br.waitFor(`window.__cg.root === ${JSON.stringify(scope(n).roots[0])}`);
    };
    const quick = () => br.pressKey({ key: 's', code: 'KeyS', vk: 83, modifiers: 2 });
    const project = async root => {
      const previous = await br.evaluate('window.__cg.view.projectId');
      await br.evaluate(`document.getElementById('projectBtn').click(); document.getElementById('projectPath').value = ${JSON.stringify(root)}; document.getElementById('projectOpen').click()`);
      await br.waitFor(`window.__cg?.view?.projectId && window.__cg.view.projectId !== ${previous} && !document.querySelector('.modal.show')`);
    };
    await open(a);
    await navigate('a_edit');
    if (conflict) {
      await br.evaluate("window.addEventListener('cg:bookmark-changed', e => { if (e.detail.remote) window.remoteUpdate = true; })");
      const result = await post('/api/bookmarks/update', { id:a.id, expectedRevision:a.revision, ...scope('a') });
      assert.ok(result.ok, result.error);
      await br.waitFor('window.remoteUpdate');
    }
    await br.evaluate(`(async () => {
      const { api } = await import('/lib/api.js');
      const key = ${JSON.stringify(mode === '另存书签' ? 'saveBookmark' : 'updateBookmark')};
      const save = api[key];
      const gate = new Promise(resolve => { window.releaseSave = resolve; });
      window.alerts = []; window.alert = text => window.alerts.push(text);
      api[key] = async (...args) => {
        api[key] = save;
        const response = await save(...args);
        window.heldSave = { ok: response.ok, conflict: !!response.conflict };
        await gate;
        return response;
      };
    })()`);
    if (panelUpdate || mode === '另存书签') {
      await br.evaluate("document.getElementById('bookmarkBtn').click()");
      await br.waitFor(`Boolean(${row('B')})`);
      if (panelUpdate) await br.evaluate(`${row('A')}.querySelector('.bm-update').click()`);
      else await br.evaluate("document.getElementById('bookmarkName').value = 'C'; document.getElementById('bookmarkSave').click()");
    } else await quick();
    await br.waitFor('Boolean(window.heldSave)');
    assert.equal(await br.evaluate('window.heldSave.conflict'), conflict);
    const savedName = mode === '另存书签' ? 'C' : 'A';
    const submitted = await find(savedName);
    assert.deepEqual(submitted.roots, scope(conflict ? 'a' : 'a_edit').roots);
    if (mode.includes('继续编辑') || mode === '连续两次快速保存') {
      const parallel = mode === '连续两次快速保存';
      if (panelUpdate) await br.evaluate("(async () => (await import('/lib/modal.js')).closeModal())()");
      await navigate('b_edit');
      const fingerprint = await br.evaluate(`(async () => (await import('/lib/state.js')).scopeFingerprint(${JSON.stringify(submitted)}))()`);
      await br.evaluate(`(async () => {
        const { api } = await import('/lib/api.js'), update = api.updateBookmark;
        api.updateBookmark = async body => {
          const res = await update(body);
          window.secondSave = { expected: body.expectedRevision, roots: body.roots, ok: res.ok };
          return res;
        };
        document.activeElement.blur();
      })()`);
      if (parallel) {
        await quick();
        await navigate('b'); // 第二次 Ctrl+S 提交的应当是按键时的 b_edit。
      }
      await br.evaluate("window.releaseSave(); new Promise(resolve => setTimeout(resolve, 0))");
      if (!parallel) {
        const active = await br.evaluate("window.bmState.activeBookmark");
        assert.deepEqual([active.id, active.revision, active.baseFingerprint], [a.id, submitted.revision, fingerprint]);
        assert.ok(await br.evaluate("document.getElementById('bookmarkQuickSave').classList.contains('dirty')"));
        assert.deepEqual((await find('A')).roots, scope('a_edit').roots);
        await quick();
      }
      await br.waitFor('Boolean(window.secondSave)');
      assert.deepEqual(await br.evaluate('window.secondSave'), { expected: submitted.revision, roots: scope('b_edit').roots, ok: true });
      const last = await find('A');
      assert.equal(last.revision, submitted.revision + 1);
      assert.deepEqual(last.roots, scope('b_edit').roots);
      await br.waitFor(`window.bmState.activeBookmark.revision === ${last.revision}`);
      assert.deepEqual(await br.evaluate("window.alerts"), []);
      assert.equal(await br.evaluate("document.getElementById('bookmarkQuickSave').classList.contains('dirty')"), parallel);
      assert.deepEqual((await find('B')).roots, scope('b').roots);
      return;
    }
    if (mode === '原绑定的版本冲突') {
      await br.evaluate('window.releaseSave()');
      await br.waitFor("window.alerts.length === 1 && document.querySelector('#bookmarkModal.show')");
      assert.equal(await br.evaluate('window.bmState.activeBookmark.id'), a.id);
      assert.deepEqual(await find('A'), submitted);
      return;
    }
    if (mode === '排队保存后切换书签') {
      await navigate('b_edit');
      await quick();
    }
    if (mode === '切换工程') { await project(two); b = await create('B','b'); }
    if (panelUpdate || mode === '另存书签') {
      await br.evaluate(`${row('B')}.querySelector('.bm-open').click()`);
      await br.waitFor(`window.bmState.activeBookmark?.id === ${b.id} && !document.querySelector('.modal.show')`);
    } else await open(b);
    if (mode === '重开同一书签') { await open(submitted); b = submitted; }
    await navigate('b_edit');
    await br.evaluate(`window.bindingBeforeRelease = window.bmState.activeBookmark; window.followUpPages = []; window.followUpBookmarkEvents = [];
      window.addEventListener('cg:bookmark-changed', e => window.followUpBookmarkEvents.push(e.detail?.bookmark?.name));
      (async () => {
        const { api } = await import('/lib/api.js'), report = api.reportPage;
        api.reportPage = page => { window.followUpPages.push(page.activeBookmark?.id); return report(page); };
        window.releaseSave(); await new Promise(resolve => setTimeout(resolve, 0));
      })()`);
    const received = await br.evaluate(`({ id: window.bmState.activeBookmark?.id, revision: window.bmState.activeBookmark?.revision,
      alerts: window.alerts.slice(), panel: !!document.querySelector('#bookmarkModal.show'),
      events: window.followUpBookmarkEvents.slice(), unchangedBinding: window.bmState.activeBookmark === window.bindingBeforeRelease,
      reports: window.followUpPages.slice() })`);
    assert.deepEqual(received.alerts, [], '过期冲突不能触发当前画布的警告');
    assert.equal(received.panel, false, '过期冲突不能打开当前画布的书签面板');
    await br.evaluate(`(async () => {
      const { api } = await import('/lib/api.js'), update = api.updateBookmark;
      api.updateBookmark = async body => { const res = await update(body); window.nextSaveId = body.id; return res; };
    })()`);
    await quick();
    // 真实后续 Ctrl+S 写入完成后再读取目标书签。
    await br.waitFor('Boolean(window.nextSaveId)');
    const finalB = await find(b.name);
    if (mode === '切换工程') await project(one);
    const finalA = await find(savedName);
    if (mode !== '重开同一书签') {
      assert.deepEqual({ savedRoots: finalA.roots, nextRoots: finalB.roots },
        { savedRoots: submitted.roots, nextRoots: scope('b_edit').roots }, '两次保存应分别落到各自的书签');
      assert.deepEqual(finalA, submitted);
      assert.ok(!received.reports.includes(a.id), '旧回复不能把新的范围以 A 的绑定上报');
    }
    assert.deepEqual(finalB.roots, scope('b_edit').roots);
    assert.equal(finalB.revision, b.revision + 1);
    assert.deepEqual([received.id, received.revision, received.events], [b.id, b.revision, []]);
    assert.ok(received.unchangedBinding, '过期回复不能重新绑定同一 ID 的新视图');
  });
});
