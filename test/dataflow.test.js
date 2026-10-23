import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseFile, collectGlobals, collectFunctions, collectAccesses } from '../src/core/cparse.js';
import { loadModel } from '../src/core/index.js';
import { dataflowFor } from '../src/core/dataflow.js';

const DEMO = path.resolve(import.meta.dirname, '../samples/demo');

/**
 * 单元口径：collectAccesses 的读写判定。
 * 行号断言与下方源码逐行对应（tree-sitter 行号 1 起），改 fixture 记得同步改断言。
 * 口径出处：11d4de3「&g 取地址或作为实参传出去算 escape，保守当『可能被写』」。
 */
const FIXTURE = `
unsigned short g_rpm;
volatile unsigned int g_tick;
struct tagGear { int ready; int pos; };
struct tagGear g_gear;
void helper(int v);
void direct(void);
void probe(void)
{
    int x;

    g_rpm = 100u;
    g_rpm += 5u;
    g_tick++;
    x = g_rpm;
    if (g_tick > 0u) {
        x = 2;
    }
    x = g_tick % 100u;
    helper(g_rpm);
    struct tagGear *p = &g_gear;
    p->pos = 3;
    x = p->ready;
    direct();
}
`;

async function fixtureAccesses() {
  const rec = await parseFile('test://df-fixture', 'fixture.c', FIXTURE);
  const names = new Set(collectGlobals(rec.root).map((g) => g.name));
  const fn = collectFunctions(rec.root).get('probe');
  return { names, acc: collectAccesses(fn, (n) => names.has(n)) };
}

test('数据流口径：裸标识符读进入读集合（此前整条漏掉）', async () => {
  const { acc } = await fixtureAccesses();
  // L13 += 的读旧值、L15 x = g_rpm 裸读、L20 helper(g_rpm) 实参读；修复前裸读不进 reads
  assert.deepEqual([...acc.reads.get('g_rpm').lines], [13, 15, 20], 'g_rpm 读行应为 13/15/20');
  // L14 ++ 的读侧、L16 g_tick > 0u 条件读、L19 g_tick % 100u 二元读
  assert.deepEqual([...acc.reads.get('g_tick').lines], [14, 16, 19], 'g_tick 读行应为 14/16/19');
});

test('数据流口径：= 纯写、复合赋值与 ++ 读写', async () => {
  const { acc } = await fixtureAccesses();
  // L12 = 纯写；L13 += 写侧；L20 实参 escape 保守写
  assert.deepEqual([...acc.writes.get('g_rpm').lines], [12, 13, 20], 'g_rpm 写行应为 12/13/20');
  assert.ok(acc.writes.get('g_rpm').indirect, '实参转义的写应带 indirect 标记');
  assert.deepEqual([...acc.writes.get('g_tick').lines], [14], 'g_tick 只有 ++ 一处写');
});

test('数据流口径：&g 转义与局部指针别名读写', async () => {
  const { acc } = await fixtureAccesses();
  const w = acc.writes.get('g_gear');
  const r = acc.reads.get('g_gear');
  // L21 声明处 &g_gear 转义、L22 p->pos = 3 经别名写
  assert.deepEqual([...w.lines], [21, 22]);
  assert.deepEqual([...w.fields], ['pos']);
  // L21 转义读 + L23 x = p->ready 经别名读
  assert.deepEqual([...r.lines], [21, 23]);
  assert.deepEqual([...r.fields], ['ready']);
  assert.ok(w.indirect && r.indirect, '别名与转义访问都应标记 indirect');
});

test('数据流口径：函数名与局部变量不进读写集合', async () => {
  const { names, acc } = await fixtureAccesses();
  assert.ok(!names.has('helper'), '函数原型不应被 collectGlobals 当变量');
  for (const map of [acc.writes, acc.reads]) {
    assert.ok(!map.has('helper') && !map.has('direct') && !map.has('probe'), '函数名不算变量访问');
    assert.ok(!map.has('x'), '局部变量不算全局访问');
  }
});

test('数据流端到端：demo 的 App_Task10ms 写 g_tick 能连到跨函数读者', async () => {
  const model = loadModel(DEMO);
  const id = model.functions.find((f) => f.name === 'App_Task10ms').id;
  const r = await dataflowFor(model, id, 'out');

  // 修复回归点：g_tick 的读者（App_Task100ms 的 g_tick % 100u、main 的 g_tick == 0u）
  // 全是裸标识符读，修复前读侧整条漏掉、dataflowFor 返回空
  const tick = r.vars.find((v) => v.name === 'g_tick');
  assert.ok(tick, 'g_tick 链路应出现');
  const peers = tick.peers.map((p) => p.name);
  assert.ok(peers.includes('App_Task100ms') && peers.includes('main'), `读者应含两个任务函数，实际 ${peers}`);

  assert.ok(
    r.edges.some((e) => e.kind === 'df-write' && e.from === id && e.to === 'var::g_tick'),
    '应有 写者→变量 边'
  );
  assert.ok(
    r.edges.some((e) => e.kind === 'df-read' && e.from === 'var::g_tick' && e.to.endsWith('::App_Task100ms')),
    '应有 变量→读者 边'
  );
});

test('数据流边界：按值实参不产生跨函数读者（参数绑定未建模）', async () => {
  const model = loadModel(DEMO);
  const id = model.functions.find((f) => f.name === 'App_Task10ms').id;
  const r = await dataflowFor(model, id, 'out');

  // g_rpm/g_speed 的读只有 App_Task10ms 自己传参那一次（Shift_Check(g_rpm, g_speed)），
  // 数据经实参流入被调方的形参——那是调用边，不是共享变量边。过滤自身后无对端，
  // 链路正确地不出现。若未来做参数绑定建模，本断言应有意改写。
  assert.ok(!r.vars.some((v) => v.name === 'g_rpm' || v.name === 'g_speed'), '按值传参不应凭空造出共享链');
});
