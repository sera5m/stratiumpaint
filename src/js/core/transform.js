// Geometric transforms. Pure functions: each returns a new image and never mutates its input.
import { createImage, cloneImage, stampImage } from './image.js';
import { clamp } from './util.js';

/** 32-bit view of an RGBA buffer (copies only if the buffer is misaligned). */
const words = (img) => {
  const n = img.width * img.height;
  return img.data.byteOffset % 4 === 0
    ? new Uint32Array(img.data.buffer, img.data.byteOffset, n)
    : new Uint32Array(Uint8Array.from(img.data).buffer);
};

export function flipImage(src, horizontal) {
  const { width: w, height: h } = src;
  const out = createImage(w, h);
  const a = words(src), b = words(out);
  if (horizontal) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + (w - 1 - x)] = a[y * w + x];
  } else {
    for (let y = 0; y < h; y++) b.set(a.subarray(y * w, y * w + w), (h - 1 - y) * w);
  }
  return out;
}

/** Rotate by quarter turns, clockwise. */
export function rotateImage(src, turns) {
  turns = ((turns % 4) + 4) % 4;
  if (turns === 0) return cloneImage(src);
  const { width: w, height: h } = src;
  const out = turns === 2 ? createImage(w, h) : createImage(h, w);
  const a = words(src), b = words(out);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx, ny;
      if (turns === 1) { nx = h - 1 - y; ny = x; }
      else if (turns === 2) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      b[ny * out.width + nx] = a[y * w + x];
    }
  }
  return out;
}

/** Per output index: first source index and normalised triangle-filter weights. */
function axisWeights(srcLen, dstLen) {
  const scale = srcLen / dstLen;
  const support = Math.max(1, scale); // widen the kernel when shrinking so it averages instead of aliasing
  const out = new Array(dstLen);
  for (let i = 0; i < dstLen; i++) {
    const centre = (i + 0.5) * scale - 0.5;
    const lo = Math.max(0, Math.ceil(centre - support));
    const hi = Math.min(srcLen - 1, Math.floor(centre + support));
    const w = [];
    let sum = 0;
    for (let j = lo; j <= hi; j++) {
      const v = Math.max(0, 1 - Math.abs(j - centre) / support);
      w.push(v);
      sum += v;
    }
    if (sum <= 0) out[i] = { start: clamp(Math.round(centre), 0, srcLen - 1), w: [1] };
    else out[i] = { start: lo, w: w.map((v) => v / sum) };
  }
  return out;
}

/**
 * Resize to dw x dh. mode 'smooth' = separable triangle filter on premultiplied colour
 * (bilinear when enlarging, area-averaging when shrinking); 'nearest' keeps hard pixels.
 */
export function resizeImage(src, dw, dh, mode = 'smooth') {
  const { width: sw, height: sh } = src;
  const out = createImage(dw, dh);
  if (mode === 'nearest') {
    const a = words(src), b = words(out);
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
      for (let x = 0; x < dw; x++) b[y * dw + x] = a[sy * sw + Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw))];
    }
    return out;
  }

  const cx = axisWeights(sw, dw), cy = axisWeights(sh, dh);
  const s = src.data;
  const tmp = new Float32Array(dw * sh * 4); // premultiplied r,g,b (0..255) and alpha

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      const { start, w } = cx[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++) {
        const i = (y * sw + start + k) * 4, al = s[i + 3], wk = w[k];
        r += (s[i] * al * wk) / 255; g += (s[i + 1] * al * wk) / 255; b += (s[i + 2] * al * wk) / 255; a += al * wk;
      }
      const o = (y * dw + x) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }

  const d = out.data;
  for (let y = 0; y < dh; y++) {
    const { start, w } = cy[y];
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++) {
        const i = ((start + k) * dw + x) * 4, wk = w[k];
        r += tmp[i] * wk; g += tmp[i + 1] * wk; b += tmp[i + 2] * wk; a += tmp[i + 3] * wk;
      }
      const o = (y * dw + x) * 4;
      if (a > 0) { d[o] = (r * 255) / a; d[o + 1] = (g * 255) / a; d[o + 2] = (b * 255) / a; d[o + 3] = a; }
    }
  }
  return out;
}

/** New canvas size; content is placed by anchor (ax, ay in 0..1) and clipped or padded with transparency. */
export function resizeCanvas(src, dw, dh, ax = 0.5, ay = 0.5) {
  const out = createImage(dw, dh);
  stampImage(out, src, Math.round((dw - src.width) * ax), Math.round((dh - src.height) * ay));
  return out;
}
