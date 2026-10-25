import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { launchServer } from '../scripts/lib/server.mjs';

// 100 Continue 确认服务器已进入请求，随后暂缓请求体，不依赖固定延时。
async function holdJson(base, endpoint, data) {
  const body = JSON.stringify(data);
  const req = http.request(base + endpoint, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Expect: '100-continue',
  } });
  const response = new Promise((resolve, reject) => {
    req.on('error', reject);
    req.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  });
  req.flushHeaders();
  await once(req, 'continue');
  return { finish: () => { req.end(body); return response; } };
}

test('工程切换拒绝旧请求和并发切换，不向新工程串写', async (t) => {
  const srv = await launchServer();
  t.after(() => srv.close());
  const post = (endpoint, data) => fetch(srv.baseUrl + endpoint, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const held = await holdJson(srv.baseUrl, '/api/overlay', { nodeId: 'main.c::main', data: { note: '旧工程标注' } });
  assert.equal((await post('/api/switch', { path: path.resolve('samples/deep') })).status, 200);
  assert.equal(await held.finish(), 409);
  const session = await (await fetch(srv.baseUrl + '/api/session/export')).json();
  assert.equal(session.overlay.nodes['main.c::main'], undefined);
  const switching = await holdJson(srv.baseUrl, '/api/switch', { path: path.resolve('samples/tcu') });
  assert.equal((await post('/api/switch', { path: path.resolve('samples/demo') })).status, 409);
  assert.equal(await switching.finish(), 200);
});

test('工程显示名持久化，移出列表后按路径恢复且保留原存档', async (t) => {
  const srv = await launchServer(); t.after(() => srv.close());
  const get = (url) => fetch(srv.baseUrl + url).then((r) => r.json());
  const post = (url, body) => fetch(srv.baseUrl + url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const project = await get('/api/project');
  await post('/api/overlay', { nodeId:'main.c::main', data:{note:'保留的标注'} });
  const renamed = await post('/api/projects/rename', { id:project.id, name:'我的变速箱工程' });
  assert.equal(renamed.project.name, '我的变速箱工程');
  assert.equal((await get('/api/project')).name, '我的变速箱工程');
  assert.equal((await get('/api/tree')).name, '我的变速箱工程');
  assert.equal((await get('/api/view')).containers.find((c) => c.root).label, '我的变速箱工程');
  assert.equal((await post('/api/projects/rename', { id:project.id, name:' ' })).ok, false);
  assert.equal((await get('/api/project')).name, '我的变速箱工程');
  await post('/api/projects/remove', { id:project.id });
  assert.equal((await get('/api/projects')).some((p) => p.id === project.id), false);
  const reopened = await post('/api/switch', { path:project.path });
  assert.equal(reopened.project.id, project.id);
  assert.equal(reopened.project.name, '我的变速箱工程');
  assert.equal((await get('/api/projects')).some((p) => p.id === project.id), true);
  assert.equal((await get('/api/session/export')).overlay.nodes['main.c::main'].note, '保留的标注');
});
