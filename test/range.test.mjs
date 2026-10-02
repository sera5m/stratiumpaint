import test from 'node:test';
import assert from 'node:assert/strict';
import { createImage } from '../src/js/core/image.js';
import { applyColorRange, inColorInterval, rgba8 } from '../src/js/core/colorrange.js';
import { removeBackground } from '../src/js/core/bgremove.js';

const solid = (w, h, [r, g, b, a = 255]) => {
  const img = createImage(w, h);
  for (let i = 0; i < w * h; i++) img.data.set([r, g, b, a], i * 4);
  return img;
};

test('interval is inclusive and ignores which end is higher', () => {
  const a = rgba8({ r: 10, g: 0, b: 0, a: 1 });
  const b = rgba8({ r: 0, g: 5, b: 0, a: 0.5 });
  assert.equal(inColorInterval([0, 0, 0, 128], a, b), true);
  assert.equal(inColorInterval([10, 5, 0, 255], a, b), true);
  assert.equal(inColorInterval([11, 0, 0, 200], a, b), false);
  assert.equal(inColorInterval([5, 0, 0, 100], a, b), false);
});

test('color range deletes only pixels inside the box', () => {
  const img = solid(2, 1, [0, 0, 0, 255]);
  img.data.set([40, 0, 0, 255], 4);
  const { img: out, count } = applyColorRange(img, { r: 0, g: 0, b: 0, a: 1 }, { r: 10, g: 0, b: 0, a: 1 }, { mode: 'delete' });
  assert.equal(count, 1);
  assert.equal(out.data[3], 0);
  assert.equal(out.data[7], 255);
});

test('color range replace writes the replacement rgba', () => {
  const img = solid(1, 1, [8, 8, 8, 255]);
  const { img: out, count } = applyColorRange(
    img,
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 10, g: 10, b: 10, a: 255 },
    { mode: 'replace', replace: { r: 1, g: 2, b: 3, a: 4 } },
  );
  assert.equal(count, 1);
  assert.deepEqual([...out.data], [1, 2, 3, 4]);
});

test('background removal clears the border colour but not an interior subject', () => {
  const img = solid(5, 5, [255, 255, 255, 255]);
  img.data.set([200, 20, 20, 255], (2 * 5 + 2) * 4);
  const { count, img: out } = removeBackground(img, { tolerance: 10, global: false });
  assert.ok(count >= 20);
  assert.equal(out.data[(2 * 5 + 2) * 4], 200);
  assert.equal(out.data[(2 * 5 + 2) * 4 + 3], 255);
  assert.equal(out.data[3], 0);
});

test('global background removal also clears interior matches', () => {
  const img = solid(3, 3, [10, 10, 10, 255]);
  img.data.set([10, 10, 10, 255], (1 * 3 + 1) * 4);
  const { count } = removeBackground(img, { tolerance: 0, global: true });
  assert.equal(count, 9);
});
