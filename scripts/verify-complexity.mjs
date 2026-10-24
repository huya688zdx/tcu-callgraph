// 布局复杂度度量基准：交叉数 / 并排线带 / 走线总长 / 长宽比 / 每节点端口数
// 用法:
//   node scripts/verify-complexity.mjs                    度量并写 .verify-tmp/complexity.json
//   node scripts/verify-complexity.mjs --save-baseline    写 .verify-tmp/complexity-baseline.json
//   node scripts/verify-complexity.mjs --compare <file>   与基线比较：任一视图交叉 > 基线*1.15
//                                                         或合计总分 > 基线*1.03 时 exit 1
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, subgraph } from '../src/core/index.js';
import { layout, layoutGrouped, routeLengthAndCrossings } from '../src/core/layout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const VIEWS = [
  { id: 'tcu-main-d5', sample: 'samples/tcu', root: 'main.c::main', up: 0, down: 5, group: true },
  { id: 'tcu-taskshift-u2d3', sample: 'samples/tcu', root: 'main.c::Task_Shift', up: 2, down: 3, group: true },
  { id: 'tcu-systick-d3', sample: 'samples/tcu', root: 'main.c::SysTick_Handler', up: 0, down: 3, group: true },
  { id: 'tcu-gearretry-flat', sample: 'samples/tcu', root: 'gear.c::Gear_Retry', up: 0, down: 3, group: false },
  { id: 'deep-main-d3', sample: 'samples/deep', root: 'src/app/main.c::main', up: 0, down: 3, group: true },
  { id: 'deep-systick-d3', sample: 'samples/deep', root: 'src/app/main.c::SysTick_Handler', up: 0, down: 3, group: true },
];

const modelCache = new Map();
const modelOf = (sample) => {
  if (!modelCache.has(sample)) modelCache.set(sample, loadModel(path.join(ROOT, sample)));
  return modelCache.get(sample);
};

function measure(view) {
  const model = modelOf(view.sample);
  const g = subgraph(model, view.root, { up: view.up, down: view.down, maxNodes: 600 });
  const nodes = g.nodes.map(({ bodyTokens, ...rest }) => rest);
  const laid = view.group
    ? layoutGrouped(nodes, g.edges, { rootLabel: path.basename(view.sample) })
    : layout(nodes, g.edges);

  const m = routeLengthAndCrossings(laid.edges || g.edges);

  // 并排带：横段按 y 排序，相邻 24px 内凑成带，带内段数 >= 3 记 1 带
  const hSegs = [];
  for (const e of laid.edges || []) {
    const pts = e.points || [];
    for (let i = 0; i < pts.length - 1; i++) {
      if (Math.abs(pts[i][1] - pts[i + 1][1]) < 0.5) hSegs.push(pts[i][1]);
    }
  }
  hSegs.sort((a, b) => a - b);
  let bands = 0;
  let run = [];
  const flush = () => {
    if (run.length >= 3) bands++;
  };
  for (const y of hSegs) {
    if (!run.length || y - run[run.length - 1] <= 24) run.push(y);
    else {
      flush();
      run = [y];
    }
  }
  flush();

  // 每节点端口数：全部边的起/终点按节点去重
  const portsOf = new Map();
  const bump = (id, key) => {
    if (!portsOf.has(id)) portsOf.set(id, new Set());
    portsOf.get(id).add(key);
  };
  for (const e of laid.edges || []) {
    const pts = e.points || [];
    if (pts.length) {
      bump(e.from, pts[0].join(','));
      bump(e.to, pts[pts.length - 1].join(','));
    }
  }
  let maxPorts = 0;
  for (const s of portsOf.values()) maxPorts = Math.max(maxPorts, s.size);

  const aspect = laid.width / Math.max(1, laid.height);
  const score =
    m.crossings * 10 +
    bands * 6 +
    m.length / 2000 +
    Math.max(0, Math.abs(Math.log(aspect)) - 0.3) * 30 +
    maxPorts * 0.5;

  return {
    id: view.id,
    nodes: nodes.length,
    edges: (laid.edges || g.edges).length,
    crossings: m.crossings,
    bands,
    length: Math.round(m.length),
    aspect: Number(aspect.toFixed(2)),
    maxPorts,
    score: Number(score.toFixed(1)),
  };
}

const results = VIEWS.map(measure);
const total = Number(results.reduce((s, r) => s + r.score, 0).toFixed(1));
const payload = { total, views: results };

const args = process.argv.slice(2);
const outFile = path.join(ROOT, '.verify-tmp', 'complexity.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });

if (args.includes('--save-baseline')) {
  fs.writeFileSync(path.join(ROOT, '.verify-tmp', 'complexity-baseline.json'), JSON.stringify(payload, null, 2));
  console.log('基线已保存 total=' + total);
} else if (args.includes('--compare')) {
  const idx = args.indexOf('--compare');
  const baseFile = args[idx + 1] || path.join(ROOT, '.verify-tmp', 'complexity-baseline.json');
  const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  const baseById = new Map(base.views.map((v) => [v.id, v]));
  // 基线视图集必须齐：少视图说明基线损坏或样本变了，对照无从谈起
  const missing = base.views.filter((b) => !results.some((v) => v.id === b.id)).map((b) => b.id);
  if (missing.length) {
    console.error('FAIL: 基线里的视图本次没有度量出来：' + missing.join(', '));
    process.exit(2);
  }
  let bad = 0;
  for (const v of results) {
    const b = baseById.get(v.id);
    // crossings 允许 ±15% 噪声（score 里 crossings*10 会让小波动放大，故总分用合计口径）
    const mark = v.crossings > b.crossings * 1.15 ? ' ✗交叉升高' : '';
    console.log(`${v.id}: crossings ${b.crossings}→${v.crossings}  bands ${b.bands}→${v.bands}  len ${b.length}→${v.length}  aspect ${b.aspect}→${v.aspect}  score ${b.score}→${v.score}${mark}`);
    if (v.crossings > b.crossings * 1.15) bad++;
  }
  console.log(`total ${base.total} → ${total}`);
  if (total > base.total * 1.03 || bad > 0) {
    console.log('FAIL: 复杂度劣化');
    process.exit(1);
  }
  console.log('PASS');
} else {
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
}
