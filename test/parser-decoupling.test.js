import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildIndex, loadModel, scanSources } from '../src/core/index.js';
import { buildDataflowIndex } from '../src/core/dataflow.js';
import { compareProjects } from '../src/core/compare.js';
import { compareGitProject } from '../src/core/git-compare.js';
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
  const result = await loadModel(dir, { parserId: 'clang-ast', parserOptions: { execClang: (file, args, { cwd }) => {
    compiled.push(path.basename(file));
    if (path.basename(file) === 'variant.c') {
      assert.ok(args.includes('-DSELECTED=2') || args.includes('SELECTED=2'));
      assert.equal(cwd, path.dirname(file));
    }
    return path.basename(file) === 'fixture.c' ? fs.readFileSync(astFile) : { kind: 'TranslationUnitDecl' };
  } } });
  assert.deepEqual(compiled, ['fixture.c', 'another.c', 'variant.c']);
  assert.ok(result.files.some((f) => f.rel === 'variant.c'));
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

test('Clang 比较忽略排版和注释，前后置自增互换会影响共享变量的读取者', async t => {
  const { dir } = project(t), before = temporary(t), after = temporary(t);
  const source = fs.readFileSync(path.join(dir, 'fixture.c'), 'utf8');
  const old = source.replace('g_state.count = x;', 'g_state.count=x++;');
  const updated = old.replace('g_state.count=x++;', 'g_state.count=++x;')
    .replace('int Read(void) { return g_state.count; }', 'int Read(void){return/**/g_state.count;}');
  fs.writeFileSync(path.join(before, 'fixture.c'), old);
  fs.writeFileSync(path.join(after, 'fixture.c'), updated);
  const result = await compareProjects(dir, before, after, {
    parserId: 'clang-ast', parserOptions: { execClang: file => {
      // 等长替换保留原夹具的定义范围；按版本提供 Clang 对自增表达式的表示。
      const ast = JSON.parse(fs.readFileSync(astFile, 'utf8'));
      const body = ast.inner.find(n => n.name === 'Enter_A').inner.find(n => n.kind === 'CompoundStmt');
      const rhs = body.inner[0].inner[1];
      delete rhs.castKind;
      Object.assign(rhs, { kind: 'UnaryOperator', opcode: '++', isPostfix: fs.readFileSync(file, 'utf8').includes('g_state.count=x++;') });
      return ast;
    } },
  });
  const writer = result.model._index.byId.get(fn('Enter_A'));
  const reader = result.model._index.byId.get(fn('Read'));
  assert.equal(writer.change, 'modified');
  assert.equal(reader.change, 'existing');
  assert.equal(reader.impactRole, 'dataflow_impact');
  assert.ok(reader.impactChainIds.includes(writer.id));
});

test('双目录与 Git 比较分析编译数据库未登记的新 C 文件，失败时拒绝发布', async t => {
  const { dir } = project(t);
  const before = temporary(t), after = temporary(t);
  const added = 'void NewEntry(void) {}';
  fs.writeFileSync(path.join(after, 'added.c'), added);
  const parserOpts = { parserId: 'clang-ast', parserOptions: { execClang: (file, args, { cwd }) => {
    if (path.basename(file) === 'fixture.c') return fs.readFileSync(astFile);
    assert.ok(args.includes('SELECTED=2'));
    assert.equal(cwd, path.dirname(file));
    return { kind: 'TranslationUnitDecl', inner: [{
      kind: 'FunctionDecl', id: 'new', name: 'NewEntry', loc: { line: 1, offset: 5, tokLen: 8 },
      range: { begin: { offset: 0, line: 1, tokLen: 4 }, end: { offset: added.length - 1, line: 1, tokLen: 1 } },
      inner: [{ kind: 'CompoundStmt' }],
    }] };
  } } };
  const twoDirs = await compareProjects(dir, before, after, parserOpts);
  assert.equal(twoDirs.model._index.byId.get('added.c::NewEntry').change, 'added');
  await assert.rejects(compareProjects(dir, before, after, { ...parserOpts, parserOptions: { execClang: file => {
    if (path.basename(file) === 'fixture.c') return fs.readFileSync(astFile);
    throw new Error('缺少编译选项');
  } } }), /added\.c.*缺少编译选项/);

  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init');
  git('add', 'fixture.c', 'types.h');
  git('-c', 'user.name=Callgraph Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline');
  fs.writeFileSync(path.join(dir, 'added.c'), added);
  const compared = await compareGitProject(dir, { baseRef: 'HEAD', targetRef: 'WORKTREE' }, parserOpts);
  assert.ok(compared.git.importFacts.directIds.includes('added.c::NewEntry'));
});

async function startSlowWrite(baseUrl, body) {
  const request = http.request(baseUrl + '/api/overlay', { method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { Expect: '100-continue', 'Content-Type': 'application/json' } });
  const response = once(request, 'response').then(async ([res]) => {
    res.resume();
    await once(res, 'end');
    return res.statusCode;
  });
  response.catch(() => {});
  const continued = once(request, 'continue');
  request.flushHeaders();
  await continued;
  request.write(body.slice(0, 10));
  return async () => {
    request.end(body.slice(10));
    return response;
  };
}

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
  const headers = temporary(t);
  const external = path.join(headers, 'external.h');
  const macroHeader = path.join(headers, 'macro only.h');
  fs.writeFileSync(macroHeader, '#define RATE 10');
  fs.writeFileSync(external, 'extern int outside;');
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
  const ast = JSON.parse(fs.readFileSync(${JSON.stringify(astFile)}, 'utf8'));
  ast.inner.push({ kind: 'VarDecl', id: 'outside', name: 'outside',
    loc: { file: ${JSON.stringify(external)}, line: 1, includedFrom: { file: args.at(-1) } } });
  const dependency = args[args.indexOf('-MF') + 1];
  const escapedPath = ${JSON.stringify(macroHeader.replaceAll('\\', '/').replaceAll(' ', '\\ '))};
  fs.writeFileSync(dependency, 'callgraph: ' + escapedPath + '\\n');
  return { stdout: JSON.stringify(ast) };
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
    const oldWrite = await startSlowWrite(srv.baseUrl,
      JSON.stringify({ nodeId: fn('Enter_A'), data: { note: '旧解析器写入' } }));
    const selected = await srv.post('/api/parsers', { parserId: 'clang-ast', compileCommandsPath: database });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    assert.equal(await oldWrite(), 409);
    assert.match(decoder.decode((await reader.read()).value), /"op":"project.switch"/);
    await reader.cancel();
    assert.equal(selected.body.active, 'clang-ast');
    assert.equal(selected.body.configured, 'clang-ast');
    assert.equal(compiled().length, 1);
    const projectInfo = (await srv.request('/api/project')).body;
    assert.equal(projectInfo.parser.id, 'clang-ast');
    const query = encodeURIComponent(fn('Read'));
    const view = (await srv.request('/api/view?root=' + query + '&up=0&down=0')).body;
    const detail = (await srv.request('/api/node?id=' + query)).body;
    assert.ok(view.nodes.some(n => n.id === fn('Read')));
    assert.equal(detail.node.id, fn('Read'));
    for (const node of [...view.nodes, detail.node]) {
      for (const key of ['sourceText', 'bodyTokens', 'semanticFingerprint']) assert.ok(!Object.hasOwn(node, key));
    }
    const response = await fetch(srv.baseUrl + '/api/export/html?root=' + query);
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /sourceText|semanticFingerprint|bodyTokens|return g_state\.count/);
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
    fs.appendFileSync(external, '\\nextern int second;');
    assert.equal((await srv.post('/api/parsers', { parserId: 'clang-ast' })).status, 200);
    assert.equal(compiled().length, 3, '工程外头文件变化必须使缓存失效');
    const other = project(t);
    writeJson(other.database, [{ directory: other.dir, file: 'fixture.c',
      arguments: ['clang', '-DSECOND_PROJECT', '-c', 'fixture.c'] }]);
    assert.equal((await srv.post('/api/switch', { path: other.dir })).status, 200);
    assert.ok(compiled().at(-1).includes('SECOND_PROJECT'), '第二个工程使用自己的数据库');
    assert.equal((await srv.post('/api/switch', { path: dir })).status, 200);
    assert.equal(compiled().length, 4, '返回原工程仍命中自己的缓存');
    fs.unlinkSync(macroHeader);
    assert.equal((await srv.post('/api/parsers', { parserId: 'clang-ast' })).status, 200);
    assert.equal(compiled().length, 5, '仅定义宏的外部头文件消失也会让缓存失效');
    fs.writeFileSync(macroHeader, '#define RATE 11');
    assert.equal((await srv.post('/api/parsers', { parserId: 'clang-ast' })).status, 200);
    assert.equal(compiled().length, 6);
  } finally {
    await srv.close();
  }
  const restarted = await startServer(dir, db, env);
  try {
    assert.equal((await restarted.request('/api/parsers')).body.active, 'clang-ast');
    assert.ok((await restarted.request('/api/vars')).body.list.some((v) => v.id === 'var::g_state'));
    assert.equal(compiled().length, 6);
  } finally {
    await restarted.close();
  }
});

test('慢速写请求跨过同工程比较的进入和退出后返回 409', async t => {
  const dir = temporary(t), before = temporary(t), after = temporary(t);
  const file = 'main.c', id = 'main.c::run';
  fs.writeFileSync(path.join(dir, file), 'int run(void) { return 0; }');
  fs.copyFileSync(path.join(dir, file), path.join(before, file));
  fs.writeFileSync(path.join(after, file), 'int run(void) { return 1; }');
  const srv = await startServer(dir, path.join(dir, 'test.db'));
  try {
    const originalId = (await srv.request('/api/project')).body.id;
    const finish = await startSlowWrite(srv.baseUrl, JSON.stringify({ nodeId: id, data: { note: '过期' } }));
    const prepared = await srv.post('/api/compare', { beforePath: before, afterPath: after });
    assert.ok(prepared.body.ok, JSON.stringify(prepared.body));
    const applied = await srv.post('/api/compare/apply', { previewId: prepared.body.preview.id, selectedIds: [id] });
    assert.ok(applied.body.ok, JSON.stringify(applied.body));
    assert.ok((await srv.post('/api/compare/exit', {})).body.ok);
    assert.equal((await srv.request('/api/project')).body.id, originalId);
    assert.equal(await finish(), 409);
    const current = (await srv.request('/api/view?root=' + encodeURIComponent(id))).body;
    assert.equal(current.nodes.find(n => n.id === id).note, undefined);
  } finally {
    await srv.close();
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
