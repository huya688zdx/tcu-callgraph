const { app, BrowserWindow, dialog, Menu, shell } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

let win = null;
let child = null;
let currentTarget = null;
let serverOrigin = null;

function stopServer() {
  if (child) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    child = null;
  }
}

function startTarget(target) {
  stopServer();
  currentTarget = target;

  child = fork(path.join(ROOT, 'src', 'server.js'), [target, '0'], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  child.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  child.on('message', (m) => {
    if (m && m.ready) {
      const url = `http://127.0.0.1:${m.port}`;
      try {
        serverOrigin = new URL(url).origin;
      } catch {
        serverOrigin = null;
      }
      if (win) win.loadURL(url);
      else createWindow(url);
    }
  });

  child.on('exit', (code) => {
    if (code && code !== 0) console.error('[server] exited with', code);
  });
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1080,
    minHeight: 680,
    title: 'TCU 调用关系图',
    backgroundColor: '#F7F6F2',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL(url);
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    let protocol = '';
    try {
      protocol = new URL(u).protocol;
    } catch {
      return { action: 'deny' };
    }
    // 只把常规网页/邮件链接交给系统浏览器，拒绝 file:/ms-*: 等协议处理器
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
      shell.openExternal(u);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, targetUrl) => {
    let origin = null;
    try {
      origin = new URL(targetUrl).origin;
    } catch {
      origin = null;
    }
    // 只允许停留在本机 server，避免被源码内容或外链把窗口带出应用
    if (!serverOrigin || origin !== serverOrigin) event.preventDefault();
  });
  win.on('closed', () => {
    win = null;
  });
}

async function pickFolder() {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '选择 TCU 工程文件夹',
    properties: ['openDirectory'],
  });
  if (!r.canceled && r.filePaths[0]) startTarget(r.filePaths[0]);
}

async function pickFile() {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '选择 .dot / .c 文件',
    properties: ['openFile'],
    filters: [
      { name: 'Graphviz DOT', extensions: ['dot', 'gv'] },
      { name: 'C 源码', extensions: ['c', 'h'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (!r.canceled && r.filePaths[0]) startTarget(r.filePaths[0]);
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: pickFolder },
          { label: '打开 DOT / C 文件…', accelerator: 'CmdOrCtrl+Shift+O', click: pickFile },
          { type: 'separator' },
          {
            label: '重新扫描当前目标',
            accelerator: 'CmdOrCtrl+R',
            click: () => currentTarget && startTarget(currentTarget),
          },
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '刷新界面' },
          ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: '开发者工具' }]),
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { role: 'togglefullscreen', label: '全屏' },
        ],
      },
    ])
  );
}

app.whenReady().then(async () => {
  buildMenu();

  const arg = process.argv.slice(1).find((a) => {
    if (a.startsWith('-') || a === '.' || a === '..') return false;
    try {
      return fs.existsSync(a);
    } catch {
      return false;
    }
  });

  if (arg) {
    startTarget(path.resolve(arg));
    return;
  }

  const r = await dialog.showOpenDialog({
    title: '选择 TCU 工程文件夹',
    properties: ['openDirectory'],
  });

  if (r.canceled || !r.filePaths[0]) {
    app.quit();
    return;
  }
  startTarget(r.filePaths[0]);
});

app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});

app.on('activate', () => {
  // macOS 点 Dock 图标：没有窗口时按当前目标重建
  if (BrowserWindow.getAllWindows().length) return;
  if (currentTarget) startTarget(currentTarget);
  else pickFolder();
});

app.on('before-quit', stopServer);
