import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModel } from '../src/core/index.js';
import { traceToTasks } from '../src/core/task-trace.js';
import { launchServer } from '../scripts/lib/server.mjs';

function fixture(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-task-trace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), source);
  return dir;
}

const id = name => 'app.c::' + name;

test('按调用点回溯跨宏与函数指针的路径，穿过嵌套任务并排除变量和递归环', t => {
  const root = fixture(t, {
    'api.h': '#define RUN(f) f()\n',
    'app.c': `
#include "api.h"
int shared = 1;
void work(void) { ++shared; }
void other(void) { ++shared; }
void recursive(void) { RUN(work); recursive(); }
typedef struct { void (*step)(void); } Ops;
const Ops ops = { .step = recursive };
TASK(Inner) { ops.step(); }
ISR(Vector) { Inner(); }
void Task_Other(void) { RUN(other); }
void scheduleEntry(void) { recursive(); }
const TaskCfg_t g_schedTbl[] = { { scheduleEntry, 10, 0 } };
void lonely(void) {}
`,
  });
  const model = loadModel(root);
  const trace = traceToTasks(model, id('work'));
  assert.equal(trace.traceStatus, 'found');
  assert.equal(trace.totalTasks, 3);
  const pathOf = name => trace.upstreamChains.find(chain => chain.taskId === id(name));
  assert.deepEqual(pathOf('Vector').path, ['Vector', 'Inner', 'recursive', 'work'].map(id));
  assert.deepEqual(pathOf('Vector').edges.map(e => e.kind), ['direct', 'fnptr', 'macro']);
  assert.deepEqual(pathOf('Inner').path, ['Inner', 'recursive', 'work'].map(id));
  assert.deepEqual(pathOf('scheduleEntry').path, ['scheduleEntry', 'recursive', 'work'].map(id));
  assert.match(trace.upstreamTasks.find(x => x.name === 'scheduleEntry').source, /C 调度表/);
  assert.ok(trace.upstreamTasks.every(x => x.evidence === 'source'));
  assert.equal(traceToTasks(model, id('other')).upstreamTasks[0].evidence, 'name-hint');
  assert.equal(traceToTasks(model, 'header::api.h::RUN').totalTasks, 4);
  assert.equal(traceToTasks(model, 'var::shared').traceStatus, 'not-callable');
  assert.equal(traceToTasks(model, id('lonely')).traceStatus, 'no-task');
  assert.deepEqual(traceToTasks(model, id('Vector')).upstreamChains[0].path, [id('Vector')]);
  const page = traceToTasks(model, id('work'), { offset: 1, limit: 1 });
  assert.deepEqual(page.upstreamChains, trace.upstreamChains.slice(1, 2));
  assert.equal(page.traceTruncated, true);
  assert.equal(page.nextOffset, 2);
});

test('节点、源码与独立回溯接口同源；比较删除函数回落修改前，并避免跨版本拼接链路', async t => {
  const before = 'void work(void) {}\nvoid gone(void) {}\nvoid mid(void) { gone(); }\nTASK(Top) { mid(); }';
  const after = 'void work(void) {}\nvoid mid(void) { work(); }\nTASK(Top) {}';
  const root = fixture(t, { 'app.c': before });
  const beforePath = fixture(t, { 'app.c': before });
  const afterPath = fixture(t, { 'app.c': after });
  const srv = await launchServer({ target: root });
  t.after(srv.close);
  const get = async url => {
    const res = await fetch(srv.baseUrl + url);
    assert.equal(res.status, 200, url);
    return res.json();
  };
  const post = async (url, body) => {
    const res = await fetch(srv.baseUrl + url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    const data = await res.json();
    assert.equal(data.ok, true, data.error);
    return data;
  };
  const query = '?id=' + id('gone');
  const live = await get('/api/trace-to-task' + query);
  assert.deepEqual(live.upstreamChains[0].path, ['Top', 'mid', 'gone'].map(id));
  for (const route of ['/api/node', '/api/source']) {
    const detail = await get(route + query);
    assert.equal(detail.traceVersion, 'current');
    assert.deepEqual(detail.upstreamChains, live.upstreamChains);
  }
  const { preview } = await post('/api/compare', { beforePath, afterPath });
  await post('/api/compare/apply', { previewId: preview.id, selectedIds: [id('gone')] });
  for (const route of ['/api/trace-to-task', '/api/node', '/api/source']) {
    const detail = await get(route + query);
    assert.equal(detail.traceVersion, 'before');
    assert.deepEqual(detail.upstreamChains, live.upstreamChains);
    if (route === '/api/source') assert.match(detail.source, /void gone/);
  }
  const current = await get('/api/trace-to-task?id=' + id('work'));
  assert.equal(current.traceVersion, 'after');
  assert.equal(current.traceStatus, 'no-task');
  assert.equal((await get('/api/trace-to-task?id=' + id('mid') + '&version=before')).totalTasks, 1);
  assert.equal((await fetch(srv.baseUrl + '/api/trace-to-task' + query + '&version=after')).status, 404);
  assert.equal((await fetch(srv.baseUrl + '/api/trace-to-task' + query + '&limit=-1')).status, 400);
});
