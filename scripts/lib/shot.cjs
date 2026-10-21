/**
 * Electron 截图的公共实现（shot.cjs / shot-file.cjs 共用）
 *
 * 用已装好的 Electron 无头打开页面，等页面画完再截图，方便核对布局效果。
 * 需要在 Electron 主进程里跑（app / BrowserWindow 只有 Electron 才有）。
 */
const fs = require('node:fs');

/** 延迟 require：普通 node 进程里也能 require 本模块做参数解析 */
function electronApi() {
  return require('electron');
}

const DEFAULTS = { url: '', out: '', w: 1600, h: 1000, wait: 2600 };

/**
 * 解析命令行：
 *   --config <file.json>   从 json 读配置（沙箱里命令行带 http:// 会静默失败时用这个）
 *   <url> [out] [w] [h] [waitMs]
 * 位置参数只有一个且指向 .json 文件时，按配置文件处理（兼容旧的 shot-file.cjs）。
 */
function parseShotArgs(argv) {
  const cfg = { ...DEFAULTS, config: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') {
      cfg.config = argv[++i];
    } else if (a === '--url' || a === '-u') {
      cfg.url = argv[++i];
    } else if (a === '--out' || a === '-o') {
      cfg.out = argv[++i];
    } else if (a === '--size') {
      const [w, h] = String(argv[++i] || '').split('x').map(Number);
      if (w) cfg.w = w;
      if (h) cfg.h = h;
    } else if (a === '--wait') {
      cfg.wait = Number(argv[++i]);
    } else {
      rest.push(a);
    }
  }

  if (cfg.config) {
    const file = JSON.parse(fs.readFileSync(cfg.config, 'utf8'));
    for (const k of Object.keys(DEFAULTS)) {
      if (file[k] !== undefined) cfg[k] = file[k];
    }
    return cfg;
  }

  // 位置参数：url [out] [w] [h] [waitMs]
  const [url, out, w, h, wait] = rest;
  if (url) {
    // 旧接口：shot-file.cjs <config.json>
    const looksLikeConfig = /\.json$/i.test(url) && fs.existsSync(url);
    if (looksLikeConfig) {
      const file = JSON.parse(fs.readFileSync(url, 'utf8'));
      for (const k of Object.keys(DEFAULTS)) {
        if (file[k] !== undefined) cfg[k] = file[k];
      }
      return cfg;
    }
    cfg.url = url;
    if (out) cfg.out = out;
    if (w) cfg.w = Number(w);
    if (h) cfg.h = Number(h);
    if (wait) cfg.wait = Number(wait);
  }
  return cfg;
}

/**
 * 打开页面 → 等一会儿 → 截图落盘 → 打印页面诊断信息
 */
async function capture(cfg) {
  const { app, BrowserWindow } = electronApi();
  const win = new BrowserWindow({
    width: cfg.w,
    height: cfg.h,
    show: false,
    backgroundColor: '#F7F6F2',
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });

  const logs = [];
  // Electron 37+ 的 console-message 只传一个事件对象，旧版是 (event, level, message)
  win.webContents.on('console-message', (...args) => {
    const ev = args[0];
    const isObj = ev && typeof ev === 'object';
    const level = isObj && ev.level !== undefined ? ev.level : args[1];
    const msg = isObj && ev.message !== undefined ? ev.message : args[2];
    logs.push(`[${level}] ${msg}`);
  });

  try {
    await win.loadURL(cfg.url);
  } catch (err) {
    console.error('页面加载失败:', err.message);
    throw err;
  }
  // 页面首次渲染 + 布局需要一点时间
  await new Promise((r) => setTimeout(r, cfg.wait));

  const info = await win.webContents.executeJavaScript(
    `JSON.stringify({
       err: document.body.getAttribute('data-err'),
       draw: document.body.getAttribute('data-draw'),
       nodes: window.__cg && window.__cg.view ? window.__cg.view.nodes.length : null,
       edges: window.__cg && window.__cg.view ? window.__cg.view.edges.length : null,
       root: window.__cg ? window.__cg.root : null,
       overlaps: window.__cg ? window.__cg.overlaps().length : null,
     })`
  );

  if (cfg.out) {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(cfg.out, img.toPNG());
    console.log('saved', cfg.out, img.getSize());
  }
  console.log('INFO ' + info);
  for (const l of logs) console.log(l);
  win.destroy();
  return { info, logs };
}

/** 命令行入口：解析参数 → 等 Electron 就绪 → 截图 → 退出 */
function runShotCli(argv) {
  const cfg = parseShotArgs(argv);
  if (!cfg.url) {
    console.error(
      '用法:\n' +
        '  electron scripts/shot.cjs <url> [out.png] [宽] [高] [等待ms]\n' +
        '  electron scripts/shot.cjs --config <config.json>'
    );
    process.exit(2);
  }
  const { app } = electronApi();
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    try {
      await capture(cfg);
    } catch (err) {
      console.error('截图失败:', err.message);
      process.exitCode = 1;
    }
    app.quit();
  });
}

module.exports = { parseShotArgs, capture, runShotCli, DEFAULTS };
