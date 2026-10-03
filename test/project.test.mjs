import assert from 'node:assert/strict';
import test from 'node:test';
import { projectOnto } from '../src/js/core/project.js';

const img = (w, h, fill) => {
  const data = new Uint8ClampedArray(w * h * 4);
  if (fill) data.fill(fill);
  return { width: w, height: h, data };
};
const at = (im, x, y) => {
  const i = (y * im.width + x) * 4;
  return [im.data[i], im.data[i + 1], im.data[i + 2], im.data[i + 3]];
};

test('an image lands only on the faces inside its rectangle', () => {
  const dst = img(4, 4);
  const src = img(2, 2, 255);
  src.data[0] = 200; src.data[1] = 10; src.data[2] = 10;
  const uvs = new Float32Array([
    0, 0, 1, 0, 0, 1,
  ]);
  projectOnto(dst, src, { u: 0, v: 0, w: 1, h: 1 }, uvs, null, null);
  assert.deepEqual(at(dst, 0, 0), [200, 10, 10, 255]);
  assert.deepEqual(at(dst, 3, 3), [0, 0, 0, 0]);

  projectOnto(dst, src, { u: 0.5, v: 0, w: 0.5, h: 1 }, uvs, null, null);
  assert.deepEqual(at(dst, 0, 0), [0, 0, 0, 0]);
  assert.ok(at(dst, 2, 0)[3] === 255);
});

test('face names drop every other group', () => {
  const dst = img(4, 4);
  const src = img(1, 1);
  src.data.set([0, 180, 40, 255]);
  const uvs = new Float32Array([
    0, 0, 1, 0, 0, 1,
    0, 0, 1, 0, 1, 1,
  ]);
  const groups = [{ name: 'body', start: 0, count: 1 }, { name: 'sensor', start: 1, count: 1 }];
  projectOnto(dst, src, { u: 0, v: 0, w: 1, h: 1 }, uvs, groups, ['sensor']);
  assert.equal(at(dst, 0, 2)[3], 0);
  assert.equal(at(dst, 3, 2)[1], 180);
});
