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
