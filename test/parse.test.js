import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadModel, stats } from '../src/core/index.js';

const SAMPLE = path.join(import.meta.dirname, '..', 'samples', 'tcu');

let cached = null;
function tcu() {
  if (!cached) cached = loadModel(SAMPLE);
  return cached;
}

// 2026-10-22 实测金标：functions 21 / edges 32 / files 8。
//
// 为什么 functions/edges 用「下限 + 关键符号存在」而不是严格相等：
// 解析层正在被并行修改（__attribute__ / __declspec 支持、K&R 支持、宏表按文件
// 快照、函数 id 去重）。前两项只会让函数和边变多；后两项会让「跨文件泄漏的宏边」
// 与「重复 id 的函数」变少。用严格相等等于把别人正在修的行为钉死，合法修复会
// 把测试打红，所以这里给 2 个余量，真正的强度由下面的「关键函数 + 关键边」承担。
const GOLDEN = { functions: 21, edges: 32, files: 8 };

test('loadModel(samples/tcu)：函数/边/文件数量在金标区间内', () => {
  const model = tcu();

  assert.ok(
    model.functions.length >= GOLDEN.functions,
    `functions 不应少于金标 ${GOLDEN.functions}，实际 ${model.functions.length}`
  );
  assert.ok(model.functions.length <= 40, `functions 异常膨胀: ${model.functions.length}`);

  // 金标 32 条调用记录 = 31 组节点对 + 1 条同对重复调用（Adc_GetFiltered 里调了两次 Adc_Read）。
  // 留 2 条余量：在途的 kind:'var' 边可能被回退，重复调用也可能被合并。
  assert.ok(
    model.edges.length >= GOLDEN.edges - 2,
    `edges 不应少于 ${GOLDEN.edges - 2}，实际 ${model.edges.length}`
  );
  assert.ok(model.edges.length <= 80, `edges 异常膨胀: ${model.edges.length}`);

  // files 只取决于目录扫描，与解析改动无关，可以严格断言
  assert.equal(model.files.length, GOLDEN.files);
  assert.deepEqual(
    model.files.map((f) => f.rel).sort(),
    ['adc.c', 'adc.h', 'can.c', 'can.h', 'config.h', 'gear.c', 'gear.h', 'main.c']
  );
});

test('loadModel(samples/tcu)：关键函数存在且 id 唯一', () => {
  const model = tcu();
  const ids = new Set(model.functions.map((fn) => fn.id));

  for (const id of [
    'main.c::main',
    'main.c::SysTick_Handler',
    'main.c::Task_10ms',
    'main.c::Task_100ms',
    'main.c::Task_Shift',
    'can.c::Can_Init',
    'can.c::Can_GetRpm',
    'adc.c::Adc_Read',
    'gear.c::Gear_Init',
    'gear.c::Gear_Apply',
    'gear.c::Gear_Retry',
    'gear.c::Gear_ShiftUp',
    'gear.c::Gear_ShiftDown',
  ]) {
    assert.ok(ids.has(id), `缺少函数 ${id}`);
  }

  // 同一函数被 #if/#else 各定义一次时会产生重复 id，导致前端按 id 建索引时丢节点
  assert.equal(ids.size, model.functions.length, 'functions 里存在重复的 id');
});

test('loadModel(samples/tcu)：关键调用边存在（含 macro / fnptr / 回边）', () => {
  const model = tcu();
  const has = (from, to, kind) =>
    model.edges.some((e) => e.from === from && e.to === to && (!kind || e.kind === kind));

  assert.ok(has('main.c::main', 'main.c::Task_100ms', 'direct'));
  assert.ok(has('main.c::main', 'main.c::Task_10ms', 'direct'));
  assert.ok(has('main.c::main', 'can.c::Can_Init', 'direct'));
  assert.ok(has('main.c::Task_10ms', 'main.c::Task_Shift', 'direct'));

  // 宏展开出来的真实调用：READ_ADC(ch) -> Adc_Read
  const macroEdge = model.edges.find(
    (e) => e.from === 'gear.c::Gear_CheckSpeed' && e.to === 'adc.c::Adc_Read' && e.kind === 'macro'
  );
  assert.ok(macroEdge, '缺少 READ_ADC 宏展开出的 macro 边');
  assert.equal(macroEdge.via, 'READ_ADC');

  // 函数指针表间接调用：INVOKE(&g_ops_4at, shift_up) -> Gear_ShiftUp
  const fnptrEdge = model.edges.find(
    (e) => e.from === 'main.c::Task_Shift' && e.to === 'gear.c::Gear_ShiftUp' && e.kind === 'fnptr'
  );
  assert.ok(fnptrEdge, '缺少经 g_ops_4at 的函数指针边');

  // 调用环：Gear_Apply <-> Gear_Retry
  assert.ok(has('gear.c::Gear_Apply', 'gear.c::Gear_Retry'));
  assert.ok(has('gear.c::Gear_Retry', 'gear.c::Gear_Apply'));

  assert.ok(model.edges.some((e) => e.kind === 'macro'), '至少应有 1 条 macro 边');
  assert.ok(model.edges.some((e) => e.kind === 'fnptr'), '至少应有 1 条 fnptr 边');
});

test('loadModel(samples/tcu)：直接/宏/函数指针边的两端都能在索引里解析', () => {
  const model = tcu();
  const byId = model._index.byId;
  // 只校验文档化的三种 kind；在途的 kind:'var' 边（数据流实验）不在本用例范围内
  for (const e of model.edges) {
    if (!['direct', 'macro', 'fnptr'].includes(e.kind)) continue;
    assert.ok(byId.has(e.from), `边 ${e.from}->${e.to} 的源端不在索引里`);
    assert.ok(byId.has(e.to), `边 ${e.from}->${e.to} 的目标端不在索引里`);
  }
});

test('stats(samples/tcu)：计数口径自洽，cycleGroups 稳定', () => {
  const model = tcu();
  const st = stats(model);

  assert.equal(st.functions, model.functions.length);
  assert.equal(st.files, model.files.length);
  assert.equal(st.calls, model.edges.length, 'calls 应等于原始调用记录数');
  const uniquePairs = new Set(model.edges.map((e) => `${e.from}|${e.to}`)).size;
  assert.equal(st.edges, uniquePairs, 'edges 应按节点对去重');
  assert.ok(st.edges <= st.calls);
  assert.equal(st.macroEdges, model.edges.filter((e) => e.kind === 'macro').length);
  assert.equal(st.fnptrEdges, model.edges.filter((e) => e.kind === 'fnptr').length);
  assert.ok(st.macroEdges >= 1 && st.fnptrEdges >= 1);

  // 金标：唯一的强连通分量是 gear.c 里的 Gear_Apply <-> Gear_Retry 双人环。
  // 排序后再比，避免 tarjan 遍历顺序变化造成的假失败。
  assert.deepEqual(
    st.cycleGroups.map((g) => [...g].sort()),
    [['gear.c::Gear_Apply', 'gear.c::Gear_Retry']]
  );
  assert.equal(st.cycles, 1);
});
