import path from 'node:path';
import fs from 'node:fs';
import { loadModel, stats, subgraph } from '../core/index.js';

const target = process.argv[2] || 'samples/tcu';
const root = path.resolve(target);

if (!fs.existsSync(root)) {
  console.error(`路径不存在: ${root}`);
  process.exit(1);
}

const model = loadModel(root);
const s = stats(model);

const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log('=== 工程画像 ===');
console.log(`根目录        ${root}`);
console.log(`文件          ${s.files}  函数 ${s.functions}  外部符号 ${s.externals}`);
console.log(`调用边        ${s.edges}  (宏 ${s.macroEdges} / 函数指针 ${s.fnptrEdges} / 未知 ${s.unknownEdges})`);
console.log(`宏定义        ${s.macros}`);
console.log(`最大扇出      ${s.maxFanOut}  ${s.maxFanOutFn}`);
console.log(`最大扇入      ${s.maxFanIn}  ${s.maxFanInFn}`);
console.log(`调用环        ${s.cycles} 组`);
for (const g of s.cycleGroups) console.log(`              ${g.join(' → ')}`);
console.log(`解析耗时      ${s.elapsedMs} ms`);
console.log('');

console.log('=== 函数调用 ===');
for (const fn of model.functions) {
  const out = model.edges.filter((e) => e.from === fn.id);
  if (!out.length) continue;
  console.log(`${fn.name}  (${fn.file}:${fn.line})`);
  for (const e of out) {
    const tag = e.kind === 'direct' ? '' : ` [${e.kind}${e.via ? ':' + e.via : ''}]`;
    const cond = e.cond ? ` {${e.cond}}` : '';
    console.log(`  → ${pad(e.callee, 22)} :${e.line}${tag}${cond}`);
  }
}
console.log('');

console.log('=== 宏表（含调用的） ===');
for (const m of model.macros) {
  if (!/\)/.test(m.raw)) continue;
  console.log(`${m.name}${m.params ? '(' + m.params.join(',') + ')' : ''}  =  ${m.raw}   [${m.file}:${m.line}]`);
}
console.log('');

console.log('=== 函数指针表 ===');
for (const t of model.fnptrTables) {
  console.log(`${t.name}:`);
  for (const [k, v] of Object.entries(t.map)) console.log(`  .${pad(k, 14)} = ${v}`);
}
console.log('');

// 示例：以 Gear_Apply 为中心取子图
const sample = model.functions.find((f) => f.name === 'Gear_Apply');
if (sample) {
  const g = subgraph(model, sample.id, { up: 1, down: 2 });
  console.log(`=== 子图示例：${sample.name} 上1层/下2层 ===`);
  console.log(`节点 ${g.nodes.length}  边 ${g.edges.length}`);
  console.log(g.nodes.map((n) => n.name).join(', '));
  console.log('');
}

fs.mkdirSync('out', { recursive: true });
const dump = {
  ...model,
  functions: model.functions.map(({ bodyTokens, ...rest }) => rest),
  _index: undefined,
};
fs.writeFileSync('out/graph.json', JSON.stringify(dump, null, 1), 'utf8');
console.log(`已写出 out/graph.json  (${(fs.statSync('out/graph.json').size / 1024).toFixed(1)} KB)`);
