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
