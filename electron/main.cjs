const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { saveExport } = require('./export.cjs');

const ROOT = path.resolve(__dirname, '..');
/**
 * 单实例锁：两个实例会各起一个 server 子进程写同一个 SQLite 库，
 * 写锁冲突下轻则报错、重则界面白屏（子进程被 SQLITE_BUSY 打死）。
 * 拿不到锁就把当前实例退出，把已有窗口叫到前面来。
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let win = null;
let child = null;
let currentTarget = null;
let serverOrigin = null;
ipcMain.handle('cg:save-export', (event, payload) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== serverOrigin) throw new Error('无效的导出来源');
  return saveExport({ dialog, window: win, userData: app.getPath('userData') }, payload);
});
// 启动后是否自动展开工程选择面板（有多个历史工程时才有意义）
let openPickerOnLoad = false;
// 子进程最近输出：启动失败时贴进错误框，否则用户只看到白屏、拿不到任何线索
let serverLog = '';
// 主动停旧进程时置位，避免把「切换工程」误判成启动失败
let stopping = false;

const noteServerLog = (s) => {
  serverLog = (serverLog + s).slice(-4000);
};

/**
 * 从本地库里取最近打开的工程。
 * 主进程能直接读 node:sqlite（Electron 内嵌 Node 24），
 * 所以不必等子进程起来再问它。
 */
function readProjects(limit = 20) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const file = path.join(app.getPath('userData'), 'callgraph.db');
    if (!fs.existsSync(file)) return [];
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare('SELECT id, path, name FROM project WHERE opened_at > 0 ORDER BY opened_at DESC LIMIT ?').all(limit);
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn('[工程] 读取本地库失败：', err.message);
    return [];
  }
}

/**
 * 停掉当前 server 子进程，并**等它真的退出**再返回。
 * 以前是 kill 完立刻 fork 新的，两个进程会短暂同时持有 SQLite 库；
 * Windows 上 kill 等于 TerminateProcess，旧连接要过一会儿才释放。
 */
function stopServer() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const c = child;
    child = null;
    stopping = true;
    let timer;
    const done = () => {
      clearTimeout(timer);
      stopping = false;
      resolve();
    };
    c.once('exit', done);
    try {
      c.kill();
    } catch {
      done();
      return;
    }
    // 兜底：万一 exit 事件没来，2s 后继续，不让切工程卡死
    timer = setTimeout(done, 2000);
    if (timer.unref) timer.unref();
  });
}

/** 启动失败时给用户一个能看懂的框，而不是一片白 */
function reportStartupFailure(code) {
  const tail = serverLog.trim().split('\n').slice(-12).join('\n');
  const msg = `本地服务没能启动（退出码 ${code}）。\n\n${tail || '（子进程没有输出）'}`;
  console.error('[server] 启动失败\n' + msg);
  try {
    dialog.showErrorBox('TCU 调用关系图：启动失败', msg);
  } catch {
    /* 对话框本身失败就算了，控制台里还有一份 */
  }
  if (!win) app.quit(); // 没有窗口可重试时退出，释放单实例锁。
}

let startQueue = Promise.resolve();
function startTarget(target) {
  // 整个“停止旧服务 → 启动新服务”串行执行，避免 child 被并发覆盖。
  const pending = startQueue.then(() => startTargetNow(target));
  startQueue = pending.catch((err) => console.error('[启动] ' + err.message));
  return pending;
}

async function startTargetNow(target) {
  await stopServer();
  currentTarget = target;
  serverLog = '';

  try {
    child = fork(path.join(ROOT, 'src', 'server.js'), [target, '0'], {
      cwd: ROOT,
      // 数据库放在 Electron 的 userData 目录。只有主进程能拿到这个路径，
      // 解析跑在子进程里，所以必须用环境变量传过去，否则打包后两边指向不同目录，
      // 症状是「标注保存了但重启就没了」。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CALLGRAPH_USER_DATA: app.getPath('userData') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  } catch (err) {
    // fork 本身失败（例如打包漏了 src/server.js）：别再让 Promise 静默 reject
    noteServerLog(String(err && err.message ? err.message : err));
    reportStartupFailure(-1);
    return;
  }

  let ready = false;
  child.stdout.on('data', (d) => {
    noteServerLog(String(d));
    process.stdout.write('[server] ' + d);
  });
  child.stderr.on('data', (d) => {
    noteServerLog(String(d));
    process.stderr.write('[server] ' + d);
  });

  child.on('message', (m) => {
    if (m && m.ready) {
      ready = true;
      const url = `http://127.0.0.1:${m.port}`;
      try {
        serverOrigin = new URL(url).origin;
      } catch {
        serverOrigin = null;
      }
      if (win) {
        maybeOpenPicker(win);
        win.loadURL(url);
      } else createWindow(url);
    }
  });

  child.on('exit', (code, signal) => {
    // 主动停（切工程 / 退出）不算失败
    if (stopping) return;
    if (!ready) reportStartupFailure(code ?? signal ?? '未知');
    else if (code && code !== 0) {
      console.error('[server] exited with', code);
    }
  });
}


/** 页面就绪后自动展开工程选择面板，让用户下次打开能直接挑工程 */
function maybeOpenPicker(w) {
  if (!openPickerOnLoad) return;
  openPickerOnLoad = false;
  w.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      w.webContents
        .executeJavaScript("document.getElementById('projectBtn')?.click()")
        .catch(() => {
          /* 页面还没准备好就算了，用户可以手动点 */
        });
    }, 700);
  });
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1080,
    minHeight: 680,
    title: 'TCU 调用关系图 · ELK',
    backgroundColor: '#F7F6F2',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  maybeOpenPicker(win);
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
  let savingClose = false, allowClose = false;
  win.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    if (savingClose) return;
    savingClose = true;
    const closingWindow = win;
    let saveTimer;
    Promise.race([
      closingWindow.webContents.executeJavaScript("import('/lib/live.js').then(m => m.savePage(true))"),
      new Promise((_, reject) => {
        saveTimer = setTimeout(() => reject(new Error('保存视图超时，本地服务可能已停止')), 5000);
      }),
    ])
      .finally(() => clearTimeout(saveTimer))
      .then(() => { allowClose = true; closingWindow.close(); })
      .catch(async (err) => {
        const { response } = await dialog.showMessageBox(closingWindow, {
          type: 'warning', title: '当前视图未能保存',
          message: '是否重试保存当前视图？', detail: err.message,
          buttons: ['重试', '暂不关闭', '不保存本次视图并关闭'],
          defaultId: 1, cancelId: 1, noLink: true,
        });
        savingClose = false;
        if (response === 2) allowClose = true;
        if (response === 0 || response === 2) closingWindow.close();
      });
  });
  win.on('closed', () => {
    win = null;
  });
}

/**
 * 选择框的打开位置：用最近一次的工程目录，别让用户每次都从默认位置重新找。
 * 优先当前目标（切工程前就在看它），没有再翻本地库的最近记录。
 */
function lastProjectDir() {
  if (currentTarget) return currentTarget;
  const recent = readProjects(1);
  return recent.length ? recent[0].path : null;
}

async function showFolderDialog() {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '选择 TCU 工程文件夹',
    defaultPath: lastProjectDir() || undefined,
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0] || null;
}

async function pickFolder() {
  const dir = await showFolderDialog();
  if (dir) startTarget(dir);
}

// 工程面板的「打开」按钮在输入框为空时也走这里：同一个选择框、同一个默认路径
ipcMain.handle('cg:pick-folder', async (event) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== serverOrigin) throw new Error('无效的工程来源');
  const dir = await showFolderDialog();
  if (dir) startTarget(dir);
  return dir;
});

ipcMain.handle('cg:open-project-folder', async (event, id) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== serverOrigin) throw new Error('无效的工程来源');
  const project = readProjects(50).find((p) => p.id === id);
  if (!project) throw new Error('工程不在最近列表中');
  let stat;
  try { stat = fs.statSync(project.path); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('工程路径已不存在，可移出最近列表后重新打开');
    throw error;
  }
  if (stat.isFile()) shell.showItemInFolder(project.path);
  else {
    const error = await shell.openPath(project.path);
    if (error) throw new Error(error);
  }
});

async function pickFile() {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '选择 .dot / .c 文件',
    defaultPath: lastProjectDir() || undefined,
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
          {
            label: '切换工程…',
            accelerator: 'CmdOrCtrl+P',
            click: () => {
              if (!win) return;
              win.webContents
                .executeJavaScript("document.getElementById('projectBtn')?.click()")
                .catch(() => {});
            },
          },
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

  // 没有命令行参数：优先回到最近打开的工程，并展开选择面板让用户换
  const projects = readProjects(20).filter((p) => {
    try {
      return fs.existsSync(p.path);
    } catch {
      return false;
    }
  });
  if (projects.length) {
    openPickerOnLoad = projects.length > 1;
    console.log(`[工程] 最近打开：${projects[0].name}（共 ${projects.length} 个）`);
    startTarget(projects[0].path);
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

app.on('second-instance', () => {
  // 用户又双击了一次图标：把已有窗口叫到前面，不要开第二个实例
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('window-all-closed', async () => {
  await stopServer();
  app.quit();
});

app.on('activate', () => {
  // macOS 点 Dock 图标：没有窗口时按当前目标重建
  if (BrowserWindow.getAllWindows().length) return;
  if (currentTarget) startTarget(currentTarget);
  else pickFolder();
});

// 菜单“退出”也先走窗口保存流程，服务在窗口关闭后再停止。
app.on('before-quit', (event) => {
  if (win && !win.isDestroyed()) { event.preventDefault(); win.close(); }
});
