'use strict';
// Electron shell: one window, native file dialogs, system clipboard, single instance.
// All editing happens in the renderer (dist/); this file only touches the OS.
const { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, nativeImage, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'dist', 'index.html');
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.jpe', '.webp', '.gif', '.bmp', '.avif', '.ora', '.2dlayered', '.3dlayered']);
const SAVE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ora']);

function userAppDir() {
  const base = process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share');
  return path.join(base, 'stratum', 'app');
}

function versionOf(dir) {
  try { return require(path.join(dir, 'package.json')).version; } catch { return '0'; }
}

function cmpVer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// A packaged copy lives in /usr and cannot write there. A newer copy in the
// home folder (from Check for Updates) is the one that should open.
function newerUserCopy() {
  const dest = userAppDir();
  if (path.resolve(dest) === path.resolve(ROOT)) return null;
  if (!fs.existsSync(path.join(dest, 'dist', 'index.html'))) return null;
  return cmpVer(versionOf(dest), versionOf(ROOT)) > 0 ? dest : null;
}

const userCopy = newerUserCopy();
if (userCopy && !process.argv.includes('--script')) {
  spawn(process.execPath, [userCopy], { detached: true, stdio: 'ignore' }).unref();
  app.exit(0);
  return;
}

const SCRIPT_MODE = process.argv.includes('--script');
let ownsScriptPort = false;
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
  if (!SCRIPT_MODE) win.once('ready-to-show', () => win.show());
}

app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const files = filesFromArgv(argv);
  if (files.length) readFiles(files).then((f) => win?.webContents.send('app:open-files', f));
});

// ---------------------------------------------------------------- IPC

ipcMain.handle('dialog:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ora', '2dlayered', '3dlayered'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : readFiles(r.filePaths);
});

ipcMain.handle('dialog:open-mesh', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Models', extensions: ['obj', 'stl', 'fbx', 'glb', 'gltf', 'json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const filePath = r.filePaths[0];
  const bytes = new Uint8Array(await fs.promises.readFile(filePath));
  return { name: path.basename(filePath), path: filePath, bytes };
});

function assertSegment(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,80}$/i.test(value)) throw new Error('Bad job name.');
  return value;
}

ipcMain.handle('scratch:write', async (_e, jobId, savepoint, kind, bytes) => {
  if (kind !== '2dlayered' && kind !== '3dlayered') throw new Error('Unknown job type.');
  const dir = path.join(app.getPath('userData'), 'internal', assertSegment(jobId), assertSegment(savepoint));
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `structure.${kind}`);
  await fs.promises.writeFile(dest, Buffer.from(bytes));
  const parent = path.dirname(dir);
  const names = (await fs.promises.readdir(parent)).sort();
  while (names.length > 3) {
    await fs.promises.rm(path.join(parent, names.shift()), { recursive: true, force: true });
  }
  return dest;
});

ipcMain.handle('scratch:drop', async (_e, jobId) => {
  const dir = path.join(app.getPath('userData'), 'internal', assertSegment(jobId));
  await fs.promises.rm(dir, { recursive: true, force: true });
});

ipcMain.handle('job:export', async (_e, defaultName, bytes) => {
  const name = path.basename(String(defaultName || 'job.2dlayered'));
  const ext = path.extname(name).toLowerCase();
  if (ext !== '.2dlayered' && ext !== '.3dlayered') throw new Error('Refusing that file type.');
  const r = await dialog.showSaveDialog(win, {
    defaultPath: name,
    filters: [{ name: ext === '.3dlayered' ? 'Stratum 3D job' : 'Stratum 2D job', extensions: [ext.slice(1)] }],
  });
  if (r.canceled || !r.filePath) return null;
  let dest = r.filePath;
  if (path.extname(dest).toLowerCase() !== ext) dest += ext;
  await fs.promises.writeFile(dest, Buffer.from(bytes));
  return dest;
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
function runCmd(cmd, args, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error((err || out || `${cmd} failed`).trim().slice(0, 500)));
    });
  });
}

function fetchBuf(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Stratum', Accept: '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects > 5) { reject(new Error('Update server redirected too many times.')); return; }
        resolve(fetchBuf(new URL(res.headers.location, url).href, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Update server returned ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('The update server took too long.')));
  });
}

async function githubVersion() {
  const buf = await fetchBuf('https://raw.githubusercontent.com/sera5m/stratiumpaint/master/package.json');
  return String(JSON.parse(buf.toString('utf8')).version || '');
}

async function canWrite(dir) {
  try { await fs.promises.access(dir, fs.constants.W_OK); return true; }
  catch { return false; }
}

/** Where an update is allowed to land. A /usr install is redirected to the home folder. */
async function updateDest() {
  if (await canWrite(ROOT)) return ROOT;
  const dest = userAppDir();
  await fs.promises.mkdir(dest, { recursive: true });
  if (!(await canWrite(dest))) throw new Error('Stratum could not find a folder it is allowed to write the update into.');
  return dest;
}

async function downloadUpdate(dest) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stratum-upd-'));
  try {
    const tarPath = path.join(tmp, 'src.tar.gz');
    await fs.promises.writeFile(tarPath, await fetchBuf('https://codeload.github.com/sera5m/stratiumpaint/tar.gz/refs/heads/master'));
    await runCmd('tar', ['-xzf', tarPath, '-C', tmp]);
    const top = (await fs.promises.readdir(tmp)).find((n) => n.startsWith('stratiumpaint'));
    if (!top) throw new Error('The download did not contain Stratum.');
    await fs.promises.cp(path.join(tmp, top), dest, {
      recursive: true,
      force: true,
      filter: (src) => {
        const base = path.basename(src);
        return base !== '.git' && base !== 'node_modules';
      },
    });
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function buildAt(dir) {
  try {
    await runCmd('npm', ['run', 'build'], dir);
  } catch (err) {
    try {
      await runCmd('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
      await runCmd('npm', ['run', 'build'], dir);
    } catch {
      throw new Error(`The update downloaded, but it did not build. ${String(err.message || err).slice(0, 300)}`);
    }
  }
}

function quoteDesktop(s) {
  return /[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s);
}

/** Point the app menu and ~/.local/bin/stratum at the home copy. */
function writeUserLauncher(dir) {
  const home = app.getPath('home');
  const desktopDir = path.join(home, '.local', 'share', 'applications');
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const exec = `${quoteDesktop(process.execPath)} ${quoteDesktop(dir)} %F`;
  fs.writeFileSync(path.join(desktopDir, 'stratum.desktop'), `[Desktop Entry]
Type=Application
Name=Stratum
GenericName=Image Editor
Comment=Layered raster image editor
Exec=${exec}
Icon=stratum
Terminal=false
Categories=Graphics;RasterGraphics;2DGraphics;
StartupWMClass=stratum
`);
  fs.writeFileSync(path.join(binDir, 'stratum'), `#!/bin/sh\nexec ${quoteDesktop(process.execPath)} ${quoteDesktop(dir)} "$@"\n`, { mode: 0o755 });
}

function relaunchAt(dir) {
  forceClose = true;
  app.releaseSingleInstanceLock();
  if (path.resolve(dir) === path.resolve(ROOT)) {
    app.relaunch();
  } else {
    writeUserLauncher(dir);
    spawn(process.execPath, [dir], { detached: true, stdio: 'ignore' }).unref();
  }
  app.quit();
}

ipcMain.handle('app:check-update', async () => {
  const version = require(path.join(ROOT, 'package.json')).version;
  let git = false;
  try {
    await runCmd('git', ['rev-parse', '--is-inside-work-tree']);
    git = true;
  } catch { /* installed copy, not a checkout */ }
  if (git) {
    try {
      await runCmd('git', ['fetch', '--quiet', 'origin']);
      let behind = '0';
      try { behind = await runCmd('git', ['rev-list', '--count', 'HEAD..@{u}']); }
      catch { behind = await runCmd('git', ['rev-list', '--count', 'HEAD..origin/master']); }
      const n = parseInt(behind, 10) || 0;
      let note = '';
      if (n) { try { note = await runCmd('git', ['log', '-1', '--pretty=%s', 'origin/master']); } catch { /* no note */ } }
      return { version, mode: 'git', behind: n, note };
    } catch { /* origin missing or offline — try the version on GitHub */ }
  }
  try {
    const remoteVersion = await githubVersion();
    const behind = cmpVer(remoteVersion, version) > 0 ? 1 : 0;
    return { version, mode: git ? 'git' : 'download', behind, note: remoteVersion, remoteVersion };
  } catch {
    return { version, mode: 'offline', behind: 0 };
  }
});

ipcMain.handle('app:apply-update', async (_e, mode) => {
  const dest = await updateDest();
  if (mode !== 'download' && dest === ROOT) {
    try {
      await runCmd('git', ['pull', '--ff-only']);
    } catch (err) {
      if (/not a git repository/i.test(String(err.message))) await downloadUpdate(dest);
      else throw new Error(`${err.message} Local changes were left as they are.`);
    }
  } else {
    await downloadUpdate(dest);
  }
  await buildAt(dest);
  relaunchAt(dest);
});

ipcMain.handle('app:confirm-close', () => { forceClose = true; win?.close(); });
ipcMain.handle('app:quit', () => { forceClose = true; app.quit(); });

ipcMain.handle('ollama:generate', async (_e, payload) => {
  const url = String(payload?.url || '');
  const model = String(payload?.model || '');
  const prompt = String(payload?.prompt || '');
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('That address is not a URL.'); }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('Only a model on this computer is allowed.');
  }
  if (!model || model.length > 80) throw new Error('Type the Ollama model name.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(parsed.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, options: { num_ctx: 8192, temperature: 0.2 } }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`The local model returned ${res.status}. Is Ollama running?`);
    const data = await res.json();
    return String(data.response || '');
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The model took longer than three minutes.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
});

// ---------------------------------------------------------------- script pipe
// `stratum --script` reads JSON commands on stdin. If a copy is already open, the
// bytes are forwarded to it and this process leaves before taking the single-instance lock.

function scriptPortFile() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'stratum', 'script.port');
}

function readScriptPort() {
  try { return Number(fs.readFileSync(scriptPortFile(), 'utf8')) || 0; } catch { return 0; }
}

function proxyScript(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const fail = (err) => { sock.destroy(); reject(err); };
    sock.once('error', fail);
    sock.once('connect', () => {
      sock.off('error', fail);
      process.stdin.pipe(sock);
      sock.pipe(process.stdout);
      const done = () => resolve();
      sock.on('end', done);
      sock.on('close', done);
      sock.on('error', done);
      process.stdin.on('end', () => sock.end());
    });
  });
}

const scriptWaiters = new Map();
const scriptQueue = [];
let scriptReady = false;
let scriptSeq = 0;

function handleScriptLine(line) {
  const text = String(line || '').trim();
  if (!text) return Promise.resolve({ ok: true, skipped: true });
  return new Promise((resolve) => {
    const id = ++scriptSeq;
    scriptWaiters.set(id, resolve);
    const send = () => win?.webContents.send('script:exec', { id, line: text });
    if (scriptReady && win) send();
    else scriptQueue.push(send);
    setTimeout(() => {
      if (!scriptWaiters.has(id)) return;
      scriptWaiters.delete(id);
      resolve({ ok: false, error: 'Script timed out.' });
    }, 120000);
  });
}

ipcMain.on('script:ready', () => {
  scriptReady = true;
  for (const send of scriptQueue.splice(0)) send();
});
ipcMain.on('script:result', (_e, id, result) => {
  const resolve = scriptWaiters.get(id);
  if (!resolve) return;
  scriptWaiters.delete(id);
  resolve(result);
});

function startScriptServer() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          handleScriptLine(line).then((res) => sock.write(`${JSON.stringify(res)}\n`)).catch((err) => {
            sock.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
          });
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const file = scriptPortFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(port));
      ownsScriptPort = true;
      resolve(server);
    });
  });
}

function pipeStdin() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleScriptLine(line).then((res) => process.stdout.write(`${JSON.stringify(res)}\n`));
    }
  });
  process.stdin.on('end', () => {
    const finish = () => {
      if (scriptWaiters.size || scriptQueue.length) { setTimeout(finish, 40); return; }
      forceClose = true;
      app.exit(0);
    };
    setTimeout(finish, 40);
  });
}

app.on('will-quit', () => {
  if (!ownsScriptPort) return;
  try { fs.unlinkSync(scriptPortFile()); } catch { /* already gone */ }
});

async function launch() {
  if (SCRIPT_MODE) {
    const port = readScriptPort();
    if (port) {
      try { await proxyScript(port); process.exit(0); return; }
      catch { /* the port file is stale; become the host if we can */ }
    }
  }
  app.setName('stratum');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  if (!app.requestSingleInstanceLock()) {
    if (SCRIPT_MODE) {
      await new Promise((r) => setTimeout(r, 300));
      const port = readScriptPort();
      if (port) {
        try { await proxyScript(port); process.exit(0); return; } catch { /* still down */ }
      }
      console.error('Stratum is already running, but its script port is not accepting a pipe.');
      process.exit(1);
    }
    app.quit();
    return;
  }
  app.whenReady().then(async () => {
    createWindow();
    try { await startScriptServer(); } catch (err) { console.error('Script port failed:', err.message); }
    if (SCRIPT_MODE) pipeStdin();
  });
  app.on('window-all-closed', () => app.quit());
}

launch();

