// Runs a page from test/browser/ in headless Chrome with SwiftShader WebGPU and prints its report.
// Usage: npm run test:gpu  |  npm run bench:move   (CHROME=/path/to/chrome to pick a browser,
// CHROME_FLAGS='--enable-gpu-rasterization --ignore-gpu-blocklist' to add switches)
// The page sets document.title to PASS / FAIL / ERROR when done and writes its report into #out.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.CHROME || ['google-chrome', 'chromium', 'chromium-browser', 'google-chrome-stable']
  .find((c) => spawnSync('which', [c]).status === 0);
if (!chrome) { console.log('SKIP: no Chrome/Chromium found (set CHROME=...)'); process.exit(0); }

const PAGE = process.argv[2] || 'webgpu-parity.html';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}/test/browser/${PAGE}`;
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stratum-gpu-'));
  const args = ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
    '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split(/\s+/) : []), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, url];
  const p = spawn(chrome, args, { stdio: 'ignore' });
  const done = (code, text) => {
    console.log(text);
    p.kill();
    server.close();
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome still closing */ } process.exit(code); }, 300);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Talk to the page over the DevTools protocol (dump-dom does not wait for async GPU work).
  let ws = null;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(url));
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
  }
  if (!ws) { done(1, typeof WebSocket === 'undefined' ? 'ERROR: this Node has no WebSocket (use Node 22+, or --experimental-websocket)' : 'ERROR: could not reach Chrome'); return; }
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const evaluate = (expression) => new Promise((resolve) => {
    const my = ++id;
    const on = (m) => { const msg = JSON.parse(m.data); if (msg.id === my) { ws.removeEventListener('message', on); resolve(msg.result?.result?.value); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  for (let i = 0; i < 1200; i++) {
    const title = await evaluate('document.title');
    if (title && title !== 'running') {
      const text = await evaluate("document.getElementById('out').textContent");
      done(title === 'PASS' ? 0 : 1, text);
      return;
    }
    await sleep(250);
  }
  done(1, 'ERROR: timed out waiting for the page');
});
