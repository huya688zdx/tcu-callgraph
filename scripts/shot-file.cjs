// 截图 + 控制台诊断：从 json 读配置（沙箱里命令行带 http:// 会静默失败）
// 用法: electron scripts/shot-file.cjs <config.json>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { url, out, w = 1600, h = 1000, wait = 2600 } = cfg;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: w,
    height: h,
    show: false,
    backgroundColor: '#F7F6F2',
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });
  const logs = [];
  win.webContents.on('console-message', (_e, level, msg) => logs.push(`[${level}] ${msg}`));
  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, wait));
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
  if (out) {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
  }
  console.log('INFO ' + info);
  for (const l of logs) console.log(l);
  app.quit();
});
