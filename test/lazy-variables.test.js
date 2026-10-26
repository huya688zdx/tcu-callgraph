import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchServer } from '../scripts/lib/server.mjs';

test('首屏不构建 AST 变量索引；变量按需加载，缓存重开仍默认只画函数', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-vars-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'main.c'), `
typedef struct { int value; } State;
State g_state;
int g_count;
void write_state(void) { g_state.value = 1; g_count++; }
void read_state(void) { int x = g_state.value + g_count; }
void main(void) { write_state(); read_state(); }
`);
  const srv = await launchServer({ target: dir });
  t.after(() => srv.close());
  const get = async (url) => {
    const r = await fetch(srv.baseUrl + url);
    assert.equal(r.status, 200, url);
    return r.json();
  };
  const viewUrl = '/api/view?root=main.c::main&down=3';
  const assertCallsOnly = (view) => {
    assert.deepEqual(view.nodes.map((n) => n.id).sort(), ['main.c::main', 'main.c::read_state', 'main.c::write_state']);
    assert.ok(view.edges.every((e) => e.kind !== 'var'));
  };
  assertCallsOnly(await get(viewUrl));
  assert.equal((await fetch(srv.baseUrl + '/api/node?id=var::g_state')).status, 404,
    '自定义类型变量只有 AST 能识别，首屏后仍不存在证明未触发 AST');

  const variables = await get('/api/vars');
  assert.ok(variables.list.some((v) => v.id === 'var::g_state'));
  assertCallsOnly(await get(viewUrl));
  const selected = await get(viewUrl + '&vars=var::g_state');
  assert.deepEqual(selected.nodes.filter((n) => n.kind === 'var').map((n) => n.id), ['var::g_state']);
  assert.ok(selected.edges.some((e) => e.to === 'var::g_state' && e.via === '写'));
  assert.ok(selected.edges.some((e) => e.to === 'var::g_state' && e.via === '读'));

  const switched = await fetch(srv.baseUrl + '/api/switch', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) });
  assert.equal(switched.status, 200);
  assert.equal((await get('/api/node?id=var::g_state')).node.kind, 'var', '完整变量分析缓存应复用');
  assertCallsOnly(await get(viewUrl));
  const flow = await get('/api/dataflow?fn=main.c::write_state&dir=out');
  assert.ok(flow.vars.some((v) => v.id === 'var::g_state' && v.peers.some((p) => p.id === 'main.c::read_state')));
});

test('直接勾选变量也会按需分析，无需预先请求变量清单', async (t) => {
  const srv = await launchServer({ target: 'samples/shared-state' });
  t.after(() => srv.close());
  const r = await fetch(srv.baseUrl + '/api/view?root=producer.c::Sensor_Update&down=0&vars=var::g_rpm');
  assert.equal(r.status, 200);
  const view = await r.json();
  assert.ok(view.nodes.some((n) => n.id === 'var::g_rpm'));
  assert.ok(view.edges.some((e) => e.to === 'var::g_rpm' && e.via === '读写'));
});

test('冷缓存失效标注检测与清理：保留 typedef 变量的标注、关系、删除记录和布局', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphan-lazy-'));
  const source = path.join(dir, 'main.c');
  fs.writeFileSync(source, [
    'typedef struct { int value; } State;',
    'State g_keep;',
    'const State g_constant = { 1 };',
    'void work(void) { g_keep.value = g_constant.value; }',
    'void main(void) { work(); }',
  ].join('\n'));
  const srv = await launchServer({ target: dir });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const get = async (url) => {
    const r = await fetch(srv.baseUrl + url);
    assert.equal(r.status, 200, url);
    return r.json();
  };
  const post = async (url, body) => {
    const r = await fetch(srv.baseUrl + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 200, url);
    return r.json();
  };
  const validEdge = 'main.c::work->var::g_keep:4';
  const badEdge = 'gone.c::old->var::missing:1';
  const layoutKey = 'main.c::main::group';
  const imported = await post('/api/session/import', {
    format: 'tcu-callgraph-session', version: 1,
    overlay: {
      nodes: { 'var::g_keep': { note: '保留变量' }, 'var::g_constant': { note: '保留常量' }, 'var::missing': { note: '失效' } },
      edges: { [validEdge]: { note: '保留关系' }, [badEdge]: { note: '失效关系' } },
      deleted: { nodes: { 'var::g_keep': true }, edges: { [validEdge]: true } },
      layout: { [layoutKey]: { nodes: { 'var::g_keep': { x: 1, y: 2 }, 'var::g_constant': { x: 3, y: 4 }, 'var::missing': { x: 5, y: 6 } } } },
    },
  });
  assert.equal(imported.ok, true);
  const cold = async () => {
    // 源码发生变化，切回同一工程也必须走缓存未命中的懒分析路径。
    fs.appendFileSync(source, '\n/* source changed */');
    assert.equal((await post('/api/switch', { path: dir })).ok, true);
    assert.equal((await fetch(srv.baseUrl + '/api/node?id=var::g_keep')).status, 404, '检测前不能偷偷预建 AST');
  };
  await cold();
  const orphans = await get('/api/orphans');
  assert.equal(orphans.total, 3, '只有真正缺失的节点标注、关系标注和布局节点应失效');
  assert.deepEqual(orphans.annotations.map((a) => `${a.kind}:${a.id}`).sort(), [`node:var::missing`, `edge:${badEdge}`].sort());
  assert.deepEqual(orphans.deleted, []);
  assert.deepEqual(orphans.layoutNodes, [{ viewKey: 'main.c::main', mode: 'group', ids: ['var::missing'] }]);

  await cold();
  const before = (await get('/api/session/export')).overlay;
  const preview = await post('/api/orphans/purge', { dry: true });
  assert.equal(preview.wouldRemove, 3);
  assert.deepEqual((await get('/api/session/export')).overlay, before, '预览不能修改存档');

  await cold();
  const purged = await post('/api/orphans/purge', {});
  assert.equal(purged.removed, 3, '直接清理也必须在完整变量索引上判断');
  const saved = (await get('/api/session/export')).overlay;
  assert.equal(saved.nodes['var::g_keep'].note, '保留变量');
  assert.equal(saved.nodes['var::g_constant'].note, '保留常量');
  assert.equal(saved.edges[validEdge].note, '保留关系');
  assert.ok(saved.deleted.nodes['var::g_keep']);
  assert.ok(saved.deleted.edges[validEdge]);
  assert.deepEqual(saved.layout[layoutKey].nodes, { 'var::g_keep': { x: 1, y: 2 }, 'var::g_constant': { x: 3, y: 4 } });
  assert.equal(saved.nodes['var::missing'], undefined);
  assert.equal(saved.edges[badEdge], undefined);
  assert.equal((await get('/api/orphans')).total, 0);

  await cold();
  const beforeFailure = (await get('/api/session/export')).overlay;
  const unavailable = source + '.unavailable';
  fs.renameSync(source, unavailable);
  try {
    // 扫描完成后文件暂时无法读取，分析器会返回部分结果而不是直接抛错。
    for (const [method, url] of [['GET', '/api/orphans'], ['POST', '/api/orphans/purge']]) {
      const response = await fetch(srv.baseUrl + url, method === 'POST' ? { method,
        headers: { 'Content-Type': 'application/json' }, body: '{}' } : {});
      assert.equal(response.status, 500, '不完整索引必须拒绝判定和清理');
    }
    assert.deepEqual((await get('/api/session/export')).overlay, beforeFailure, '分析失败不能删除任何存档');
  } finally { fs.renameSync(unavailable, source); }
  assert.equal((await post('/api/switch', { path: dir })).ok, true);
  assert.equal((await fetch(srv.baseUrl + '/api/node?id=var::g_keep')).status, 404, '不完整分析不能覆盖磁盘上的正常解析缓存');
  assert.equal((await get('/api/orphans')).total, 0, '源码恢复后重新打开即可重试');
});
