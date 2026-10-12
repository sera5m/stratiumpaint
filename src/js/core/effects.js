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
  const out = cloneImage(src);
  const data = src.data;
  for (let i = 0; i < data.length; i += 4) {
    if (!inRange(data, i, p)) continue;
    const [r, g, b, a] = fn(data[i], data[i + 1], data[i + 2], data[i + 3]);
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

export const EFFECTS = [
  {
    id: 'gaussian-blur', name: 'Gaussian Blur', category: 'Blurs',
    params: [range('radius', 'Radius', 0, 100, 10)],
    margin: (p) => Math.ceil(p.radius * 1.5),
    apply: (src, { radius }) => (radius <= 0 ? cloneImage(src) : blurImage(src, radius / 2)),
  },
  {
    id: 'acid', name: 'Acid', category: 'Stylize',
    params: [range('intensity', 'Intensity', 0, 100, 60), range('hue', 'Hue shift', -180, 180, 90), range('sat', 'Saturation boost', 100, 400, 220), ...rangeParams()],
    apply: (src, p) => selective(src, p, (r, g, b, a) => {
      const k = p.intensity / 100;
      const L = lum(r, g, b) / 255;
      const hue = ((Math.atan2(g - b, r - 0.5 * (g + b)) * 180 / Math.PI) + p.hue * k) % 360;
      const sat = Math.min(4, (p.sat / 100) * (1 + k));
      const [nr, ng, nb] = hslToRgb(hue, sat, L);
      return [nr, ng, nb, a];
    }),
  },
  {
    id: 'oversaturate', name: 'Oversaturate', category: 'Color',
    params: [range('amount', 'Amount', 100, 800, 250), checkbox('preserveLuma', 'Preserve luminance', true), ...rangeParams()],
    apply: (src, p) => selective(src, p, (r, g, b, a) => {
      const L = lum(r, g, b);
      const k = p.amount / 100;
      let nr = L + (r - L) * k, ng = L + (g - L) * k, nb = L + (b - L) * k;
      if (p.preserveLuma) { const nL = lum(nr, ng, nb) || 1; const s = L / nL; nr *= s; ng *= s; nb *= s; }
      return [nr, ng, nb, a];
    }),
  },
  {
    id: 'burn', name: 'Burn', category: 'Photo',
    params: [range('amount', 'Amount', 0, 100, 40), range('heat', 'Heat', 0, 100, 50), range('threshold', 'Threshold', 0, 255, 140), ...rangeParams()],
    apply: (src, p) => selective(src, p, (r, g, b, a) => {
      const L = lum(r, g, b);
      const t = clamp((p.threshold - L) / 40, 0, 1);
      const k = (p.amount / 100) * t;
      const heat = p.heat / 100;
      return [r * (1 - k) + (r * 0.4 + 180 * heat) * k, g * (1 - k) + (g * 0.2 + 60 * heat) * k, b * (1 - k * 1.2), a];
    }),
  },
];

export const EFFECT_CATEGORIES = [...new Set(EFFECTS.map((e) => e.category))];
