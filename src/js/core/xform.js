// Box transforms for floating content (moved / scaled / rotated selections).
//
// A float is the lifted source image (sw × sh) placed into a box {x, y, w, h} (the unrotated
// placement, in document pixels) and turned by `angle` radians about the box centre. Everything
// that draws or resamples a float (Canvas 2D preview, WebGPU preview, the final CPU resample, the
// selection mask, marching ants, handle hit-testing) goes through these few functions.
import { createImage } from './image.js';
import { createMask } from './mask.js';
import { resizeImage } from './transform.js';

export const DEG = Math.PI / 180;

/** Normalise to (-π, π]. */
export function normAngle(a) {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return Object.is(r, -0) ? 0 : r;
}

/** Shift-snap to 15° steps. */
export const snapAngle = (a, step = 15 * DEG) => normAngle(Math.round(a / step) * step);

/**
 * Affine matrix [a, b, c, d, e, f] (canvas setTransform order: X = a·x + c·y + e, Y = b·x + d·y + f)
 * mapping source pixel coordinates (0..sw, 0..sh) into the document.
 */
export function floatMatrix(sw, sh, box, angle = 0) {
  const sx = box.w / sw, sy = box.h / sh;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  // T(c) · R(angle) · S(sx, sy) · T(-sw/2, -sh/2)
  const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;
  return [a, b, c, d, cx - a * (sw / 2) - c * (sh / 2), cy - b * (sw / 2) - d * (sh / 2)];
}

export function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  if (!det) return [1, 0, 0, 1, 0, 0];
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}

export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Corners of a box turned about its centre, in document coordinates (nw, ne, se, sw). */
export function boxCorners(box, angle = 0) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2, cos = Math.cos(angle), sin = Math.sin(angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([kx, ky]) => {
    const dx = (kx * box.w) / 2, dy = (ky * box.h) / 2;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  });
}

/** Integer axis-aligned bounds of a turned box. */
export function rotatedBounds(box, angle = 0) {
  if (!angle) return { x: Math.floor(box.x), y: Math.floor(box.y), w: Math.ceil(box.x + box.w) - Math.floor(box.x), h: Math.ceil(box.y + box.h) - Math.floor(box.y) };
  const pts = boxCorners(box, angle);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  // Trig leaves 1e-16-ish noise on exact turns (90°: cos ≈ 6e-17); don't let it widen the bounds.
  const lo = (v) => Math.floor(v + 1e-6), hi = (v) => Math.ceil(v - 1e-6);
  const x0 = lo(Math.min(...xs)), y0 = lo(Math.min(...ys));
  return { x: x0, y: y0, w: hi(Math.max(...xs)) - x0, h: hi(Math.max(...ys)) - y0 };
}

/** A point in the box's own (unturned) frame: rotate it back about the box centre. */
export function toBoxFrame(x, y, box, angle = 0) {
  if (!angle) return [x, y];
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2, cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * cos + dy * sin, cy - dx * sin + dy * cos];
}

/** The inverse of toBoxFrame. */
export function fromBoxFrame(x, y, box, angle = 0) {
  if (!angle) return [x, y];
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2, cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

/**
 * Resample `src` into its box in ONE pass from the original pixels (so moving, scaling and
 * rotating any number of times never stacks resampling blur). Returns { img, x, y }: the result
 * and where its top-left goes in the document.
 *  - no turn: exactly the old path (copy, or resizeImage's separable triangle filter);
 *  - turned: inverse-mapped bilinear on premultiplied colour, with n×n supersampling when the
 *    float is shrunk so detail averages instead of aliasing.
 */
export function resampleFloat(src, box, angle = 0) {
  const sw = src.width, sh = src.height;
  if (!angle) {
    const img = box.w === sw && box.h === sh ? src : resizeImage(src, box.w, box.h, 'smooth');
    return { img, x: box.x, y: box.y };
  }
  const b = rotatedBounds(box, angle);
  const out = createImage(Math.max(1, b.w), Math.max(1, b.h));
  const inv = invert(floatMatrix(sw, sh, box, angle));
  const shrink = Math.max(sw / Math.max(1, box.w), sh / Math.max(1, box.h));
  const n = Math.min(4, Math.max(1, Math.ceil(shrink)));
  const s = src.data, o = out.data;
  const tap = (u, v, acc) => { // bilinear, premultiplied, transparent outside
    const x = u - 0.5, y = v - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    for (let j = 0; j < 2; j++) {
      const yy = y0 + j;
      if (yy < 0 || yy >= sh) continue;
      const wy = j ? fy : 1 - fy;
      for (let i = 0; i < 2; i++) {
        const xx = x0 + i;
        if (xx < 0 || xx >= sw) continue;
        const w = wy * (i ? fx : 1 - fx);
        if (!w) continue;
        const k = (yy * sw + xx) * 4, a = s[k + 3] * w;
        acc[0] += s[k] * a; acc[1] += s[k + 1] * a; acc[2] += s[k + 2] * a; acc[3] += a;
      }
    }
  };
  const acc = [0, 0, 0, 0];
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      acc[0] = acc[1] = acc[2] = acc[3] = 0;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const px = b.x + x + (i + 0.5) / n, py = b.y + y + (j + 0.5) / n;
          tap(inv[0] * px + inv[2] * py + inv[4], inv[1] * px + inv[3] * py + inv[5], acc);
        }
      }
      const a = acc[3] / (n * n);
      if (a <= 0) continue;
      const k = (y * b.w + x) * 4;
      o[k] = acc[0] / acc[3]; o[k + 1] = acc[1] / acc[3]; o[k + 2] = acc[2] / acc[3]; o[k + 3] = a;
    }
  }
  return { img: out, x: b.x, y: b.y };
}

/** Selection mask `m` with the part inside `from` moved into `box` and turned by `angle`. */
export function transformMask(m, from, box, angle = 0) {
  const out = createMask(m.width, m.height);
  if (!(from.w > 0) || !(from.h > 0) || !(box.w > 0) || !(box.h > 0)) return out;
  const inv = invert(floatMatrix(from.w, from.h, box, angle));
  const b = rotatedBounds(box, angle);
  const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y), x1 = Math.min(m.width, b.x + b.w), y1 = Math.min(m.height, b.y + b.h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const u = Math.floor(inv[0] * px + inv[2] * py + inv[4]), v = Math.floor(inv[1] * px + inv[3] * py + inv[5]);
      if (u < 0 || v < 0 || u >= from.w || v >= from.h) continue;
      const su = from.x + u, sv = from.y + v;
      if (su < 0 || sv < 0 || su >= m.width || sv >= m.height) continue;
      out.data[y * m.width + x] = m.data[sv * m.width + su];
    }
  }
  return out;
}
