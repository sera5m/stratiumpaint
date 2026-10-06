// Builds dist/:
//   index.html + app.js + app.css   what the Electron shell loads (file://, strict CSP)
//   stratum.html                    everything inlined: double-click it and it runs in any modern browser
// Usage: node scripts/bundle-standalone.mjs [--dev]     (--dev = unminified, inline source map)
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const dist = path.join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const entry = path.join(root, 'src/js/main.js');

/** esbuild from node_modules if it is installed, otherwise the `esbuild` binary on PATH (Arch: pacman -S esbuild). */
async function bundleJs() {
  let api = null;
  if (!process.env.STRATUM_ESBUILD_CLI) {
    try { api = await import('esbuild'); } catch { /* fall through to the CLI */ }
  }
  if (api) {
    const r = await api.build({
      entryPoints: [entry], bundle: true, format: 'iife', target: 'chrome120', minify: !dev,
      sourcemap: dev ? 'inline' : false, legalComments: 'none', write: false, logLevel: 'warning',
    });
    return r.outputFiles[0].text;
  }
  const args = [entry, '--bundle', '--format=iife', '--target=chrome120', '--legal-comments=none', '--log-level=warning', dev ? '--sourcemap=inline' : '--minify'];
  const { stdout } = await promisify(execFile)('esbuild', args, { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

const js = await bundleJs();
const css = await readFile(path.join(root, 'src/css/app.css'), 'utf8');
const html = await readFile(path.join(root, 'src/index.html'), 'utf8');

const scriptTag = '<script type="module" src="js/main.js"></script>';
const styleTag = '<link rel="stylesheet" href="css/app.css">';
const cspTag = /<meta http-equiv="Content-Security-Policy"[^>]*>/;
for (const [name, needle] of [['script', scriptTag], ['stylesheet', styleTag]]) {
  if (!html.includes(needle)) throw new Error(`src/index.html no longer contains the expected ${name} tag: ${needle}`);
}
if (!cspTag.test(html)) throw new Error('src/index.html has no Content-Security-Policy meta tag');

await writeFile(path.join(dist, 'app.js'), js);
await writeFile(path.join(dist, 'app.css'), css);
await writeFile(
  path.join(dist, 'index.html'),
  html.replace(styleTag, '<link rel="stylesheet" href="app.css">').replace(scriptTag, '<script src="app.js" defer></script>'),
);

const inlineCsp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src http://127.0.0.1:11434 http://localhost:11434; object-src 'none'; base-uri 'none'">`;
await writeFile(
  path.join(dist, 'stratum.html'),
  html.replace(cspTag, inlineCsp).replace(styleTag, () => `<style>${css}</style>`)
    .replace(scriptTag, () => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`),
);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`dist/app.js ${kb(js.length)}, app.css ${kb(css.length)}${dev ? ' (dev build)' : ''}`);
