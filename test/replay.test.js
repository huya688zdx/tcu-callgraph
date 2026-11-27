/**
 * 回放一致性测试。
 *
 * 时间轴的核心承诺是「恢复到某一刻 = 那一刻的样子」。这要求两件事同时成立：
 *   1. 每个写接口在改状态的同时记一条能完整还原它的事件；
 *   2. 重放这些事件得到的结果，与库里当前状态逐字段相同。
 *
 * 之前 55 个用例一个都没碰 overlayAt / applyEvent，所以「事件记了但回放不出来」
 * 这类问题（例如标注写了 updatedAt、事件却没记）完全测不出来。
 * 这里走真实 HTTP：写一圈 → 取最新事件 id → 用 at=<id> 重放 → 和当前状态对比。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { launchCdp, resolveChromePath } from '../scripts/lib/cdp.mjs';
import { launchServer } from '../scripts/lib/server.mjs';
import { openStore } from '../src/core/store.js';
import { diffViewScopes } from '../src/core/view-scope.js';

const jsonPost = (base, p, body) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

/** 只保留「状态类」字段：坐标、标注、变更标记都是 overlay 决定的 */
const stateOf = (view) => ({
  nodes: view.nodes
    .map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      note: n.note,
      color: n.color,
      tag: n.tag,
      change: n.change,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1)),
  edges: (view.edges || []).map((e) => e.key || `${e.from}->${e.to}`).sort(),
});

test('时间轴回看并恢复历史画布，同时保留该时刻的标注', async (t) => {
  const srv = await launchServer();
  const base = srv.baseUrl;
  const get = (url) => fetch(base + url).then((r) => r.json());
  const post = (url, body) => jsonPost(base, url, body);
  t.after(() => srv.close());
  const project = await get('/api/project');
  const legacyAt = (await get('/api/events?limit=1')).latest;
  const main = 'main.c::main';
  const gear = 'gear.c::Gear_Apply';
  const tick = 'main.c::SysTick_Handler';
  const cleared = { roots: [], expansions: [], up: 0, down: 0, group: false, groupMode: 'flat', vars: [], hiddenVars: [], empty: true };
  const viewA = { ...cleared, roots: [main], empty: false };
  const viewB = { ...viewA, roots: [gear, tick], group: true, groupMode: 'period',
    expansions: [gear, main].map((root) => ({ root, up: 0, down: 0 })) };
  const record = async (view, op = 'view.snapshot', label) => {
    const result = await post('/api/view-event', { op, view, label });
    assert.equal(result.ok, true);
    assert.ok(result.eventId > 0);
    return result.eventId;
  };
  const review = (id) => get(`/api/view?root=${gear}&up=1&down=1&group=1&at=${id}&useSnapshot=1`);
  const nodeIds = (view) => view.nodes.map((node) => node.id).sort();

  const legacy = await review(legacyAt);
  assert.equal(legacy.reviewSnapshot, null);
  assert.equal(legacy.root, gear);
  const atA = await record(viewA);
  assert.equal((await post('/api/view-event', { op: 'view.snapshot', view: viewA })).deduplicated, true);
  assert.equal((await post('/api/page', { projectId: project.id, ...viewA })).ok, true);
  assert.equal((await post('/api/overlay', { nodeId: main, data: { note: '当时的备注' } })).ok, true);
  const annotationAt = (await get('/api/events?limit=1')).latest;
  const atB = await record(viewB, 'view.snapshot', '三个函数');
  const atClear = await record(cleared, 'view.clear');
  assert.equal((await post('/api/page', { projectId: project.id, ...cleared })).ok, true);
  assert.equal((await post('/api/page', { projectId: project.id, ...viewA, at: atA })).ok, true);
  assert.equal((await post('/api/view-event', { op: 'view.snapshot', view: viewA })).ignored, true);
  assert.equal((await get('/api/page?saved=1')).page.empty, true);

  const events = (await get('/api/events?detail=1')).events;
  const annotation = events.find((event) => event.id === annotationAt);
  assert.deepEqual(annotation.after, { note: '当时的备注', view: viewA });
  assert.deepEqual(events.find((event) => event.id === atB).brief,
    { count: 3, roots: 2, vars: 0, empty: false, label: '三个函数' });
  const store = openStore({ dbPath: project.db });
  try {
    assert.equal(store.viewAt(project.id, legacyAt), null);
    assert.deepEqual(store.viewAt(project.id, atA), viewA);
    assert.deepEqual(store.viewAt(project.id, atB), viewB);
    assert.deepEqual(store.viewAt(project.id, atClear), cleared);
    assert.deepEqual(store.overlayAt(project.id, annotationAt).nodes[main], { note: '当时的备注' });
  } finally {
    store.close();
  }

  const a = await review(atA);
  assert.deepEqual(a.reviewSnapshot, viewA);
  assert.deepEqual(nodeIds(a), [main]);
  assert.equal(a.nodes[0].note, undefined);
  const annotated = await review(annotationAt);
  assert.deepEqual(annotated.reviewSnapshot, viewA);
  assert.equal(annotated.nodes[0].note, '当时的备注');
  const b = await review(atB);
  assert.deepEqual(b.reviewSnapshot, viewB);
  assert.deepEqual(nodeIds(b), [gear, main, tick].sort());
  const postReview = await post(`/api/view?at=${atB}`, { useSnapshot: true });
  assert.deepEqual(postReview.reviewSnapshot, viewB);
  assert.deepEqual(stateOf(postReview), stateOf(b));
  const empty = await review(atClear);
  assert.deepEqual(empty.reviewSnapshot, cleared);
  assert.deepEqual(empty.nodes, []);
  assert.equal(empty.empty, true);

  const restored = await post('/api/restore', { eventId: atA });
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.restoredView, viewA);
  const saved = (await get('/api/page?saved=1')).page;
  for (const key of Object.keys(viewA)) assert.deepEqual(saved[key], viewA[key]);
  assert.equal(saved.reviewing, false);
  assert.equal(saved.at, 0);
  assert.equal(saved.selected, null);
  assert.equal(saved.selectedEdge, null);
  assert.equal((await post('/api/page', { ...cleared, revision: 0 })).ok, false, '旧上报不能覆盖恢复后的画布');
  const replayedRestore = await review(restored.eventId);
  assert.deepEqual(replayedRestore.reviewSnapshot, viewA);
  assert.deepEqual(stateOf(replayedRestore), stateOf(a));
  assert.equal((await get(`/api/view?root=${main}&up=0&down=0`)).nodes[0].note, undefined);
});

test('回放一致性：写满一圈后 at=最新 的视图与当前状态逐字段相同', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const base = srv.baseUrl;

  const view0 = await (await fetch(`${base}/api/view?root=main.c::main`)).json();
  assert.ok(view0.nodes.length > 1, '视图应有节点');
  const target = view0.nodes.find((n) => n.id !== 'main.c::main') || view0.nodes[0];
  const doomed = view0.nodes.find((n) => n.id !== target.id && n.id !== 'main.c::main');

  // 1) 标注：写 note + color，再单独改一次（两次事件要能叠加）。
  //    color 用固定四色内的值——规则外颜色会被 /api/overlay 拒收（见 mcp.test.js）
  assert.equal((await jsonPost(base, '/api/overlay', { nodeId: target.id, data: { note: '回放用' } })).ok, true);
  assert.equal((await jsonPost(base, '/api/overlay', { nodeId: target.id, data: { color: '#FFFF99' } })).ok, true);

  // 2) 删除一个节点（回放要能还原 deleted）
  if (doomed) {
    assert.equal((await jsonPost(base, '/api/delete', { nodes: [doomed.id] })).ok, true);
  }

  // 3) 布局：写一个坐标
  await jsonPost(base, '/api/layout', {
    root: 'main.c::main',
    mode: 'flat',
    nodes: { [target.id]: { x: 321, y: 123 } },
  });

  const latest = (await (await fetch(`${base}/api/events?limit=1`)).json()).latest;
  assert.ok(latest > 1, '应有除 baseline 外的事件');

  const cur = await (await fetch(`${base}/api/view?root=main.c::main`)).json();
  const replayed = await (await fetch(`${base}/api/view?root=main.c::main&at=${latest}`)).json();

  assert.deepEqual(stateOf(replayed), stateOf(cur), '重放出来的历史状态必须等于当前状态');

  // 顺带确认标注真的生效了（否则上面的对比可能是在比两份空状态）
  const hit = cur.nodes.find((n) => n.id === target.id);
  assert.equal(hit.note, '回放用');
  assert.equal(hit.color, '#FFFF99');
});

test('回放一致性：恢复历史点后，重放该点等于恢复出来的状态', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const base = srv.baseUrl;

  const view0 = await (await fetch(`${base}/api/view?root=main.c::main`)).json();
  const target = view0.nodes.find((n) => n.id !== 'main.c::main') || view0.nodes[0];

  await jsonPost(base, '/api/overlay', { nodeId: target.id, data: { note: '第一版' } });
  const midEvent = (await (await fetch(`${base}/api/events?limit=1`)).json()).latest;
  await jsonPost(base, '/api/overlay', { nodeId: target.id, data: { note: '第二版' } });

  // 回到「第一版」那一刻
  const restored = await jsonPost(base, '/api/restore', { eventId: midEvent });
  assert.equal(restored.ok, true);

  const afterRestore = await (await fetch(`${base}/api/view?root=main.c::main`)).json();
  const hit = afterRestore.nodes.find((n) => n.id === target.id);
  assert.equal(hit.note, '第一版', '恢复应回到第一版的标注');

  // 恢复本身也留了一条 restore_point，重放它应当等于恢复后的状态
  const latest = (await (await fetch(`${base}/api/events?limit=1`)).json()).latest;
  const replayed = await (await fetch(`${base}/api/view?root=main.c::main&at=${latest}`)).json();
  assert.deepEqual(stateOf(replayed), stateOf(afterRestore), 'restore_point 之后重放应与现状一致');
});

test('回放一致性：书签事件带完整载荷，删除后仍能从事件里读回原值', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const base = srv.baseUrl;

  const saved = await jsonPost(base, '/api/bookmarks', {
    name: '换挡链路',
    roots: ['main.c::main'],
    expansions: [{ root: 'main.c::main', up: 2, down: 4 }],
    up: 1,
    down: 2,
    group: false,
    vars: ['g_ops_4at'],
  });
  assert.equal(saved.ok, true);
  const id = saved.bookmark.id;

  await jsonPost(base, '/api/bookmarks/delete', { id });

  // detail=1 才回完整载荷：默认列表只给 brief，用来渲染时间轴
  const events = await (await fetch(`${base}/api/events?limit=20&detail=1`)).json();
  const del = events.events.find((e) => e.op === 'bookmark.delete' && e.target === '换挡链路');
  assert.ok(del, '删除应留下时间轴事件');
  // 整份视图参数都要在，否则「删了再想恢复」只剩个名字
  assert.deepEqual(del.before, {
    name: '换挡链路',
    roots: ['main.c::main'],
    expansions: [{ root: 'main.c::main', up: 2, down: 4 }],
    up: 1,
    down: 2,
    group: false,
    vars: ['g_ops_4at'],
  });
});

test('书签原地更新、版本冲突 409、书签快照回放与检查点里程碑筛选', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const base = srv.baseUrl;

  const created = await jsonPost(base, '/api/bookmarks', {
    name: '主调度链路',
    roots: ['main.c::main'],
    up: 1,
    down: 2,
    hiddenVars: ['var::g_flag'],
    createOnly: true,
  });
  assert.equal(created.ok, true);
  assert.equal(created.bookmark.revision, 1);
  assert.deepEqual(created.bookmark.hiddenVars, ['var::g_flag']);

  // 同名 createOnly 返回 409
  const dupRes = await fetch(`${base}/api/bookmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '主调度链路', roots: ['main.c::main'], createOnly: true }),
  });
  assert.equal(dupRes.status, 409);

  // 原地更新
  const updated = await jsonPost(base, '/api/bookmarks/update', {
    id: created.bookmark.id,
    expectedRevision: 1,
    roots: ['main.c::main', 'gear.c::Gear_Apply'],
    hiddenVars: [],
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.bookmark.revision, 2);

  // 过期 revision 返回 409 冲突
  const staleRes = await fetch(`${base}/api/bookmarks/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: created.bookmark.id, expectedRevision: 1, roots: ['main.c::main'] }),
  });
  assert.equal(staleRes.status, 409);
  const staleJson = await staleRes.json();
  assert.equal(staleJson.conflict, true);

  // view.checkpoint + level=milestone + bookmarkId 过滤
  const cp = await jsonPost(base, '/api/view-event', {
    op: 'view.checkpoint',
    label: '检查点一',
    view: { roots: ['main.c::main', 'gear.c::Gear_Apply'], expansions: [], up: 1, down: 2 },
    ctx: { bookmarkId: created.bookmark.id, bookmarkName: '主调度链路', checkpointName: '检查点一', milestone: 1 },
  });
  assert.equal(cp.ok, true);

  const ms = await (await fetch(`${base}/api/events?level=milestone&bookmarkId=${created.bookmark.id}`)).json();
  assert.ok(ms.events.some((e) => e.op === 'view.checkpoint' && e.ctx?.checkpointName === '检查点一'));
  assert.ok(ms.events.some((e) => e.op === 'bookmark.save' && e.ctx?.action === 'update'));
});

test('diffViewScopes 能识别同一函数的局部展开层数变化', () => {
  const diff = diffViewScopes(
    { roots: ['a.c::f'], expansions: [{ root: 'a.c::f', up: 0, down: 1 }] },
    { roots: ['a.c::f'], expansions: [{ root: 'a.c::f', up: 0, down: 2 }] },
  );
  assert.equal(diff.changed, true);
  assert.equal(diff.expansionDepthChanged, true);
  assert.match(diff.summary, /局部展开/);
});

test('恢复历史时原子保存最新工作区检查点，空画布和局部展开均可恢复', async t => {
  const old = { roots: ['gear.c::Gear_Init'], up: 0, down: 0 };
  const id = 'main.c::main';
  for (const [name, scope] of [['空画布', { roots: [], expansions: [], empty: true }],
    ['只有局部展开', { roots: [], expansions: [{ root: id, up: 1, down: 0 }], empty: false }]]) {
    await t.test(name, async t => {
      const srv = await launchServer(); t.after(srv.close);
      const post = (url, p) => jsonPost(srv.baseUrl, url, p);
      const get = url => fetch(srv.baseUrl + url).then(r => r.json());
      const { eventId } = await post('/api/view-event', { op: 'view.snapshot', view: old });
      await post('/api/page', { ...scope, groupMode: 'flat', up: 0, down: 0 });
      await post('/api/overlay', { nodeId: id, data: { note: '最新工作' } });
      await post('/api/page', { ...old, at: eventId });
      const result = await post('/api/restore', { eventId });
      assert.ok(result.ok, result.error);
      const events = (await get('/api/events?detail=1')).events;
      const cp = events.find(e => e.id === result.checkpointId);
      assert.equal(cp?.op, 'view.checkpoint');
      assert.equal(cp.target, '恢复前自动快照');
      assert.deepEqual(cp.after.view.expansions, scope.expansions);
      assert.deepEqual(cp.after.view.roots, []);
      assert.equal(cp.after.view.empty, scope.empty);
      assert.equal(cp.after.view.groupMode, 'flat');
      assert.deepEqual((await get('/api/page?saved=1')).page.roots, old.roots);
      const recovered = await post('/api/restore', { eventId: cp.id });
      assert.equal(recovered.ok, true, recovered.error);
      assert.deepEqual(recovered.restoredView, cp.after.view);
      assert.equal((await get('/api/session/export')).overlay.nodes[id].note, '最新工作');
    });
  }
  await t.test('尚未打开画布时检查点为空，错误的目标不会产生事件', async t => {
    const srv = await launchServer(); t.after(srv.close);
    const post = (url, p) => jsonPost(srv.baseUrl, url, p);
    const get = url => fetch(srv.baseUrl + url).then(r => r.json());
    const target = await post('/api/view-event', { op: 'view.snapshot', view: old });
    const latest = (await get('/api/events?limit=1')).latest;
    assert.equal((await post('/api/restore', { eventId: latest + 1 })).ok, false);
    assert.equal((await get('/api/events?limit=1')).latest, latest);
    const restored = await post('/api/restore', { eventId: target.eventId });
    const cp = (await get('/api/events?detail=1')).events.find(e => e.id === restored.checkpointId);
    assert.deepEqual(cp?.after.view.roots, []);
    assert.equal(cp.after.view.empty, true);
  });
  for (const op of ['view.checkpoint', 'restore_point']) {
    await t.test(op + ' 写入失败时保留页面、标注和历史', async t => {
      const srv = await launchServer(); t.after(srv.close);
      const post = (url, p) => jsonPost(srv.baseUrl, url, p);
      const get = url => fetch(srv.baseUrl + url).then(r => r.json());
      const { eventId } = await post('/api/view-event', { op: 'view.snapshot', view: old });
      await post('/api/page', { roots: [id], up: 0, down: 1 });
      await post('/api/overlay', { nodeId: id, data: { note: '保留' } });
      const latest = (await get('/api/events?limit=1')).latest;
      const db = new DatabaseSync((await get('/api/project')).db);
      t.after(() => db.close());
      db.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON event WHEN NEW.op = '" + op
        + "' BEGIN SELECT RAISE(ABORT, 'checkpoint test failure'); END");
      const response = await post('/api/restore', { eventId });
      assert.equal(response.ok, false);
      assert.match(response.error, /checkpoint test failure/);
      assert.deepEqual((await get('/api/page?saved=1')).page.roots, [id]);
      assert.equal((await get('/api/session/export')).overlay.nodes[id].note, '保留');
      assert.equal((await get('/api/events?limit=1')).latest, latest);
    });
  }
});

test('浏览器从回看恢复时保留另一窗口后来保存的画布，检查点失败可重试', async t => {
  try { resolveChromePath(); } catch (err) { t.skip(err.message); return; }
  const srv = await launchServer(); t.after(srv.close);
  const post = (url,p) => jsonPost(srv.baseUrl, url,p);
  const get = url => fetch(srv.baseUrl + url).then(r=>r.json());
  const historical = 'gear.c::Gear_Init', latest = 'gear.c::Gear_Apply';
  const { eventId } = await post('/api/view-event', { op: 'view.checkpoint', ctx: { checkpointName: '历史基线' }, view: { roots: [historical], up: 0, down: 0 } });
  await post('/api/page', { roots: ['main.c::main'], up: 0, down: 0 });
  const br = await launchCdp({ url: srv.baseUrl }); t.after(() => br.close());
  const review = async id => {
    await br.evaluate("document.getElementById('timelineBtn').click()");
    const entry = '.ev[data-id="' + id + '"] .ev-review';
    await br.waitFor('Boolean(document.querySelector(' + JSON.stringify(entry) + '))');
    await br.evaluate('document.querySelector(' + JSON.stringify(entry) + ').click()');
    await br.waitFor('window.__cg?.at === ' + id + ' && !document.getElementById("reviewRestore").disabled');
  };
  await br.waitFor('window.__cg?.root === "main.c::main"');
  await review(eventId);
  await br.waitFor('window.__cg.root === ' + JSON.stringify(historical));
  const blocked = await br.evaluate("(async () => (await import('/lib/api.js')).api.saveCheckpoint('禁用的手动写入', { roots: [] }))()");
  assert.equal(blocked.ok, false);
  await post('/api/page', { roots: [], expansions: [{ root: latest, up: 0, down: 0 }], up: 0, down: 0 });
  const db = new DatabaseSync((await get('/api/project')).db); t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON event WHEN NEW.op='view.checkpoint' BEGIN SELECT RAISE(ABORT,'checkpoint unavailable'); END");
  await br.evaluate("window.alert = text => window.restoreError = text; document.getElementById('reviewRestore').click()");
  await br.waitFor('Boolean(window.restoreError) || window.__cg.at === 0');
  assert.match(await br.evaluate("String(window.restoreError)"), /checkpoint unavailable/);
  assert.equal(await br.evaluate('window.__cg.at'), eventId);
  db.exec('DROP TRIGGER fail_checkpoint');
  await br.evaluate("document.getElementById('reviewRestore').click()");
  await br.waitFor('window.__cg.at === 0 && window.__cg.root === ' + JSON.stringify(historical));
  const cp = (await get('/api/events?detail=1')).events.find(e => e.target === '恢复前自动快照');
  assert.deepEqual(cp?.after.view.expansions, [{ root: latest, up: 0, down: 0 }]);
  await review(cp.id);
  await br.evaluate("document.getElementById('reviewRestore').click()");
  await br.waitFor('window.__cg.at === 0 && window.__cg.view.nodes.some(n => n.id === ' + JSON.stringify(latest) + ')');
  assert.deepEqual((await get('/api/page?saved=1')).page.expansions, cp.after.view.expansions);
  const unnamed = await post('/api/view-event', { op: 'view.checkpoint', view: cp.after.view });
  await review(unnamed.eventId);
});
