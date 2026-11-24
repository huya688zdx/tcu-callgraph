import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { launchServer } from '../scripts/lib/server.mjs';

test('显式空画布可通过 GET 与 POST 打开，切换工程后仍能恢复', async (t) => {
  const srv = await launchServer();
  t.after(() => srv.close());
  const get = (url) => fetch(srv.baseUrl + url).then((r) => r.json());
  const post = (url, body) => fetch(srv.baseUrl + url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const project = await get('/api/project');
  assert.equal(project.focusFile, null);
  assert.equal((await get('/api/page?saved=1')).page, null);
  assert.ok((await get('/api/view')).nodes.length > 0, '旧请求仍自动挑选入口');
  const emptyView = { nodes: [], edges: [], groups: [], containers: [], width: 480, height: 260,
    root: null, roots: [], expansions: [], empty: true, groupMode: 'file', projectId: project.id };
  assert.deepEqual(await get('/api/view?empty=1'), emptyView);
  assert.deepEqual(await post('/api/view', { empty: true }), emptyView);
  assert.ok((await get('/api/view?empty=1&root=main.c::main')).nodes.length > 0);

  assert.equal((await post('/api/page', { projectId: project.id, roots: [], empty: true })).ok, true);
  assert.equal((await post('/api/switch', { path: path.resolve('samples/tcu/main.c') })).ok, true);
  assert.equal((await get('/api/project')).focusFile, 'main.c');
  assert.equal((await get('/api/page?saved=1')).page, null);
  assert.equal((await post('/api/switch', { path: project.path })).ok, true);
  assert.equal((await get('/api/page')).page, null);
  const saved = (await get('/api/page?saved=1')).page;
  assert.equal(saved.empty, true);
  assert.deepEqual(saved.roots, []);
  assert.deepEqual(saved.expansions, []);
});

test('最近视图按工程保存，切回后恢复函数组合、选中项和视角', async (t) => {
  const srv = await launchServer(); t.after(() => srv.close());
  const get = (url) => fetch(srv.baseUrl + url).then((r) => r.json());
  const post = (url, body) => fetch(srv.baseUrl + url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const project = await get('/api/project');
  const page = { projectId: project.id, roots: ['main.c::main', 'main.c::SysTick_Handler'],
    up: 2, down: 5, group: true, vars: ['var::g_ops_4at'], hiddenVars: ['var::g_gearCtx'],
    selected: 'gear.c::Gear_Apply', ctxBox: { kind: 'file', id: 'gear.c' }, cam: { x: 25, y: 60, k: 0.8 } };
  assert.equal((await post('/api/page', page)).ok, true);
  await post('/api/switch', { path: path.resolve('samples/deep') });
  assert.equal((await get('/api/page?saved=1')).page, null, '新工程不能恢复其他工程的选择');
  await post('/api/switch', { path: project.path });
  assert.equal((await get('/api/page')).page, null, '工程切换已清空内存中的上报');
  const saved = (await get('/api/page?saved=1')).page;
  for (const key of ['roots', 'up', 'down', 'group', 'vars', 'hiddenVars', 'selected', 'ctxBox', 'cam']) {
    assert.deepEqual(saved[key], page[key]);
  }
});

test('旧视图入口和展开范围迁移为真实函数，手工连线按迁移后的入口保存', async (t) => {
  const srv = await launchServer(); t.after(() => srv.close());
  const get = (url) => fetch(srv.baseUrl + url).then((r) => r.json());
  const post = (url, body) => fetch(srv.baseUrl + url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const project = await get('/api/project');
  const root = 'gear.c::Gear_Apply';
  const legacyRoot = 'ext::Gear_Apply';
  const secondRoot = 'main.c::main';
  const key = `${root}+${secondRoot}::group`;
  const legacyKey = `${legacyRoot}+${secondRoot}::group`;
  const existing = { from: root, to: secondRoot };
  const added = { from: secondRoot, to: root };
  const group = '?group=1&up=0&down=0';
  const legacyExpansions = [{ root: 'ext::SysTick_Handler', up: 0, down: 0 }];
  const manualOf = (view) => view.edges.filter(e => e.manual).map(({ from, to }) => ({ from, to }));
  const reload = (at = 0) => post(`/api/view${group}&at=${at}`, { projectId: project.id, roots: [root, secondRoot] });
  const latestEvent = async () => (await get('/api/events?limit=1')).latest;

  assert.equal((await post('/api/session/import', { format: 'tcu-callgraph-session', version: 1,
    overlay: { layout: { [legacyKey]: { manual: [existing] }, [key]: { nodes: { [root]: { x: 1, y: 2 } } } } },
  })).ok, true);
  const view = await post('/api/view' + group, {
    projectId: project.id, roots: [legacyRoot, secondRoot], expansions: legacyExpansions,
  });
  assert.equal(view.root, root);
  assert.deepEqual(view.roots, [root, secondRoot]);
  assert.deepEqual(view.expansions, [{ root: 'main.c::SysTick_Handler', up: 0, down: 0 }]);
  assert.ok(view.nodes.some(n => n.id === 'main.c::SysTick_Handler'));
  assert.deepEqual(manualOf(await reload()), [existing]);
  const importedAt = await latestEvent();

  assert.deepEqual(await post('/api/layout', { root: `${legacyRoot}+${secondRoot}`, mode: 'group', manual: [existing, added] }), { ok: true });
  const saved = await get('/api/session/export?events=0');
  assert.deepEqual(saved.overlay.layout[key].manual, [existing, added]);
  assert.deepEqual(saved.overlay.layout[legacyKey].manual, []);
  assert.deepEqual(manualOf(await reload()), [existing, added]);

  assert.deepEqual(await post('/api/layout', { root: `${root}+${secondRoot}`, mode: 'group', manual: [] }), { ok: true });
  assert.deepEqual(manualOf(await reload()), [], '清空后旧槽位里的连线不应重新出现');
  assert.deepEqual(manualOf(await reload(await latestEvent())), [], '回放清空后的状态也不应恢复旧连线');
  assert.deepEqual(manualOf(await reload(importedAt)), [existing]);
});
