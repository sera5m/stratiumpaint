import test from 'node:test';
import assert from 'node:assert/strict';

import { BLEND_MODES } from '../src/js/core/blend.js';
import { SEPARABLE, NON_SEPARABLE, CHANNEL, MODE_INDEX, modeIndex, blendRGB, compositePixel, compositeLayersCPU } from '../src/js/gpu/blendmath.js';
import { COMPOSITE_WGSL, PRESENT_WGSL } from '../src/js/gpu/shaders.js';
import { requestedRenderer, chooseRenderer, STORAGE_KEY } from '../src/js/gpu/backend.js';
import { Doc } from '../src/js/doc/document.js';
import { Layer } from '../src/js/doc/layer.js';

const grid = [0, 0.1, 0.25, 0.3, 0.5, 0.51, 0.75, 0.9, 1];
const select = (f, t, c) => (c ? t : f);

test('every blend mode has a definition, in BLEND_MODES order', () => {
  for (const [id] of BLEND_MODES) assert.ok(SEPARABLE[id] || NON_SEPARABLE.includes(id), id);
  BLEND_MODES.forEach(([id], i) => assert.equal(MODE_INDEX[id], i));
  assert.equal(modeIndex('nonsense'), 0, 'unknown modes composite as Normal');
});

test('JS channel functions match the expressions the WGSL is generated from', () => {
  for (const [id, expr] of Object.entries(SEPARABLE)) {
    // eslint-disable-next-line no-new-func
    const fromExpr = new Function('select', 'min', 'max', 'abs', 'sqrt', 'cb', 'cs', `return ${expr};`);
    for (const cb of grid) for (const cs of grid) {
      const a = fromExpr(select, Math.min, Math.max, Math.abs, Math.sqrt, cb, cs);
      assert.ok(Math.abs(a - CHANNEL[id](cb, cs)) < 1e-12, `${id}(${cb}, ${cs})`);
    }
    assert.match(COMPOSITE_WGSL, new RegExp(`return ${expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`), `${id} is in the shader`);
  }
});

test('the shader has a switch case for every mode and no eval-only syntax', () => {
  BLEND_MODES.forEach((_, i) => assert.ok(COMPOSITE_WGSL.includes(`case ${i}u:`), `case ${i}`));
  for (const src of [COMPOSITE_WGSL, PRESENT_WGSL]) {
    assert.ok(!/[?]/.test(src), 'no JS ternaries leaked into WGSL');
    assert.ok(/@fragment fn fs/.test(src) && /@vertex fn vs/.test(src));
  }
});

test('separable modes match the W3C definitions at known points', () => {
  const c = (id, cb, cs) => blendRGB(id, [cb, cb, cb], [cs, cs, cs])[0];
  assert.equal(c('multiply', 0.5, 0.5), 0.25);
  assert.equal(c('screen', 0.5, 0.5), 0.75);
  assert.equal(c('overlay', 0.25, 0.5), 0.25);
  assert.equal(c('difference', 0.2, 0.7).toFixed(6), '0.500000');
  assert.equal(c('color-dodge', 0, 1), 0);
  assert.equal(c('color-dodge', 0.5, 1), 1);
  assert.equal(c('color-burn', 1, 0), 1);
  assert.equal(c('color-burn', 0.5, 0), 0);
  assert.equal(c('soft-light', 0.5, 0.5), 0.5);
  assert.equal(c('hard-light', 0.5, 1), 1);
});

test('non-separable modes keep the right component of each colour', () => {
  const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const sat = (c) => Math.max(...c) - Math.min(...c);
  const cb = [0.4, 0.5, 0.45], cs = [0.6, 0.3, 0.5];
  assert.ok(Math.abs(lum(blendRGB('luminosity', cb, cs)) - lum(cs)) < 1e-9, 'luminosity takes Lum from the source');
  assert.ok(Math.abs(lum(blendRGB('color', cb, cs)) - lum(cb)) < 1e-9, 'color keeps Lum of the backdrop');
  assert.ok(Math.abs(lum(blendRGB('hue', cb, cs)) - lum(cb)) < 1e-9, 'hue keeps Lum of the backdrop');
  assert.ok(Math.abs(sat(blendRGB('hue', cb, cs)) - sat(cb)) < 1e-9, 'hue keeps Sat of the backdrop');
  assert.ok(Math.abs(sat(blendRGB('saturation', cb, cs)) - sat(cs)) < 1e-9, 'saturation takes Sat from the source');
  for (const id of NON_SEPARABLE) for (const v of blendRGB(id, [0.9, 0.95, 1], [0, 0, 1])) assert.ok(v >= -1e-9 && v <= 1 + 1e-9, `${id} stays in gamut`);
});

test('normal blend with opacity matches the existing CPU compositor', () => {
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const doc = new Doc(16, 8);
  const top = doc.addLayer();
  top.opacity = 0.6;
  for (const l of doc.layers) {
    const d = l.img.data;
    for (let i = 0; i < d.length; i++) d[i] = Math.floor(rnd() * 256);
    l.touch();
  }
  const cpu = doc.compositeImage(); // node path: paintImage source-over stack
  const ref = compositeLayersCPU(16, 8, doc.layers);
  let worst = 0;
  for (let i = 0; i < cpu.data.length; i += 4) {
    worst = Math.max(worst, Math.abs(cpu.data[i + 3] - ref.data[i + 3]));
    if (cpu.data[i + 3] < 32) continue; // straight colour of near-transparent pixels is noisy
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(cpu.data[i + k] - ref.data[i + k]));
  }
  assert.ok(worst <= 2, `worst channel difference ${worst}`);
});

test('compositePixel: transparent source leaves the backdrop, opaque normal replaces it', () => {
  const dst = [0.2, 0.1, 0.05, 0.5];
  assert.deepEqual(compositePixel('multiply', dst, [1, 0, 0, 0], 1), dst);
  assert.deepEqual(compositePixel('source-over', dst, [0.3, 0.6, 0.9, 1], 1), [0.3, 0.6, 0.9, 1]);
  const half = compositePixel('source-over', [0, 0, 0, 0], [1, 1, 1, 1], 0.5);
  assert.deepEqual(half, [0.5, 0.5, 0.5, 0.5]);
});

test('renderer selection: Canvas 2D unless WebGPU is asked for and actually works', () => {
  const store = (v) => ({ getItem: (k) => (k === STORAGE_KEY ? v : null) });
  assert.equal(requestedRenderer({}), 'canvas');
  assert.equal(requestedRenderer({ search: '?renderer=webgpu' }), 'webgpu');
  assert.equal(requestedRenderer({ search: '', storage: store('webgpu') }), 'webgpu');
  assert.equal(requestedRenderer({ search: '?renderer=canvas', storage: store('webgpu') }), 'canvas', 'URL beats storage');
  assert.equal(requestedRenderer({ search: '?renderer=bogus', storage: store('bogus') }), 'canvas');
  assert.equal(requestedRenderer({ storage: { getItem() { throw new Error('denied'); } } }), 'canvas');

  const ok = { requested: 'webgpu', hasGPU: true, adapter: true, device: true, maxTexture: 8192, docSize: 4000 };
  assert.equal(chooseRenderer(ok).renderer, 'webgpu');
  assert.equal(chooseRenderer({ ...ok, requested: 'canvas' }).renderer, 'canvas');
  assert.equal(chooseRenderer({}).renderer, 'canvas');
  for (const miss of [{ hasGPU: false }, { adapter: false }, { device: false }, { docSize: 10000 }, { failed: true }]) {
    const r = chooseRenderer({ ...ok, ...miss });
    assert.equal(r.renderer, 'canvas', JSON.stringify(miss));
    assert.ok(r.reason && r.reason !== 'ok');
  }
});

test('layers record a GPU dirty rect only once the compositor tracks them', () => {
  const l = new Layer(10, 10);
  l.touch({ x: 1, y: 1, w: 2, h: 2 });
  assert.equal(l._gpuDirty, null, 'untracked layers do no bookkeeping');
  l._gpuTracked = true;
  l.touch({ x: 1, y: 1, w: 2, h: 2 });
  l.touch({ x: 5, y: 6, w: 1, h: 1 });
  assert.deepEqual(l._gpuDirty, { x: 1, y: 1, w: 5, h: 6 });
  l.touch();
  assert.equal(l._gpuDirty, 'all');
  l._gpuDirty = null;
  l.replaceImage({ width: 4, height: 4, data: new Uint8ClampedArray(64) });
  assert.equal(l._gpuDirty, 'all');
});

test('no eval in app code (the CSP forbids it and the app would fail to start)', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`]));
  for (const f of walk('src/js').filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/new Function\s*\(|\beval\s*\(/.test(src), f);
  }
});
