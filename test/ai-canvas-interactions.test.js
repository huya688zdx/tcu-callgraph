import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
