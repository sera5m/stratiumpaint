'use strict';
// Electron shell: one window, native file dialogs, system clipboard, single instance.
// All editing happens in the renderer (dist/); this file only touches the OS.
const { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'dist', 'index.html');
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.jpe', '.webp', '.gif', '.bmp', '.avif', '.ora']);
const SAVE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ora']);

app.setName('stratum');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto'); // native Wayland when available

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let win = null;
let forceClose = false;

const isImagePath = (p) => IMAGE_EXTS.has(path.extname(p).toLowerCase());

/** Image files named on a command line (flags and non-images are ignored). */
const filesFromArgv = (argv) => argv.slice(1).filter((a) => !a.startsWith('-') && isImagePath(a) && fs.existsSync(a)).map((a) => path.resolve(a));

async function readFiles(paths) {
  const out = [];
  for (const p of paths) {
    try {
      out.push({ name: path.basename(p), path: p, bytes: new Uint8Array(await fs.promises.readFile(p)) });
    } catch (err) {
      console.error(`Could not read ${p}:`, err.message);
    }
  }
  return out;
}

const pending = filesFromArgv(process.argv);

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#121316', title: 'Stratum', show: false, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null); // the app draws its own menu bar
  win.loadFile(INDEX);
  win.once('ready-to-show', () => win.show());

  // Let the renderer ask about unsaved work before the window really closes.
  win.on('close', (e) => {
    if (forceClose || win.webContents.isCrashed()) return;
    e.preventDefault();
    win.webContents.send('app:request-close');
  });
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
}

app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const files = filesFromArgv(argv);
  if (files.length) readFiles(files).then((f) => win?.webContents.send('app:open-files', f));
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------- IPC

ipcMain.handle('dialog:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ora'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : readFiles(r.filePaths);
});

ipcMain.handle('dialog:open-mesh', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Models', extensions: ['obj', 'json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const filePath = r.filePaths[0];
  const text = await fs.promises.readFile(filePath, 'utf8');
  return { name: path.basename(filePath), path: filePath, text };
});

ipcMain.handle('dialog:save', async (_e, defaultName) => {
  const name = typeof defaultName === 'string' ? defaultName : 'Untitled.png';
  const ext = path.extname(name).slice(1).toLowerCase();
  const filters = [
    { name: 'PNG', extensions: ['png'] },
    { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
    { name: 'WebP', extensions: ['webp'] },
    { name: 'OpenRaster (keeps layers)', extensions: ['ora'] },
  ].sort((a, b) => b.extensions.includes(ext) - a.extensions.includes(ext)); // the current format first
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('file:write', async (_e, filePath, bytes) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !SAVE_EXTS.has(path.extname(filePath).toLowerCase())) {
    throw new Error('Refusing to write that file type.');
  }
  await fs.promises.writeFile(filePath, Buffer.from(bytes));
});

function backupDir(hintPath) {
  const base = (typeof hintPath === 'string' && path.isAbsolute(hintPath))
    ? path.dirname(hintPath)
    : app.getPath('userData');
  return path.join(base, '.stratum-backups');
}

async function prune(dir, prefix, keep) {
  const names = (await fs.promises.readdir(dir)).filter((n) => n.startsWith(prefix)).sort();
  while (names.length > keep) await fs.promises.unlink(path.join(dir, names.shift()));
}

/** Keep the previous bytes of a file we are about to overwrite. */
ipcMain.handle('file:backup-existing', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Refusing that path.');
  if (!fs.existsSync(filePath)) return null;
  const dir = backupDir(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${path.basename(filePath)}.${stamp}`);
  await fs.promises.copyFile(filePath, dest);
  const ext = path.extname(filePath);
  const alias = path.join(path.dirname(filePath), `${path.basename(filePath, ext)}.bak${ext || '.png'}`);
  await fs.promises.copyFile(filePath, alias);
  await prune(dir, path.basename(filePath), 12);
  return dest;
});

ipcMain.handle('file:write-backup', async (_e, hintPath, filename, bytes) => {
  const safe = path.basename(String(filename || 'backup.ora')).replace(/[^a-z0-9._-]+/gi, '_');
  if (!safe.endsWith('.ora') && !SAVE_EXTS.has(path.extname(safe).toLowerCase())) {
    throw new Error('Refusing to write that backup type.');
  }
  const dir = backupDir(hintPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, safe);
  await fs.promises.writeFile(dest, Buffer.from(bytes));
  await prune(dir, '', 24);
  return dest;
});

// Electron replaced the sync clipboard.writeImage/readImage with a W3C-style async API (clipboard.write/read
// with ClipboardItem). Support both, so this works on whatever `electron` the distro ships.
async function clipboardWritePng(bytes) {
  if (typeof clipboard.writeImage === 'function') {
    const img = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (!img.isEmpty()) clipboard.writeImage(img);
    return;
  }
  const { ClipboardItem } = require('electron');
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
}

async function clipboardReadPng() {
  if (typeof clipboard.readImage === 'function') {
    const img = clipboard.readImage();
    return img.isEmpty() ? null : new Uint8Array(img.toPNG());
  }
  for (const item of await clipboard.read()) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) return new Uint8Array(await (await item.getType(type)).arrayBuffer());
  }
  return null;
}

ipcMain.handle('clipboard:write-image', (_e, bytes) => clipboardWritePng(bytes));
ipcMain.handle('clipboard:read-image', () => clipboardReadPng());

ipcMain.handle('app:initial-files', async () => readFiles(pending.splice(0)));
ipcMain.handle('app:confirm-close', () => { forceClose = true; win?.close(); });
ipcMain.handle('app:quit', () => { forceClose = true; app.quit(); });
