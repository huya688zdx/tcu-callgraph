import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { exportSvg } from '../src/core/export-svg.js';

function startServer(targetDir, dbPath) {
  return new Promise((resolve, reject) => {
    const child = fork(path.resolve('src/server.js'), [targetDir, '0'], {
      cwd: process.cwd(),
      env: { ...process.env, CALLGRAPH_DB: dbPath },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let log = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server start timeout:\n${log}`));
    }, 15000);
    child.stdout?.on('data', (d) => { log += d; });
    child.stderr?.on('data', (d) => { log += d; });
    child.on('message', (m) => {
      if (m && m.ready) {
        clearTimeout(timer);
        resolve({ base: `http://127.0.0.1:${m.port}`, child });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}):\n${log}`));
    });
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((r) => child.once('exit', r));
}

test('手工添加函数与变量：跨重启持久化、支持手动连线、比较模式拦截与永久删除', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-manual-'));
  const srcDir = path.join(tmp, 'proj');
  const dbPath = path.join(tmp, 'callgraph.db');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'main.c'), 'int g_common = 0;\nvoid App_Main(void) {}\n', 'utf8');
  fs.writeFileSync(path.join(srcDir, 'shift.c'), 'void Shift_Run(void) {}\n', 'utf8');

  let srv = await startServer(srcDir, dbPath);
  const post = (p, body) => fetch(`${srv.base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const get = (p) => fetch(`${srv.base}${p}`).then((r) => r.json());

  try {
    // 1. 向 shift.c 添加源码里不存在的手工函数与手工变量
    const addFn = await post('/api/manual-nodes', {
      file: 'shift.c', kind: 'fn', name: 'Shift_PlannedHook', change: 'added',
    });
    assert.equal(addFn.status, 200);
    assert.equal(addFn.body.ok, true);
    assert.equal(addFn.body.node.id, 'shift.c::Shift_PlannedHook');
    assert.equal(addFn.body.node.manual, true);

    const addVar = await post('/api/manual-nodes', {
      file: 'shift.c', kind: 'var', name: 'g_u16PlannedGear', typeText: 'uint16_t', change: 'modified',
    });
    assert.equal(addVar.status, 200);
    assert.equal(addVar.body.ok, true);
    assert.equal(addVar.body.node.id, 'var::shift.c::g_u16PlannedGear');
    assert.equal(addVar.body.node.manual, true);

    // 2. 虚拟文件拒绝；同文件同名 / 真实全局变量重名均应被拒绝
    const badFile = await post('/api/manual-nodes', { file: 'period-init/functions', kind: 'fn', name: 'BadFn' });
    assert.equal(badFile.status, 400, '周期分区等虚拟路径不得创建虚拟文件');
    const dupManual = await post('/api/manual-nodes', { file: 'shift.c', kind: 'fn', name: 'Shift_PlannedHook' });
    assert.equal(dupManual.status, 409);
    const dupReal = await post('/api/manual-nodes', { file: 'shift.c', kind: 'fn', name: 'Shift_Run' });
    assert.equal(dupReal.status, 409);
    const dupGlobalVar = await post('/api/manual-nodes', { file: 'main.c', kind: 'var', name: 'g_common' });
    assert.equal(dupGlobalVar.status, 409, '与真实全局变量同名时必须拒绝');

    // 3. 文件树和全局变量列表立即包含新节点（同时触发延迟数据流分析与写缓存）
    const tree = await get('/api/tree');
    const shiftFile = tree.children.find((c) => c.path === 'shift.c');
    assert.ok(shiftFile.functions.some((f) => f.id === 'shift.c::Shift_PlannedHook' && f.manual));
    const vars = await get('/api/vars');
    assert.ok(vars.list.some((v) => v.id === 'var::shift.c::g_u16PlannedGear' && v.typeText === 'uint16_t'));

    // 4. 在画布视图中拉入真实函数 + 手工函数 + 手工变量，使用增量 addManual 保存手工连线（不丢隐藏边）
    assert.equal((await post('/api/layout', {
      root: 'main.c::App_Main',
      mode: 'group',
      addManual: [{ from: 'main.c::App_Main', to: 'shift.c::Shift_PlannedHook' }],
    })).status, 200);
    assert.equal((await post('/api/layout', {
      root: 'main.c::App_Main',
      mode: 'group',
      addManual: [{ from: 'shift.c::Shift_PlannedHook', to: 'var::shift.c::g_u16PlannedGear' }],
    })).status, 200);

    // 给有效手工连线加标注，孤儿检测不应将其判为孤儿
    const manualEdgeKey = 'main.c::App_Main->shift.c::Shift_PlannedHook:0';
    assert.equal((await post('/api/overlay', {
      edgeKey: manualEdgeKey,
      data: { note: 'planned call' },
    })).status, 200);
    const orphans = await get('/api/orphans');
    assert.ok(!orphans.annotations.some((a) => a.id === manualEdgeKey), '有效手工边标注不应被判为孤儿');

    // .cgx 会话导出应包含 manualNodes
    const cgx = await get('/api/session/export');
    assert.ok(Array.isArray(cgx.manualNodes) && cgx.manualNodes.some((m) => m.id === 'shift.c::Shift_PlannedHook'));

    const view = await post('/api/view?up=0&down=0&group=1', {
      roots: ['main.c::App_Main'],
      expansions: [{ root: 'shift.c::Shift_PlannedHook', up: 0, down: 0 }],
      vars: ['var::shift.c::g_u16PlannedGear'],
    });
    assert.equal(view.status, 200);
    const fnNode = view.body.nodes.find((n) => n.id === 'shift.c::Shift_PlannedHook');
    const varNode = view.body.nodes.find((n) => n.id === 'var::shift.c::g_u16PlannedGear');
    assert.ok(fnNode?.manual && fnNode.change === 'added');
    assert.ok(varNode?.manual && varNode.change === 'modified' && varNode.typeText === 'uint16_t');
    assert.equal(view.body.edges.filter((e) => e.manual).length, 2, '两条增量手工连线均已保留');

    // 服务端 SVG 导出应把手工函数副标题渲染为「手工函数」而非 shift.c:0
    const svg = exportSvg(view.body);
    assert.ok(svg.includes('手工函数'), 'SVG 应包含手工函数副标题');
    assert.ok(!svg.includes('shift.c:0'), '手工函数不应显示 :0 行号');

    // 5. 重启服务后，手工节点、变量与手工连线均持久保留
    await stopServer(srv.child);
    srv = await startServer(srcDir, dbPath);
    const viewAfterRestart = await post('/api/view?up=0&down=0&group=1', {
      roots: ['main.c::App_Main'],
      expansions: [{ root: 'shift.c::Shift_PlannedHook', up: 0, down: 0 }],
      vars: ['var::shift.c::g_u16PlannedGear'],
    });
    assert.ok(viewAfterRestart.body.nodes.some((n) => n.id === 'shift.c::Shift_PlannedHook' && n.manual));
    assert.ok(viewAfterRestart.body.nodes.some((n) => n.id === 'var::shift.c::g_u16PlannedGear' && n.manual));
    assert.equal(viewAfterRestart.body.edges.filter((e) => e.manual).length, 2);

    // 6. 永久删除手工函数：清理模型与手工连线，且重启后绝不会从解析缓存复活
    const eventsBeforeDel = await get('/api/events?limit=20');
    const preDeleteEventId = eventsBeforeDel.latest;
    const del = await post('/api/manual-nodes/delete', { id: 'shift.c::Shift_PlannedHook' });
    assert.equal(del.status, 200);
    const detail = await fetch(`${srv.base}/api/node?id=${encodeURIComponent('shift.c::Shift_PlannedHook')}`);
    assert.equal(detail.status, 404);
    await stopServer(srv.child);
    srv = await startServer(srcDir, dbPath);
    const detailAfterCacheRestart = await fetch(`${srv.base}/api/node?id=${encodeURIComponent('shift.c::Shift_PlannedHook')}`);
    assert.equal(detailAfterCacheRestart.status, 404, '已删除的手工节点重启后绝不能从解析缓存复活');

    // 7. 时间轴恢复到删除前事件：手工节点应随之恢复
    const restoreRes = await post('/api/restore', { eventId: preDeleteEventId });
    assert.equal(restoreRes.status, 200);
    const detailAfterRestore = await fetch(`${srv.base}/api/node?id=${encodeURIComponent('shift.c::Shift_PlannedHook')}`);
    assert.equal(detailAfterRestore.status, 200, '时间轴恢复后手工节点应重新可用');

    // 8. 若该规划函数后来在真实源码中实现，删除手工记录时绝不能误删真实函数
    fs.writeFileSync(path.join(srcDir, 'shift.c'), 'void Shift_Run(void) {}\nvoid Shift_PlannedHook(void) {}\n', 'utf8');
    await stopServer(srv.child);
    srv = await startServer(srcDir, dbPath);
    const delStaleManual = await post('/api/manual-nodes/delete', { id: 'shift.c::Shift_PlannedHook' });
    assert.equal(delStaleManual.status, 200);
    assert.equal(delStaleManual.body.keptSourceSymbol, true);
    const realFnDetail = await (await fetch(`${srv.base}/api/node?id=${encodeURIComponent('shift.c::Shift_PlannedHook')}`)).json();
    assert.equal(realFnDetail.node.line, 2, '真实源码函数应完整保留不被误删');
  } finally {
    await stopServer(srv.child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const parserId of ['builtin', 'clang-ast']) {
  test(`手工变量由同文件全局变量实现后迁移存档与历史恢复（${parserId}）`, async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-manual-binding-'));
    const src = path.join(tmp, 'src');
    const db = path.join(tmp, 'callgraph.db');
    fs.mkdirSync(src);
    let srv;
    t.after(async () => {
      await stopServer(srv?.child);
      fs.rmSync(tmp, { recursive: true, force: true });
    });
    const file = path.join(src, 'app.c');
    fs.writeFileSync(file, 'void Entry(void) {}\nvoid Write(void) {}\n');
    fs.writeFileSync(path.join(src, 'other.c'), 'static int planned;\nvoid Other(void) { planned++; }\n');
    srv = await startServer(src, db);
    const get = (route) => fetch(srv.base + route).then(r => r.json());
    const post = async (route, body) => {
      const res = await fetch(srv.base + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      assert.equal(res.status, 200, `${route}: ${data.error}`);
      return data;
    };
    if (parserId === 'clang-ast') {
      const clang = (await get('/api/parsers')).parsers.find(parser => parser.id === parserId);
      if (!clang.available) { t.skip(clang.reason); return; }
      assert.equal((await post('/api/parsers', { parserId })).active, parserId);
    }
    const root = 'app.c::Entry';
    const before = 'var::app.c::planned';
    const after = 'var::planned';
    const edge = (id) => `${root}->${id}:0`;
    await post('/api/manual-nodes', { kind: 'var', file: 'app.c', name: 'planned', typeText: 'int' });
    await post('/api/overlay', { nodeId: before, data: { note: 'planned variable', tag: 'planned' } });
    await post('/api/layout', { root, addManual: [{ from: root, to: before }] });
    await post('/api/overlay', { edgeKey: edge(before), data: { note: 'planned relation' } });
    await post('/api/page', { roots: [root], vars: [before], selected: before, selectedEdge: edge(before) });
    await post('/api/bookmarks', { name: 'planned', roots: [root], vars: [before] });
    const priorEvent = (await get('/api/events')).latest;
    const priorArchive = await get('/api/session/export');
    await stopServer(srv.child);

    fs.writeFileSync(file, 'int planned;\nvoid Entry(void) {}\nvoid Write(void) { planned++; }\n');
    srv = await startServer(src, db);
    assert.equal((await get('/api/parsers')).active, parserId);
    const vars = (await get('/api/vars')).list.filter(v => v.name === 'planned');
    assert.deepEqual(vars.map(v => v.id).sort(), ['var::other.c::planned', after]);
    assert.ok(!vars.find(v => v.id === after).manual);
    const saved = (await get('/api/page?saved')).page;
    assert.deepEqual(saved.vars, [after]);
    assert.equal(saved.selected, after);
    assert.equal(saved.selectedEdge, edge(after));
    let archive = await get('/api/session/export');
    assert.ok(!archive.manualNodes.some(node => node.id === before));
    assert.deepEqual(archive.bookmarks.find(bookmark => bookmark.name === 'planned').vars, [after]);
    assert.equal(archive.overlay.nodes[after].note, 'planned variable');
    assert.equal(archive.overlay.edges[edge(after)].note, 'planned relation');
    assert.deepEqual(archive.overlay.layout[`${root}::flat`].manual, [{ from: root, to: after }]);
    const view = await post('/api/view?up=0&down=0&group=0', {
      roots: [root], vars: [after], expansions: [{ root: 'app.c::Write', up: 0, down: 0 }],
    });
    assert.ok(view.edges.some(e => e.from === root && e.to === after && e.manual));
    assert.ok(view.edges.some(e => e.from === 'app.c::Write' && e.to === after && e.kind === 'var'));
    const historical = await post(`/api/view?up=0&down=0&group=0&at=${priorEvent}`, { roots: [root], vars: [before] });
    assert.ok(historical.nodes.some(node => node.id === before && node.manual));
    assert.ok((await post('/api/restore', { eventId: priorEvent })).ok);
    archive = await get('/api/session/export');
    assert.ok(!archive.manualNodes.some(node => node.id === before));
    assert.equal(archive.overlay.edges[edge(after)].note, 'planned relation');

    priorArchive.overlay.nodes[after] = { note: 'source note' };
    assert.ok((await post('/api/session/import', priorArchive)).ok);
    archive = await get('/api/session/export');
    assert.ok(!archive.manualNodes.some(node => node.id === before));
    assert.equal(archive.overlay.nodes[after].note, 'source note');
    assert.equal(archive.overlay.nodes[after].tag, 'planned');
  });
}
