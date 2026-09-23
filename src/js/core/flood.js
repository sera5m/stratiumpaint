// Flood selection used by the Magic Wand and Paint Bucket.
import { createMask } from './mask.js';

/**
 * Colour-similarity test against the seed pixel. `tol` is 0..100 (percent);
 * distance is the RMS difference over RGBA, so 0 means "exactly equal".
 */
function makeMatcher(img, sx, sy, tol) {
  const d = img.data;
  const s = (sy * img.width + sx) * 4;
  const r0 = d[s], g0 = d[s + 1], b0 = d[s + 2], a0 = d[s + 3];
  const thr = ((tol / 100) * 255) ** 2;
  return (i) => {
    const a = d[i + 3];
    if (a === 0 && a0 === 0) return true; // any two fully transparent pixels are equal
    const dr = d[i] - r0, dg = d[i + 1] - g0, db = d[i + 2] - b0, da = a - a0;
    return (dr * dr + dg * dg + db * db + da * da) / 4 <= thr;
  };
}

/** Returns a 0/255 mask of pixels similar to the one at (sx,sy). */
export function floodMask(img, sx, sy, tol = 0, contiguous = true) {
  const { width: w, height: h } = img;
  const mask = createMask(w, h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const match = makeMatcher(img, sx, sy, tol);
  const out = mask.data;

  if (!contiguous) {
    for (let i = 0, n = w * h; i < n; i++) if (match(i * 4)) out[i] = 255;
    return mask;
  }

  // scanline fill with an explicit stack (no recursion, safe on huge regions)
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop();
    let x = stack.pop();
    const row = y * w;
    if (out[row + x]) continue;
    while (x > 0 && !out[row + x - 1] && match((row + x - 1) * 4)) x--;
    let up = false, down = false;
    for (; x < w && !out[row + x] && match((row + x) * 4); x++) {
      out[row + x] = 255;
      if (y > 0) {
        const ok = !out[row - w + x] && match((row - w + x) * 4);
        if (ok && !up) { stack.push(x, y - 1); up = true; } else if (!ok) up = false;
      }
      if (y < h - 1) {
        const ok = !out[row + w + x] && match((row + w + x) * 4);
        if (ok && !down) { stack.push(x, y + 1); down = true; } else if (!ok) down = false;
      }
    }
  }
  return mask;
}
