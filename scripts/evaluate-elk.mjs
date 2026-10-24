// 布局对比评估，不被应用导入；使用项目安装的 ELK 依赖。
// 运行：node scripts/evaluate-elk.mjs；单例：node scripts/evaluate-elk.mjs tcu-main-d3
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { loadModel, subgraph } from '../src/core/index.js';
import { buildDataflowIndex } from '../src/core/dataflow.js';
import { layoutGrouped, routeLengthAndCrossings } from '../src/core/layout.js';
import { optimizeCrossings } from '../src/core/optimize.js';
import { graphOf, converted, facesOf } from '../src/core/layout-elk.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const runtime = path.join(ROOT, 'node_modules/elkjs');
const ELK = require(path.join(runtime, 'lib/elk.bundled.js'));
const pkg = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8'));
const elk = new ELK();
const OUT = path.join(ROOT, 'out/elk-evaluation');
fs.mkdirSync(OUT, { recursive: true });
const clone = (value) => structuredClone(value);
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const round = (n) => Math.round(n * 100) / 100;
// 与画布一致：普通、宏、函数指针调用都是实线；变量是虚线，数据流另有颜色。
const visibleEdge = (e) => ({ ...e, kind: e.kind === 'var' || e.kind?.startsWith('df-') ? e.kind : 'direct' });
const styleKey = (e) => `${visibleEdge(e).kind}|${e.change || 'existing'}`;
const cases = [
  { id: 'tcu-main-d3', sample: 'tcu', root: 'main.c::main', down: 3 },
  { id: 'tcu-vars-d3', sample: 'tcu', root: 'main.c::main', down: 3, variables: true },
  { id: 'tcu-colors-d3', sample: 'tcu', root: 'main.c::main', down: 3, colors: true },
  { id: 'tcu-main-d5', sample: 'tcu', root: 'main.c::main', down: 5 },
  { id: 'deep-main-d3', sample: 'deep', root: 'src/app/main.c::main', down: 3 },
  { id: 'demo-all', sample: 'demo', all: true },
  { id: 'large-80', sample: 'large', down: 4, limit: 80 },
];

function cleanEdges(edges) {
  return edges.map(({ points, fromSide, toSide, custom, _p0, _p1, ...e }) => ({ ...e, change: e.change || 'existing' }));
}

async function inputOf(spec) {
  const model = loadModel(path.join(ROOT, 'samples', spec.sample));
  const g = spec.all ? { nodes: model.functions, edges: model.edges } :
    subgraph(model, spec.root || model.functions[0].id, { up: 0, down: spec.down, maxNodes: spec.limit || 600 });
  const nodes = g.nodes.map(({ bodyTokens, ...n }) => n);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = cleanEdges(g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)));
  if (spec.colors) edges.find((e) => e.from === 'main.c::Task_Shift' && e.to === 'can.c::Can_GetRpm').change = 'added';
  if (spec.variables) {
    const df = await buildDataflowIndex(model);
    const variable = df.defs.find((v) => v.name === 'g_gearCtx');
    if (!variable) throw new Error('样本缺少 g_gearCtx，不能完成变量评估');
    nodes.push({ ...variable, kind: 'var' });
    const users = new Set([...(df.writers.get(variable.id) || []), ...(df.readers.get(variable.id) || [])]);
    for (const from of users) if (ids.has(from))
      edges.push({ from, to: variable.id, kind: 'var', line: 0, change: 'existing' });
  }
  return { nodes, edges };
}

function metrics(view) {
  const raw = routeLengthAndCrossings(view.edges.map(visibleEdge));
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  let badPorts = 0, detached = 0, diagonal = 0, nodeOverlap = 0, bodyHits = 0, hierarchy = 0;
  const overlap = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
  for (let i = 0; i < view.nodes.length; i++) for (let j = i + 1; j < view.nodes.length; j++)
    if (overlap(view.nodes[i], view.nodes[j])) nodeOverlap++;
  for (const n of view.nodes) {
    const g = view.groups.find((g) => g.id === n.file);
    if (!g || n.x < g.x - .5 || n.y < g.y + 26 - .5 || n.x + n.w > g.x + g.w + .5 || n.y + n.h > g.y + g.h + .5) hierarchy++;
  }
  for (const e of view.edges) {
    for (const [id, p] of [[e.from, e.points[0]], [e.to, e.points.at(-1)]]) {
      const n = byId.get(id);
      const ports = [[n.x + n.w / 2, n.y], [n.x + n.w / 2, n.y + n.h], [n.x, n.y + n.h / 2], [n.x + n.w, n.y + n.h / 2]];
      if (!ports.some((q) => Math.abs(q[0] - p[0]) < .5 && Math.abs(q[1] - p[1]) < .5)) badPorts++;
      const inX = p[0] >= n.x - .5 && p[0] <= n.x + n.w + .5, inY = p[1] >= n.y - .5 && p[1] <= n.y + n.h + .5;
      if (!(inX && inY && (Math.abs(p[0] - n.x) < .5 || Math.abs(p[0] - n.x - n.w) < .5 ||
        Math.abs(p[1] - n.y) < .5 || Math.abs(p[1] - n.y - n.h) < .5))) detached++;
    }
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1], b = e.points[i];
      if (Math.abs(a[0] - b[0]) > .5 && Math.abs(a[1] - b[1]) > .5) diagonal++;
      for (const n of view.nodes) {
        const h = Math.abs(a[1] - b[1]) < .5 && a[1] > n.y + .5 && a[1] < n.y + n.h - .5 &&
          Math.max(a[0], b[0]) > n.x + .5 && Math.min(a[0], b[0]) < n.x + n.w - .5;
        const v = Math.abs(a[0] - b[0]) < .5 && a[0] > n.x + .5 && a[0] < n.x + n.w - .5 &&
          Math.max(a[1], b[1]) > n.y + .5 && Math.min(a[1], b[1]) < n.y + n.h - .5;
        if (h || v) bodyHits++;
      }
    }
  }
  return { nodes: view.nodes.length, edges: view.edges.length, crossings: raw.crossings, length: round(raw.length),
    rawLength: round(raw.rawLength), bends: raw.bends, forbiddenOverlap: round(raw.overlapLength),
    aspect: round(view.width / view.height), area: Math.round(view.width * view.height),
    badPorts, detached, diagonal, nodeOverlap, bodyHits, hierarchy };
}

function svg(view, title) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${view.width + 20}" height="${view.height + 40}" viewBox="0 -20 ${view.width + 20} ${view.height + 40}" font-family="Segoe UI,Microsoft YaHei,sans-serif">`,
    `<rect x="0" y="-20" width="100%" height="100%" fill="#fafaf8"/><text x="12" y="0" font-size="14">${esc(title)}</text>`,
    '<defs>' + ['333', 'd9303e', 'c2410c', '0e7490'].map((c) => `<marker id="arrow-${c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="#${c}"/></marker>`).join('') + '</defs>'];
  for (const g of [...view.containers, ...view.groups]) parts.push(`<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="9" fill="#e8f2fb" fill-opacity=".5" stroke="#9fc7ee"/><text x="${g.x + 10}" y="${g.y + 20}" fill="#14578b" font-size="13">${esc(g.label)}</text>`);
  for (const e of view.edges) {
    const color = e.change === 'added' ? '#d9303e' : e.kind === 'df-write' ? '#c2410c' : e.kind === 'df-read' ? '#0e7490' : '#333';
    const dash = e.kind === 'var' ? ' stroke-dasharray="7 4"' : e.kind?.startsWith('df-') ? ' stroke-dasharray="3 3"' : '';
    parts.push(`<path d="M${e.points.map((p) => p.join(',')).join(' L')}" fill="none" stroke="${color}" stroke-width="1.2"${dash} marker-end="url(#arrow-${color.slice(1)})"/>`);
  }
  for (const n of view.nodes) parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="7" fill="#cfc" stroke="#555" stroke-dasharray="5 3"/><text x="${n.x + n.w / 2}" y="${n.y + n.h / 2 - 4}" text-anchor="middle" font-size="12">${esc(n.name || n.id)}${n.kind === 'var' ? '' : '()'}</text><text x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + 12}" text-anchor="middle" font-size="10" fill="#888">${esc(n.file)}:${n.line || ''}</text>`);
  return parts.join('\n') + '</svg>';
}

const results = [];
for (const spec of cases.filter((c) => !process.argv[2] || c.id === process.argv[2])) {
  const input = await inputOf(spec);
  const start = performance.now();
  const baseline = layoutGrouped(clone(input.nodes), clone(input.edges), { rootLabel: spec.sample });
  optimizeCrossings(baseline.nodes, baseline.edges, { groupBoxes: new Map(baseline.groups.map((g) => [g.id, g])) });
  const variants = [{ name: 'current', view: baseline, ms: performance.now() - start }];
  const dimensions = baseline.nodes.map((n) => ({ ...n }));
  for (const direction of ['DOWN', 'RIGHT']) {
    const t = performance.now();
    const seed = converted(await elk.layout(graphOf(dimensions, input.edges, direction)), dimensions, input.edges);
    const seedMs = performance.now() - t;
    if (direction === 'DOWN') variants.push({ name: 'elk-free', view: seed, ms: seedMs });
    // 第一轮由 ELK 选面；第二轮只将该面上的连接点收紧到中点，仍完全使用 ELK 布线。
    const fixed = converted(await elk.layout(graphOf(dimensions, input.edges, direction, facesOf(seed))), dimensions, input.edges);
    variants.push({ name: 'elk-four-' + direction.toLowerCase(), view: fixed, ms: performance.now() - t });
    const styleStart = performance.now();
    const styled = converted(await elk.layout(graphOf(dimensions, input.edges, direction, facesOf(seed), true)), dimensions, input.edges);
    variants.push({ name: 'elk-style-' + direction.toLowerCase(), view: styled, ms: seedMs + performance.now() - styleStart });
  }
  for (const variant of variants) {
    const result = { case: spec.id, engine: variant.name, ...metrics(variant.view), ms: round(variant.ms) };
    results.push(result);
    fs.writeFileSync(path.join(OUT, spec.id + '-' + variant.name + '.svg'), svg(variant.view, spec.id + ' / ' + variant.name));
    fs.writeFileSync(path.join(OUT, spec.id + '-' + variant.name + '.json'), JSON.stringify(variant.view));
    console.log(JSON.stringify(result));
  }
}
fs.writeFileSync(path.join(OUT, 'results' + (process.argv[2] ? '-' + process.argv[2] : '') + '.json'), JSON.stringify({
  runtime: { version: pkg.version, license: pkg.license, selectedLicense: 'EPL-2.0' },
  generated: new Date().toISOString(),
  baselineHashes: Object.fromEntries(['layout', 'routing', 'optimize'].map((name) => [name,
    createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src/core', name + '.js'))).digest('hex')])),
  results,
}, null, 2));

// 输出同一图的并排预览；各自等比例缩放，不靠拉伸让比例看起来更好。
for (const spec of cases.filter((c) => results.some((r) => r.case === c.id))) {
  const panels = ['current', 'elk-style-right'].map((engine, i) => {
    const view = JSON.parse(fs.readFileSync(path.join(OUT, spec.id + '-' + engine + '.json'), 'utf8'));
    const source = svg(view, engine).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    const m = results.find((r) => r.case === spec.id && r.engine === engine);
    const x = 20 + i * 790;
    return `<text x="${x}" y="70" font-size="18">${i ? 'ELK 四中点、按样式分组（右向）' : '原布局算法'}</text>` +
      `<text x="${x}" y="100" font-size="14">交叉 ${m.crossings} · 折弯 ${m.bends} · 比例 ${m.aspect} · 不应重叠线长 ${m.forbiddenOverlap}</text>` +
      `<svg x="${x}" y="125" width="770" height="740" viewBox="0 -20 ${view.width + 20} ${view.height + 40}">${source}</svg>`;
  });
  fs.writeFileSync(path.join(OUT, spec.id + '-comparison.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" font-family="Segoe UI,Microsoft YaHei,sans-serif"><rect width="100%" height="100%" fill="#fff"/><text x="20" y="30" font-size="20">${esc(spec.id)}：相同节点、尺寸、调用关系</text>${panels.join('')}</svg>`);
}

const names = { current: '原布局算法', 'elk-free': 'ELK 自由端口（控制组）', 'elk-four-down': 'ELK 四中点/下向',
  'elk-four-right': 'ELK 四中点/右向', 'elk-style-down': 'ELK 四中点+样式/下向', 'elk-style-right': 'ELK 四中点+样式/右向' };
const report = [
  '# ELK 布局核心评估', '', '日期：' + new Date().toISOString().slice(0, 10) + '。版本：elkjs ' + pkg.version + '。本脚本只对比算法，不读写用户布局存档；应用已默认接入 ELK。', '',
  '## 结论', '',
  '开源、可按 EPL-2.0 商用，已接入应用。本报告仅覆盖自动布局对照，不能作为所有交互和排版约束均已达标的证明。', '',
  '小图上可减少交叉和线长，大图的改善更明显。但四中点约束下仍有不应合并的共线段，部分图的宽高比偏离方形，部分图的交叉比现有引擎更多。不能只拿自由端口或低交叉的截图作为达标证明。', '',
  '## 许可', '',
  '- 安装包声明 EPL-2.0 OR GPL-3.0-or-later，本次选择 EPL-2.0；未修改库本体。',
  '- EPL-2.0 允许商业使用和分发。分发时需保留许可及版权声明，并提供对应库源码的合理获取方式；修改库本体后分发时，修改部分需满足 EPL 的源码提供要求。',
  '- 独立的调用接口和业务代码不会仅因调用该库就自动成为其修改作品；复制、修改库代码的情况需另行判断。',
  '- [项目许可证](https://github.com/kieler/elkjs/blob/master/LICENSE.md)，安装包的完整许可已复制为 [elkjs-LICENSE.md](./elkjs-LICENSE.md)。', '',
  '## 对照方法', '',
  '- 两侧使用相同函数、调用关系、函数框尺寸、文件/目录层级；全部重新自动布局，不读取旧端口锁定或手工折线。',
  '- large-80 来自仓库生成的压力样本，不是用户生产工程；结果用于检查复杂图的扩展能力。',
  '- 基线是仓库保留的原布局算法，使用其默认优化预算。ELK 随机种子固定为 1；对照结果未用原路由器修补 ELK 输出。',
  '- ELK 控制组允许自由端口；四中点组先由 ELK 自由布局选出边的朝向，再固定到对应边中点重新布局。',
  '- 样式组按实际界面颜色/虚实区分逻辑端口，但所有逻辑端口的坐标仍仅为四个边中点。物理端点没有增加。',
  '- 普通、宏及函数指针调用在当前画布都是黑色实线，不按内部 kind 误判为不同样式。新增红线、变量虚线和不同颜色的数据流分别计分。',
  '- “不应重叠线长”包括不同样式长线段以及没有可合并关系的共线段；共同节点附近 15px 引出段除外。',
  '- 检查了居中端点、端点脱离、斜线、节点重叠、穿框及文件包含关系；指标的原始数据见 results.json。',
  '- TCU 颜色组仅把真实存在的 Task_Shift → Can_GetRpm 调用标为新增，模拟红黑混合；未写入用户标注。',
  '- 耗时为本机单次试跑，ELK 四中点结果计入两轮计算；现有引擎带时间预算，重复运行可能得到不同路径，不能视为稳定性能保证。', '',
  '## 统一右向候选对照', '',
  '以下固定展示 ELK 四中点+样式/右向，未逐图挑选最有利方向；下向结果在完整表中。', '',
  '| 图 | 节点/边 | 交叉：现有→ELK | 折弯：现有→ELK | 线长：现有→ELK | 宽高比：现有→ELK | 不应重叠线长：现有→ELK |',
  '|---|---:|---:|---:|---:|---:|---:|',
];
for (const id of [...new Set(results.map((r) => r.case))]) {
  const a = results.find((r) => r.case === id && r.engine === 'current');
  const b = results.find((r) => r.case === id && r.engine === 'elk-style-right');
  report.push(`| [${id}](./${id}-comparison.svg) | ${a.nodes}/${a.edges} | ${a.crossings}→${b.crossings} | ${a.bends}→${b.bends} | ${a.length}→${b.length} | ${a.aspect}→${b.aspect} | ${a.forbiddenOverlap}→${b.forbiddenOverlap} |`);
}
report.push('', '## 完整结果', '', '| 图 | 配置 | 交叉 | 线长 | 折弯 | 不应重叠 | 宽高比 | 非中点端点 | 脱离/斜线/节点重叠/穿框/包含错误 | 毫秒 |', '|---|---|---:|---:|---:|---:|---:|---:|---|---:|');
for (const r of results) report.push(`| ${r.case} | [${names[r.engine]}](./${r.case}-${r.engine}.svg) | ${r.crossings} | ${r.length} | ${r.bends} | ${r.forbiddenOverlap} | ${r.aspect} | ${r.badPorts} | ${r.detached}/${r.diagonal}/${r.nodeOverlap}/${r.bodyHits}/${r.hierarchy} | ${r.ms} |`);
report.push('', '## 迁移边界与下一步', '',
  '本脚本对比 ELK 的全局分层、嵌套及正交布线能力。应用的默认排版与拖动接入说明见 [ELK 接入](../../docs/ELK接入.md)。', '',
  '后续仍需改善不同样式的共线段、图比例控制等约束。应用拖动时优先保留原走廊、调整端部，遇到碰撞才重新寻路；本报告只比较初始自动排版。', '',
  '本脚本不覆盖手工位置保持、双击导航、拖动交互、标注避让及多段边显示；交互行为需单独验证。', '',
  '另用官方 MULTI_EDGE 包裹选项试过 80 节点嵌套图，本次输入下结果没有变化；因此没有把它当成已解决比例问题。', '',
  '## 重现', '',
  '在仓库根目录执行：', '', '```powershell',
  'npm install',
  'node scripts/gen-large.js',
  'node scripts/evaluate-elk.mjs', '```', '',
  '使用项目锁定的 elkjs 依赖；仅评估单个样本时可运行 node scripts/evaluate-elk.mjs tcu-main-d3，无需生成压力样本。', '',
  '[ELK Layered 能力](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html) · [固定端口](https://eclipse.dev/elk/reference/options/org-eclipse-elk-portConstraints.html) · [候选端口选择限制](https://github.com/eclipse-elk/elk/issues/916)');
fs.copyFileSync(path.join(runtime, 'LICENSE.md'), path.join(OUT, 'elkjs-LICENSE.md'));
fs.writeFileSync(path.join(OUT, process.argv[2] ? '评估报告-' + process.argv[2] + '.md' : '评估报告.md'), report.join('\n'));
