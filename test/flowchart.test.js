import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, loadModel } from '../src/core/index.js';
import { buildFlowchart, flowchartCacheHash } from '../src/core/flowchart.js';
import { launchServer } from '../scripts/lib/server.mjs';
import { launchCdp, resolveChromePath } from '../scripts/lib/cdp.mjs';

const sample = fileURLToPath(new URL('../samples/tcu/', import.meta.url));
const clangFixture = new URL('./fixtures/clang-ast/', import.meta.url);
const diff = name => path.resolve('samples/diff', name);

function chart(model, name, expandMacros = false) {
  const fn = model.functions.find(item => item.name === name);
  assert.ok(fn, name);
  return buildFlowchart(model, fn, { expandMacros });
}

function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flowchart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) fs.writeFileSync(path.join(root, file), contents);
  return root;
}

function find(graph, text, kind) {
  const node = graph.nodes.find(n => (!kind || n.kind === kind) && (text instanceof RegExp ? text.test(n.text) : n.text === text));
  assert.ok(node, `找不到 ${text}：${graph.nodes.map(n => n.text).join(' | ')}`);
  return node;
}

function links(graph, from) {
  return graph.edges.filter(edge => edge.from === from.id);
}

function assertBranches(graph, node) {
  const edges = links(graph, node).sort((a, b) => a.branch.localeCompare(b.branch));
  assert.deepEqual(edges.map(edge => [edge.branch, edge.label]), [['OFF', 'OFF'], ['ON', 'ON']]);
}

test('TCU 样例保留编译分支、运行期分支、宏提示和可下钻的函数指针目标', async () => {
  const model = buildIndex(sample);
  const raw = await chart(model, 'Task_Shift');
  const compile = find(raw, '#ifdef CONFIG_SPORT_MODE', 'preproc_decision');
  const runtime = find(raw, 'if (ok)', 'decision');
  for (const node of [compile, runtime]) assertBranches(raw, node);
  const compileExits = links(raw, compile).map(edge => edge.to);
  assert.ok(compileExits.every(id => raw.edges.some(edge => edge.from === id && edge.to === runtime.id)));
  const invoke = find(raw, /^INVOKE.*shift_up/, 'call');
  assert.equal(invoke.callees[0].name, 'Gear_ShiftUp');
  assert.ok(invoke.macros.some(macro => macro.name === 'INVOKE'));
  assert.ok(raw.macrosUsed.some(macro => macro.name === 'INVOKE' && macro.file === 'config.h'));
  const expanded = await chart(model, 'Task_Shift', true);
  const shift = find(expanded, /->shift_up/, 'call');
  assert.equal(shift.code, invoke.code);
  assert.equal(shift.line, invoke.line);
  assert.equal(shift.callees[0].name, 'Gear_ShiftUp');
  assert.equal(expanded.nodes.some(node => node.text.includes('INVOKE')), false);
});

test('同一目标切换仅头文件宏不同的基线时，流程图重新标注宏调用节点', async t => {
  const source = 'void send(const char *s) {}\nvoid run(void) { send(MESSAGE); }\n';
  const modelWith = message => buildIndex(project(t, { 'app.c': source, 'config.h': `#define MESSAGE "${message}"\n` }));
  const after = modelWith('A  B');
  const same = modelWith('A  B');
  const changed = modelWith('A B');
  const fn = model => model.functions.find(node => node.name === 'run');
  const options = baseline => ({ expandMacros: true, otherModel: baseline, otherFn: fn(baseline) });

  assert.notEqual(flowchartCacheHash(after, fn(after), options(same)),
    flowchartCacheHash(after, fn(after), options(changed)));
  const sameGraph = await buildFlowchart(after, fn(after), options(same));
  const changedGraph = await buildFlowchart(after, fn(after), options(changed));
  assert.equal(find(sameGraph, /send\("A  B"\)/).change, 'existing');
  assert.equal(find(changedGraph, /send\("A  B"\)/).change, 'modified');
});

test('流程图比较保留字面量里的空白差异并忽略标记之间的排版', async t => {
  const modelWith = body => buildIndex(project(t, {
    'app.c': `void send(const char *s) {}\nvoid run(void) { ${body} }\n`,
  }));
  const before = modelWith(`send("A B"); int c = ' '; int x = c + 1;`);
  const after = modelWith(`send("A  B"); int c = '\t'; int x=c+1;`);
  const fn = model => model.functions.find(node => node.name === 'run');
  for (const [primary, other, version] of [[after, before, 'after'], [before, after, 'before']]) {
    const graph = await buildFlowchart(primary, fn(primary), { otherModel: other, otherFn: fn(other), version });
    assert.equal(find(graph, /send\("A +B"\)/).change, 'modified');
    assert.equal(find(graph, /int c = '[ \t]'/).change, 'modified');
    assert.equal(find(graph, /int x/).change, 'existing');
  }
});

test('局部 define/undef、条件宏、宏体回溯和一次执行的 do-while', async t => {
  const root = project(t, {
    'macros.h': `#define LIMIT 9
#define IS_READY(v) ((v) != 0 && check(v))
#define CLEANUP(err) do { if (err) cleanup(); } while (0u)
#define CLEANUP_BOOL(err) do { if (err) cleanup(); } while (false)
`,
    'main.c': `int check(int value) { return value; }
void cleanup(void) {}
void run(int x) {
#undef LIMIT
#define LIMIT 50
  if (x > LIMIT) cleanup();
#undef LIMIT
  if (x > LIMIT) cleanup();
  if (IS_READY(x)) CLEANUP(x);
  CLEANUP_BOOL(x);
}`,
  });
  const model = buildIndex(root);
  const raw = await chart(model, 'run');
  assert.equal(raw.nodes.filter(node => node.text === 'if (x > LIMIT)').length, 2);
  assert.deepEqual(find(raw, 'if (IS_READY(x))').macros.map(macro => macro.name), ['IS_READY']);
  assert.equal(raw.nodes.some(node => /^#(?:define|undef)/.test(node.text)), false);
  const expanded = await chart(model, 'run', true);
  assert.ok(find(expanded, /^if \(x > 50\)/));
  assert.deepEqual(find(expanded, 'if (x > LIMIT)').macros, []);
  assert.ok(find(expanded, /^if .*check\(x\)/));
  assert.equal(expanded.nodes.filter(node => node.text === 'if (x)').length, 2);
  for (const node of expanded.nodes.filter(node => node.kind === 'decision')) assertBranches(expanded, node);
  assert.equal(expanded.nodes.some(node => /while/.test(node.text)), false);
  assert.equal(expanded.edges.some(edge => Number(edge.from.slice(1)) >= Number(edge.to.slice(1))), false);
  assert.equal(find(expanded, 'if (x)').code, 'CLEANUP(x)');
  assert.deepEqual(expanded.macrosUsed.filter(m => m.name === 'LIMIT').map(m => [m.raw, m.file, m.line]), [['50', 'main.c', 5]]);
});

test('编译期恒真/恒假、elif 链、分支内宏定义和汇流', async t => {
  const root = project(t, { 'main.c': `void run(void) {
#if (0) /* 此分支的代码不必能解析 */
  not valid C !!!
#elif 0
  dead();
#elif OPTION
#define LEVEL 2
  option(LEVEL);
#elif 1
#define LEVEL 3
  fallback(LEVEL);
#else
  dead();
#endif
#if 1
  live();
#else
  dead();
#endif
#ifndef DEBUG
  no_debug();
#endif
  common(LEVEL);
}` });
  const graph = await chart(buildIndex(root), 'run', true);
  assert.equal(graph.nodes.some(node => /dead|not valid/.test(node.text)), false);
  const option = find(graph, '#elif OPTION', 'preproc_decision');
  const noDebug = find(graph, '#ifndef DEBUG', 'preproc_decision');
  const live = find(graph, 'live();');
  const common = find(graph, 'common(LEVEL);');
  assertBranches(graph, option);
  assertBranches(graph, noDebug);
  for (const [branch, text] of [['ON', 'option(2);'], ['OFF', 'fallback(3);']]) {
    const branchNode = find(graph, text);
    assert.equal(links(graph, option).find(edge => edge.branch === branch).to, branchNode.id);
    assert.equal(links(graph, branchNode)[0].to, live.id);
  }
  assert.equal(links(graph, noDebug).find(edge => edge.branch === 'OFF').to, common.id);
});

test('运行期 if/else if、return、goto 与顺序边遵循控制流', async t => {
  const root = project(t, { 'main.c': `int run(int err) {
  if (err < 0) { return -1; after_return(); }
  else if (err > 0) goto done;
  nextStep();
  goto missing;
  after_goto();
done:
  return 0;
}` });
  const graph = await chart(buildIndex(root), 'run');
  const cond = find(graph, 'if (err < 0)'), elseIf = find(graph, 'if (err > 0)');
  const early = find(graph, 'return -1;', 'return'), next = find(graph, 'nextStep();');
  const jump = find(graph, 'goto done;'), missing = find(graph, 'goto missing;'), done = find(graph, 'done:');
  for (const node of [cond, elseIf]) assertBranches(graph, node);
  assert.equal(links(graph, cond).find(edge => edge.branch === 'OFF').to, elseIf.id);
  assert.equal(links(graph, cond).find(edge => edge.branch === 'ON').to, early.id);
  assert.deepEqual(links(graph, early), []);
  assert.equal(links(graph, elseIf).find(edge => edge.branch === 'OFF').to, next.id);
  assert.equal(links(graph, jump)[0].to, done.id);
  assert.deepEqual(links(graph, missing), []);
  assert.equal(graph.nodes.some(node => node.text.includes('after_')), false);
});

test('while、for、do-while、continue、break 与 switch fallthrough', async t => {
  const root = project(t, { 'main.c': `void run(int x) {
  while (x) {
    if (x < 0) break;
    continue;
    unreachable();
  }
  for (int i = 0; i < x; i++) work(i);
  do work(x); while (x--);
  switch (x) {
    case 0:
    case 1: one(); break;
    default: rest();
  }
  finish();
}` });
  const graph = await chart(buildIndex(root), 'run');
  const whileNode = find(graph, 'while (x)');
  const forNode = find(graph, /^for.*i < x/);
  const doNode = find(graph, 'do while (x--)');
  for (const node of [whileNode, forNode, doNode]) assertBranches(graph, node);
  assert.equal(links(graph, find(graph, 'continue;'))[0].to, whileNode.id);
  const initializer = find(graph, 'int i = 0;');
  const whileBreak = graph.nodes.find(node => node.text === 'break;');
  assert.equal(links(graph, whileBreak)[0].to, initializer.id);
  assert.equal(links(graph, find(graph, 'i++'))[0].to, forNode.id);
  assert.equal(links(graph, doNode).find(edge => edge.branch === 'ON').to, find(graph, 'work(x);').id);
  assert.equal(links(graph, find(graph, 'work(x);'))[0].to, doNode.id);
  const selection = find(graph, 'switch (x)', 'switch');
  assert.deepEqual(links(graph, selection).map(edge => [edge.branch, edge.label]), [['CASE', 'case 0'], ['CASE', 'case 1'], ['CASE', 'default']]);
  assert.equal(links(graph, find(graph, 'case 0:'))[0].to, find(graph, 'case 1:').id);
  const finish = find(graph, 'finish();');
  const switchBreak = graph.nodes.findLast(node => node.text === 'break;');
  assert.equal(links(graph, switchBreak)[0].to, finish.id);
  assert.equal(links(graph, find(graph, 'rest();'))[0].to, finish.id);
  assert.equal(graph.nodes.some(node => node.text.includes('unreachable')), false);
});

test('OSEK TASK/ISR 和 AUTOSAR FUNC 的源码体可以定位', async t => {
  const root = project(t, { 'main.c': `TASK(TaskA) { if (flag) run(); }
ISR(IsrA) { run(); }
` });
  const model = buildIndex(root);
  for (const name of ['TaskA', 'IsrA']) {
    const graph = await chart(model, name);
    assert.match(graph.nodes[0].text, /(?:TASK|ISR)\(/);
    assert.equal(find(graph, 'run();').code, 'run();');
  }

  const fixture = project(t, Object.fromEntries(['fixture.c', 'types.h'].map(file =>
    [file, fs.readFileSync(new URL(file, clangFixture), 'utf8').replaceAll('\r\n', '\n')])));
  const file = path.join(fixture, 'fixture.c');
  fs.writeFileSync(path.join(fixture, 'compile_commands.json'), JSON.stringify([
    { directory: fixture, file, arguments: ['clang', '-DSELECTED=2', '-c', file] },
  ]));
  const clang = await loadModel(file, null, { parserId: 'clang-ast', parserOptions: {
    execClang: () => fs.readFileSync(new URL('fixture.ast.json', clangFixture), 'utf8'),
  } });
  assert.equal(clang.parserId, 'clang-ast');
  const graph = await chart(clang, 'Runnable');
  assert.match(graph.nodes[0].text, /FUNC\(void, RTE_CODE\) Runnable\(void\)/);
  assert.ok(find(graph, /^RUN_WITH_ARG/, 'call').callees.some(callee => callee.name === 'Enter_A'));
  assert.equal(find(graph, 'g_tbl[1].enter(1);', 'call').callees[0].name, 'Enter_B');
});

test('HTTP 接口返回正交折线坐标和分支标签，校验节点、同源与工程身份', async t => {
  const files = Object.fromEntries(fs.readdirSync(sample).filter(file => /\.[ch]$/.test(file))
    .map(file => [file, fs.readFileSync(path.join(sample, file))]));
  files['unresolved.c'] = 'extern void missing(void); void Unresolved(void) { missing(); }';
  const server = await launchServer({ target: project(t, files) });
  t.after(() => server.close());
  const get = (id, query = '', headers) => fetch(`${server.baseUrl}/api/flowchart?id=${encodeURIComponent(id)}${query}`, { headers });
  const response = await get('main.c::Task_Shift', '&expandMacros=1');
  assert.equal(response.status, 200);
  const graph = await response.json();
  assert.ok(graph.ok && graph.expandMacros && graph.width > 0 && graph.height > 0);
  assert.ok(graph.nodes.every(node => [node.x, node.y, node.w, node.h].every(Number.isFinite)));
  for (const edge of graph.edges) {
    assert.ok(edge.points.length >= 2 && edge.points.flat().every(Number.isFinite));
    assert.ok(edge.points.slice(1).every(([x, y], i) => x === edge.points[i][0] || y === edge.points[i][1]));
    if (edge.label) assert.ok([edge.labelX, edge.labelY].every(Number.isFinite));
  }
  assertBranches(graph, find(graph, 'if (ok)'));
  assert.equal((await get('')).status, 400);
  assert.equal((await get('main.c::Task_Shift', '&expandMacros=2')).status, 400);
  assert.equal((await get('var::main.c::g_tick')).status, 400);
  assert.equal((await get('ext::missing')).status, 400);
  assert.equal((await get('header::config.h::INVOKE')).status, 400);
  assert.equal((await get('missing')).status, 404);
  assert.equal((await get('main.c::Task_Shift', '&projectId=stale')).status, 409);
  assert.equal((await get('main.c::Task_Shift', '', { Origin: 'https://example.com' })).status, 403);
  assert.equal((await get('main.c::Task_Shift', '', { Origin: 'http://127.0.0.1:1' })).status, 403);
});

test('HTTP 比较模式使用前后版本独立的源码和头文件宏', async t => {
  const server = await launchServer({ target: diff('project') });
  t.after(() => server.close());
  const post = (api, body) => fetch(server.baseUrl + api, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const prepared = await post('/api/compare', { beforePath: diff('before'), afterPath: diff('after') });
  assert.ok(prepared.ok, prepared.error);
  const applied = await post('/api/compare/apply', { previewId: prepared.preview.id,
    selectedIds: prepared.preview.candidates.map(node => node.id) });
  assert.ok(applied.ok, applied.error);
  for (const [version, expected] of [['before', '10'], ['after', '20']]) {
    const query = new URLSearchParams({ id: 'sensor.c::Sensor_Update', version, expandMacros: '1',
      comparisonId: applied.comparison.id });
    const result = await fetch(server.baseUrl + '/api/flowchart?' + query).then(r => r.json());
    assert.ok(result.ok, result.error);
    assert.ok(result.fn.hasBefore && result.fn.hasAfter);
    assert.equal(result.version, version);
    assert.ok(result.macrosUsed.some(macro => macro.name === 'SCALE' && macro.raw === expected));
  }
});

test('无头浏览器：右键和详情打开流程图，验证下钻、宏开关与独立 SVG', async t => {
  try { resolveChromePath(); } catch (error) { t.skip(error.message); return; }
  const server = await launchServer();
  t.after(() => server.close());
  const id = 'main.c::Task_Shift';
  const saved = await fetch(server.baseUrl + '/api/page', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roots: [id], selected: id, down: 0, up: 0 }) }).then(r => r.json());
  assert.ok(saved.ok, saved.error);
  const chrome = await launchCdp({ url: server.baseUrl });
  t.after(() => chrome.close());
  const { evaluate, waitFor, rightClick, pressKey } = chrome;
  const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const canvas = q('#flowchartCanvas');
  const modal = q('#flowchartModal');
  const click = selector => evaluate(`${q(selector)}.click()`);
  await waitFor(q('[data-node-flowchart]'));
  const rect = await evaluate(`(() => {
    const box = __cg.view.nodes.find(node => node.id === ${JSON.stringify(id)});
    const {x, y, k} = __cg.cam;
    const bounds = ${q('#cv')}.getBoundingClientRect();
    return [bounds.left + x + (box.x + box.w / 2) * k, bounds.top + y + (box.y + box.h / 2) * k];
  })()`);
  await rightClick(...rect);
  await evaluate(`Array.from(document.querySelectorAll('#ctxMenu button')).find(button => button.textContent.includes('查看函数流程图')).click()`);
  await waitFor(`${canvas}.querySelector('svg')`);
  assert.equal(await evaluate(`${canvas}.querySelectorAll('polygon').length`), 2);
  assert.equal(await evaluate(`Array.from(${canvas}.querySelectorAll('text')).filter(text => ['ON', 'OFF'].includes(text.textContent)).length`), 4);
  const zoom = `${canvas}.querySelector('svg').viewBox.baseVal.width`;
  const fitted = await evaluate(zoom);
  await click('#flowchartZoomIn');
  assert.ok((await evaluate(zoom)) < fitted);
  await click('#flowchartExpand');
  await waitFor(`Array.from(${canvas}.querySelectorAll('text')).some(text => text.textContent.includes('->shift_up'))`);
  await evaluate(`Array.from(${canvas}.querySelectorAll('g[data-call]')).find(node => node.querySelector('title').textContent.includes('Gear_ShiftUp')).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await waitFor(`${canvas}.querySelector('svg > title')?.textContent.startsWith('Gear_ShiftUp')`);
  assert.match(await evaluate(`${q('#flowchartCrumbs')}.textContent`), /Task_Shift\(\).*Gear_ShiftUp\(\)/);
  await click('#flowchartBack');
  await waitFor(`${canvas}.querySelector('svg > title')?.textContent.startsWith('Task_Shift')`);
  await evaluate(`window.showSaveFilePicker = async options => ({
    createWritable: async () => ({
      write: async blob => { window.__flowchartSaved = [options.suggestedName, await blob.text()]; },
      close: async () => {},
    }),
  })`);
  await click('#flowchartExport');
  const [name, svg] = await waitFor('window.__flowchartSaved');
  assert.match(name, /Task_Shift.*\.svg$/);
  assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<polygon/);
  assert.match(svg, />OFF<\/text>/);
  assert.doesNotMatch(svg, /data-call=/);
  await pressKey({ key: 'Delete', code: 'Delete', vk: 46 });
  assert.equal(await evaluate(`__cg.view.nodes.some(node => node.id === ${JSON.stringify(id)})`), true);
  await pressKey({ key: 'Escape', code: 'Escape', vk: 27 });
  await waitFor(`!${modal}.classList.contains('show')`);
  await click('[data-node-flowchart]');
  await waitFor(`${modal}.classList.contains('show') && ${canvas}.querySelector('svg')`);
  await click('#overlayMask');
  await waitFor(`!${modal}.classList.contains('show')`);
});
