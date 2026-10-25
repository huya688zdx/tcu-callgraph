import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { launchServer } from '../scripts/lib/server.mjs';

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
