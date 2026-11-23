/**
 * 界面偏好（范围下拉的向下 / 向上层数）走真实 HTTP 的存取链路。
 *
 * 范围是界面习惯不是工程数据：存全局 setting 表（ui.depth），跨重启、跨工程生效。
 * 每次 launchServer 都是新临时库，「跨重启」由与 labels.conn.mode 同一套
 * getSetting/setSetting 机制保证，这里验证默认值、存取回读与非法值拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchServer } from '../scripts/lib/server.mjs';

const jsonPost = (base, p, body) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

test('界面偏好：默认范围是向下 1 / 向上 1', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());

  const r = await (await fetch(srv.baseUrl + '/api/ui-prefs')).json();
  assert.deepEqual(r, { down: 1, up: 1, macroNameMode: 'alias' });
});

test('界面偏好：保存后读回，非法值拒绝且不覆盖旧值', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const base = srv.baseUrl;

  const w = await jsonPost(base, '/api/ui-prefs', { down: 5, up: 2 });
  assert.equal(w.ok, true);
  assert.deepEqual(await (await fetch(base + '/api/ui-prefs')).json(), { down: 5, up: 2, macroNameMode: 'alias' });

  // 聚焦查找产生的范围同样可以保存，包含零层及边界值。
  for (const depths of [{ down: 0, up: 3 }, { down: 4, up: 7 }, { down: 20, up: 20 }]) {
    assert.equal((await jsonPost(base, '/api/ui-prefs', depths)).ok, true);
    assert.deepEqual(await (await fetch(base + '/api/ui-prefs')).json(), { ...depths, macroNameMode: 'alias' });
  }
  for (const bad of [{ down: -1, up: 0 }, { down: 1, up: 21 }, { down: 1.5, up: 1 }, { down: 5 }, {}]) {
    const r = await jsonPost(base, '/api/ui-prefs', bad);
    assert.equal(r.ok, false, `非法载荷应被拒绝：${JSON.stringify(bad)}`);
  }
  assert.deepEqual(await (await fetch(base + '/api/ui-prefs')).json(), { down: 20, up: 20, macroNameMode: 'alias' });
});

test('宏名称默认偏好：独立更新、跨工程保存；非法混合更新不会部分写入', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const get = () => fetch(srv.baseUrl + '/api/ui-prefs').then((r) => r.json());
  assert.equal((await jsonPost(srv.baseUrl, '/api/ui-prefs', { macroNameMode: 'target' })).ok, true);
  assert.deepEqual(await get(), { down: 1, up: 1, macroNameMode: 'target' });
  assert.equal((await jsonPost(srv.baseUrl, '/api/ui-prefs', { down: 5, up: 2 })).ok, true);
  assert.deepEqual(await get(), { down: 5, up: 2, macroNameMode: 'target' });
  for (const bad of [{ macroNameMode: null }, { macroNameMode: 'other', down: 1, up: 0 }, { macroNameMode: 'alias', up: 7 }]) {
    assert.equal((await jsonPost(srv.baseUrl, '/api/ui-prefs', bad)).ok, false);
    assert.deepEqual(await get(), { down: 5, up: 2, macroNameMode: 'target' });
  }
  assert.equal((await jsonPost(srv.baseUrl, '/api/switch', { path: 'samples/shared-state' })).ok, true);
  assert.deepEqual(await get(), { down: 5, up: 2, macroNameMode: 'target' });
});
