// Colour / pattern / gradient fills. Pure functions over pixel buffers.
import { clamp } from './util.js';
import { blendPixel, createImage } from './image.js';

export const PATTERN_TYPES = [
  ['checker', 'Checkerboard'],
  ['stripes-h', 'Horizontal stripes'],
  ['stripes-v', 'Vertical stripes'],
  ['diagonal', 'Diagonal stripes'],
  ['dots', 'Dots'],
  ['grid', 'Grid'],
  ['brick', 'Bricks'],
];

/** true → primary colour, false → secondary colour, for pixel (x,y) with cell size s. */
export function patternIsPrimary(type, x, y, s) {
  switch (type) {
    case 'checker': return ((Math.floor(x / s) + Math.floor(y / s)) & 1) === 0;
    case 'stripes-h': return (Math.floor(y / s) & 1) === 0;
    case 'stripes-v': return (Math.floor(x / s) & 1) === 0;
    case 'diagonal': return (Math.floor((x + y) / s) & 1) === 0;
    case 'grid': { const t = Math.max(1, Math.round(s / 8)); return x % s < t || y % s < t; }
    case 'dots': {
      const cx = (x % s) - s / 2 + 0.5, cy = (y % s) - s / 2 + 0.5;
      return cx * cx + cy * cy <= (s * 0.3) ** 2;
    }
    case 'brick': {
      const bh = s, bw = s * 2, row = Math.floor(y / bh);
      const xx = x + (row & 1 ? bw / 2 : 0);
      return !(y % bh === 0 || xx % bw === 0); // primary = brick, secondary = mortar
    }
    default: return true;
  }
}

/**
 * Source-over a colour (or pattern) through a mask into `img`, in place.
 * color / secondary are {r,g,b,a}. `mask` may be null (=everything).
 */
export function fillMask(img, mask, color, { pattern = null, secondary = null, patternSize = 16 } = {}) {
  const { width: w, height: h, data } = img;
  const s = Math.max(2, patternSize | 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = mask ? mask.data[y * w + x] : 255;
      if (!m) continue;
      let c = color;
      if (pattern) c = patternIsPrimary(pattern, x, y, s) ? color : secondary ?? color;
      blendPixel(data, (y * w + x) * 4, c.r, c.g, c.b, ((c.a ?? 1) * m) / 255);
    }
  }
}

export const GRADIENT_TYPES = [
  ['linear', 'Linear'],
  ['reflected', 'Reflected'],
  ['diamond', 'Diamond'],
  ['radial', 'Radial'],
  ['conical', 'Conical'],
];

/**
 * Renders a gradient into a fresh image covering `region` (document coordinates).
 * The result is already multiplied by the selection `mask` (null = everything).
 */
export function renderGradient(region, type, p0, p1, c0, c1, mask, docWidth) {
  const out = createImage(region.w, region.h);
  const d = out.data;
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const L = Math.hypot(dx, dy);
  const ux = L ? dx / L : 1, uy = L ? dy / L : 0;
  const a0 = c0.a ?? 1, a1 = c1.a ?? 1;
  for (let y = 0; y < region.h; y++) {
    const py = region.y + y + 0.5 - p0.y;
    for (let x = 0; x < region.w; x++) {
      const gx = region.x + x;
      const m = mask ? mask.data[(region.y + y) * docWidth + gx] : 255;
      if (!m) continue;
      const px = gx + 0.5 - p0.x;
      let t = 0;
      if (L > 0) {
        const u = px * ux + py * uy, v = -px * uy + py * ux;
        switch (type) {
          case 'linear': t = u / L; break;
          case 'reflected': t = Math.abs(u) / L; break;
          case 'diamond': t = (Math.abs(u) + Math.abs(v)) / L; break;
          case 'radial': t = Math.hypot(px, py) / L; break;
          case 'conical': t = Math.abs(Math.atan2(v, u)) / Math.PI; break;
          default: t = u / L;
        }
        t = clamp(t, 0, 1);
      }
      const i = (y * region.w + x) * 4;
      d[i] = c0.r + (c1.r - c0.r) * t;
      d[i + 1] = c0.g + (c1.g - c0.g) * t;
      d[i + 2] = c0.b + (c1.b - c0.b) * t;
      d[i + 3] = (a0 + (a1 - a0) * t) * (m / 255) * 255;
    }
  }
  return out;
}
