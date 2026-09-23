// Pixel buffers are plain {width, height, data: Uint8ClampedArray RGBA, non-premultiplied},
// so they are structurally identical to the browser's ImageData and work in Node tests.
import { clamp, rectIntersect } from './util.js';

export const createImage = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });

export const cloneImage = (img) => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) });

/** Copy of region r. Areas outside the source are transparent. */
export function cropImage(img, r) {
  const out = createImage(r.w, r.h);
  const s = rectIntersect(r, { x: 0, y: 0, w: img.width, h: img.height });
  if (!s) return out;
  for (let y = 0; y < s.h; y++) {
    const from = ((s.y + y) * img.width + s.x) * 4;
    out.data.set(img.data.subarray(from, from + s.w * 4), ((s.y - r.y + y) * r.w + (s.x - r.x)) * 4);
  }
  return out;
}

/** Replace pixels of dst with src at (dx,dy), clipped. */
export function stampImage(dst, src, dx, dy) {
  const s = rectIntersect({ x: dx, y: dy, w: src.width, h: src.height }, { x: 0, y: 0, w: dst.width, h: dst.height });
  if (!s) return;
  for (let y = 0; y < s.h; y++) {
    const from = ((s.y - dy + y) * src.width + (s.x - dx)) * 4;
    dst.data.set(src.data.subarray(from, from + s.w * 4), ((s.y + y) * dst.width + s.x) * 4);
  }
}

/**
 * Blend `fx` over `orig` using a selection mask (premultiplied-correct).
 * Both images are the same size; (ox,oy) locates them inside the mask's coordinate space.
 * A null mask means "everything selected".
 */
export function blendByMask(orig, fx, mask, ox = 0, oy = 0) {
  const { width: w, height: h } = orig;
  const out = new Uint8ClampedArray(orig.data);
  const a = orig.data, b = fx.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = mask ? mask.data[(oy + y) * mask.width + ox + x] : 255;
      if (m === 0) continue;
      const i = (y * w + x) * 4;
      if (m === 255) {
        out[i] = b[i]; out[i + 1] = b[i + 1]; out[i + 2] = b[i + 2]; out[i + 3] = b[i + 3];
        continue;
      }
      const t = m / 255;
      const a0 = a[i + 3] / 255, a1 = b[i + 3] / 255;
      const oa = a0 + (a1 - a0) * t;
      if (oa <= 0) { out[i + 3] = 0; continue; }
      const k0 = a0 * (1 - t), k1 = a1 * t;
      out[i] = (a[i] * k0 + b[i] * k1) / oa;
      out[i + 1] = (a[i + 1] * k0 + b[i + 1] * k1) / oa;
      out[i + 2] = (a[i + 2] * k0 + b[i + 2] * k1) / oa;
      out[i + 3] = Math.round(oa * 255);
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Bilinear sample with premultiplied interpolation and edge clamping.
 * Pixel centres sit at integer coordinates. Writes [r,g,b,a] (0..255) into `out`.
 */
export function sampleBilinear(img, x, y, out) {
  const w = img.width, h = img.height, d = img.data;
  x = clamp(x, 0, w - 1);
  y = clamp(y, 0, h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const a00 = d[i00 + 3] * (1 - fx) * (1 - fy), a10 = d[i10 + 3] * fx * (1 - fy);
  const a01 = d[i01 + 3] * (1 - fx) * fy, a11 = d[i11 + 3] * fx * fy;
  const a = a00 + a10 + a01 + a11;
  if (a <= 0) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
  out[0] = (d[i00] * a00 + d[i10] * a10 + d[i01] * a01 + d[i11] * a11) / a;
  out[1] = (d[i00 + 1] * a00 + d[i10 + 1] * a10 + d[i01 + 1] * a01 + d[i11 + 1] * a11) / a;
  out[2] = (d[i00 + 2] * a00 + d[i10 + 2] * a10 + d[i01 + 2] * a01 + d[i11 + 2] * a11) / a;
  out[3] = a;
  return out;
}

/** Source-over one straight-alpha colour (sa in 0..1) onto pixel i of a buffer. */
export function blendPixel(data, i, r, g, b, sa) {
  if (sa <= 0) return;
  const da = data[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  const k = da * (1 - sa);
  data[i] = (r * sa + data[i] * k) / oa;
  data[i + 1] = (g * sa + data[i + 1] * k) / oa;
  data[i + 2] = (b * sa + data[i + 2] * k) / oa;
  data[i + 3] = Math.round(oa * 255);
}
