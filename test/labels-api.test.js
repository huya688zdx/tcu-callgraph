/**
 * 连线标签的服务端行为（走真实 HTTP）。
 *
 * 纯几何在 test/labels.test.js；这里只管「写进库再读出来」这条链路：
 *   1. 外部写入（MCP / 脚本）只给 preset 时，结合点编号要自动递增、样式要跟预设一致；
 *   2. 标签要能跟着时间轴回放、跟着 .cgx 会话一起搬走。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  //（落库统一为 labels 数组；兼容旧库里可能还是单条 label 的情况）
  const sess = await (await fetch(`${base}/api/session/export`)).json();
  const raw = sess.overlay.edges[k1] || {};
  assert.ok(raw.labels?.[0] || raw.label, '.cgx 里要带标签');

  const srv2 = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv2.close());
  const r = await jsonPost(srv2.baseUrl, '/api/session/import', sess);
  assert.equal(r.ok, true);
  const v2 = await (await fetch(`${srv2.baseUrl}/api/view?root=main.c::main`)).json();
  const moved = v2.edges.find((e) => e.label)?.label;
  assert.ok(moved, '导入后标签应该还在');
  assert.equal(moved.text, 'TASK:2ms');
});

test('多标签：一线多条整组替换、note 随行、旧字段清空', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const base = srv.baseUrl;
  const [k1] = await firstEdges(base, 1);

  const w = await jsonPost(base, '/api/overlay', {
    edgeKey: k1,
    data: {
      labels: [
        { preset: 'task', text: 'TASK:2ms' },
        { preset: 'conn', num: 5, note: '换挡请求入口' },
      ],
    },
  });
  assert.equal(w.ok, true);
  let v = await (await fetch(`${base}/api/view?root=main.c::main`)).json();
  const e1 = v.edges.find((e) => edgeKeyOf(e) === k1);
  assert.equal(e1.labels.length, 2, '一线应能挂两条');
  assert.equal(e1.labels[1].note, '换挡请求入口');
  assert.equal(e1.labels[1].text, '結合点：5', '结合点文字随编号走');
  assert.ok(e1.labels.every((l) => l.id), '每条标签都该有稳定 id');

  // 旧字段 label=null = 清空全部（与旧客户端兼容）
  await jsonPost(base, '/api/overlay', { edgeKey: k1, data: { label: null } });
  v = await (await fetch(`${base}/api/view?root=main.c::main`)).json();
  assert.ok(!v.edges.find((e) => edgeKeyOf(e) === k1).labels, '旧字段 null 应清空整组');
});

test('结合点编号：固定/重排模式配置 + 重排端点（含回放一致）', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const base = srv.baseUrl;
  const [k1, k2, k3] = await firstEdges(base, 3);

  // 默认固定
  assert.equal((await (await fetch(base + '/api/labels/config')).json()).mode, 'fixed');
  // 改成重排能读回
  await jsonPost(base, '/api/labels/config', { mode: 'renumber' });
  assert.equal((await (await fetch(base + '/api/labels/config')).json()).mode, 'renumber');
  await jsonPost(base, '/api/labels/config', { mode: 'fixed' });

  // 三个结合点 2/3/5（1、4 空缺）
  await jsonPost(base, '/api/overlay', { edgeKey: k1, data: { labels: [{ preset: 'conn', num: 2 }] } });
  await jsonPost(base, '/api/overlay', { edgeKey: k2, data: { labels: [{ preset: 'conn', num: 3 }] } });
  await jsonPost(base, '/api/overlay', { edgeKey: k3, data: { labels: [{ preset: 'conn', num: 5 }] } });
  let v = await (await fetch(`${base}/api/view?root=main.c::main`)).json();
  const ids = {};
  for (const e of v.edges) {
    for (const l of e.labels || []) if (l.preset === 'conn') ids[edgeKeyOf(e)] = l.id;
  }

  const rn = await jsonPost(base, '/api/labels/renumber', {
    items: [
      { edgeKey: k1, id: ids[k1], num: 1 },
      { edgeKey: k2, id: ids[k2], num: 2 },
      { edgeKey: k3, id: ids[k3], num: 3 },
    ],
  });
  assert.equal(rn.ok, true);
  assert.equal(rn.changed, 3);

  v = await (await fetch(`${base}/api/view?root=main.c::main`)).json();
  const nums = {};
  for (const e of v.edges) for (const l of e.labels || []) if (l.preset === 'conn') nums[edgeKeyOf(e)] = l.num;
  assert.deepEqual([nums[k1], nums[k2], nums[k3]], [1, 2, 3]);
  const text1 = v.edges.find((e) => edgeKeyOf(e) === k1).labels.find((l) => l.preset === 'conn').text;
  assert.equal(text1, '結合点：1', '编号变了文字要跟着变');

  // 重排事件可回放：at=最新 的视图与当前一致
  const latest = (await (await fetch(base + '/api/events?limit=1')).json()).latest;
  const rep = await (await fetch(`${base}/api/view?root=main.c::main&at=${latest}`)).json();
  const repNums = {};
  for (const e of rep.edges) for (const l of e.labels || []) if (l.preset === 'conn') repNums[edgeKeyOf(e)] = l.num;
  assert.deepEqual([repNums[k1], repNums[k2], repNums[k3]], [1, 2, 3]);
});

test('自动检测：samples/tcu 找出 TASK 周期与コール順 建议', async (t) => {
  const srv = await launchServer({ target: 'samples/tcu' });
  t.after(() => srv.close());
  const base = srv.baseUrl;

  const r = await (await fetch(base + '/api/detect-tasks')).json();
  assert.equal(r.ok, true);
  const tasks = r.suggestions.filter((s) => s.kind === 'task');
  const calls = r.suggestions.filter((s) => s.kind === 'call');
  assert.ok(tasks.some((s) => /TASK:10ms/.test(s.text)), '应从函数名认出 Task_10ms');
  assert.ok(tasks.some((s) => /TASK:100ms/.test(s.text)), '应认出 Task_100ms');
  assert.ok(calls.length > 0, '同一函数内应给出コール順建议');
  assert.ok(r.suggestions.every((s) => s.edgeKey && s.preset && s.evidence), '每条建议都带 edgeKey 与证据');
});

async function callOrderSample(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-call-order-'));
  fs.writeFileSync(path.join(root, 'order.c'), `
int g_state = 0;
int Leaf(void) { return 1; }
int Child(int value) { Leaf(); Leaf(); return value; }
int Plain(void) { Child(1); g_state = 1; Leaf(); Child(2); return 0; }
void Task_10ms(void) { Plain(); Leaf(); }
void Nested(void) { Child(Leaf()); Plain(); }
`);
  const srv = await launchServer({ target: root });
  t.after(async () => {
    await srv.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'cg-call-order-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return (name) => fetch(`${srv.baseUrl}/api/detect-tasks?from=order.c::${name}`).then((r) => r.json());
}

test('コール順：只编号当前函数内的调用点，同一行及重复调用不丢失，子函数单独编号', async (t) => {
  const detect = await callOrderSample(t);
  const plain = (await detect('Plain')).suggestions.filter((s) => s.kind === 'call');
  assert.deepEqual(plain.map((s) => [s.to, s.text]), [
    ['order.c::Child', 'コール順1,3'], ['order.c::Leaf', 'コール順2'],
  ]);
  assert.ok(plain.every((s) => s.from === 'order.c::Plain'));
  const task = (await detect('Task_10ms')).suggestions.filter((s) => s.kind === 'call');
  assert.deepEqual(task.map((s) => [s.to, s.text]), [
    ['order.c::Plain', 'コール順1'], ['order.c::Leaf', 'コール順2'],
  ]);
  const child = (await detect('Child')).suggestions.filter((s) => s.kind === 'call');
  assert.deepEqual(child.map((s) => s.text), ['コール順1,2']);
});

test('コール順：嵌套实参调用不强行给出线性执行顺序', async (t) => {
  const detect = await callOrderSample(t);
  const result = await detect('Nested');
  assert.equal(result.suggestions.filter((s) => s.kind === 'call').length, 0);
  assert.ok(result.skipped.some((s) => s.from === 'order.c::Nested' && s.reason.includes('嵌套')));
});
