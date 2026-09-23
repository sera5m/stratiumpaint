// Adjustments: per-pixel colour operations. Each has declarative params so the UI can build
// its dialog automatically, and apply(src, params) -> new image (src is never mutated).
import { clamp } from './util.js';
import { cloneImage } from './image.js';

const range = (id, label, min, max, def, step = 1) => ({ id, label, type: 'range', min, max, step, default: def });

const buildLut = (fn) => {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = fn(v);
  return lut;
};

function applyLuts(src, lr, lg = lr, lb = lr) {
  const out = cloneImage(src), d = out.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = lr[d[i]]; d[i + 1] = lg[d[i + 1]]; d[i + 2] = lb[d[i + 2]]; }
  return out;
}

export function levelsLut({ inLow, inHigh, gamma, outLow, outHigh }) {
  const span = Math.max(1, inHigh - inLow);
  return buildLut((v) => outLow + (outHigh - outLow) * Math.pow(clamp((v - inLow) / span, 0, 1), 1 / gamma));
}

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// scratch for hslToRgb without allocating per pixel
const rgbScratch = [0, 0, 0];
function hslInto(h, s, l, out) {
  const c = (1 - Math.abs(2 * l - 1)) * s, hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  switch (Math.floor(hp)) {
    case 0: r = c; g = x; break;
    case 1: r = x; g = c; break;
    case 2: g = c; b = x; break;
    case 3: g = x; b = c; break;
    case 4: r = x; b = c; break;
    default: r = c; b = x;
  }
  out[0] = (r + m) * 255; out[1] = (g + m) * 255; out[2] = (b + m) * 255;
}

export const ADJUSTMENTS = [
  {
    id: 'auto-level', name: 'Auto-Level', shortcut: 'Ctrl+Shift+L',
    params: [range('clip', 'Clip shadows/highlights (%)', 0, 10, 0.5, 0.1)],
    apply(src, { clip }) {
      const hist = new Float64Array(256);
      let total = 0;
      const d = src.data;
      for (let i = 0; i < d.length; i += 4) {
        if (!d[i + 3]) continue;
        hist[Math.round(lum(d[i], d[i + 1], d[i + 2]))]++;
        total++;
      }
      const cut = (total * clip) / 100;
      let lo = 0, hi = 255, acc = 0;
      for (; lo < 255; lo++) { acc += hist[lo]; if (acc > cut) break; }
      acc = 0;
      for (; hi > 0; hi--) { acc += hist[hi]; if (acc > cut) break; }
      if (hi <= lo) return cloneImage(src);
      return applyLuts(src, levelsLut({ inLow: lo, inHigh: hi, gamma: 1, outLow: 0, outHigh: 255 }));
    },
  },
  {
    id: 'black-white', name: 'Black and White', shortcut: 'Ctrl+Shift+G', params: [],
    apply(src) {
      const out = cloneImage(src), d = out.data;
      for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = lum(d[i], d[i + 1], d[i + 2]);
      return out;
    },
  },
  {
    id: 'brightness-contrast', name: 'Brightness / Contrast',
    params: [range('brightness', 'Brightness', -100, 100, 0), range('contrast', 'Contrast', -100, 100, 0)],
    apply(src, { brightness, contrast }) {
      const C = contrast * 2.55, f = (259 * (C + 255)) / (255 * (259 - C)), off = brightness * 2.55;
      return applyLuts(src, buildLut((v) => f * (v - 128) + 128 + off));
    },
  },
  {
    id: 'hue-saturation', name: 'Hue / Saturation', shortcut: 'Ctrl+Shift+U',
    params: [range('hue', 'Hue', -180, 180, 0), range('saturation', 'Saturation', 0, 200, 100), range('lightness', 'Lightness', -100, 100, 0)],
    apply(src, { hue, saturation, lightness }) {
      const out = cloneImage(src), d = out.data;
      const sm = saturation / 100, L = lightness / 100;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), dd = max - min;
        let l = (max + min) / 2, s = 0, h = 0;
        if (dd > 0) {
          const den = 1 - Math.abs(2 * l - 1);
          s = den > 0 ? dd / den : 0;
          if (max === r) h = ((g - b) / dd) % 6; else if (max === g) h = (b - r) / dd + 2; else h = (r - g) / dd + 4;
          h *= 60;
        }
        s = clamp(s * sm, 0, 1);
        l = L >= 0 ? l + (1 - l) * L : l * (1 + L);
        hslInto(h + hue, s, l, rgbScratch);
        d[i] = rgbScratch[0]; d[i + 1] = rgbScratch[1]; d[i + 2] = rgbScratch[2];
      }
      return out;
    },
  },
  {
    id: 'invert', name: 'Invert Colors', shortcut: 'Ctrl+Shift+I', params: [],
    apply(src) {
      const out = cloneImage(src), d = out.data;
      for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
      return out;
    },
  },
  {
    id: 'levels', name: 'Levels', shortcut: 'Ctrl+L',
    params: [
      range('inLow', 'Input black', 0, 254, 0), range('inHigh', 'Input white', 1, 255, 255),
      range('gamma', 'Gamma', 0.1, 5, 1, 0.01),
      range('outLow', 'Output black', 0, 254, 0), range('outHigh', 'Output white', 1, 255, 255),
    ],
    apply: (src, p) => applyLuts(src, levelsLut(p)),
  },
  {
    id: 'posterize', name: 'Posterize',
    params: [range('levels', 'Levels per channel', 2, 64, 4)],
    apply: (src, { levels }) => applyLuts(src, buildLut((v) => Math.round((Math.round((v / 255) * (levels - 1)) * 255) / (levels - 1)))),
  },
  {
    id: 'sepia', name: 'Sepia', shortcut: 'Ctrl+Shift+E', params: [],
    apply(src) {
      const out = cloneImage(src), d = out.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        d[i] = 0.393 * r + 0.769 * g + 0.189 * b;
        d[i + 1] = 0.349 * r + 0.686 * g + 0.168 * b;
        d[i + 2] = 0.272 * r + 0.534 * g + 0.131 * b;
      }
      return out;
    },
  },
];

export const defaultParams = (spec) => Object.fromEntries((spec.params ?? []).map((p) => [p.id, p.default]));
