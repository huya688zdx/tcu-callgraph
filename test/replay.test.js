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
import { launchServer } from '../scripts/lib/server.mjs';

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
    up: 1,
    down: 2,
    group: false,
    fixed: false,
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
    up: 1,
    down: 2,
    group: false,
    fixed: false,
    vars: ['g_ops_4at'],
  });
});
