import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildIndex, loadModel, scanSources } from '../src/core/index.js';
import { buildDataflowIndex } from '../src/core/dataflow.js';
import { compareProjects } from '../src/core/compare.js';
import { cacheKey, openStore } from '../src/core/store.js';
import { clangParser, detectClang, readCompileCommands } from '../src/core/parsers/clang-parser.js';
import { diffParserModels, emptyDataflow, normalizeGraphIR, validateGraphIR } from '../src/core/parsers/ir.js';
import { getParser, listParsers, registerParser, resolveParserForTarget } from '../src/core/parsers/registry.js';

const fixtureDir = fileURLToPath(new URL('./fixtures/clang-ast/', import.meta.url));
// Clang 19 以 -std=c11 -DSELECTED=2 -ast-dump=json 生成，省略隐式内建声明并固定 AST 地址 ID。
const astFile = path.join(fixtureDir, 'fixture.ast.json');
const fn = (name) => `fixture.c::${name}`;
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data));

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-parser-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function project(t) {
  const dir = temporary(t);
  for (const file of ['fixture.c', 'types.h']) {
    const source = fs.readFileSync(path.join(fixtureDir, file), 'utf8').replaceAll('\r\n', '\n');
    fs.writeFileSync(path.join(dir, file), source); // 固定原始字节偏移，也兼容 Windows CRLF checkout
  }
  const database = path.join(dir, 'compile_commands.json');
  writeJson(database, [{ directory: dir, file: 'fixture.c', arguments: ['clang', '-std=c11', '-DSELECTED=2', '-c', 'fixture.c'] }]);
  return { dir, database };
}

test('GraphIR：补齐集合，校验节点身份、边端点和数据流结构', () => {
  const meta = { root: '/project', parserId: 'example', parserName: '示例' };
  const model = normalizeGraphIR({ _df: emptyDataflow(), files: [{ rel: 'main.c' }] }, meta);
  assert.equal(validateGraphIR(model), model);
  assert.deepEqual(model.headerSymbols, []);
  assert.throws(() => normalizeGraphIR({ edges: [{ from: 'x', to: 'y', kind: 'direct' }] }, meta), /edges/);
  assert.throws(() => normalizeGraphIR({ functions: [{ id: 'x', name: 'f' }], variables: [{ id: 'x', name: 'v' }] }, meta), /variables/);
  assert.throws(() => normalizeGraphIR({ _df: { ...emptyDataflow(), writers: [] } }, meta), /_df.writers/);
});

test('第三方引擎可动态注册，数据流并发请求只委托一次，DOT 按目标类型选择', async (t) => {
  const root = temporary(t);
  const first = { id: 'main.c::first', name: 'first', file: 'main.c', line: 1, params: [] };
  const second = { id: 'main.c::second', name: 'second', file: 'main.c', line: 2, params: [] };
  fs.writeFileSync(path.join(root, 'main.c'), 'void builtin(void) {}');
  const dot = path.join(root, 'graph.gv');
  fs.writeFileSync(dot, 'digraph { a -> b }');
  let calls = 0;
  const adapter = registerParser({
    id: 'example', name: '第三方测试适配器', available: () => ({ ok: true }),
    parse: async (dir, { parserOptions }) => ({ root: dir, functions: [first, second],
      edges: [{ from: first.id, to: second.id, line: 1, kind: parserOptions.kind }] }),
    buildDataflow: async () => {
      calls++;
      return emptyDataflow();
    },
  });
  assert.equal(getParser('example'), adapter);
  assert.ok(listParsers().includes(adapter));
  assert.throws(() => registerParser(adapter), /已注册/);
  const model = await buildIndex(root, { parserId: 'example', parserOptions: { kind: 'direct' } });
  assert.equal(model.parserId, 'example');
  assert.equal(model._index.byId.get(first.id).name, 'first');
  assert.equal(model.edges.length, 1);
  const [a, b] = await Promise.all([buildDataflowIndex(model), buildDataflowIndex(model)]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  assert.equal(loadModel(root).parserId, 'builtin');
  assert.equal(resolveParserForTarget(dot, adapter.id).id, 'dot');
  assert.equal(loadModel(dot).parserId, 'dot');
});

test('Clang AST：激活分支、宏签名、位置和指定初始化、类型约束候选与预计算变量索引', async (t) => {
  const { dir } = project(t);
  const source = path.join(dir, 'fixture.c');
  const model = await loadModel(source, null, { parserId: 'clang-ast', parserOptions: {
    execClang: (file, args, { cwd }) => {
      assert.equal(file, source);
      assert.equal(cwd, dir);
      assert.deepEqual(args.slice(0, 3), ['-fsyntax-only', '-Xclang', '-ast-dump=json']);
      assert.ok(args.includes('SELECTED=2'));
      return fs.readFileSync(astFile, 'utf8');
    },
  } });
  assert.equal(model.parserId, 'clang-ast');
  assert.equal(model.focusFile, 'fixture.c');
  assert.equal(model._index.byId.get(fn('Runnable')).line, 20);
  assert.ok(model._index.byId.has('types.h::header_value'));
  assert.ok(!model._index.byId.has(fn('Inactive')));
  assert.ok(!model._df.byId.has('var::g_inactive'));
  assert.deepEqual(model.fnptrTables.find((table) => table.name === 'g_tbl').map,
    { '[0].enter': 'Enter_A', '[0].run': 'Run_A', '[1].enter': 'Enter_B', '[1].run': 'Run_B' });
  assert.deepEqual(model.fnptrTables.find((table) => table.name === 'g_sparse').map, { '[3]': 'Enter_B' });
  assert.deepEqual(model.fnptrTables.find((table) => table.name === 'g_handlers').map, { '[0]': 'Enter_A', '[1]': 'Run_A' });
  const runnable = model.edges.filter((e) => e.from === fn('Runnable'));
  assert.ok(runnable.some((e) => e.kind === 'macro' && e.to === fn('Enter_A') && e.via === 'RUN_WITH_ARG' && e.line === 21));
  assert.ok(runnable.some((e) => e.kind === 'direct' && e.to === 'types.h::header_value'));
  for (const [line, callee] of [[22, 'Enter_B'], [23, 'Run_A'], [24, 'Enter_B']]) {
    const edges = runnable.filter((e) => e.kind === 'fnptr' && e.line === line);
    assert.deepEqual(edges.map((e) => e.to), [fn(callee)]);
    assert.match(edges[0].via, /初始化槽位/);
  }
  assert.deepEqual(runnable.filter((e) => e.kind === 'fnptr' && e.line === 25).map((e) => e.callee).sort(), ['Run_A', 'Run_B']);
  const dispatch = model.edges.filter((e) => e.from === fn('Dispatch') && e.kind === 'fnptr');
  for (const line of [30, 31]) {
    const candidates = dispatch.filter((e) => e.line === line);
    assert.deepEqual(candidates.map((e) => e.callee).sort(), ['Enter_A', 'Enter_B', 'Run_A', 'Run_B']);
    assert.ok(candidates.every((e) => /已取地址函数/.test(e.via)));
  }
  assert.ok(dispatch.some((e) => e.to.startsWith('ext::fnptr::') && /未解析/.test(e.via)));
  const df = model._df, edges = model.edges, vars = model.variables;
  assert.deepEqual([...df.fnAccess.get(fn('Enter_A')).writes.get('var::g_state').fields], ['count']);
  assert.ok(!df.fnAccess.get(fn('Enter_A')).reads.has('var::g_state'));
  assert.ok(df.fnAccess.get(fn('Run_A')).reads.has('var::g_state'));
  assert.ok(df.fnAccess.get(fn('Runnable')).addresses.has('var::g_state'));
  assert.ok(df.fnAccess.get(fn('write_through')).writes.get('var::g_state').indirect);
  assert.ok(df.readers.get('var::g_state').has(fn('Read')));
  fs.unlinkSync(source);
  assert.equal(await buildDataflowIndex(model), df);
  assert.equal(model.edges, edges);
  assert.equal(model.variables, vars);
});

test('无编译数据库时，Clang 自动从工程头文件目录建立搜索路径', async (t) => {
  const { dir, database } = project(t);
  fs.unlinkSync(database);
  const headers = path.join(dir, 'extra headers');
  fs.mkdirSync(headers);
  fs.writeFileSync(path.join(headers, 'extra.h'), '');
  await loadModel(dir, { parserId: 'clang-ast', parserOptions: {
    execClang: (_file, args) => {
      assert.equal(args[args.indexOf('-I') + 1], dir);
      assert.equal(args[args.indexOf(headers) - 1], '-I');
      return fs.readFileSync(astFile);
    },
  } });
});

test('编译数据库：两种参数格式、相对工作目录、过滤域外与未构建文件、配置指纹隔离', async (t) => {
  const { dir, database } = project(t);
  const build = path.join(dir, 'build');
  fs.mkdirSync(build);
  fs.mkdirSync(path.join(dir, 'inc dir'));
  fs.writeFileSync(path.join(dir, 'another.c'), 'void another(void) {}');
  fs.writeFileSync(path.join(dir, 'variant.c'), 'void Runnable(void) {}');
  const seen = scanSources(dir);
  const entries = [
    { directory: '..', file: 'fixture.c', arguments: ['cc', '-I', 'inc dir', '-isystem', 'sys', '-DSELECTED=2',
      '-U', 'IGNORED', '-include', 'types.h', '-std=c11', '-c', 'fixture.c', '-o', 'fixture.o'] },
    { directory: '..', file: 'another.c', command: 'cc -I"inc dir" -D"MSG=with spaces" -std c99 -c another.c -o another.o' },
    { directory: '../..', file: 'stub.c', arguments: ['cc', '-c', 'stub.c'] },
  ];
  fs.unlinkSync(database);
  const buildDb = path.join(build, 'compile_commands.json');
  writeJson(buildDb, entries);
  const units = readCompileCommands(dir, buildDb, { files: seen });
  assert.deepEqual(units.map((u) => u.rel), ['fixture.c', 'another.c']);
  assert.deepEqual(units[0].args, ['-I', path.join(dir, 'inc dir'), '-isystem', path.join(dir, 'sys'), '-D', 'SELECTED=2',
    '-U', 'IGNORED', '-include', path.join(dir, 'types.h'), '-std=c11']);
  assert.deepEqual(units[1].args, ['-I', path.join(dir, 'inc dir'), '-D', 'MSG=with spaces', '-std=c99']);
  const compiled = [];
  const result = await loadModel(dir, { parserId: 'clang-ast', parserOptions: { execClang: (file) => {
    compiled.push(path.basename(file));
    return path.basename(file) === 'fixture.c' ? fs.readFileSync(astFile) : { kind: 'TranslationUnitDecl' };
  } } });
  assert.deepEqual(compiled, ['fixture.c', 'another.c']);
  assert.ok(!result.files.some((f) => f.rel === 'variant.c'));
  const status = { bin: 'test', version: 'test' };
  const oldKey = cacheKey(seen, '', clangParser.cacheKey(dir, {}, status));
  fs.appendFileSync(buildDb, ' ');
  assert.notEqual(oldKey, cacheKey(seen, '', clangParser.cacheKey(dir, {}, status)));
  assert.notEqual(oldKey, cacheKey(seen));
  assert.equal(cacheKey(seen), cacheKey(seen, '', 'builtin'));
});

test('解析器差异报告：调用类型、端点与变量读写分别计算', () => {
  const n = (id) => ({ id, name: id });
  const meta = { root: '/project', parserId: 'example', parserName: '示例' };
  const a = normalizeGraphIR({ functions: [{ ...n('a'), varAccess: [{ id: 'v', read: true }] }, n('b')],
    variables: [n('v')], edges: [{ from: 'a', to: 'b', kind: 'direct' }] }, meta);
  const b = normalizeGraphIR({ functions: [{ ...n('a'), varAccess: [{ id: 'v', write: true }] }, n('b'), n('c')],
    variables: [n('v')], edges: [{ from: 'a', to: 'b', kind: 'fnptr' }, { from: 'a', to: 'c', kind: 'direct' }] }, meta);
  const diff = diffParserModels(a, b);
  assert.deepEqual(diff.kindDiffs, [{ from: 'a', to: 'b', a: ['direct'], b: ['fnptr'] }]);
  assert.deepEqual(diff.onlyInB.functions.map((f) => f.id), ['c']);
  assert.deepEqual(diff.onlyInA.variableAccess, [{ from: 'a', to: 'v', kind: 'read' }]);
  assert.deepEqual(diff.onlyInB.variableAccess, [{ from: 'a', to: 'v', kind: 'write' }]);
  assert.equal(diff.summary.edges.b, 2);
});

test('工程比较直接复用 Clang 图，编译前后两个独立源码映射', async (t) => {
  const { dir } = project(t);
  const before = temporary(t), after = temporary(t);
  const source = fs.readFileSync(path.join(dir, 'fixture.c'), 'utf8');
  fs.writeFileSync(path.join(before, 'fixture.c'), source);
  fs.writeFileSync(path.join(after, 'fixture.c'), source.replace('return g_state.count;', 'return g_state.other;'));
  const seen = [];
  const result = await compareProjects(dir, before, after, {
    parserId: 'clang-ast', parserOptions: { execClang: (file, _args, { cwd }) => {
      assert.equal(path.dirname(file), cwd);
      assert.notEqual(cwd, dir);
      assert.ok(fs.existsSync(path.join(cwd, 'types.h')));
      seen.push(fs.readFileSync(file, 'utf8'));
      return fs.readFileSync(astFile);
    } },
  });
  assert.match(seen[0], /return g_state.count/);
  assert.match(seen[1], /return g_state.other/);
  assert.equal(result.model.parserId, 'clang-ast');
  assert.equal(result.model._index.byId.get(fn('Read')).change, 'modified');
});

async function startServer(dir, db, env = {}) {
  const child = fork(fileURLToPath(new URL('../src/server.js', import.meta.url)), [dir, '0'], {
    env: { ...process.env, CALLGRAPH_DB: db, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const closed = once(child, 'close');
  const close = async () => {
    child.kill();
    await closed;
  };
  try {
    const [{ port }] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(15000) }),
      closed.then(() => { throw new Error('服务已退出'); }),
    ]);
    const baseUrl = `http://127.0.0.1:${port}`;
    const request = async (route, init) => {
      const response = await fetch(baseUrl + route, init);
      return { status: response.status, body: await response.json() };
    };
    return { baseUrl, close, request, post: (route, body, headers = {}) => request(route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    }) };
  } catch (error) {
    await close();
    throw new Error(`测试服务启动失败：${error.message}\n${logs}`);
  }
}

test('解析器 API：切换、重启和配置缓存隔离，变量查询不覆盖 Clang 图', async (t) => {
  const { dir, database } = project(t);
  const preload = path.join(dir, 'mock-clang.mjs');
  const log = path.join(dir, 'clang.log');
  const db = path.join(dir, 'test.db');
  // 保留服务、worker 和编译器适配器的真实调用入口，仅替换测试二进制的版本/编译输出。
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
const bin = 'callgraph-fixture-clang';
const originalSync = cp.execFileSync;
const original = cp.execFile;
cp.execFileSync = (file, args, options) => file === bin
  ? 'clang version fixture' : originalSync(file, args, options);
function wrapped(...args) { return original(...args); }
wrapped[promisify.custom] = async (file, args, options) => {
  if (file !== bin) return promisify(original)(file, args, options);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
  return { stdout: fs.readFileSync(${JSON.stringify(astFile)}, 'utf8') };
};
cp.execFile = wrapped;
syncBuiltinESMExports();
`);
  const env = { CALLGRAPH_CLANG: 'callgraph-fixture-clang', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  const compiled = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const srv = await startServer(dir, db, env);
  try {
    const listed = (await srv.request('/api/parsers')).body;
    assert.equal(listed.active, 'builtin');
    assert.equal(listed.configured, 'builtin');
    assert.equal(listed.parsers.find((p) => p.id === 'clang-ast').available, true);
    assert.equal(listed.parsers.find((p) => p.id === 'clang-ast').hasCompileCommands, true);
    assert.equal((await srv.post('/api/parsers', { parserId: 'clang-ast' }, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await srv.post('/api/parsers', { parserId: 'invalid' })).status, 400);
    const stream = await fetch(srv.baseUrl + '/api/stream', { signal: AbortSignal.timeout(5000) });
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    assert.match(decoder.decode((await reader.read()).value), /^retry:/);
    const selected = await srv.post('/api/parsers', { parserId: 'clang-ast', compileCommandsPath: database });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    assert.match(decoder.decode((await reader.read()).value), /"op":"project.switch"/);
    await reader.cancel();
    assert.equal(selected.body.active, 'clang-ast');
    assert.equal(selected.body.configured, 'clang-ast');
    assert.equal(compiled().length, 1);
    const projectInfo = (await srv.request('/api/project')).body;
    assert.equal(projectInfo.parser.id, 'clang-ast');
    const previous = (await srv.request('/api/stats?summary=1')).body;
    const variables = (await srv.request('/api/vars')).body.list;
    assert.ok(variables.some((v) => v.id === 'var::g_state'));
    assert.ok(!variables.some((v) => v.id === 'var::g_inactive'));
    const flow = (await srv.request('/api/dataflow?fn=' + encodeURIComponent(fn('Enter_A')))).body;
    assert.equal(flow.fn.id, fn('Enter_A'));
    assert.ok(flow.vars.some((v) => v.id === 'var::g_state'));
    assert.deepEqual((await srv.request('/api/stats?summary=1')).body, previous);
    assert.equal(compiled().length, 1);

    const report = (await srv.post('/api/parsers/diff', { other: 'builtin' })).body;
    assert.equal(report.ok, true);
    assert.equal(report.a, 'clang-ast');
    assert.ok(report.onlyInA.functions.some((f) => f.id === fn('Runnable')));
    assert.equal(compiled().length, 1);
    fs.appendFileSync(database, ' ');
    assert.equal((await srv.post('/api/parsers', { parserId: 'clang-ast' })).status, 200);
    assert.equal(compiled().length, 2);
    assert.equal((await srv.post('/api/parsers', { parserId: 'builtin' })).body.active, 'builtin');
    assert.equal((await srv.post('/api/parsers', { parserId: 'clang-ast' })).body.active, 'clang-ast');
    assert.equal(compiled().length, 2);
  } finally {
    await srv.close();
  }
  const restarted = await startServer(dir, db, env);
  try {
    assert.equal((await restarted.request('/api/parsers')).body.active, 'clang-ast');
    assert.ok((await restarted.request('/api/vars')).body.list.some((v) => v.id === 'var::g_state'));
    assert.equal(compiled().length, 2);
  } finally {
    await restarted.close();
  }
});

test('Clang 缺失：保留持久化选择，启动回退并说明理由，显式切换失败不改变引擎', async (t) => {
  const { dir } = project(t);
  const missing = path.join(dir, 'missing-clang');
  const dbPath = path.join(dir, 'test.db');
  const status = detectClang(missing);
  assert.equal(status.ok, false);
  assert.match(status.reason, /ENOENT/);
  const store = openStore({ dbPath });
  store.setSetting('parser.active', 'clang-ast');
  store.close();
  const srv = await startServer(dir, dbPath, { CALLGRAPH_CLANG: missing });
  try {
    const listed = (await srv.request('/api/parsers')).body;
    assert.equal(listed.active, 'builtin');
    assert.equal(listed.configured, 'clang-ast');
    assert.match(listed.fallbackReason, /ENOENT/);
    assert.equal(listed.parsers.find((p) => p.id === 'clang-ast').available, false);
    const rejected = await srv.post('/api/parsers', { parserId: 'clang-ast' });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /ENOENT/);
    assert.equal((await srv.request('/api/project')).body.parser.id, 'builtin');
  } finally {
    await srv.close();
  }
});
