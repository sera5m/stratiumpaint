import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeBmp, encodeGif, encodeTga } from '../src/js/core/encode.js';

function img(w, h, paint) {
  const data = new Uint8ClampedArray(w * h * 4);
  paint(data, w, h);
  return { width: w, height: h, data };
}

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return u16(b, o) | (u16(b, o + 2) << 16); }

test('BMP is a 32-bit bitmap and keeps the pixel', () => {
  const src = img(2, 2, (d) => {
    d.set([255, 0, 0, 255], 0);
    d.set([0, 255, 0, 128], 4);
  });
  const b = encodeBmp(src);
  assert.equal(String.fromCharCode(b[0], b[1]), 'BM');
  assert.equal(u32(b, 10), 54);
  assert.equal(u32(b, 18), 2);
  assert.equal(u32(b, 22), 2);
  assert.equal(u16(b, 28), 32);
  // bottom-up: first stored row is the empty bottom row, then red then green
  assert.deepEqual([...b.subarray(54, 58)], [0, 0, 0, 0]);
  assert.deepEqual([...b.subarray(54 + 8, 54 + 12)], [0, 0, 255, 255]);
  assert.deepEqual([...b.subarray(54 + 12, 54 + 16)], [0, 255, 0, 128]);
});

test('TGA is true-color with the alpha kept', () => {
  const src = img(1, 1, (d) => d.set([10, 20, 30, 40]));
  const b = encodeTga(src);
  assert.equal(b[2], 2);
  assert.equal(u16(b, 12), 1);
  assert.equal(u16(b, 14), 1);
  assert.equal(b[16], 32);
  assert.deepEqual([...b.subarray(18, 22)], [30, 20, 10, 40]);
});

test('GIF starts as GIF89a and marks a transparent pixel', () => {
  const src = img(2, 1, (d) => {
    d.set([255, 0, 0, 255], 0);
    d.set([0, 0, 0, 0], 4);
  });
  const b = encodeGif(src);
  assert.equal(String.fromCharCode(...b.subarray(0, 6)), 'GIF89a');
  assert.equal(u16(b, 6), 2);
  assert.equal(u16(b, 8), 1);
  assert.equal(b[b.length - 1], 0x3b);
  // graphic control extension is present when anything is transparent
  assert.ok(b.includes(0x21) && b.includes(0xf9));
});

test('GIF of one solid color is a valid short file', () => {
  const src = img(3, 2, (d) => { for (let i = 0; i < d.length; i += 4) d.set([1, 2, 3, 255], i); });
  const b = encodeGif(src);
  assert.equal(String.fromCharCode(...b.subarray(0, 6)), 'GIF89a');
  assert.ok(b.length > 20);
  assert.equal(b[b.length - 1], 0x3b);
});
