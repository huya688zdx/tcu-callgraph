import test from 'node:test';
import assert from 'node:assert/strict';
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
