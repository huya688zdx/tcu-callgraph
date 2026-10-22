/**
 * 会话文件（.cgx）与时间轴分页的回归测试。
 *
 * 三个都是评审时实测出来的真实问题：
 *   1. 导入只记了几个计数，没记全量状态 → at=这一刻 重放出来是导入前的样子，
 *      restore 还会把导入进来的标注抹掉；
 *   2. 导出把中文工程名直接塞进 Content-Disposition，HTTP 头是 latin1，
 *      Node 抛 ERR_INVALID_CHAR → 中文名工程导出必 500；
 *   3. /api/events 的 limit 传非数字时 Math.max(1, NaN) 仍是 NaN，
 *      绑定进 SQL 变 datatype mismatch → 500。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchServer } from '../scripts/lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const jsonPost = (base, p, body) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const session = (over = {}) => ({
  format: 'tcu-callgraph-session',
  version: 1,
  project: { name: '同事的工程', fingerprint: null },
  overlay: {
    nodes: { 'main.c::main': { note: '来自导入', change: 'modified' } },
    edges: {},
    deleted: { nodes: {}, edges: {} },
    layout: {},
  },
  bookmarks: [{ name: '导入的书签', roots: ['main.c::main'], down: 2 }],
  ...over,
});

test('会话导入：导入后的状态能被重放出来（at=最新 等于当前）', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const base = srv.baseUrl;

  const r = await jsonPost(base, '/api/session/import', session());
  assert.equal(r.ok, true);
  assert.equal(r.imported.annotations, 1);
  assert.equal(r.imported.bookmarks, 1);

  const latest = (await (await fetch(`${base}/api/events?limit=1`)).json()).latest;
  const cur = await (await fetch(`${base}/api/view?root=main.c::main`)).json();
  const rep = await (await fetch(`${base}/api/view?root=main.c::main&at=${latest}`)).json();
  const pick = (v) => {
    const n = v.nodes.find((x) => x.id === 'main.c::main');
    return { note: n.note, change: n.change };
  };
  assert.deepEqual(pick(cur), { note: '来自导入', change: 'modified' });
  assert.deepEqual(pick(rep), pick(cur), '导入这一条事件必须能重放出全量状态');

  // 时间轴一行要显示导入摘要，而不是把整份 overlay 的节点数当成「改了 N 个节点」
  const ev = await (await fetch(`${base}/api/events?limit=5`)).json();
  const imp = ev.events.find((e) => e.op === 'session.import');
  assert.deepEqual(imp.brief.import, { annotations: 1, layout: 0, bookmarks: 1 });
});

test('会话导入：坏数据被拒，且不会留下半份数据', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const base = srv.baseUrl;

  // bookmarks 不是数组：直接 400，不该先写进一半再 500
  const bad = await fetch(base + '/api/session/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(session({ bookmarks: { nope: 1 } })),
  });
  assert.equal(bad.status, 400);

  const view = await (await fetch(`${base}/api/view?root=main.c::main`)).json();
  const main = view.nodes.find((n) => n.id === 'main.c::main');
  assert.equal(main.note, undefined, '被拒的导入不应写进任何标注');
});

test('会话导出：中文工程名不再 500，文件名按 RFC 5987 编码', async (t) => {
  // 造一个中文名工程目录（工程名取目录名）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-中文-'));
  fs.copyFileSync(path.join(ROOT, 'samples', 'tcu', 'main.c'), path.join(dir, 'main.c'));
  const srv = await launchServer({ target: dir });
  t.after(async () => {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const res = await fetch(srv.baseUrl + '/api/session/export');
  assert.equal(res.status, 200, '中文工程名导出不能 500');

  const cd = res.headers.get('content-disposition') || '';
  // 头里只能有 ASCII：非 ASCII 会让 Node 抛 ERR_INVALID_CHAR
  assert.ok(/^[\x20-\x7e]*$/.test(cd), `Content-Disposition 必须是 ASCII：${cd}`);
  assert.match(cd, /filename\*=UTF-8''/, '要带 RFC 5987 的 filename*');

  const body = await res.json();
  assert.equal(body.format, 'tcu-callgraph-session');
  assert.equal(body.version, 1);
  assert.ok(body.overlay && body.bookmarks, '会话文件应包含 overlay 与 bookmarks');
});

test('时间轴：limit / before 传垃圾值不 500', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const base = srv.baseUrl;

  for (const q of ['limit=abc', 'limit=-5', 'limit=99999', 'before=abc', 'before=-1', 'limit=1.5']) {
    const res = await fetch(`${base}/api/events?${q}`);
    assert.equal(res.status, 200, `${q} 不该报错`);
    const body = await res.json();
    assert.ok(Array.isArray(body.events), `${q} 应返回 events 数组`);
    assert.ok(body.events.length <= 200, `${q} 的条数要被夹到 200 以内`);
  }
});
