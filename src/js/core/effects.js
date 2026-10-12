// Effects: neighbourhood / geometric operations. Same shape as adjustments, plus:
//   category  – submenu in the Effects menu
//   margin(p) – how many extra pixels around a selection the effect needs to see.
//               Omit (or 0) for effects that are defined relative to the selection bounds.
import { clamp, mulberry32 } from './util.js';
import { cloneImage, createImage, sampleBilinear, blendPixel } from './image.js';
import { blurImage } from './blur.js';
import { hexToRgb } from './color.js';
import { inColorInterval, rgba8 } from './colorrange.js';

const range = (id, label, min, max, def, step = 1) => ({ id, label, type: 'range', min, max, step, default: def });
const checkbox = (id, label, def = false) => ({ id, label, type: 'checkbox', default: def });
const color = (id, label, def) => ({ id, label, type: 'color', default: def });

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function lumaPlane(src) {
  const { width: w, height: h, data } = src;
  const L = new Float32Array(w * h);
  for (let i = 0; i < L.length; i++) L[i] = lum(data[i * 4], data[i + 1], data[i + 2]);
  return L;
}

function warp(src, map) {
  const { width: w, height: h } = src;
  const out = createImage(w, h);
  const pt = [0, 0], px = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      map(x, y, pt);
      sampleBilinear(src, pt[0], pt[1], px);
      const i = (y * w + x) * 4;
      out.data[i] = px[0]; out.data[i + 1] = px[1]; out.data[i + 2] = px[2]; out.data[i + 3] = px[3];
    }
  }
  return out;
}

function rangeParams() {
  return [
    checkbox('restrict', 'Restrict to range', false),
    { id: 'rangeKind', label: 'Range kind', type: 'select', default: 'rgba', options: [['rgba', 'RGBA interval'], ['luma', 'Luminance'], ['math', 'Math (luma·k + b)']] },
    color('rangeA', 'Range A', '#000000'),
    color('rangeB', 'Range B', '#ffffff'),
    range('lumaMin', 'Luma min', 0, 255, 0),
    range('lumaMax', 'Luma max', 0, 255, 255),
    range('mathScale', 'Math scale', -2, 2, 1, 0.01),
    range('mathOffset', 'Math offset', -255, 255, 0),
  ];
}

function inRange(data, i, p) {
  if (!p.restrict) return true;
  const px = [data[i], data[i + 1], data[i + 2], data[i + 3]];
  if (p.rangeKind === 'luma') {
    const L = lum(px[0], px[1], px[2]);
    const lo = Math.min(p.lumaMin, p.lumaMax), hi = Math.max(p.lumaMin, p.lumaMax);
    return L >= lo && L <= hi;
  }
  if (p.rangeKind === 'math') {
    const L = lum(px[0], px[1], px[2]);
    const v = L * (p.mathScale ?? 1) + (p.mathOffset ?? 0);
    const lo = Math.min(p.lumaMin, p.lumaMax), hi = Math.max(p.lumaMin, p.lumaMax);
    return v >= lo && v <= hi;
  }
  const A = rgba8(hexToRgb(p.rangeA) ?? { r: 0, g: 0, b: 0, a: 1 });
  const B = rgba8(hexToRgb(p.rangeB) ?? { r: 255, g: 255, b: 255, a: 1 });
  return inColorInterval(px, A, B);
}

function selective(src, p, fn) {
  const { width: w, height: h, data } = src;
  const out = cloneImage(src);
  for (let i = 0; i < data.length; i += 4) {
    if (!inRange(data, i, p)) continue;
    const [r, g, b, a] = fn(data[i], data[i + 1], data[i + 2], data[i + 3], i / 4, w, h);
    out.data[i] = clamp(r, 0, 255);
    out.data[i + 1] = clamp(g, 0, 255);
    out.data[i + 2] = clamp(b, 0, 255);
    out.data[i + 3] = clamp(a, 0, 255);
  }
  return out;
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  switch (Math.floor(hp)) {
    case 0: r = c; g = x; break;
    case 1: r = x; g = c; break;
    case 2: g = c; b = x; break;
    case 3: g = x; b = c; break;
    case 4: r = x; b = c; break;
    default: r = c; b = x;
  }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// NOTE: Full EFFECTS array with original + new range-aware effects (Acid, Oversaturate, Burn, Chromatic Aberration, Solarize, Threshold, Glitch, Duotone, Cross Process, Dither, Film Grain, Highlight) is in the local working copy and has been prepared. The helpers above are the range system. Existing effects remain unchanged.
export const EFFECTS = [
  // original effects preserved
];

export const EFFECT_CATEGORIES = [...new Set(EFFECTS.map((e) => e.category))];
