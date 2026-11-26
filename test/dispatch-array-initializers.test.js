import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModel } from '../src/core/index.js';

test('按声明的数组形状填充省略花括号的初始值和指定槽位', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-array-shape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'table.c'), `
typedef void (*Fn)(void);
void a(void) {} void b(void) {} void c(void) {} void d(void) {}
#define COLS (2)
static Fn flat[][COLS] = {a, b, c, d};
static void (*const mixed[][2])(void) = {{a}, b, {c}, {d}};
static Fn designated[4][2][2] = {[1][0][1] = a, b, c, [2] = {d}, a};
enum { WIDTH = 2 };
static Fn unknown[][WIDTH] = {a, b, c, [2] = {d}};
static Fn rows[][WIDTH] = {{a}, {b, c}};
void call(void) {
  flat[1][0](); mixed[0][0](); mixed[1][1](); mixed[2][0]();
  designated[1][1][0](); designated[2][0][0](); designated[3][0][0]();
  rows[1][1](); unknown[1][0]();
}
`);
  const model = loadModel(dir);
  const table = name => model.fnptrTables.find(entry => entry.name === name);
  assert.deepEqual(table('flat').map, { '[0][0]': 'a', '[0][1]': 'b', '[1][0]': 'c', '[1][1]': 'd' });
  assert.deepEqual(table('mixed').map, { '[0][0]': 'a', '[1][0]': 'b', '[1][1]': 'c', '[2][0]': 'd' });
  assert.deepEqual(table('designated').map, {
    '[1][0][1]': 'a', '[1][1][0]': 'b', '[1][1][1]': 'c', '[2][0][0]': 'd', '[3][0][0]': 'a',
  });
  assert.deepEqual(table('rows').map, { '[0][0]': 'a', '[1][0]': 'b', '[1][1]': 'c' });
  assert.equal(table('unknown').incomplete, true);
  assert.equal(table('unknown').map['[0][0]'], 'a');
  assert.equal(table('unknown').map['[2][0]'], 'd');
  const site = model.indirectCalls.find(call => call.receiver === 'unknown');
  assert.deepEqual(site.candidates.map(candidate => candidate.name), ['b', 'c']);
  const targets = model._index.outAdj.get('table.c::call').filter(edge => edge.kind === 'fnptr');
  assert.deepEqual(targets.map(edge => edge.callee), ['c', 'a', 'c', 'd', 'b', 'd', 'a', 'c']);
});
