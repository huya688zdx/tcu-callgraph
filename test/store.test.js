import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, fingerprintFiles, importLegacyOverlay, resolveDbPath } from '../src/core/store.js';

/** 每个用例一个独立临时库，互不干扰，也不碰用户真实的 userData 库 */
function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-'));
  const store = openStore({ dbPath: path.join(dir, 'callgraph.db') });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

const PROJ_A = 'C:/proj/alpha';
const PROJ_B = 'C:/proj/beta';

test('store：建库后 user_version 落在当前版本', (t) => {
  const store = tmpStore(t);
  assert.ok(fs.existsSync(store.file));
  const row = store.db.prepare('PRAGMA user_version').get();
  assert.ok(Number(row.user_version) >= 1);
});

test('store：同一路径重复 upsert 返回同一个 id', (t) => {
  const store = tmpStore(t);
  const a = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  const b = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  assert.equal(a.id, b.id);
  assert.equal(a.isNew, true);
  assert.equal(b.isNew, false);
  assert.equal(store.listProjects().length, 1);
});

test('store：两个工程用同一个 node id 时标注互不影响', (t) => {
  const store = tmpStore(t);
  const a = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  const b = store.upsertProject({ path: PROJ_B, name: 'beta' });

  store.setAnnotation(a.id, 'node', 'main.c::main', { change: 'added' });

  assert.equal(store.loadOverlay(a.id).nodes['main.c::main'].change, 'added');
  assert.deepEqual(store.loadOverlay(b.id).nodes, {});

  store.setAnnotation(b.id, 'node', 'main.c::main', { change: 'deleted' });
  assert.equal(store.loadOverlay(a.id).nodes['main.c::main'].change, 'added');
  assert.equal(store.loadOverlay(b.id).nodes['main.c::main'].change, 'deleted');
});

test('store：标注按字段合并，写 null 等于清除该字段', (t) => {
  const store = tmpStore(t);
  const p = store.upsertProject({ path: PROJ_A, name: 'alpha' });

  store.setAnnotation(p.id, 'node', 'x.c::f', { change: 'added', note: '待确认' });
  const merged = store.setAnnotation(p.id, 'node', 'x.c::f', { tag: '风险' });

  assert.equal(merged.change, 'added');
  assert.equal(merged.note, '待确认');
  assert.equal(merged.tag, '风险');
  assert.ok(merged.updatedAt);

  const cleared = store.setAnnotation(p.id, 'node', 'x.c::f', { note: null });
  assert.equal(cleared.note, undefined);
  assert.equal(cleared.change, 'added');
});

test('store：删除与恢复只影响对应工程', (t) => {
  const store = tmpStore(t);
  const a = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  const b = store.upsertProject({ path: PROJ_B, name: 'beta' });

  const c1 = store.setDeleted(a.id, { nodes: ['x.c::f'], edges: ['x.c::f->y.c::g:3'] });
  assert.deepEqual(c1, { nodes: 1, edges: 1 });
  assert.deepEqual(store.loadOverlay(a.id).deleted.nodes, { 'x.c::f': 1 });
  assert.deepEqual(store.loadOverlay(b.id).deleted.nodes, {});

  const c2 = store.setDeleted(a.id, { nodes: ['x.c::f'] }, true);
  assert.deepEqual(c2, { nodes: 0, edges: 1 });

  store.clearDeleted(a.id);
  assert.deepEqual(store.loadOverlay(a.id).deleted, { nodes: {}, edges: {} });
});

test('store：布局按 view_key + mode 分槽，clear 只清自己的槽位', (t) => {
  const store = tmpStore(t);
  const p = store.upsertProject({ path: PROJ_A, name: 'alpha' });

  store.saveLayout(p.id, 'main.c::main', 'group', { nodes: { 'main.c::main': { x: 10, y: 20 } } });
  store.saveLayout(p.id, 'main.c::main', 'flat', { nodes: { 'main.c::main': { x: 1, y: 2 } } });
  store.saveLayout(p.id, 'main.c::main+adc.c::Adc_Read', 'group', { manual: [{ from: 'a', to: 'b' }] });

  const ov = store.loadOverlay(p.id);
  assert.deepEqual(ov.layout['main.c::main::group'].nodes, { 'main.c::main': { x: 10, y: 20 } });
  assert.deepEqual(ov.layout['main.c::main::flat'].nodes, { 'main.c::main': { x: 1, y: 2 } });
  assert.equal(ov.layout['main.c::main+adc.c::Adc_Read::group'].manual.length, 1);

  // 合并语义：后写的只覆盖传进来的键
  store.saveLayout(p.id, 'main.c::main', 'group', { nodes: { 'other.c::h': { x: 5, y: 5 } } });
  const g = store.loadOverlay(p.id).layout['main.c::main::group'];
  assert.deepEqual(g.nodes['main.c::main'], { x: 10, y: 20 });
  assert.deepEqual(g.nodes['other.c::h'], { x: 5, y: 5 });

  store.saveLayout(p.id, 'main.c::main', 'group', { clear: true });
  assert.equal(store.loadOverlay(p.id).layout['main.c::main::group'], undefined);
  assert.ok(store.loadOverlay(p.id).layout['main.c::main::flat']);
});

test('store：事件按时间倒序返回，同毫秒内 seq 递增', (t) => {
  const store = tmpStore(t);
  const p = store.upsertProject({ path: PROJ_A, name: 'alpha' });

  store.appendEvent(p.id, { op: 'node.annotate', target: 'a', after: { change: 'added' } });
  store.appendEvent(p.id, { op: 'node.annotate', target: 'b', after: { change: 'deleted' } });
  store.appendEvent(p.id, { op: 'layout.save', target: 'main::group' });

  const list = store.listEvents(p.id);
  assert.equal(list.length, 3);
  assert.equal(list[0].op, 'layout.save');
  assert.equal(list[2].target, 'a');
  assert.deepEqual(list[2].after, { change: 'added' });
});

test('store：事件按工程隔离', (t) => {
  const store = tmpStore(t);
  const a = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  const b = store.upsertProject({ path: PROJ_B, name: 'beta' });
  store.appendEvent(a.id, { op: 'delete', target: 'x' });
  assert.equal(store.listEvents(a.id).length, 1);
  assert.equal(store.listEvents(b.id).length, 0);
});

test('store：旧 overlay 导入一次，重复调用不会覆盖已有数据', (t) => {
  const store = tmpStore(t);
  const p = store.upsertProject({ path: PROJ_A, name: 'alpha' });

  const legacy = {
    nodes: { 'main.c::main': { change: 'existing', note: '旧备注' } },
    edges: { 'main.c::main->adc.c::Adc_Read:12': { change: 'added' } },
    notes: [],
    deleted: { nodes: { 'old.c::gone': 1 }, edges: {} },
    layout: { 'main.c::main::group': { nodes: { 'main.c::main': { x: 7, y: 8 } }, edges: {}, manual: [] } },
  };

  const r1 = importLegacyOverlay(store, p.id, legacy);
  assert.equal(r1.imported, true);
  assert.equal(r1.annotations, 2);

  const ov = store.loadOverlay(p.id);
  assert.equal(ov.nodes['main.c::main'].note, '旧备注');
  assert.equal(ov.edges['main.c::main->adc.c::Adc_Read:12'].change, 'added');
  assert.deepEqual(ov.deleted.nodes, { 'old.c::gone': 1 });
  assert.deepEqual(ov.layout['main.c::main::group'].nodes, { 'main.c::main': { x: 7, y: 8 } });

  // 用户后来改了标注，再跑一次导入不应该被旧数据盖回去
  store.setAnnotation(p.id, 'node', 'main.c::main', { note: '新备注' });
  const r2 = importLegacyOverlay(store, p.id, legacy);
  assert.equal(r2.imported, false);
  assert.equal(r2.reason, 'exists');
  assert.equal(store.loadOverlay(p.id).nodes['main.c::main'].note, '新备注');
});

test('store：空 overlay 导入直接跳过', (t) => {
  const store = tmpStore(t);
  const p = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  const r = importLegacyOverlay(store, p.id, { nodes: {}, edges: {}, notes: [] });
  assert.equal(r.imported, false);
});

test('store：指纹对文件顺序不敏感，对字节数敏感', () => {
  const files = [
    { rel: 'b.c', bytes: 20, isHeader: false },
    { rel: 'a.h', bytes: 10, isHeader: true },
  ];
  const f1 = fingerprintFiles(files);
  const f2 = fingerprintFiles([...files].reverse());
  assert.equal(f1, f2);

  const f3 = fingerprintFiles([{ rel: 'b.c', bytes: 21, isHeader: false }, files[1]]);
  assert.notEqual(f1, f3);
});

test('store：CALLGRAPH_DB 环境变量优先于 userData', () => {
  const prev = process.env.CALLGRAPH_DB;
  try {
    process.env.CALLGRAPH_DB = 'D:/tmp/x.db';
    assert.equal(resolveDbPath({ userData: 'C:/Users/x/AppData' }), path.resolve('D:/tmp/x.db'));
    delete process.env.CALLGRAPH_DB;
    assert.equal(
      resolveDbPath({ userData: 'C:/Users/x/AppData' }),
      path.join(path.resolve('C:/Users/x/AppData'), 'callgraph.db')
    );
  } finally {
    if (prev === undefined) delete process.env.CALLGRAPH_DB;
    else process.env.CALLGRAPH_DB = prev;
  }
});

test('store：listAllTargets 汇总标注、删除记录与布局槽位', (t) => {
  const store = tmpStore(t);
  const p = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  store.setAnnotation(p.id, 'node', 'x.c::f', { note: 'n' });
  store.setAnnotation(p.id, 'edge', 'x.c::f->y.c::g:3', { change: 'added' });
  store.setDeleted(p.id, { nodes: ['z.c::h'] });
  store.saveLayout(p.id, 'x.c::f', 'group', { nodes: { 'x.c::f': { x: 1, y: 2 } } });

  const all = store.listAllTargets(p.id);
  assert.equal(all.annotations.length, 2);
  assert.deepEqual(
    all.annotations.map((a) => `${a.kind}:${a.id}`).sort(),
    ['edge:x.c::f->y.c::g:3', 'node:x.c::f']
  );
  assert.deepEqual(all.deleted, [{ kind: 'node', id: 'z.c::h' }]);
  assert.equal(all.layouts.length, 1);
  assert.deepEqual(all.layouts[0].nodes, { 'x.c::f': { x: 1, y: 2 } });
});

test('store：purgeTargets 只删传进来的条目', (t) => {
  const store = tmpStore(t);
  const p = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  store.setAnnotation(p.id, 'node', 'keep.c::f', { note: '保留' });
  store.setAnnotation(p.id, 'node', 'gone.c::g', { note: '删掉' });
  store.setDeleted(p.id, { nodes: ['gone.c::g'] });
  store.saveLayout(p.id, 'gone.c::g', 'group', { nodes: { 'gone.c::g': { x: 1, y: 1 } } });

  const removed = store.purgeTargets(p.id, {
    annotations: [{ kind: 'node', id: 'gone.c::g' }],
    deleted: [{ kind: 'node', id: 'gone.c::g' }],
    layoutSlots: [{ viewKey: 'gone.c::g', mode: 'group' }],
  });
  assert.deepEqual(removed, { annotations: 1, deleted: 1, layoutSlots: 1, layoutNodes: 0 });

  const ov = store.loadOverlay(p.id);
  assert.deepEqual(Object.keys(ov.nodes), ['keep.c::f']);
  assert.deepEqual(ov.deleted.nodes, {});
  assert.deepEqual(ov.layout, {});
});

test('store：purgeTargets 清掉槽位里最后一个节点时整个槽位一起删', (t) => {
  const store = tmpStore(t);
  const p = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  store.saveLayout(p.id, 'x.c::f', 'flat', {
    nodes: { 'keep.c::f': { x: 0, y: 0 }, 'gone.c::g': { x: 1, y: 1 } },
  });

  store.purgeTargets(p.id, { layoutNodes: [{ viewKey: 'x.c::f', mode: 'flat', ids: ['gone.c::g'] }] });
  assert.deepEqual(store.loadOverlay(p.id).layout['x.c::f::flat'].nodes, { 'keep.c::f': { x: 0, y: 0 } });

  store.purgeTargets(p.id, { layoutNodes: [{ viewKey: 'x.c::f', mode: 'flat', ids: ['keep.c::f'] }] });
  assert.equal(store.loadOverlay(p.id).layout['x.c::f::flat'], undefined, '空槽位应被删掉');
});

test('store：书签按工程隔离，同名保存覆盖而不是新增', (t) => {
  const store = tmpStore(t);
  const a = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  const b = store.upsertProject({ path: PROJ_B, name: 'beta' });

  const r1 = store.saveBookmark(a.id, { name: '换挡链路', roots: ['gear.c::Gear_Apply'], up: 1, down: 2 });
  assert.equal(r1.overwritten, false);
  assert.deepEqual(r1.bookmark.roots, ['gear.c::Gear_Apply']);

  const r2 = store.saveBookmark(a.id, { name: '换挡链路', roots: ['gear.c::Gear_Apply'], up: 0, down: 5 });
  assert.equal(r2.overwritten, true);
  assert.equal(r2.bookmark.id, r1.bookmark.id, '同名保存应复用同一条记录');
  assert.equal(r2.bookmark.down, 5);

  assert.equal(store.listBookmarks(a.id).length, 1);
  assert.equal(store.listBookmarks(b.id).length, 0, '别的工程看不到');
});

test('store：书签名称不能为空，删除按工程校验', (t) => {
  const store = tmpStore(t);
  const a = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  const b = store.upsertProject({ path: PROJ_B, name: 'beta' });

  assert.throws(() => store.saveBookmark(a.id, { name: '   ', roots: [] }), /名称不能为空/);

  const { bookmark } = store.saveBookmark(a.id, { name: 'x', roots: ['a::b'] });
  assert.equal(store.deleteBookmark(b.id, bookmark.id), false, '不能删别的工程的书签');
  assert.equal(store.deleteBookmark(a.id, bookmark.id), true);
  assert.equal(store.listBookmarks(a.id).length, 0);
});

test('store：v1 老库能自动补出 bookmark 表且数据不丢', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mig-'));
  const file = path.join(dir, 'callgraph.db');
  let second = null;
  // 清理必须在 close 之后：WAL 文件被占用时 rm 会 EBUSY
  t.after(() => {
    try {
      second?.close();
    } catch {
      /* 已关闭 */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响结论 */
    }
  });

  // 造一个「v1 结构」的库：有标注、没有 bookmark 表
  const first = openStore({ dbPath: file });
  const p = first.upsertProject({ path: PROJ_A, name: 'alpha' });
  first.setAnnotation(p.id, 'node', 'x.c::f', { note: '老数据' });
  first.db.exec('DROP TABLE bookmark');
  first.db.exec('PRAGMA user_version = 1');
  first.close();

  // 再用新代码打开，应自动补表
  second = openStore({ dbPath: file });
  assert.ok(second.version >= 2);
  const hasTable = !!second.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bookmark'")
    .get();
  assert.equal(hasTable, true);
  assert.equal(second.loadOverlay(p.id).nodes['x.c::f'].note, '老数据');
  assert.deepEqual(second.listBookmarks(p.id), []);
});

test('store：时间轴分页不重不漏，游标按 id 往回翻', (t) => {
  const store = tmpStore(t);
  const p = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  for (let i = 0; i < 25; i++) {
    store.appendEvent(p.id, { op: 'node.annotate', target: `x.c::f${i}`, after: { note: `第 ${i} 条` } });
  }
  store.appendEvent(p.id, { op: 'layout.save', target: 'x.c::f::group', after: { nodes: { a: 1 } } });

  const page1 = store.listEventsPage(p.id, { limit: 10 });
  assert.equal(page1.length, 10);
  assert.equal(store.countEvents(p.id), 26);

  const cursor = page1[page1.length - 1].id;
  const page2 = store.listEventsPage(p.id, { limit: 10, beforeId: cursor });
  assert.equal(page2.length, 10);
  assert.ok(page2.every((e) => e.id < cursor), '第二页必须全在游标之前');
  const ids = [...page1, ...page2].map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, '两页不能有重复');

  const all = store.listEventsPage(p.id, { limit: 100 });
  assert.equal(all.length, 26);
});

test('store：时间轴列表只给 brief，不给完整载荷', (t) => {
  const store = tmpStore(t);
  const p = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  store.appendEvent(p.id, { op: 'node.annotate', target: 'x.c::f', after: { change: 'added', note: '备注内容' } });

  const [e] = store.listEventsPage(p.id, { limit: 10 });
  assert.equal(e.after, undefined, '默认不该带完整载荷');
  assert.equal(e.before, undefined);
  assert.equal(e.brief.change, 'added');
  assert.equal(e.brief.note, '备注内容');

  const [full] = store.listEventsPage(p.id, { limit: 10, withPayload: true });
  assert.deepEqual(full.after, { change: 'added', note: '备注内容' });
});

test('store：时间轴按类型和关键词过滤', (t) => {
  const store = tmpStore(t);
  const p = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  store.appendEvent(p.id, { op: 'node.annotate', target: 'gear.c::Gear_Apply', after: { note: '换挡' } });
  store.appendEvent(p.id, { op: 'node.annotate', target: 'adc.c::Adc_Read', after: { note: '采集' } });
  store.appendEvent(p.id, { op: 'layout.save', target: 'gear.c::Gear_Apply::group', after: { nodes: { a: 1 } } });

  const onlyLayout = store.listEventsPage(p.id, { ops: ['layout.save', 'layout.clear'] });
  assert.equal(onlyLayout.length, 1);
  assert.equal(store.countEvents(p.id, { ops: ['layout.save'] }), 1);

  const byTarget = store.listEventsPage(p.id, { q: 'Gear_Apply' });
  assert.equal(byTarget.length, 2, 'target 命中两条');
  assert.equal(store.countEvents(p.id, { q: 'Gear_Apply' }), 2);

  const byNote = store.listEventsPage(p.id, { q: '换挡' });
  assert.equal(byNote.length, 1, 'after 里的备注也能搜到');
});

test('store：导出的事件按 id 升序且带完整载荷', (t) => {
  const store = tmpStore(t);
  const p = store.upsertProject({ path: PROJ_A, name: 'alpha' });
  store.appendEvent(p.id, { op: 'node.annotate', target: 'a', after: { change: 'added' } });
  store.appendEvent(p.id, { op: 'node.annotate', target: 'b', after: { change: 'deleted' } });

  const dump = store.dumpEvents(p.id);
  assert.equal(dump.length, 2);
  assert.ok(dump[0].id < dump[1].id, '导出必须按 id 升序，导入方才能按序重放');
  assert.deepEqual(dump[0].after, { change: 'added' });
});
