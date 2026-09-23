// Pixel compositing helpers. paintImage is pure; the canvas helpers need a DOM.
import { blendPixel } from '../core/image.js';
import { rectIntersect } from '../core/util.js';

/**
 * Source-over `src` onto `dst` at (dx,dy), optionally through a selection mask (same size as dst)
 * and scaled by `alpha` (0..1). Returns the touched rect, or null.
 */
export function paintImage(dst, src, dx, dy, mask = null, alpha = 1) {
  const r = rectIntersect({ x: dx, y: dy, w: src.width, h: src.height }, { x: 0, y: 0, w: dst.width, h: dst.height });
  if (!r) return null;
  const sd = src.data, dd = dst.data;
  for (let y = r.y; y < r.y + r.h; y++) {
    let si = ((y - dy) * src.width + (r.x - dx)) * 4;
    let di = (y * dst.width + r.x) * 4;
    let mi = y * dst.width + r.x;
    for (let x = 0; x < r.w; x++, si += 4, di += 4, mi++) {
      const sa = sd[si + 3];
      if (!sa) continue;
      let a = (sa / 255) * alpha;
      if (mask) {
        const m = mask.data[mi];
        if (!m) continue;
        a *= m / 255;
      }
      blendPixel(dd, di, sd[si], sd[si + 1], sd[si + 2], a);
    }
  }
  return r;
}

/** Snap partial alpha to 0/255 (for "antialiasing off"). */
export function hardenAlpha(img, threshold = 128) {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= threshold ? 255 : 0;
  return img;
}

export const createCanvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
};

/** Run `draw(ctx)` on a fresh transparent canvas and return the result as a pixel buffer. */
export function rasterize(w, h, draw) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  draw(ctx);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: id.data };
}
