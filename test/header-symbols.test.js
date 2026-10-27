import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, rebuildIndex, subgraph, search } from '../src/core/index.js';
import { launchServer } from '../scripts/lib/server.mjs';
import { collectOrphans } from '../src/core/orphans.js';
import { exportSvg } from '../src/core/export-svg.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-header-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'include'));
  fs.writeFileSync(path.join(dir, 'include/api.h'), `
#ifndef API_H
#define API_H
#define ReadSpeed Driver_ReadSpeed
#define ReadAgain ReadSpeed
#define ReadWrapper(x) Driver_ReadSpeed(x)
#define Pair(x) (Driver_ReadSpeed(x) + Other(x))
#define VALUE 123
#define TYPE unsigned
#define CALLBACK(cb) cb()
#endif
`);
  fs.writeFileSync(path.join(dir, 'include/empty.h'), '#define LIMIT 10\n');
  fs.writeFileSync(path.join(dir, 'main.c'), `
#include "include/api.h"
int Driver_ReadSpeed(int x) { return x; }
int Other(int x) { return x; }
void main(void) { ReadSpeed(Other(1)); ReadAgain(2); ReadWrapper(3); }
`);
  return dir;
}

test('头文件函数别名：对象宏、别名链、包装宏保留定义位置，常量与类型不当作函数', (t) => {
  const m = buildIndex(fixture(t));
  assert.deepEqual(m.headerSymbols.map((n) => n.name), ['ReadSpeed', 'ReadAgain', 'ReadWrapper', 'Pair']);
  const alias = m.headerSymbols[0];
  assert.equal(alias.file, 'include/api.h');
  assert.deepEqual(alias.targetIds, ['main.c::Driver_ReadSpeed']);
  const calls = m.edges.filter((e) => e.from === 'main.c::main');
  assert.equal(calls.filter((e) => e.to === 'main.c::Driver_ReadSpeed').length, 3);
  assert.ok(calls.some((e) => e.to === 'main.c::Other'), '别名实参里的嵌套调用不能丢失');
  assert.ok(search(m, 'ReadAgain').some((n) => n.id === 'header::include/api.h::ReadAgain'));
  assert.ok(search(m, 'Driver_ReadSpeed').some((n) => n.id === alias.id));
  const restored = rebuildIndex(JSON.parse(JSON.stringify({ ...m, _index: undefined })));
  assert.equal(restored._index.byId.get(alias.id).name, 'ReadSpeed');
  const g = subgraph(restored, alias.id, { up: 1, down: 1, includeVariables: false });
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), [alias.id, 'main.c::Driver_ReadSpeed', 'main.c::main'].sort());
  assert.ok(g.edges.some((e) => e.from === alias.id && e.to === 'main.c::Driver_ReadSpeed'));
  assert.ok(g.edges.some((e) => e.to === alias.id && e.from === 'main.c::main'));
  assert.equal(collectOrphans(m, { annotations: [
    { kind: 'node', id: alias.id },
    { kind: 'edge', id: `${alias.id}->main.c::Driver_ReadSpeed:${alias.line}` },
  ] }).annotations.length, 0);
});

test('头文件树、分组和名称切换：刷新、会话、AST 缓存保留，普通函数图不增加宏节点', async (t) => {
  const dir = fixture(t);
  const srv = await launchServer({ target: dir });
  t.after(() => srv.close());
  const get = async (url) => { const r = await fetch(srv.baseUrl + url); assert.equal(r.status, 200, url); return r.json(); };
  const post = async (url, body) => { const r = await fetch(srv.baseUrl + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 200); return r.json(); };
  const tree = await get('/api/tree');
  const headers = tree.children.find((n) => n.name === 'include').children;
  assert.ok(headers.some((n) => n.name === 'empty.h' && n.functions.length === 0));
  assert.equal(headers.find((n) => n.name === 'api.h').functions.length, 4);
  const id = 'header::include/api.h::ReadSpeed';
  const url = '/api/view?root=' + encodeURIComponent(id) + '&up=1&down=1';
  let v = await get(url);
  assert.ok(v.groups.some((g) => g.id === 'include/api.h'));
  const left = v.nodes.find((n) => n.id === id);
  assert.equal(left.displayName, 'ReadSpeed');
  await post('/api/overlay', { nodeId: id, data: { nameMode: 'target' } });
  v = await get(url);
  const right = v.nodes.find((n) => n.id === id);
  assert.equal(right.displayName, 'Driver_ReadSpeed');
  assert.equal(right.name, 'ReadSpeed', '切换显示不能改节点身份');
  assert.equal(left.w, right.w, '切换名称不改变框大小');
  assert.deepEqual(v.edges.map((e) => [e.from, e.to]), (await get(url)).edges.map((e) => [e.from, e.to]));
  assert.match(exportSvg(v), /Driver_ReadSpeed<\/text>/);
  assert.equal((await get('/api/session/export')).overlay.nodes[id].nameMode, 'target');
  await get('/api/vars');
  assert.equal((await get(url)).nodes.find((n) => n.id === id).displayName, 'Driver_ReadSpeed');
  await post('/api/switch', { path: path.join(dir, 'include/api.h') });
  assert.ok((await get('/api/view')).nodes.some((n) => n.headerSymbol));
  await post('/api/switch', { path: dir });
  const regular = await get('/api/view?root=main.c::main&up=0&down=1');
  assert.ok(regular.nodes.every((n) => !n.headerSymbol && n.kind !== 'var'));
  assert.equal((await get(url)).nodes.find((n) => n.id === id).displayName, 'Driver_ReadSpeed');
  const invalid = await fetch(srv.baseUrl + '/api/overlay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodeId: id, data: { nameMode: 'bad' } }) });
  assert.equal(invalid.status, 400);
});

test('宏名称优先级：节点选择优先于默认，清除选择后继续跟随设置', async (t) => {
  const srv = await launchServer({ target: fixture(t) });
  t.after(() => srv.close());
  const id = 'header::include/api.h::ReadSpeed';
  const get = async () => (await (await fetch(srv.baseUrl + '/api/view?root=' + encodeURIComponent(id))).json()).nodes.find((n) => n.id === id);
  const post = async (url, body) => {
    const r = await fetch(srv.baseUrl + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 200); return r.json();
  };
  assert.equal((await get()).nameModeOverride, null);
  await post('/api/ui-prefs', { macroNameMode: 'target' });
  assert.equal((await get()).displayName, 'Driver_ReadSpeed');
  await post('/api/overlay', { nodeId: id, data: { nameMode: 'alias' } });
  assert.equal((await get()).displayName, 'ReadSpeed');
  assert.equal((await get()).nameModeOverride, 'alias');
  await post('/api/ui-prefs', { macroNameMode: 'alias' });
  await post('/api/ui-prefs', { macroNameMode: 'target' });
  assert.equal((await get()).displayName, 'ReadSpeed');
  await post('/api/overlay', { nodeId: id, data: { nameMode: null } });
  assert.equal((await get()).displayName, 'Driver_ReadSpeed');
  assert.equal((await get()).nameModeOverride, null);
  await post('/api/ui-prefs', { macroNameMode: 'alias' });
  assert.equal((await get()).displayName, 'ReadSpeed');
  const html = () => fetch(srv.baseUrl + '/api/export/html?root=' + encodeURIComponent(id) + '&up=0&down=0').then((r) => r.text());
  await post('/api/ui-prefs', { macroNameMode: 'target' });
  assert.match(await html(), /data-name="Driver_ReadSpeed"/);
  await post('/api/overlay', { nodeId: id, data: { nameMode: 'alias' } });
  assert.match(await html(), /data-name="ReadSpeed"/);
  await post('/api/ui-prefs', { macroNameMode: 'alias' });
  await post('/api/overlay', { nodeId: id, data: { nameMode: 'target' } });
  assert.match(await html(), /data-name="Driver_ReadSpeed"/);
});

test('宏来源：对象别名指向包装宏，嵌套实参保留各自的调用者', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'include/api.h'), `
#define Wrapper(x) Driver_ReadSpeed(x)
#define Alias Wrapper
#define Outer Driver_ReadSpeed
#define Inner Other
`);
  fs.writeFileSync(path.join(dir, 'main.c'), `
int Driver_ReadSpeed(int x) { return x; }
int Other(void) { return 1; }
void main(void) { Outer(Inner()); Alias(Inner()); }
`);
  const m = buildIndex(dir);
  assert.deepEqual(m.headerSymbols.find((n) => n.name === 'Alias').targetNames, ['Driver_ReadSpeed']);
  const nested = m.edges.filter((e) => e.from === 'main.c::main' && e.to === 'main.c::Other');
  assert.equal(nested.length, 2);
  assert.ok(nested.every((e) => e.macroChain.includes('Inner') && !e.macroChain.includes('Outer')));
  assert.ok(m.headerEdges.some((e) => e.from === 'main.c::main' && e.to === 'header::include/api.h::Inner'));
  const caller = subgraph(m, 'header::include/api.h::Inner', { up: 1, down: 0 });
  assert.ok(caller.nodes.some((n) => n.id === 'main.c::main'));
});

test('头文件宏上下文：后扫描的被包含头文件与不同源文件的 static 目标', (t) => {
  const dir=fixture(t);
  fs.writeFileSync(path.join(dir,'include/api.h'),'#include "z.h"\n#define Public(x) Private(x)\n#define Alias Private\n#define Run Step\n');
  fs.writeFileSync(path.join(dir,'include/z.h'),'#define Private(x) Real(x)\n');
  fs.writeFileSync(path.join(dir,'main.c'),'static int Step(void){return 1;} int Real(int x){return x;} void main(void){Public(1);Alias(1);Run();}');
  fs.writeFileSync(path.join(dir,'other.c'),'static int Step(void){return 2;} void other(void){Run();}');
  const m=buildIndex(dir);
  for(const name of ['Public','Alias'])assert.deepEqual(m.headerSymbols.find(n=>n.name===name).targetIds,['main.c::Real']);
  const run=m.headerSymbols.find(n=>n.name==='Run');
  assert.deepEqual(run.targetIds.sort(),['main.c::Step','other.c::Step']);
  assert.deepEqual(run.targetNames,['Step']);
  assert.ok(!m.externals.some(n=>n.name==='Private'));
  const g=subgraph(m,run.id,{up:1,down:1});
  for(const id of ['main.c::Step','other.c::Step','main.c::main','other.c::other'])assert.ok(g.nodes.some(n=>n.id===id),id);
});
