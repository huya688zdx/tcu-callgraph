import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModel, stats, scanSources, rebuildIndex, subgraph } from '../src/core/index.js';
import { openStore, cacheKey } from '../src/core/store.js';

const SAMPLE = path.resolve(import.meta.dirname, '../samples/tcu');

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cache-'));
  const store = openStore({ dbPath: path.join(dir, 'callgraph.db') });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test('cacheKey：文件清单顺序无关，mtime 变化会换 key', () => {
  const files = [
    { rel: 'a.c', bytes: 10, mtimeMs: 1000, isHeader: false },
    { rel: 'b.h', bytes: 20, mtimeMs: 2000, isHeader: true },
  ];
  const k1 = cacheKey(files);
  assert.equal(k1, cacheKey([...files].reverse()));

  // 大小没变但 mtime 变了：必须换 key，否则「同大小改写」会一直命中旧缓存
  const touched = [{ ...files[0], mtimeMs: 3000 }, files[1]];
  assert.notEqual(k1, cacheKey(touched));

  // focusFile 不同也要区分：同一个目录下聚焦不同 .c 文件，模型里的 focusFile 不一样
  assert.notEqual(cacheKey(files), cacheKey(files, 'a.c'));
});

test('scanSources：返回 rel / bytes / mtime / isHeader', () => {
  const files = scanSources(SAMPLE);
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.equal(typeof f.rel, 'string');
    assert.ok(f.bytes > 0);
    assert.ok(f.mtimeMs > 0);
    assert.equal(typeof f.isHeader, 'boolean');
  }
  assert.ok(files.some((f) => f.isHeader), '样例里有头文件');
  assert.ok(files.some((f) => !f.isHeader), '样例里有源文件');
});

test('解析缓存：往返后统计与子图完全一致', (t) => {
  const store = tmpStore(t);
  const files = scanSources(SAMPLE);
  const key = cacheKey(files);

  const model = loadModel(SAMPLE);
  const before = stats(model);
  const put = store.putCachedModel(key, model);
  assert.equal(put.cached, true);

  const cached = store.getCachedModel(key);
  assert.ok(cached, '应命中缓存');
  assert.equal(cached._index, undefined, '缓存里不该存 _index（对象引用留不住）');

  rebuildIndex(cached);
  const after = stats(cached);

  for (const k of ['files', 'functions', 'edges', 'variables', 'macros', 'maxFanOut', 'maxFanIn', 'cycles']) {
    assert.deepEqual(after[k], before[k], `统计项 ${k} 应一致`);
  }

  // 子图依赖 _index 的邻接表，重建后必须和原始模型等价
  const a = subgraph(model, 'main.c::main', { up: 1, down: 2 });
  const b = subgraph(cached, 'main.c::main', { up: 1, down: 2 });
  assert.deepEqual(
    b.nodes.map((n) => n.id).sort(),
    a.nodes.map((n) => n.id).sort()
  );
  assert.equal(b.edges.length, a.edges.length);
});

test('解析缓存：_index 重建后指向同一批函数对象（不是副本）', (t) => {
  const store = tmpStore(t);
  const key = cacheKey(scanSources(SAMPLE));
  store.putCachedModel(key, loadModel(SAMPLE));
  const cached = rebuildIndex(store.getCachedModel(key));

  const fn = cached.functions[0];
  assert.equal(cached._index.byId.get(fn.id), fn, 'byId 必须和 functions 数组共享同一对象');
});

test('解析缓存：损坏的 blob 当作未命中并删除', (t) => {
  const store = tmpStore(t);
  const key = cacheKey(scanSources(SAMPLE));
  store.db
    .prepare('INSERT INTO parse_cache (fingerprint, created_at, model) VALUES (?, ?, ?)')
    .run(key, Date.now(), new Uint8Array([1, 2, 3, 4]));

  assert.equal(store.getCachedModel(key), null);
  const left = store.db.prepare('SELECT COUNT(*) AS c FROM parse_cache').get();
  assert.equal(Number(left.c), 0, '坏记录应被清掉');
});

test('解析缓存：超出体积上限时不缓存', (t) => {
  const store = tmpStore(t);
  const key = cacheKey(scanSources(SAMPLE));
  const r = store.putCachedModel(key, loadModel(SAMPLE), { maxBytes: 64 });
  assert.equal(r.cached, false);
  assert.equal(r.reason, 'too-large');
  assert.equal(store.getCachedModel(key), null);
});

test('解析缓存：按 created_at 只保留最近 N 份', (t) => {
  const store = tmpStore(t);
  const model = loadModel(SAMPLE);
  for (let i = 0; i < 5; i++) {
    store.putCachedModel(`k${i}`, model, { keep: 3 });
  }
  const rows = store.db.prepare('SELECT fingerprint FROM parse_cache ORDER BY created_at DESC').all();
  assert.equal(rows.length, 3);
  // 最新写入的一定在
  assert.ok(rows.some((r) => r.fingerprint === 'k4'));
});
