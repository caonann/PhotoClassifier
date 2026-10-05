'use strict';

const { app, BrowserWindow, dialog, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// 单实例：再次双击 app 时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
}

// 数据与缓存目录放到用户目录，而不是只读的 .app 包内
process.env.PHOTO_CLASSIFIER_DATA_DIR = path.join(app.getPath('userData'), 'data');
process.env.PHOTO_CLASSIFIER_CACHE_DIR = path.join(app.getPath('userData'), 'cache');

const server = require('./server');
let mainWindow = null;
let httpServer = null;

const WIN_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
function loadWinState() {
  try { return JSON.parse(fs.readFileSync(WIN_STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveWinState(win) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(WIN_STATE_FILE, JSON.stringify({ ...b, maximized: win.isMaximized(), fullscreen: win.isFullScreen() }));
  } catch { /* ignore */ }
}

async function createWindow(port) {
  const st = loadWinState();
  mainWindow = new BrowserWindow({
    width: st.width || 1440,
    height: st.height || 900,
    x: st.x,
    y: st.y,
    minWidth: 1000,
    minHeight: 640,
    title: 'PhotoClassifier',
    backgroundColor: '#121417',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (st.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => saveWinState(mainWindow));
  mainWindow.on('closed', () => { mainWindow = null; });

  // 外链（例如 GPS 地图）用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

/** 用 Electron 原生对话框替代 osascript */
server.setFolderPicker(async (prompt, defaultDir) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: prompt,
    message: prompt,
    buttonLabel: '选择',
    defaultPath: defaultDir && fs.existsSync(defaultDir) ? defaultDir : app.getPath('pictures'),
    properties: ['openDirectory', 'createDirectory', 'treatPackageAsDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 PhotoClassifier' },
        { type: 'separator' },
        {
          label: '打开数据目录',
          click: () => shell.openPath(app.getPath('userData')),
        },
        {
          label: '清空缩略图缓存',
          click: async () => {
            fs.rmSync(process.env.PHOTO_CLASSIFIER_CACHE_DIR, { recursive: true, force: true });
            fs.mkdirSync(process.env.PHOTO_CLASSIFIER_CACHE_DIR, { recursive: true });
            dialog.showMessageBox(mainWindow, { message: '缓存已清空', buttons: ['好'] });
          },
        },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 PhotoClassifier' },
      ],
    }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '拷贝' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大界面' }, { role: 'zoomOut', label: '缩小界面' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, ...(isMac ? [{ type: 'separator' }, { role: 'front', label: '全部置于顶层' }] : [{ role: 'close', label: '关闭' }])],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) {
    const icon = path.join(__dirname, 'build', 'icon.png');
    if (fs.existsSync(icon)) app.dock.setIcon(nativeImage.createFromPath(icon));
  }
  buildMenu();
  try {
    const r = await server.start(0); // 随机空闲端口，避免与其他程序冲突
    httpServer = r.server;
    await createWindow(r.port);
  } catch (e) {
    dialog.showErrorBox('启动失败', String(e && e.stack || e));
    app.quit();
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0 && httpServer) {
      await createWindow(httpServer.address().port);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (httpServer) httpServer.close();
});
