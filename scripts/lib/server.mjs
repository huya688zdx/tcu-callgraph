/**
 * 本地服务夹具：起一个 src/server.js 子进程，返回它的 baseUrl
 *
 * 端口传 0 由系统分配（src/server.js 监听后会通过 IPC 回报真实端口），
 * 所以 E2E 不用再要求「人手先起 5173」，多开也不会撞端口。
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const SERVER = path.join(ROOT, 'src', 'server.js');

/**
 * 启动服务
 * @param {object} opts
 * @param {string} opts.target     扫描目标目录（相对仓库根）
 * @param {number} opts.port       端口；0 = 系统分配
 * @param {number} opts.timeoutMs  启动超时
 * @returns {Promise<{baseUrl:string, port:number, close:() => Promise<void>, child:object}>}
 */
export async function launchServer({ target = 'samples/tcu', port = 0, timeoutMs = 30000 } = {}) {
  // 每个实例一份临时库：E2E 会改标注、删节点，绝不能写进用户真实的 userData 库
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-e2e-'));
  const dbPath = path.join(tmpDir, 'callgraph.db');

  const child = fork(SERVER, [target, String(port)], {
    cwd: ROOT,
    env: { ...process.env, CALLGRAPH_DB: dbPath },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  // 收集子进程输出：启动失败时把日志带进错误信息
  let log = '';
  child.stdout?.on('data', (d) => {
    log += d;
  });
  child.stderr?.on('data', (d) => {
    log += d;
  });

  const actualPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`服务启动超时（${timeoutMs}ms）\n${log}`));
    }, timeoutMs);
    child.on('message', (m) => {
      if (m && m.ready) {
        clearTimeout(timer);
        resolve(m.port);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`服务进程提前退出（code ${code} signal ${signal}）\n${log}`));
    });
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const t = setTimeout(resolve, 3000); // 兜底：不让 close() 卡死调用方
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响测试结论 */
    }
  };

  return {
    baseUrl: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    target,
    close,
    child,
  };
}
