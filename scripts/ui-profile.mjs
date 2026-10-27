// Drives the real built app (dist/index.html) in headless Chrome with mouse events over CDP and
// reports per-phase frame cost + the hottest JS functions. Diagnostic only (not part of npm test).
//   npm run profile:ui [-- canvas|webgpu]   env: MASK=ellipse|rect|none  EVENTS=16 (pointer samples per frame)
//   FLAGS='--enable-gpu-rasterization --ignore-gpu-blocklist' for GPU-rasterized canvas (SwiftShader).
// WebGPU in the full app loses its device under headless SwiftShader, so use bench:move for that path.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.CHROME || ['google-chrome', 'chromium', 'chromium-browser'].find((c) => spawnSync('which', [c]).status === 0);
const RENDERER = process.argv[2] || 'canvas';
const MASK = process.env.MASK || 'ellipse'; // ellipse | rect | none
const N = +(process.env.EVENTS || 16); // pointer events per frame (1000 Hz mouse at 60 Hz = 16)
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}/dist/index.html?renderer=${RENDERER}`;
  const port = 9800 + Math.floor(Math.random() * 100);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stratum-ui-'));
  const p = spawn(chrome, ['--headless=new', '--no-sandbox', '--window-size=1600,1000', '--disable-frame-rate-limit', '--disable-gpu-vsync', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
    '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', ...(process.env.FLAGS ? process.env.FLAGS.split(' ') : []), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, url], { stdio: 'ignore' });
  let ws = null;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(250);
    try { const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); if (page) ws = new WebSocket(page.webSocketDebuggerUrl); } catch { /* */ }
  }
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve) => {
    const my = ++id;
    const on = (m) => { const msg = JSON.parse(m.data); if (msg.id === my) { ws.removeEventListener('message', on); resolve(msg.result); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  for (let i = 0; i < 40 && !(await ev('!!window.stratum')); i++) await sleep(250);
  for (let i = 0; i < 60 && RENDERER === 'webgpu' && (await ev('window.stratum.view.renderer')) !== 'webgpu'; i++) await sleep(250);
  await sleep(500);
  const setup = await ev(`(async () => {
    const { ed, view, cmds } = window.stratum;
    if (!ed.doc) { cmds.get('viewNodes').run(); cmds.get('viewCanvas').run(); } // the only no-dialog way to get a Doc
    const D = ed.doc?.constructor;
    if (!D) return 'no doc';
    const W = 720, H = 720, doc = new D(W, H);
    const fill = (layer, f) => { const d = layer.img.data; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f(d, (y * W + x) * 4, x, y); layer.touch(); };
    fill(doc.layers[0], (d, i, x, y) => { d[i] = x & 255; d[i + 1] = y & 255; d[i + 2] = 128; d[i + 3] = 255; });
    fill(doc.addLayer(), (d, i, x, y) => { d[i] = 255; d[i + 1] = (x ^ y) & 255; d[i + 3] = 200; });
    fill(doc.addLayer(), (d, i, x, y) => { d[i + 2] = 255; d[i + 3] = ((x >> 6) + (y >> 6)) & 1 ? 60 : 0; });
    doc.active = 1;
    ed.addDoc(doc);
    const m = new Uint8Array(W * H);
    if ('${MASK}' === 'rect') for (let y = 100; y < 400; y++) m.fill(255, y * W + 100, y * W + 400);
    else for (let y = 100; y < 400; y++) for (let x = 100; x < 400; x++) if ((x - 250) ** 2 + (y - 250) ** 2 < 150 ** 2) m[y * W + x] = 255;
    if ('${MASK}' !== 'none') doc.setSelection({ width: W, height: H, data: m });
    ed.setTool('move-pixels');
    await new Promise((r) => setTimeout(r, 300));
    const r = view.overlay.getBoundingClientRect();
    window.__pt = (x, y) => [r.left + view.ox + x * view.zoom, r.top + view.oy + y * view.zoom];
    window.__frames = []; let last = performance.now();
    const tick = (t) => { window.__frames.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    return 'ok renderer=' + view.renderer + ' (' + view.rendererReason + ')' + ' zoom=' + view.zoom;
  })()`);
  console.log(setup);
  // In-page driver: each animation frame applies 4 tool events, then the app renders as usual.
  // With the frame-rate limit off, the frame interval is the real cost of a frame (JS + raster).
  await ev(`(() => {
    const { ed, view } = window.stratum;
    const E = window.__E = (x, y, extra = {}) => ({ x, y, sx: view.ox + x * view.zoom, sy: view.oy + y * view.zoom, zoom: view.zoom, ox: view.ox, oy: view.oy, button: 0, shift: false, ctrl: false, alt: false, ...extra });
    window.__run = (name, frames, perFrame) => new Promise((resolve) => {
      const times = [], js = []; let last = 0, f = 0;
      const step = (t) => {
        if (last) times.push(t - last);
        last = t;
        if (f++ >= frames) { const s = times.slice(2).sort((a, b) => a - b), j = js.slice(2).sort((a, b) => a - b); resolve({ name, median: s[s.length >> 1], p90: s[Math.floor(s.length * 0.9)], js: j[j.length >> 1] }); return; }
        const t0 = performance.now();
        perFrame(f, E);
        js.push(performance.now() - t0);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  })()`);
  const run = async (name, js) => {
    const r = await ev(js);
    console.log(`${(MASK + ' ' + r.name).padEnd(44)} frame median ${r.median.toFixed(2)} ms  p90 ${r.p90.toFixed(2)} ms  sync JS in events ${r.js.toFixed(2)} ms/frame`);
  };
  const T = 'window.stratum.ed';
  await run('', `(async () => { const ed = ${T}; ed.pointer('down', __E(250, 250)); return __run('plain drag', 120, (f, E) => { for (let k = 0; k < ${N}; k++) ed.pointer('move', E(250 + f * 2 + k * 0.5, 250 + (f % 9))); }); })()`);
  await ev(`${T}.pointer('up', __E(490, 250))`);
  await run('', `(async () => { const ed = ${T}; const b = ed.doc.float.box; ed.pointer('down', __E(b.x + b.w, b.y + b.h)); return __run('scale by handle (to ~2x)', 120, (f, E) => { for (let k = 0; k < ${N}; k++) ed.pointer('move', E(b.x + b.w + f * 2.5, b.y + b.h + f * 2.5)); }); })()`);
  await ev(`(() => { const ed = ${T}, b = ed.doc.float.box; ed.pointer('up', __E(b.x + b.w, b.y + b.h)); })()`);
  await run('', `(async () => { const ed = ${T}; const b = ed.doc.float.box, cx = b.x + b.w / 2, cy = b.y + b.h / 2; ed.pointer('down', __E(cx, cy)); return __run('drag the scaled float', 120, (f, E) => { for (let k = 0; k < ${N}; k++) ed.pointer('move', E(cx - f * 2, cy - (f % 9))); }); })()`);
  await ev(`(() => { const ed = ${T}; ed.pointer('up', __E(0, 0)); })()`);
  await sleep(800);
  await run('', `(async () => { const ed = ${T}; const b = ed.doc.float.box, cx = b.x + b.w / 2, cy = b.y + b.h / 2; ed.pointer('down', __E(cx, cy)); return __run('drag after a 0.8 s pause', 120, (f, E) => { for (let k = 0; k < ${N}; k++) ed.pointer('move', E(cx + f * 2, cy + (f % 9))); }); })()`);
  await ev(`(() => { const ed = ${T}; ed.pointer('up', __E(0, 0)); })()`);
  console.log('\nfloat box', await ev('JSON.stringify(window.stratum.ed.doc.float?.box)'), 'history', await ev('window.stratum.ed.doc.history?.undoStack?.length ?? window.stratum.ed.doc.history?.entries?.length'));
  p.kill(); server.close(); setTimeout(() => process.exit(0), 300);
});
