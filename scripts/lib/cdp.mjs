/**
 * Chrome DevTools Protocol 夹具
 *
 * 起一个无头 Chrome、连上调试 WebSocket，提供求值 / 等待 / 点击 / 拖拽 / 按键 / 截图，
 * 结束时统一收尾（关连接 → 杀进程 → 删临时 profile）。
 *
 * 之前三个 e2e-*.mjs 各抄了一份约 60 行的「起 Chrome + 连 WebSocket + send/evaluate/click」样板，
 * 现在统一收敛到这里。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 常见 Chrome 安装位置（按平台探测，第一个存在的就用） */
function chromeCandidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files/Google/Chrome Beta/Application/chrome.exe',
      path.join(home, 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

/**
 * 定位 Chrome 可执行文件。
 * 优先级：显式参数 > CHROME_PATH 环境变量 > 常见安装路径；都找不到就明确报错（不静默失败）。
 */
export function resolveChromePath({ chromePath, env = process.env } = {}) {
  const explicit = chromePath || env.CHROME_PATH;
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    throw new Error(
      `找不到 Chrome 可执行文件：${explicit}\n` +
        '（该路径来自 chromePath 参数或 CHROME_PATH 环境变量）'
    );
  }
  const list = chromeCandidates();
  for (const p of list) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 探测失败就跳过 */
    }
  }
  throw new Error(
    '找不到 Chrome 可执行文件。请安装 Chrome，或用 CHROME_PATH 环境变量指定路径。\n已探测：\n' +
      list.map((p) => '  - ' + p).join('\n')
  );
}

/** 轮询直到 fn 返回真值；超时抛错（fn 抛出的异常记在错误信息里） */
async function poll(fn, { timeoutMs = 30000, interval = 50, label = '等待' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}超时（${timeoutMs}ms）${lastErr ? '：' + lastErr.message : ''}`);
    }
    await sleep(interval);
  }
}

/**
 * 起 Chrome 并连上调试 WebSocket。
 *
 * @param {object} opts
 * @param {string} opts.url          起始页面
 * @param {number} opts.width        窗口宽
 * @param {number} opts.height       窗口高
 * @param {number} opts.port         调试端口；0 = 让系统分配（避免固定端口冲突）
 * @param {number} opts.timeoutMs    启动 / 命令超时
 * @param {string} opts.chromePath   显式指定 Chrome 路径
 * @returns {Promise<object>} handle：send/evaluate/waitFor/click/rightClick/drag/pressKey/screenshot/close
 */
export async function launchCdp({
  url = 'about:blank',
  width = 1400,
  height = 950,
  port = 0,
  timeoutMs = 30000,
  chromePath,
  profilePrefix = 'cg-cdp-',
} = {}) {
  const exe = resolveChromePath({ chromePath });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), profilePrefix));

  const chrome = spawn(
    exe,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-proxy-server',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-dev-shm-usage',
      `--window-size=${width},${height}`,
      // 0 = 由系统挑空闲端口，避免多开 E2E 时固定端口互相抢占
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      url,
    ],
    { stdio: 'ignore' }
  );

  // spawn 失败（ENOENT / 权限）不会抛到调用方，只会触发 'error' 事件
  let spawnError = null;
  chrome.on('error', (err) => {
    spawnError = err;
  });
  // 脚本被强杀时至少不留孤儿 Chrome
  const killOnExit = () => {
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
  };
  process.once('exit', killOnExit);

  const cleanupProfile = () => {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  let ws = null;
  let closed = false;

  try {
    // ---- 1. 拿实际调试端口 ----
    const realPort = await poll(
      async () => {
        if (spawnError) throw spawnError;
        if (chrome.exitCode !== null) {
          throw new Error(`Chrome 提前退出（code ${chrome.exitCode}）`);
        }
        // port=0 时 Chrome 把真实端口写进 profile 目录
        const file = path.join(profile, 'DevToolsActivePort');
        let txt = '';
        try {
          txt = fs.readFileSync(file, 'utf8');
        } catch {
          return null; // 还没写出来
        }
        const first = txt.split(/\r?\n/)[0]?.trim();
        return /^\d+$/.test(first || '') ? Number(first) : null;
      },
      { timeoutMs, label: 'Chrome 调试端口' }
    );

    // ---- 2. 找到页面目标 ----
    const target = await poll(
      async () => {
        const res = await fetch(`http://127.0.0.1:${realPort}/json/list`);
        const list = await res.json();
        const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (!pages.length) return null;
        // 优先选起始 URL 对应的那个标签页
        return pages.find((t) => url !== 'about:blank' && String(t.url || '').startsWith(url)) || pages[0];
      },
      { timeoutMs, label: 'Chrome 页面目标' }
    );

    // ---- 3. 连 WebSocket ----
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error('无法连接 Chrome 调试 WebSocket'));
    });

    // ---- 4. 命令管道 ----
    let msgId = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!m.id || !pending.has(m.id)) return;
      const { resolve, reject, timer, method } = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(timer);
      if (m.error) reject(new Error(`CDP ${method} 失败：${m.error.message || JSON.stringify(m.error)}`));
      else resolve(m);
    };

    const send = (method, params = {}, { timeoutMs: cmdTimeoutMs = 15000 } = {}) =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error(`CDP ${method}：连接已关闭`));
          return;
        }
        const id = ++msgId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} 超时（${cmdTimeoutMs}ms）`));
        }, cmdTimeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });

    /** 在页面里求值；页面抛异常时把异常抛给调用方 */
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      const d = r.result?.exceptionDetails;
      if (d) {
        throw new Error('页面求值异常：' + (d.exception?.description || d.text || '未知异常'));
      }
      return r.result?.result?.value;
    };

    /** 条件等待：表达式为真才返回（替代固定 sleep） */
    const waitFor = async (expression, { timeoutMs: waitMs = 10000, interval = 100 } = {}) => {
      const deadline = Date.now() + waitMs;
      for (;;) {
        let v = null;
        try {
          v = await evaluate(expression);
        } catch {
          v = null; // 页面还没就绪时求值会抛，继续等
        }
        if (v) return v;
        if (Date.now() >= deadline) {
          throw new Error(`等待超时（${waitMs}ms）：${expression}`);
        }
        await sleep(interval);
      }
    };

    const mouse = async (type, x, y, button, extra = {}) =>
      send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button,
        clickCount: 1,
        ...extra,
      });

    const click = (x, y) => mouse('mousePressed', x, y, 'left').then(() => mouse('mouseReleased', x, y, 'left'));

    const rightClick = (x, y) =>
      mouse('mousePressed', x, y, 'right').then(() => mouse('mouseReleased', x, y, 'right'));

    /** 按下 → 分步移动 → 松开 */
    const drag = async (x0, y0, x1, y1, { steps = 12, stepDelayMs = 16 } = {}) => {
      await mouse('mousePressed', x0, y0, 'left');
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: x0 + (x1 - x0) * t,
          y: y0 + (y1 - y0) * t,
          button: 'left',
          buttons: 1,
        });
        // 分步移动之间留一帧：前端在 pointermove 里实时重布线，
        // 一次性跳到终点会让中间过程被跳过（节点可能直接落在目标身上）
        if (stepDelayMs) await sleep(stepDelayMs);
      }
      await mouse('mouseReleased', x1, y1, 'left');
    };

    /** 敲一个键；modifiers 用 CDP 的位掩码（1=Alt 2=Ctrl 4=Meta 8=Shift） */
    const pressKey = async ({ key, code, vk, modifiers } = {}) => {
      const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      if (modifiers) base.modifiers = modifiers;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    };

    /** 截图落盘 */
    const screenshot = async (outPath) => {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const data = shot.result?.data;
      if (!data) throw new Error('截图失败：Page.captureScreenshot 没有返回图像数据');
      const buf = Buffer.from(data, 'base64');
      if (outPath) {
        fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
        fs.writeFileSync(outPath, buf);
      }
      return { path: outPath, buffer: buf, size: buf.length };
    };

    /** 幂等收尾：关连接 → 杀 Chrome → 删 profile */
    const close = async () => {
      if (closed) return;
      closed = true;
      process.off('exit', killOnExit);
      try {
        if (ws) ws.close();
      } catch {
        /* ignore */
      }
      try {
        chrome.kill();
      } catch {
        /* ignore */
      }
      // 给 Chrome 一点时间退出，再删 profile（否则文件被占用）
      await sleep(200);
      cleanupProfile();
    };

    return {
      send,
      evaluate,
      waitFor,
      click,
      rightClick,
      drag,
      pressKey,
      screenshot,
      close,
      port: realPort,
      profile,
      chromePath: exe,
    };
  } catch (err) {
    // 启动失败也要收尾，别把临时 profile 和 Chrome 进程留在后台
    closed = true;
    process.off('exit', killOnExit);
    try {
      if (ws) ws.close();
    } catch {
      /* ignore */
    }
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
    cleanupProfile();
    throw err;
  }
}
