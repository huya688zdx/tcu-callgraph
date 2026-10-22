/**
 * 连线标签的服务端行为（走真实 HTTP）。
 *
 * 纯几何在 test/labels.test.js；这里只管「写进库再读出来」这条链路：
 *   1. 外部写入（MCP / 脚本）只给 preset 时，结合点编号要自动递增、样式要跟预设一致；
 *   2. 标签要能跟着时间轴回放、跟着 .cgx 会话一起搬走。
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

const edgeKeyOf = (e) => `${e.from}->${e.to}:${e.line}`;

async function firstEdges(base, n = 3) {
  const v = await (await fetch(`${base}/api/view?root=main.c::main`)).json();
  return v.edges.slice(0, n).map(edgeKeyOf);
}

test('连线标签：外部写入只给 preset 时，结合点编号自动递增且样式跟预设一致', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const base = srv.baseUrl;

  const keys = await firstEdges(base, 3);
  for (const k of keys) {
    const r = await jsonPost(base, '/api/overlay', { edgeKey: k, data: { label: { preset: 'conn' } } });
    assert.equal(r.ok, true);
  }

  const v = await (await fetch(`${base}/api/view?root=main.c::main`)).json();
  const labels = v.edges.filter((e) => e.label).map((e) => e.label);
  assert.deepEqual(
    labels.map((l) => l.num),
    [1, 2, 3],
    '三条结合点不能全叫「結合点：1」'
  );
  assert.equal(labels[0].text, '結合点：1');
  // 红框红字：预设样式必须跟着走，否则 MCP 写的标签和界面里长得不一样
  assert.equal(labels[0].border, '#C0392B');
  assert.equal(labels[0].color, '#C0392B');
});

test('连线标签：显式编号被尊重，非法颜色降级', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const base = srv.baseUrl;

  const [k1] = await firstEdges(base, 1);
  await jsonPost(base, '/api/overlay', {
    edgeKey: k1,
    data: { label: { preset: 'conn', num: 7, border: 'javascript:alert(1)', color: '#00ff00' } },
  });

  const v = await (await fetch(`${base}/api/view?root=main.c::main`)).json();
  const l = v.edges.find((e) => e.label).label;
  assert.equal(l.num, 7);
  assert.equal(l.text, '結合点：7');
  assert.equal(l.border, null, '非法边框色要降级成无边框');
  assert.equal(l.color, '#00ff00');
});

test('连线标签：能跟着时间轴回放，也能跟着 .cgx 会话搬走', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const base = srv.baseUrl;

  const [k1] = await firstEdges(base, 1);
  await jsonPost(base, '/api/overlay', {
    edgeKey: k1,
    data: { label: { preset: 'task', text: 'TASK:2ms' } },
  });

  // 回放：at=最新 必须能还原出标签
  const latest = (await (await fetch(`${base}/api/events?limit=1`)).json()).latest;
  const rep = await (await fetch(`${base}/api/view?root=main.c::main&at=${latest}`)).json();
  const repLabel = rep.edges.find((e) => e.label)?.label;
  assert.ok(repLabel, '回放里应该有标签');
  assert.equal(repLabel.text, 'TASK:2ms');

  // 会话导出 → 导入另一个库 → 标签还在
  const sess = await (await fetch(`${base}/api/session/export`)).json();
  assert.ok(sess.overlay.edges[k1].label, '.cgx 里要带标签');

  const srv2 = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv2.close());
  const r = await jsonPost(srv2.baseUrl, '/api/session/import', sess);
  assert.equal(r.ok, true);
  const v2 = await (await fetch(`${srv2.baseUrl}/api/view?root=main.c::main`)).json();
  const moved = v2.edges.find((e) => e.label)?.label;
  assert.ok(moved, '导入后标签应该还在');
  assert.equal(moved.text, 'TASK:2ms');
});
