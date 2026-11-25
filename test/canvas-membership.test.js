import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchCdp, resolveChromePath } from '../scripts/lib/cdp.mjs';
import { launchServer } from '../scripts/lib/server.mjs';

const file = 'main, & 台.c';
const fn = (name) => `${file}::${name}`;
const special = `var::${file}::g_special`;
const varIds = [special, 'var::g_count', 'var::g_const', 'var::g_pick'];
const varNodes = (view) => view.nodes.filter((node) => node.kind === 'var').map((node) => node.id).sort();

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-canvas-membership-'));
  let server;
  t.after(async () => { await server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, file), `
typedef struct { int value; } State;
static State g_special;
int g_count, g_pick;
const int g_const = 1;
void b(void) { g_count++; }
void d(void) { g_special.value = g_const; }
void c(void) { g_count = g_pick; d(); }
void a(void) { g_pick++; b(); c(); }
`);
  server = await launchServer({ target: dir });
  const request = async (url, body) => {
    const response = await fetch(server.baseUrl + url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, 200, `${url} ${JSON.stringify(data.error || '')}`);
    return data;
  };
  return { baseUrl: server.baseUrl, request };
}

test('变量清单与构图使用同一 ID，支持逗号路径、删除空位、纯变量视图和历史', async (t) => {
  const { request } = await fixture(t);
  const coldRoot = await request(`/api/view?root=${encodeURIComponent(special)}&up=0&down=0`);
  assert.deepEqual(varNodes(coldRoot), [special], 'AST 自定义类型变量也可以直接作为入口');
  const globals = (await request('/api/vars')).list;
  assert.deepEqual(globals.map((item) => item.id).sort(), [...varIds].sort());
  assert.ok(globals.every((item) => item.file === file));
  const url = '/api/view?up=0&down=0';
  const scope = { roots: [fn('a')], vars: varIds };
  const before = await request(url, scope);
  assert.deepEqual(varNodes(before), [...varIds].sort());
  assert.ok(before.nodes.every((node) => [node.x, node.y, node.w, node.h].every(Number.isFinite)));
  const skipped = await request(url, { ...scope, hiddenVars: [special], previous: before });
  assert.deepEqual(varNodes(skipped), varIds.slice(1).sort());
  assert.ok(skipped.layoutSlots.nodes.some((node) => node.id === special));
  const readded = await request(url, { ...scope, previous: skipped });
  assert.deepEqual(readded.nodes, before.nodes, '布局空位只恢复位置，节点仍由当前请求决定');
  const legacy = await request(`${url}&root=${encodeURIComponent(fn('a'))}&vars=var%3A%3Ag_count`);
  assert.deepEqual(varNodes(legacy), ['var::g_count']);

  const { ok } = await request('/api/delete', { nodes: [fn('a'), special] });
  assert.equal(ok, true);
  const filtered = await request(url, { ...scope, vars: [...varIds, 'var::missing', fn('b')], previous: before });
  assert.deepEqual(filtered.nodes.map((node) => node.id).sort(), varIds.slice(1).sort());
  assert.equal((await request('/api/delete', { nodes: [special], restore: true })).ok, true);
  const variablesOnly = await request(url, { roots: [], vars: varIds, empty: true });
  assert.equal(variablesOnly.empty, true);
  assert.deepEqual(varNodes(variablesOnly), [...varIds].sort());
  const { eventId } = await request('/api/view-event', { op: 'view.snapshot', view: {
    roots: [], expansions: [], vars: varIds, hiddenVars: [], up: 0, down: 0, group: true, empty: true,
  } });
  const reviewed = await request(`${url}&at=${eventId}&useSnapshot=1`);
  assert.deepEqual(varNodes(reviewed), [...varIds].sort());
  assert.deepEqual((await request(`${url}&empty=1`)).nodes, []);
});

test('比较变量与清单同源，取消勾选时已在入口列表中的变量也不回流', async (t) => {
  const { baseUrl, request } = await fixture(t);
  const compare = path.resolve(import.meta.dirname, '../samples/diff');
  const { preview } = await request('/api/compare', {
    beforePath: path.join(compare, 'before'), afterPath: path.join(compare, 'after'),
  });
  const added = preview.candidates.find((node) => node.kind === 'var' && node.change === 'added');
  assert.ok(added);
  assert.equal((await request('/api/compare/apply', { previewId: preview.id, selectedIds: [added.id] })).ok, true);
  assert.ok((await request('/api/vars')).list.some((node) => node.id === added.id && node.file === added.file));
  assert.deepEqual(varNodes(await request('/api/view')), [added.id]);
  const url = '/api/view?up=0&down=0';
  const scope = { roots: [added.id], vars: [added.id] };
  const hidden = await request(url, { ...scope, hiddenVars: [added.id] });
  assert.deepEqual(hidden.nodes, []);
  const shown = await request(url, { ...scope, previous: hidden });
  assert.deepEqual(varNodes(shown), [added.id]);
  assert.equal(shown.nodes[0].change, 'added');
  const denied = await fetch(`${baseUrl}/api/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodes: [added.id], restore: true }),
  });
  assert.equal(denied.status, 409);
});

test('无头浏览器：变量勾选与入图一致，添加或定位调用关系时保留原函数详情', async (t) => {
  try { resolveChromePath(); } catch (error) { t.skip(error.message); return; }
  const { baseUrl, request } = await fixture(t);
  assert.equal((await request('/api/delete', { nodes: [special] })).ok, true);
  assert.equal((await request('/api/page', {
    roots: [fn('a')], vars: [special], selected: fn('a'), down: 0, up: 0, group: true,
    ctxBox: { kind: 'file', id: file },
  })).ok, true);
  const chrome = await launchCdp({ url: `${baseUrl}/` });
  t.after(() => chrome.close());
  const { evaluate, waitFor, click, pressKey } = chrome;
  const byId = (selector, attribute, id) => `${selector}[${attribute}=${JSON.stringify(id)}]`;
  const check = (id) => byId('#vars .var-row', 'data-id', id) + ' input';
  const relationButton = (name) => byId('#edges [data-add-function]', 'data-add-function', fn(name));
  const inView = (name) => byId('#edges .in-view', 'data-peer-id', fn(name));
  const query = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
  const select = (selector) => evaluate(`${query(selector)}.click()`);
  const detailA = `__cg.selected.node === ${JSON.stringify(fn('a'))} && ${query('#detail .detail-title')}?.textContent === 'a'`;
  const count = (n) => `__cg.view.nodes.filter(node => node.kind === 'var').length === ${n} &&
    ${query('#vars .vars-cnt')}?.textContent === '${n}/4' &&
    document.querySelectorAll('#vars .var-row input:checked').length === ${n}`;
  const deleteKey = () => pressKey({ key: 'Delete', code: 'Delete', vk: 46 });
  const undo = () => pressKey({ key: 'z', code: 'KeyZ', vk: 90, modifiers: 2 });
  const canvasPoint = (selector, point) => evaluate(`(() => {
    const box = ${selector};
    const { x, y, k } = __cg.cam;
    const r = document.getElementById('cv').getBoundingClientRect();
    return [r.left + x + (${point[0]}) * k, r.top + y + (${point[1]}) * k];
  })()`);
  const clickNode = async (id) => click(...await canvasPoint(
    `__cg.view.nodes.find(node => node.id === ${JSON.stringify(id)})`, ['box.x + box.w / 2', 'box.y + box.h / 2']));

  await waitFor(detailA);
  await select('#vars [data-load-vars]');
  await waitFor(count(0));
  await evaluate(`(() => {
    const fetchOriginal = window.fetch;
    const hold = new Promise(resolve => { window.releaseRestore = resolve; });
    window.fetch = async (url, options) => {
      if (url === '/api/delete' && JSON.parse(options.body).nodes.includes(${JSON.stringify(special)})) await hold;
      return fetchOriginal(url, options);
    };
  })()`);
  // 让第一项的恢复请求晚于另外三次点击，并在请求中反复勾选同一项。
  await evaluate(`${varIds.map((id) => `${query(check(id))}.click()`).join(';')};
    ${query(check(special))}.click(); ${query(check(special))}.click();`);
  assert.equal(await evaluate(`${query('#vars .vars-cnt')}.textContent`), '0/4');
  await evaluate('releaseRestore()');
  await waitFor(`${count(4)} && ${detailA}`);
  await evaluate(`(() => {
    const fetchOriginal = window.fetch;
    const hold = new Promise(resolve => { window.releaseOlderView = resolve; });
    window.fetch = async (url, options) => {
      const response = await fetchOriginal(url, options);
      if (url.startsWith('/api/view?') && options && JSON.parse(options.body).hiddenVars.includes(${JSON.stringify(special)})) {
        window.olderViewReady = true;
        await hold;
        const read = response.json.bind(response);
        response.json = async () => { const data = await read(); window.olderViewRead = true; return data; };
      }
      return response;
    };
    window.initialView = __cg.view;
  })()`);
  await select(check(special));
  await waitFor('window.olderViewReady');
  await select(check(special));
  await waitFor(`${count(4)} && __cg.view !== initialView`);
  await evaluate('releaseOlderView()');
  await waitFor('window.olderViewRead');
  assert.equal(await evaluate(`${count(4)} && ${detailA}`), true, '较旧的取消勾选响应不能覆盖最新视图');
  const painted = await evaluate(`(() => {
    const ctx = document.getElementById('cv').getContext('2d');
    const fillText = ctx.fillText;
    const names = new Set();
    ctx.fillText = function (name, ...args) { names.add(name); return fillText.call(this, name, ...args); };
    try { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' })); }
    finally { ctx.fillText = fillText; }
    return [...names];
  })()`);
  assert.ok(['g_special', 'g_count', 'g_const', 'g_pick'].every((name) => painted.includes(name)), painted.join(', '));

  await select(relationButton('b'));
  await select('#ctxMenu button[data-i="0"]');
  await waitFor(`${query(inView('b'))} && ${detailA}`);
  assert.equal(await evaluate(`__cg.view.edges.some(edge => edge.from === ${JSON.stringify(fn('a'))} &&
    edge.to === ${JSON.stringify(fn('b'))})`), true);
  const zoom = await evaluate('__cg.cam.k');
  await select(inView('b'));
  await waitFor(`__cg.flash === ${JSON.stringify(fn('b'))} && ${detailA}`);
  await select(relationButton('b'));
  await select('#ctxMenu button[data-i="0"]');
  assert.equal(await evaluate(`__cg.flash === ${JSON.stringify(fn('b'))} && ${detailA} && __cg.cam.k === ${zoom}`), true);

  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }))");
  await clickNode('var::g_pick');
  await waitFor(`__cg.selected.node === 'var::g_pick'`);
  await deleteKey();
  await waitFor(count(3));
  assert.equal((await request('/api/node?id=var%3A%3Ag_pick')).hidden, true);
  await undo();
  await waitFor(count(4));
  assert.equal((await request('/api/node?id=var%3A%3Ag_pick')).hidden, false);
  await clickNode('var::g_pick');
  await deleteKey();
  await waitFor(count(3));

  await clickNode(fn('a'));
  await waitFor(detailA);
  await select(relationButton('c'));
  await select('#ctxMenu button[data-i="1"]');
  await select('#addFunctionsControls [data-scope-depth="1"]');
  const pickVar = '#addFunctionsList input[data-var-id="var::g_pick"]';
  const pickD = byId('#addFunctionsList input', 'data-function-id', fn('d'));
  await waitFor(`${query(pickVar)} && ${query(pickD)}?.checked`);
  await select(pickVar);
  await select('#addFunctionsApply');
  await waitFor(`${query(inView('c'))} && ${detailA} && ${count(4)} && !${query('#addFunctionsModal')}.classList.contains('show')`);
  assert.equal(await evaluate(`__cg.view.nodes.some(node => node.id === ${JSON.stringify(fn('d'))})`), true);
  assert.equal((await request('/api/node?id=var%3A%3Ag_pick')).hidden, false, '关系预览也解除变量删除标记');

  const point = await canvasPoint('__cg.view.groups[0]', ['box.x + 15', 'box.y + 12']);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await chrome.send('Input.dispatchMouseEvent', { type, x: point[0], y: point[1], button: 'left', clickCount: 2 });
  }
  await deleteKey();
  await waitFor(`${count(0)} && __cg.view.nodes.length === 0`);
  await undo();
  await waitFor(`${count(4)} && __cg.view.nodes.length === 8`);

  await clickNode(fn('a'));
  await waitFor(detailA);
  assert.equal((await request('/api/delete', { nodes: [special], actor: 'ai' })).ok, true);
  await waitFor(`${count(3)} && ${detailA}`);
  await select(check(special));
  await waitFor(`${count(4)} && ${detailA}`);
  await waitFor(`(async () => (await (await fetch('/api/page?saved=1')).json()).page?.vars.length === 4)()`);
  await chrome.send('Page.reload');
  await waitFor(detailA);
  await select('#vars [data-load-vars]');
  await waitFor(count(4));
  await select('#clearCanvas');
  await waitFor('__cg.view.empty && !__cg.view.nodes.length');
  await evaluate(`(() => {
    const search = document.getElementById('search');
    search.value = 'a';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const searchA = byId('#results [data-add-function]', 'data-add-function', fn('a'));
  await waitFor(query(searchA));
  await select(searchA);
  await select('#ctxMenu button[data-i="0"]');
  await waitFor(detailA);
});

test('无头浏览器：撤销与重做手工连线增量存档并保留视图之外的连线', async t => {
  try { resolveChromePath(); } catch (error) { t.skip(error.message); return; }
  const { baseUrl, request } = await fixture(t);
  const root = fn('a');
  const outside = { from: fn('b'), to: fn('d') };
  const original = { from: root, to: fn('b') };
  const changed = { from: root, to: fn('c') };
  await request('/api/layout', { root, mode: 'group', addManual: [outside] });
  await request('/api/page', { roots: [root], up: 0, down: 1, group: true });
  const chrome = await launchCdp({ url: `${baseUrl}/` });
  t.after(() => chrome.close());
  const { evaluate, waitFor } = chrome;
  const snapshot = async () => {
    const archive = await request('/api/session/export');
    return archive.overlay.layout[`${root}::group`].manual;
  };
  await waitFor(`__cg.view?.nodes.some(n => n.id === ${JSON.stringify(original.to)})`);
  const checkWrites = (commands, expected) => evaluate(`(async () => {
    const h = await import('/lib/history.js');
    const { api } = await import('/lib/api.js');
    const { state } = await import('/lib/state.js');
    const persist = api.layout;
    const writes = [];
    api.layout = (patch) => {
      const pending = persist(patch);
      writes.push(pending);
      return pending;
    };
    try {
      const original = ${JSON.stringify(original)};
      const changed = ${JSON.stringify(changed)};
      const reconnect = (id) => {
        const edge = state.view.edges.find(edge => edge.manual);
        const hover = state.view.nodes.find(node => node.id === id);
        const y = edge.toSide === 'top' ? hover.y + hover.h : hover.y;
        state.dragEnd = { edge, which: 'to', hover, pos: { x: hover.x + hover.w / 2, y } };
        document.getElementById('cv').dispatchEvent(new PointerEvent('pointerup'));
      };
      ${commands}
      await Promise.all(writes);
      return state.view.edges.filter(edge => edge.manual).map(({ from, to }) => ({ from, to }));
    } finally {
      api.layout = persist;
    }
  })()`).then(edges => assert.deepEqual(edges, expected));

  await checkWrites('await h.addManualEdge(original.from, original.to);', [original]);
  assert.deepEqual(await snapshot(), [outside, original]);
  await checkWrites('h.undo();', []);
  assert.deepEqual(await snapshot(), [outside]);
  await checkWrites('h.redo();', [original]);
  assert.deepEqual(await snapshot(), [outside, original]);
  await checkWrites('reconnect(original.to);', [original]);
  assert.deepEqual(await snapshot(), [outside, original], '同节点换端口不能删除已存关系');
  const reloaded = await request(`/api/view?root=${encodeURIComponent(root)}&up=0&down=1&group=1`);
  assert.ok(reloaded.edges.some(edge => edge.manual && edge.from === root && edge.to === original.to));

  await checkWrites('reconnect(changed.to);', [changed]);
  await checkWrites('h.undo();', [original]);
  assert.deepEqual(await snapshot(), [outside, original]);
  await checkWrites('h.redo();', [changed]);
  assert.deepEqual(await snapshot(), [outside, changed]);
  await checkWrites('h.undo(); h.redo(); h.undo();', [original]);
  assert.deepEqual(await snapshot(), [outside, original]);

  await checkWrites(`
    const pending = h.addManualEdge(changed.from, changed.to);
    h.undo();
    await pending;
  `, [original]);
  assert.deepEqual(await snapshot(), [outside, original], '新增尚未返回时也可以撤销');

  await checkWrites(`
    const cv = document.getElementById('cv');
    const edge = { ...state.view.edges.find(edge => edge.manual) };
    const hover = state.view.nodes.find(node => node.id === changed.to);
    state.dragEnd = { edge, which: 'to', hover, pos: { x: hover.x, y: hover.y + hover.h / 2 } };
    cv.dispatchEvent(new PointerEvent('pointerup'));

    state.linkFrom = { ...state.view.nodes.find(node => node.id === original.from) };
    state.linkMode = 'click';
    const { cam } = await import('/lib/state.js');
    const rect = cv.parentElement.getBoundingClientRect();
    cv.dispatchEvent(new PointerEvent('pointerdown', {
      button: 0, clientX: rect.left + cam.x + (hover.x + hover.w / 2) * cam.k,
      clientY: rect.top + cam.y + (hover.y + hover.h / 2) * cam.k,
    }));
    if (writes.length) throw new Error('测试发现旧画布的手势发出了存档请求');
  `, [original]);
  assert.deepEqual(await snapshot(), [outside, original]);
  await checkWrites('h.redo(); reconnect(changed.to);', [original, changed]);
  assert.deepEqual(await snapshot(), [outside, original, changed], '重连到已有关系不能吞掉原来的连线');
});

test('无头浏览器：手工节点增删绑定原工程和会话，切换后丢弃过期操作与响应', async t => {
  try { resolveChromePath(); } catch (error) { t.skip(error.message); return; }
  const { baseUrl, request } = await fixture(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-manual-delete-other-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.writeFileSync(path.join(other, file), 'int value;');
  const first = await request('/api/project');
  const id = fn('Planned');
  const addNode = () => request('/api/manual-nodes', { kind: 'fn', name: 'Planned', file });
  const switchTo = (body) => request('/api/switch', body);
  const marker = () => request('/api/page', { roots: [id], up: 0, down: 0 });
  await addNode();
  await marker();
  await switchTo({ path: other });
  const second = await request('/api/project');
  const emptyView = await request('/api/view');
  assert.equal(emptyView.projectId, second.id, '空画布也能从文件树打开创建窗口');
  await addNode();
  await marker();
  await switchTo({ id: first.id });

  const chrome = await launchCdp({ url: `${baseUrl}/` });
  t.after(() => chrome.close());
  const { evaluate, waitFor } = chrome;
  const waitProject = (project) => waitFor(`(async () => {
    const { state } = await import('/lib/state.js');
    return state.view?.projectId === ${project} && state.roots.includes(${JSON.stringify(id)});
  })()`);
  const openDeletion = async () => {
    await evaluate(`(async () => {
      const { removeManualNodePermanently } = await import('/lib/manual-node.js');
      window.pendingDeletion = removeManualNodePermanently({ id: ${JSON.stringify(id)} });
    })()`);
    await waitFor('document.querySelector(".confirm-modal [data-ok]") !== null');
  };
  const confirm = () => evaluate('document.querySelector(".confirm-modal [data-ok]").click()');

  await waitProject(first.id);
  await evaluate(`(async () => {
    const { api } = await import('/lib/api.js');
    window.originalDelete = api.deleteManualNode;
    window.deleteCalls = [];
    api.deleteManualNode = async body => {
      window.deleteCalls.push(body);
      return window.originalDelete(body);
    };
  })()`);
  await openDeletion();
  await switchTo({ id: second.id });
  await waitProject(second.id);
  await confirm();
  assert.equal(await evaluate('window.pendingDeletion'), false);
  assert.deepEqual(await evaluate('window.deleteCalls'), []);
  assert.ok((await request('/api/session/export')).manualNodes.some(node => node.id === id));

  await switchTo({ id: first.id });
  await waitProject(first.id);
  const oldRevision = await evaluate(`import('/lib/state.js').then(({ state }) => state.view.sessionRevision)`);
  assert.ok(Number.isSafeInteger(oldRevision));
  await evaluate(`(async () => {
    const { api } = await import('/lib/api.js');
    api.deleteManualNode = async body => {
      window.deleteCalls.push(body);
      window.deleteResponse = await window.originalDelete(body);
      await new Promise(resolve => { window.releaseDeletion = resolve; });
      return window.deleteResponse;
    };
  })()`);
  await openDeletion();
  await confirm();
  await waitFor('window.deleteResponse?.ok === true && typeof window.releaseDeletion === "function"');
  assert.deepEqual(await evaluate('window.deleteCalls'), [{ id, projectId: first.id, sessionRevision: oldRevision }]);

  await switchTo({ id: second.id });
  await waitProject(second.id);
  await evaluate('window.releaseDeletion()');
  assert.equal(await evaluate('window.pendingDeletion'), false);
  await waitProject(second.id);
  assert.ok((await request('/api/session/export')).manualNodes.some(node => node.id === id));
  const stale = await fetch(`${baseUrl}/api/manual-nodes/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Callgraph-Project': String(second.id),
      'X-Callgraph-Session': String(oldRevision) }, body: JSON.stringify({ id }),
  });
  assert.equal(stale.status, 409);

  const active = (projectId) => waitFor(`import('/lib/state.js').then(({ state }) => state.view?.projectId === ${projectId})`);
  const openCreation = (name) => evaluate(`(async () => {
    const { openManualNodeDialog } = await import('/lib/manual-node.js');
    openManualNodeDialog({ file: ${JSON.stringify(file)} });
    document.getElementById('manualNodeName').value = ${JSON.stringify(name)};
  })()`);
  const submitCreation = () => evaluate("document.getElementById('manualNodeForm').requestSubmit()");
  await evaluate(`(async () => {
    const { api } = await import('/lib/api.js');
    const add = api.addManualNode;
    window.creations = [];
    api.addManualNode = async (body) => {
      const request = { body };
      window.creations.push(request);
      request.response = await add(body);
      await new Promise(resolve => { request.release = resolve; });
      return request.response;
    };
  })()`);

  await openCreation('Stale');
  await switchTo({ id: first.id });
  await active(first.id);
  await submitCreation();
  assert.equal(await evaluate('window.creations.length'), 0);
  assert.ok(!(await request('/api/session/export')).manualNodes.some(node => node.id === fn('Stale')));

  await openCreation('FirstNew');
  await submitCreation();
  await waitFor('typeof window.creations[0]?.release === "function"');
  assert.deepEqual(await evaluate('window.creations[0].body.projectId'), first.id);
  assert.ok(await evaluate('Number.isSafeInteger(window.creations[0].body.sessionRevision)'));
  await switchTo({ id: second.id });
  await active(second.id);
  await openCreation('SecondNew');
  await submitCreation();
  await waitFor('typeof window.creations[1]?.release === "function"');
  assert.equal(await evaluate('window.creations[1].body.projectId'), second.id);
  await evaluate('window.creations[0].release()');
  assert.ok(await evaluate("document.getElementById('manualNodeModal').classList.contains('show') && document.getElementById('manualNodeSubmit').disabled"));
  await evaluate('window.creations[1].release()');
  await waitFor(`__cg.view?.nodes.some(n => n.id === ${JSON.stringify(fn('SecondNew'))})`);
  assert.ok(!(await request('/api/session/export')).manualNodes.some(node => node.id === fn('FirstNew')));
  await switchTo({ id: first.id });
  assert.ok((await request('/api/session/export')).manualNodes.some(node => node.id === fn('FirstNew')));
});
