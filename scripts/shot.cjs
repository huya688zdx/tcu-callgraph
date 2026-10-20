// 截图小工具：electron scripts/shot.cjs <url> <out.png> [宽] [高] [等待ms]
// 用已装好的 Electron 无头截图，方便核对布局效果
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

const url = process.argv[2];
const out = process.argv[3];
const w = Number(process.argv[4] || 1600);
const h = Number(process.argv[5] || 1000);
const wait = Number(process.argv[6] || 2600);

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: w,
    height: h,
    show: false,
    backgroundColor: '#F7F6F2',
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, wait));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('saved', out, img.getSize());
  app.quit();
});
