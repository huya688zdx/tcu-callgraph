import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchServer } from '../scripts/lib/server.mjs';
import { normalizeExpansions } from '../src/core/expansion.js';
import { openStore } from '../src/core/store.js';

test('局部层级参数：合并同一函数的两个方向，拒绝无界/小数/非法层数', () => {
  assert.deepEqual(normalizeExpansions([{ root: 'b', up: 2, down: 0 }, { root: 'b', up: 0, down: 3 }]),
    [{ root: 'b', up: 2, down: 3 }]);
  for (const invalid of [null, {}, [{ root: 'b', up: -1, down: 1 }], [{ root: 'b', up: 1.5, down: 0 }],
    [{ root: 'b', up: 0, down: 21 }], [{ root: 'b', up: 0, down: '2' }], [{ root: '', up: 1, down: 0 }],
    Array.from({ length: 129 }, () => ({ root: 'b', up: 1, down: 0 }))]) {
    assert.throws(() => normalizeExpansions(invalid));
  }
});

test('单函数层级查找：默认上下各一层，按方向扩展、累积且不加载变量', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-expand-'));
  fs.writeFileSync(path.join(dir, 'chain.c'), `
typedef struct { int n; } State;
State shared;
void e(void) { shared.n++; }
void d(void) { e(); }
void c(void) { d(); }
void b(void) { c(); }
void a(void) { b(); }
void top(void) { a(); }
void side(void) { c(); }
`);
  const srv = await launchServer({ target: dir });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const get = async (url) => (await fetch(srv.baseUrl + url)).json();
  const post = async (url, body) => {
    const r = await fetch(srv.baseUrl + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const ids = (view) => view.nodes.map((n) => n.name).sort();
  const base = '/api/view?root=chain.c::b';
  assert.deepEqual(ids(await get(base)), ['a', 'b', 'c']);
  assert.deepEqual(ids(await get('/api/view')), ['a', 'top'], '自动入口也必须遵守一层默认值');
  assert.deepEqual(ids(await get('/api/view?down=0&up=0')), ['top'], '显式零层不能被强行提高到三层');
  const downward = [{ root: 'chain.c::b', up: 0, down: 2 }];
  const down = await post(base, { expansions: downward });
  assert.equal(down.status, 200);
  assert.deepEqual(ids(down.data), ['a', 'b', 'c', 'd']);
  assert.ok(!ids(down.data).includes('side'), '向下不能通过被调用函数拉入其他调用者');
  const both = [{ root: 'chain.c::b', up: 2, down: 3 }];
  const expanded = (await post(base, { expansions: both })).data;
  assert.deepEqual(ids(expanded), ['a', 'b', 'c', 'd', 'e', 'top']);
  assert.deepEqual(ids((await post(base, { expansions: [{ root: 'chain.c::c', up: 2, down: 0 }] })).data),
    ['a', 'b', 'c', 'side'], '向上只按指定深度找调用者');
  assert.ok(expanded.nodes.every((n) => n.kind !== 'var'));
  assert.equal((await fetch(srv.baseUrl + '/api/node?id=var::shared')).status, 404, '查找层级不应触发 AST 变量分析');
  const edgeIds = expanded.edges.map((e) => `${e.from}|${e.to}|${e.line}|${e.kind}`);
  assert.equal(new Set(edgeIds).size, edgeIds.length, '重叠的局部范围不能重复添加连线');
  assert.equal((await post(base, { expansions: [{ root: 'chain.c::b', up: 0, down: 21 }] })).status, 400);

  const project = await get('/api/project');
  assert.equal((await post('/api/page', { projectId: project.id, roots: ['chain.c::b'], up: 1, down: 1, expansions: both, group: true })).status, 200);
  assert.deepEqual((await get('/api/page?saved=1')).page.expansions, both);
  const bookmark = await post('/api/bookmarks', { name: '局部查找', roots: ['chain.c::b'], up: 1, down: 1, expansions: both });
  assert.equal(bookmark.status, 200);
  assert.deepEqual(bookmark.data.bookmark.expansions, both);
  assert.deepEqual((await get('/api/bookmarks')).list[0].expansions, both);
  await post('/api/switch', { path: path.resolve('samples/tcu') });
  assert.equal((await get('/api/page?saved=1')).page, null);
  await post('/api/switch', { path: dir });
  assert.deepEqual((await get('/api/page?saved=1')).page.expansions, both);
});

test('旧版书签数据库升级后保留旧内容，并支持局部范围', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-expand-store-'));
  const dbPath = path.join(dir, 'callgraph.db');
  let store = openStore({ dbPath });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const project = store.upsertProject({ path: dir, name: 'legacy' });
  store.saveBookmark(project.id, { name: '旧书签', roots: ['b'] });
  store.db.exec('ALTER TABLE bookmark DROP COLUMN expansions; PRAGMA user_version = 3');
  store.close();
  store = openStore({ dbPath });
  assert.deepEqual(store.listBookmarks(project.id)[0].roots, ['b']);
  assert.deepEqual(store.listBookmarks(project.id)[0].expansions, []);
  const ranges = [{ root: 'b', up: 2, down: 3 }];
  assert.deepEqual(store.saveBookmark(project.id, { name: '旧书签', roots: ['b'], expansions: ranges }).bookmark.expansions, ranges);
});

test('向上查找追加到当前多入口画布，保留原函数和变量，不拉入上层旁支', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-expand-append-'));
  fs.writeFileSync(path.join(dir, 'calls.c'), `
int shared;
void leaf(void) { shared++; }
void b(void) { leaf(); }
void keep(void) {}
void x(void) {}
void a(void) { b(); x(); }
void y(void) {}
void top(void) { a(); y(); }
`);
  const srv = await launchServer({ target: dir });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const roots = ['calls.c::b', 'calls.c::keep'];
  const url = srv.baseUrl + '/api/view?' + new URLSearchParams({ roots: roots.join(','), up: 0, down: 1, vars: 'var::shared' });
  const names = view => view.nodes.map(n => n.name).sort();
  const original = await (await fetch(url)).json();
  assert.deepEqual(names(original), ['b', 'keep', 'leaf', 'shared']);
  const expand = async expansions => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: original.projectId, expansions }) })).json();
  const singleScope = { root: 'calls.c::a', up: 0, down: 0 };
  const single = await expand([singleScope]);
  assert.deepEqual(names(single), ['a', 'b', 'keep', 'leaf', 'shared'], '零层添加只能新增指定函数，不能带出 top 或 x');
  assert.deepEqual(single.roots, roots, '单个添加不改变原入口层数');
  assert.ok(single.edges.some(e => e.from === 'calls.c::a' && e.to === 'calls.c::b'), '保留与已有函数的调用线');
  assert.ok(original.edges.every(old => single.edges.some(e => e.from === old.from && e.to === old.to)));
  assert.deepEqual(names(await expand(single.expansions)), names(single), '刷新后仍然只显示指定函数');
  const firstScope = { root: 'calls.c::b', up: 1, down: 0 };
  const first = await expand([firstScope]);
  assert.deepEqual(first.roots, roots, '新找到的调用者不成为入口');
  assert.deepEqual(names(first), ['a', 'b', 'keep', 'leaf', 'shared']);
  assert.ok(first.edges.some(e => e.from === 'calls.c::a' && e.to === 'calls.c::b'));
  assert.ok(original.edges.every(old => first.edges.some(e => e.from === old.from && e.to === old.to)));
  const next = await expand([firstScope, { root: 'calls.c::a', up: 1, down: 0 }]);
  assert.deepEqual(names(next), ['a', 'b', 'keep', 'leaf', 'shared', 'top']);
  assert.ok(next.edges.some(e => e.from === 'calls.c::top' && e.to === 'calls.c::a'));
  assert.ok(!next.nodes.some(n => ['x', 'y'].includes(n.name)), '上层的其他被调用分支不新增');
  const none = await expand([...next.expansions, { root: 'calls.c::keep', up: 2, down: 0 }]);
  assert.deepEqual(names(none), names(next), '无调用者时保留整张画布');
});
