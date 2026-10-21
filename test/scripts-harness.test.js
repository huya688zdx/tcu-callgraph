/**
 * scripts/ 下公共夹具（CDP / 服务端）的自检
 *
 * 不需要 Chrome：只验证参数解析、服务端启动、以及 E2E 脚本的静态约束。
 * 真正的浏览器行为仍需人工跑 scripts/e2e-*.mjs 验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveChromePath } from '../scripts/lib/cdp.mjs';
import { launchServer } from '../scripts/lib/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

const tmpFile = (name) => {
  const p = path.join(os.tmpdir(), `cg-test-${name}-${process.pid}`);
  fs.writeFileSync(p, 'x');
  return p;
};

/** 只去掉整行注释（块注释 + 行首 //），免得注释里的 "clear:true" 被当成真调用 */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l))
    .join('\n');

test('resolveChromePath 认显式传入的路径', () => {
  const p = tmpFile('chrome');
  try {
    assert.equal(resolveChromePath({ chromePath: p, env: {} }), p);
  } finally {
    fs.unlinkSync(p);
  }
});

test('resolveChromePath 认 CHROME_PATH 环境变量', () => {
  const p = tmpFile('chrome-env');
  try {
    assert.equal(resolveChromePath({ env: { CHROME_PATH: p } }), p);
  } finally {
    fs.unlinkSync(p);
  }
});

test('resolveChromePath 路径不存在时明确报错', () => {
  assert.throws(
    () => resolveChromePath({ chromePath: path.join(os.tmpdir(), 'no-such-chrome-xyz'), env: {} }),
    /找不到 Chrome/
  );
  assert.throws(
    () => resolveChromePath({ env: { CHROME_PATH: path.join(os.tmpdir(), 'no-such-chrome-xyz') } }),
    /找不到 Chrome/
  );
});

test('launchServer 起服务并回报真实端口', async () => {
  const srv = await launchServer({ target: 'samples/tcu' });
  try {
    assert.ok(srv.port > 0, '应拿到系统分配的端口');
    assert.equal(srv.baseUrl, `http://127.0.0.1:${srv.port}`);
    const res = await fetch(srv.baseUrl + '/api/stats');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.stats && body.stats.functions > 0, '应解析出函数');
  } finally {
    await srv.close();
  }
});

test('E2E 脚本不再硬编码 Chrome 路径 / 调试端口，也不做破坏性清理', () => {
  for (const f of ['e2e-delete.mjs', 'e2e-interact.mjs', 'e2e-menu.mjs']) {
    const raw = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
    const src = stripComments(raw);
    assert.ok(!/Program Files[\\/]Google[\\/]Chrome/.test(src), `${f} 不应硬编码 Chrome 路径`);
    assert.ok(!/remote-debugging-port=\d{4,}/.test(src), `${f} 不应硬编码调试端口`);
    assert.ok(!/clear:\s*true/.test(src), `${f} 不应使用 clear:true 批量清理`);
    assert.ok(raw.includes("./lib/cdp.mjs"), `${f} 应使用公共 CDP 夹具`);
  }
});

test('verify-fix.mjs 不再使用 clear:true', () => {
  const src = stripComments(fs.readFileSync(path.join(SCRIPTS, 'verify-fix.mjs'), 'utf8'));
  assert.ok(!/clear:\s*true/.test(src), 'verify-fix.mjs 不应使用 clear:true');
  assert.ok(/finally/.test(src), 'verify-fix.mjs 的清理应放在 try/finally 里');
});
