import test from 'node:test';
import assert from 'node:assert/strict';

import * as M from '../src/js/core/mask.js';
import { floodMask } from '../src/js/core/flood.js';
import { createImage, cloneImage, cropImage, blendByMask, sampleBilinear } from '../src/js/core/image.js';
import { blurImage } from '../src/js/core/blur.js';
import { ADJUSTMENTS, defaultParams } from '../src/js/core/adjustments.js';
import { EFFECTS } from '../src/js/core/effects.js';
import { History } from '../src/js/core/history.js';
import { crc32, zipStore, unzip } from '../src/js/core/zip.js';
import { encodeOra, decodeOra } from '../src/js/core/ora.js';
import { fillMask, renderGradient, patternIsPrimary } from '../src/js/core/fill.js';
import { mulberry32 } from '../src/js/core/util.js';
import { powerSteps, stepValueAt, indexOfStep } from '../src/js/core/color.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);
const maskArea = (m) => sum(m.data) / 255;

function noiseImage(w, h, seed = 3) {
  const rng = mulberry32(seed), img = createImage(w, h);
  for (let i = 0; i < img.data.length; i++) img.data[i] = rng() * 255;
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  return img;
}
const solid = (w, h, [r, g, b, a = 255]) => {
  const img = createImage(w, h);
  for (let i = 0; i < w * h; i++) img.data.set([r, g, b, a], i * 4);
  return img;
};

test('rectMask covers exactly the requested pixels', () => {
  const m = M.rectMask(20, 10, 2, 3, 12, 8);
  assert.equal(maskArea(m), 10 * 5);
  assert.deepEqual(M.maskBounds(m), { x: 2, y: 3, w: 10, h: 5 });
});

test('ellipseMask area ≈ πab and is anti-aliased', () => {
  const m = M.ellipseMask(200, 200, 20, 40, 180, 160);
  const expected = Math.PI * 80 * 60;
  assert.ok(Math.abs(maskArea(m) - expected) / expected < 0.01, `area ${maskArea(m)} vs ${expected}`);
  assert.ok(m.data.some((v) => v > 0 && v < 255), 'has partial-coverage edge pixels');
});

test('polygonMask fills a triangle with the right area', () => {
  const m = M.polygonMask(100, 100, [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 10, y: 90 }]);
  assert.ok(Math.abs(maskArea(m) - 3200) < 40, `area ${maskArea(m)}`);
  assert.equal(m.data[30 * 100 + 30] > 250, true); // inside
  assert.equal(m.data[85 * 100 + 85], 0); // outside
});

test('combineMasks: union / subtract / intersect / xor / null base', () => {
  const a = M.rectMask(10, 10, 0, 0, 6, 10), b = M.rectMask(10, 10, 4, 0, 10, 10);
  assert.equal(maskArea(M.combineMasks(a, b, 'union')), 100);
  assert.equal(maskArea(M.combineMasks(a, b, 'subtract')), 40);
  assert.equal(maskArea(M.combineMasks(a, b, 'intersect')), 20);
  assert.equal(maskArea(M.combineMasks(a, b, 'xor')), 80);
  assert.equal(maskArea(M.combineMasks(null, b, 'union')), 60);
  assert.equal(maskArea(M.combineMasks(null, b, 'subtract')), 0);
  assert.equal(maskArea(M.invertMask(a)), 40);
});

test('translateMask shifts and clips', () => {
  const m = M.rectMask(10, 10, 0, 0, 4, 4);
  const t = M.translateMask(m, 3, 2);
  assert.deepEqual(M.maskBounds(t), { x: 3, y: 2, w: 4, h: 4 });
  assert.equal(maskArea(M.translateMask(m, -2, -2)), 4);
  assert.equal(maskArea(M.translateMask(m, 20, 0)), 0);
});

test('maskOutline of a rectangle is its perimeter as 4 merged segments', () => {
  const seg = M.maskOutline(M.rectMask(20, 20, 5, 6, 15, 12));
  assert.equal(seg.length / 4, 4);
  let len = 0;
  for (let i = 0; i < seg.length; i += 4) len += Math.abs(seg[i + 2] - seg[i]) + Math.abs(seg[i + 3] - seg[i + 1]);
  assert.equal(len, 2 * (10 + 6));
});

test('RLE round-trips masks', () => {
  const m = M.ellipseMask(64, 64, 4, 4, 60, 50);
  const back = M.rleDecode(M.rleEncode(m.data), m.data.length);
  assert.deepEqual(back, m.data);
});

test('floodMask: contiguous vs global, tolerance', () => {
  const img = solid(10, 10, [255, 255, 255]);
  for (let y = 0; y < 10; y++) img.data.set([0, 0, 0, 255], (y * 10 + 5) * 4); // black wall at x=5
  img.data.set([0, 0, 0, 255], (0 * 10 + 8) * 4); // isolated black pixel right of the wall
  const left = floodMask(img, 1, 1, 0, true);
  assert.equal(maskArea(left), 5 * 10);
  assert.equal(maskArea(floodMask(img, 1, 1, 0, false)), 100 - 11);
  const near = solid(4, 1, [100, 100, 100]);
  near.data.set([110, 110, 110, 255], 4 * 3);
  assert.equal(maskArea(floodMask(near, 0, 0, 0)), 3);
  assert.equal(maskArea(floodMask(near, 0, 0, 10)), 4);
});

test('floodMask handles a large open area without recursion trouble', () => {
  const img = solid(600, 600, [1, 2, 3]);
  assert.equal(maskArea(floodMask(img, 300, 300, 0)), 600 * 600);
});

test('blendByMask is premultiplied-correct', () => {
  const orig = solid(1, 1, [0, 0, 0, 0]), fx = solid(1, 1, [255, 0, 0, 255]);
  const half = M.createMask(1, 1); half.data[0] = 128;
  const out = blendByMask(orig, fx, half);
  assert.deepEqual([...out.data.slice(0, 3)], [255, 0, 0]); // colour not darkened by transparent black
  assert.equal(out.data[3], 128);
});

test('sampleBilinear interpolates and clamps', () => {
  const img = createImage(2, 1);
  img.data.set([0, 0, 0, 255, 200, 100, 50, 255]);
  const px = [0, 0, 0, 0];
  sampleBilinear(img, 0.5, 0, px);
  assert.deepEqual(px.map(Math.round), [100, 50, 25, 255]);
  sampleBilinear(img, 9, 9, px);
  assert.deepEqual(px.map(Math.round), [200, 100, 50, 255]);
});

test('blur keeps flat colour flat and spreads an impulse', () => {
  const flat = blurImage(solid(30, 20, [40, 90, 200]), 4);
  for (let i = 0; i < flat.data.length; i += 4) assert.deepEqual([...flat.data.slice(i, i + 4)], [40, 90, 200, 255]);
  const dot = createImage(41, 41);
  dot.data.set([255, 255, 255, 255], (20 * 41 + 20) * 4);
  const b = blurImage(dot, 3);
  const centre = b.data[(20 * 41 + 20) * 4 + 3], off = b.data[(20 * 41 + 24) * 4 + 3];
  assert.ok(centre < 255 && centre > off && off > 0);
  let total = 0;
  for (let i = 3; i < b.data.length; i += 4) total += b.data[i];
  assert.ok(Math.abs(total - 255) / 255 < 0.1, `alpha mass ${total}`);
});

test('blur does not bleed dark fringes at transparent edges', () => {
  const img = createImage(20, 1);
  for (let x = 0; x < 10; x++) img.data.set([255, 200, 0, 255], x * 4); // opaque orange left half
  const b = blurImage(img, 2);
  for (let x = 0; x < 20; x++) if (b.data[x * 4 + 3] > 20) assert.ok(b.data[x * 4] > 240, `x=${x} r=${b.data[x * 4]}`);
});

test('every adjustment runs, keeps size, and never mutates its input', () => {
  const src = noiseImage(16, 12);
  const snapshot = cloneImage(src);
  for (const adj of ADJUSTMENTS) {
    const out = adj.apply(src, defaultParams(adj));
    assert.equal(out.width, 16, adj.id);
    assert.equal(out.data.length, src.data.length, adj.id);
    assert.deepEqual(src.data, snapshot.data, `${adj.id} mutated input`);
  }
});

test('adjustment maths', () => {
  const by = (id) => ADJUSTMENTS.find((a) => a.id === id);
  const src = noiseImage(8, 8);
  assert.deepEqual(by('invert').apply(by('invert').apply(src, {}), {}).data, src.data);
  const id = by('hue-saturation').apply(src, { hue: 0, saturation: 100, lightness: 0 });
  for (let i = 0; i < src.data.length; i++) assert.ok(Math.abs(id.data[i] - src.data[i]) <= 1, 'hue/sat identity');
  const gray = by('black-white').apply(solid(1, 1, [255, 0, 0]), {});
  assert.ok(gray.data[0] === gray.data[1] && gray.data[1] === gray.data[2]);
  const post = by('posterize').apply(solid(1, 1, [100, 130, 250]), { levels: 2 });
  assert.deepEqual([...post.data.slice(0, 3)], [0, 255, 255]);
  const lv = by('levels').apply(solid(1, 1, [128, 128, 128]), { inLow: 0, inHigh: 255, gamma: 1, outLow: 0, outHigh: 100 });
  assert.equal(lv.data[0], 50);
  const dull = createImage(4, 1);
  [80, 100, 120, 140].forEach((v, i) => dull.data.set([v, v, v, 255], i * 4));
  const auto = by('auto-level').apply(dull, { clip: 0 });
  assert.equal(auto.data[0], 0);
  assert.equal(auto.data[12], 255);
  const hs = by('hue-saturation').apply(solid(1, 1, [255, 0, 0]), { hue: 120, saturation: 100, lightness: 0 });
  assert.ok(hs.data[1] > 250 && hs.data[0] < 5, `red hue-shifted 120° should be green, got ${[...hs.data]}`);
});

test('every effect runs on odd sizes and returns finite pixels', () => {
  const src = noiseImage(23, 17);
  for (const fx of EFFECTS) {
    const out = fx.apply(src, defaultParams(fx));
    assert.equal(out.width, 23, fx.id);
    assert.equal(out.height, 17, fx.id);
    assert.equal(out.data.length, src.data.length, fx.id);
  }
});

test('effect behaviour spot checks', () => {
  const by = (id) => EFFECTS.find((e) => e.id === id);
  const src = noiseImage(16, 16);
  const px = by('pixelate').apply(src, { size: 4 });
  assert.deepEqual([...px.data.slice(0, 4)], [...px.data.slice(4, 8)]); // same cell → same colour
  const sh = by('drop-shadow').apply(
    (() => { const i = createImage(40, 40); for (let y = 15; y < 25; y++) for (let x = 15; x < 25; x++) i.data.set([255, 0, 0, 255], (y * 40 + x) * 4); return i; })(),
    { offsetX: 6, offsetY: 6, blur: 0, opacity: 100, color: '#000000' });
  assert.equal(sh.data[(28 * 40 + 28) * 4 + 3], 255); // shadow pixel outside the square
  assert.deepEqual([...sh.data.slice((20 * 40 + 20) * 4, (20 * 40 + 20) * 4 + 4)], [255, 0, 0, 255]); // square stays on top
  const same = by('add-noise').apply(src, { intensity: 40, saturation: 100, coverage: 100, seed: 5 });
  const again = by('add-noise').apply(src, { intensity: 40, saturation: 100, coverage: 100, seed: 5 });
  assert.deepEqual(same.data, again.data); // deterministic
  const flat = solid(9, 9, [90, 90, 90]);
  const edges = by('edge-detect').apply(flat, { strength: 1, invert: false });
  assert.equal(edges.data[0], 0);
});

test('History: push / undo / redo / jump / limits', () => {
  const h = new History({ limitCount: 3 });
  let v = 0;
  const cmd = (name, d) => { v += d; return { name, undo: () => (v -= d), redo: () => (v += d) }; };
  h.push(cmd('a', 1)); h.push(cmd('b', 10)); h.push(cmd('c', 100));
  assert.equal(v, 111);
  h.undo(); assert.equal(v, 11); assert.equal(h.canRedo, true);
  h.jumpTo(-1); assert.equal(v, 0);
  h.jumpTo(2); assert.equal(v, 111);
  h.undo(); h.push(cmd('d', 1000)); // new branch discards redo
  assert.equal(h.canRedo, false);
  assert.deepEqual(h.entries().map((e) => e.name), ['a', 'b', 'd']);
  h.push(cmd('e', 1)); // exceeds limitCount → oldest evicted
  assert.equal(h.entries().length, 3);
  assert.equal(h.entries()[0].name, 'b');
});

test('zip round-trip (stored) and crc32', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const files = [{ name: 'a.txt', data: new TextEncoder().encode('hello') }, { name: 'dir/b.bin', data: Uint8Array.from([1, 2, 3, 250]) }];
  const out = await unzip(zipStore(files));
  assert.equal(new TextDecoder().decode(out.get('a.txt')), 'hello');
  assert.deepEqual([...out.get('dir/b.bin')], [1, 2, 3, 250]);
});

test('unzip reads deflate-compressed entries from other tools', async () => {
  // Build a real zip with the system-independent path: deflate-raw via CompressionStream
  const payload = new TextEncoder().encode('deflate me '.repeat(50));
  const deflated = new Uint8Array(await new Response(new Blob([payload]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const stored = zipStore([{ name: 'x.txt', data: deflated }]);
  // patch the headers to claim method 8 and the real uncompressed size
  const dv = new DataView(stored.buffer);
  dv.setUint16(8, 8, true);
  const cen = stored.length - 22 - (46 + 5);
  dv.setUint16(cen + 10, 8, true);
  dv.setUint32(cen + 24, payload.length, true);
  const out = await unzip(stored);
  assert.equal(new TextDecoder().decode(out.get('x.txt')), new TextDecoder().decode(payload));
});

test('OpenRaster round-trip keeps order, names, opacity, blend and visibility', async () => {
  const layers = [
    { name: 'Top & <bold>', visible: true, opacity: 0.5, blend: 'multiply', png: Uint8Array.from([1, 2, 3]) },
    { name: 'Background', visible: false, opacity: 1, blend: 'source-over', png: Uint8Array.from([9, 9]) },
  ];
  const bytes = encodeOra({ width: 64, height: 32, layers, mergedPng: Uint8Array.from([7]) });
  const back = await decodeOra(bytes);
  assert.equal(back.width, 64);
  assert.equal(back.height, 32);
  assert.equal(back.layers.length, 2);
  assert.equal(back.layers[0].name, 'Top & <bold>');
  assert.equal(back.layers[0].blend, 'multiply');
  assert.equal(back.layers[0].opacity, 0.5);
  assert.equal(back.layers[1].visible, false);
  assert.deepEqual([...back.layers[1].png], [9, 9]);
  const files = await unzip(bytes);
  assert.equal([...files.keys()][0], 'mimetype'); // must be first for ORA readers
  assert.equal(new TextDecoder().decode(files.get('mimetype')), 'image/openraster');
});

test('fillMask: solid, alpha, pattern; gradient endpoints', () => {
  const img = createImage(4, 4);
  fillMask(img, null, { r: 255, g: 0, b: 0, a: 0.5 });
  assert.deepEqual([...img.data.slice(0, 4)], [255, 0, 0, 128]);
  const pat = createImage(4, 1);
  fillMask(pat, null, { r: 255, g: 255, b: 255, a: 1 }, { pattern: 'stripes-v', secondary: { r: 0, g: 0, b: 0, a: 1 }, patternSize: 2 });
  assert.deepEqual([...pat.data].filter((_, i) => i % 4 === 0), [255, 255, 0, 0]);
  assert.equal(patternIsPrimary('checker', 0, 0, 4), true);
  assert.equal(patternIsPrimary('checker', 4, 0, 4), false);
  const g = renderGradient({ x: 0, y: 0, w: 11, h: 1 }, 'linear', { x: 0.5, y: 0.5 }, { x: 10.5, y: 0.5 }, { r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }, null, 11);
  assert.equal(g.data[0], 0);
  assert.equal(g.data[10 * 4], 255);
  assert.ok(Math.abs(g.data[5 * 4] - 127.5) < 1);
});

test('cropImage pads out-of-range areas with transparency', () => {
  const src = solid(4, 4, [10, 20, 30]);
  const c = cropImage(src, { x: -1, y: -1, w: 3, h: 3 });
  assert.equal(c.data[3], 0);
  assert.deepEqual([...c.data.slice((1 * 3 + 1) * 4, (1 * 3 + 1) * 4 + 4)], [10, 20, 30, 255]);
});

test('powerSteps: whole doubling ramp, endpoints, and half/quarter subdivision', () => {
  assert.deepEqual(powerSteps(255, 'whole'), [0, 2, 4, 8, 16, 32, 64, 128, 255]);
  assert.deepEqual(powerSteps(16, 'whole'), [0, 2, 4, 8, 16]);
  const half = powerSteps(255, 'half');
  assert.equal(half[0], 0);
  assert.equal(half.at(-1), 255);
  assert.ok(half.includes(91), `expected the geometric mean of 64/128 (~91) in ${half}`); // 2^6.5 ≈ 90.5
  assert.ok(half.length > powerSteps(255, 'whole').length);
  const quarter = powerSteps(255, 'quarter');
  assert.ok(quarter.length > half.length);
  assert.equal(new Set(quarter).size, quarter.length, 'no duplicate steps');
  assert.deepEqual([...quarter].sort((a, b) => a - b), quarter, 'stays sorted ascending');
});

test('stepValueAt / indexOfStep are inverses across a powerSteps ramp', () => {
  const steps = powerSteps(255, 'whole');
  assert.equal(stepValueAt(steps, 0), 0);
  assert.equal(stepValueAt(steps, steps.length - 1), 255);
  assert.equal(stepValueAt(steps, 1.5), (2 + 4) / 2); // halfway between the 2nd and 3rd step
  assert.ok(Math.abs(indexOfStep(steps, 3) - 1.5) < 1e-9); // 3 is halfway between steps[1]=2 and steps[2]=4
  for (const idx of [0, 2, 4.25, steps.length - 1]) {
    assert.ok(Math.abs(indexOfStep(steps, stepValueAt(steps, idx)) - idx) < 1e-6);
  }
  assert.equal(indexOfStep(steps, -50), 0, 'clamps below range');
  assert.equal(indexOfStep(steps, 9999), steps.length - 1, 'clamps above range');
});
