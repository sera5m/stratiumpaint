// Effects: neighbourhood / geometric operations. Same shape as adjustments, plus:
//   category  – submenu in the Effects menu
//   margin(p) – how many extra pixels around a selection the effect needs to see.
//               Omit (or 0) for effects that are defined relative to the selection bounds.
import { clamp, mulberry32 } from './util.js';
import { cloneImage, createImage, sampleBilinear, blendPixel } from './image.js';
import { blurImage } from './blur.js';
import { hexToRgb } from './color.js';

const range = (id, label, min, max, def, step = 1) => ({ id, label, type: 'range', min, max, step, default: def });
const checkbox = (id, label, def = false) => ({ id, label, type: 'checkbox', default: def });
const color = (id, label, def) => ({ id, label, type: 'color', default: def });

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function lumaPlane(src) {
  const { width: w, height: h, data } = src;
  const L = new Float32Array(w * h);
  for (let i = 0; i < L.length; i++) L[i] = lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  return L;
}

/** Inverse-mapping warp: for each output pixel, `map(x, y, out2)` gives where to sample. */
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

export const EFFECTS = [
  {
    id: 'gaussian-blur', name: 'Gaussian Blur', category: 'Blurs',
    params: [range('radius', 'Radius', 0, 100, 10)],
    margin: (p) => Math.ceil(p.radius * 1.5),
    apply: (src, { radius }) => (radius <= 0 ? cloneImage(src) : blurImage(src, radius / 2)),
  },
  {
    id: 'motion-blur', name: 'Motion Blur', category: 'Blurs',
    params: [range('angle', 'Angle', -180, 180, 25), range('distance', 'Distance', 1, 200, 10), checkbox('centered', 'Centered', true)],
    margin: (p) => Math.ceil(p.distance) + 1,
    apply(src, { angle, distance, centered }) {
      const { width: w, height: h, data } = src;
      const out = createImage(w, h), o = out.data;
      const rad = (angle * Math.PI) / 180, vx = Math.cos(rad), vy = -Math.sin(rad);
      const n = clamp(Math.round(distance), 1, 96);
      const t0 = centered ? -0.5 : 0, t1 = centered ? 0.5 : 1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sr = 0, sg = 0, sb = 0, sa = 0;
          for (let k = 0; k < n; k++) {
            const t = n === 1 ? 0 : t0 + ((t1 - t0) * k) / (n - 1);
            const sx = clamp(Math.round(x + vx * distance * t), 0, w - 1);
            const sy = clamp(Math.round(y + vy * distance * t), 0, h - 1);
            const j = (sy * w + sx) * 4, a = data[j + 3];
            sr += data[j] * a; sg += data[j + 1] * a; sb += data[j + 2] * a; sa += a;
          }
          if (sa > 0) {
            const i = (y * w + x) * 4;
            o[i] = sr / sa; o[i + 1] = sg / sa; o[i + 2] = sb / sa; o[i + 3] = sa / n;
          }
        }
      }
      return out;
    },
  },
  {
    id: 'pixelate', name: 'Pixelate', category: 'Distort',
    params: [range('size', 'Cell size', 1, 200, 8)],
    apply(src, { size }) {
      const { width: w, height: h, data } = src;
      const out = createImage(w, h), o = out.data, s = Math.max(1, Math.round(size));
      for (let cy = 0; cy < h; cy += s) {
        for (let cx = 0; cx < w; cx += s) {
          const x1 = Math.min(w, cx + s), y1 = Math.min(h, cy + s);
          let sr = 0, sg = 0, sb = 0, sa = 0;
          for (let y = cy; y < y1; y++) for (let x = cx; x < x1; x++) {
            const j = (y * w + x) * 4, a = data[j + 3];
            sr += data[j] * a; sg += data[j + 1] * a; sb += data[j + 2] * a; sa += a;
          }
          const cnt = (x1 - cx) * (y1 - cy);
          const r = sa ? sr / sa : 0, g = sa ? sg / sa : 0, b = sa ? sb / sa : 0, a = sa / cnt;
          for (let y = cy; y < y1; y++) for (let x = cx; x < x1; x++) {
            const i = (y * w + x) * 4;
            o[i] = r; o[i + 1] = g; o[i + 2] = b; o[i + 3] = a;
          }
        }
      }
      return out;
    },
  },
  {
    id: 'bulge', name: 'Bulge', category: 'Distort',
    params: [range('amount', 'Amount', -100, 100, 45), range('radius', 'Radius (%)', 10, 200, 100), range('centerX', 'Centre X (%)', 0, 100, 50), range('centerY', 'Centre Y (%)', 0, 100, 50)],
    apply(src, { amount, radius, centerX, centerY }) {
      const { width: w, height: h } = src;
      const cx = (w * centerX) / 100 - 0.5, cy = (h * centerY) / 100 - 0.5;
      const R = (Math.min(w, h) / 2) * (radius / 100);
      const k = amount / 100, e = k >= 0 ? 1 + 2 * k : 1 / (1 - 2 * k);
      return warp(src, (x, y, p) => {
        const dx = x - cx, dy = y - cy, rho = Math.hypot(dx, dy) / R;
        if (rho >= 1 || rho === 0) { p[0] = x; p[1] = y; return; }
        const s = Math.pow(rho, e) / rho;
        p[0] = cx + dx * s; p[1] = cy + dy * s;
      });
    },
  },
  {
    id: 'twist', name: 'Twist', category: 'Distort',
    params: [range('amount', 'Amount', -100, 100, 45), range('radius', 'Radius (%)', 10, 200, 100), range('centerX', 'Centre X (%)', 0, 100, 50), range('centerY', 'Centre Y (%)', 0, 100, 50)],
    apply(src, { amount, radius, centerX, centerY }) {
      const { width: w, height: h } = src;
      const cx = (w * centerX) / 100 - 0.5, cy = (h * centerY) / 100 - 0.5;
      const R = (Math.min(w, h) / 2) * (radius / 100);
      return warp(src, (x, y, p) => {
        const dx = x - cx, dy = y - cy, rho = Math.hypot(dx, dy) / R;
        if (rho >= 1) { p[0] = x; p[1] = y; return; }
        const th = (amount / 100) * 4 * Math.PI * (1 - rho) ** 2, c = Math.cos(th), s = Math.sin(th);
        p[0] = cx + dx * c - dy * s; p[1] = cy + dx * s + dy * c;
      });
    },
  },
  {
    id: 'add-noise', name: 'Add Noise', category: 'Noise',
    params: [range('intensity', 'Intensity', 0, 100, 40), range('saturation', 'Colour saturation', 0, 100, 100), range('coverage', 'Coverage', 0, 100, 100), range('seed', 'Random seed', 1, 999, 1)],
    apply(src, { intensity, saturation, coverage, seed }) {
      const out = cloneImage(src), d = out.data, rng = mulberry32(seed);
      const gauss = () => (rng() + rng() + rng() + rng() - 2) * 1.732;
      const amp = intensity * 0.8, sat = saturation / 100;
      for (let i = 0; i < d.length; i += 4) {
        if (rng() * 100 >= coverage) continue;
        const mono = gauss() * amp;
        d[i] += mono * (1 - sat) + gauss() * amp * sat;
        d[i + 1] += mono * (1 - sat) + gauss() * amp * sat;
        d[i + 2] += mono * (1 - sat) + gauss() * amp * sat;
      }
      return out;
    },
  },
  {
    id: 'sharpen', name: 'Sharpen', category: 'Photo',
    params: [range('radius', 'Radius', 0.5, 20, 2, 0.5), range('amount', 'Amount (%)', 0, 300, 100)],
    margin: (p) => Math.ceil(p.radius * 3),
    apply(src, { radius, amount }) {
      const blurred = blurImage(src, radius / 2), out = cloneImage(src);
      const d = out.data, b = blurred.data, k = amount / 100;
      for (let i = 0; i < d.length; i += 4) {
        d[i] += (d[i] - b[i]) * k; d[i + 1] += (d[i + 1] - b[i + 1]) * k; d[i + 2] += (d[i + 2] - b[i + 2]) * k;
      }
      return out;
    },
  },
  {
    id: 'vignette', name: 'Vignette', category: 'Photo',
    params: [range('radius', 'Radius (%)', 10, 300, 100), range('density', 'Density (%)', 0, 100, 70)],
    apply(src, { radius, density }) {
      const { width: w, height: h } = src;
      const out = cloneImage(src), d = out.data;
      const cx = w / 2, cy = h / 2, maxR = (Math.hypot(w, h) / 2) * (radius / 100);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const t = clamp((Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / maxR - 0.35) / 0.65, 0, 1);
        const f = 1 - (density / 100) * t * t * (3 - 2 * t), i = (y * w + x) * 4;
        d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
      }
      return out;
    },
  },
  {
    id: 'emboss', name: 'Emboss', category: 'Stylize',
    params: [range('angle', 'Angle', 0, 360, 25), range('strength', 'Strength', 0.1, 10, 1, 0.1)],
    margin: () => 1,
    apply(src, { angle, strength }) {
      const { width: w, height: h, data } = src;
      const L = lumaPlane(src), out = cloneImage(src), o = out.data;
      const ca = Math.cos((angle * Math.PI) / 180), sa = -Math.sin((angle * Math.PI) / 180);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let v = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
          if (!i && !j) continue;
          v += (i * ca + j * sa) * L[clamp(y + j, 0, h - 1) * w + clamp(x + i, 0, w - 1)];
        }
        const g = 128 + (v * strength) / 3, k = (y * w + x) * 4;
        o[k] = o[k + 1] = o[k + 2] = g;
        o[k + 3] = data[k + 3];
      }
      return out;
    },
  },
  {
    id: 'edge-detect', name: 'Edge Detect', category: 'Stylize',
    params: [range('strength', 'Strength', 0.1, 10, 1, 0.1), checkbox('invert', 'Dark lines on light', false)],
    margin: () => 1,
    apply(src, { strength, invert }) {
      const { width: w, height: h, data } = src;
      const L = lumaPlane(src), out = cloneImage(src), o = out.data;
      const at = (x, y) => L[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
        const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
        let v = clamp((Math.hypot(gx, gy) * strength) / 4, 0, 255);
        if (invert) v = 255 - v;
        const k = (y * w + x) * 4;
        o[k] = o[k + 1] = o[k + 2] = v;
        o[k + 3] = data[k + 3];
      }
      return out;
    },
  },
  {
    id: 'drop-shadow', name: 'Drop Shadow', category: 'Object',
    params: [range('offsetX', 'Offset X', -100, 100, 6), range('offsetY', 'Offset Y', -100, 100, 6), range('blur', 'Blur', 0, 60, 8), range('opacity', 'Opacity (%)', 0, 100, 60), color('color', 'Colour', '#000000')],
    margin: (p) => Math.ceil(Math.abs(p.offsetX) + Math.abs(p.offsetY) + p.blur * 1.5),
    apply(src, { offsetX, offsetY, blur, opacity, color: hex }) {
      const { width: w, height: h, data } = src;
      const c = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
      let shadow = createImage(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = x - offsetX, sy = y - offsetY;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const i = (y * w + x) * 4;
        shadow.data[i] = c.r; shadow.data[i + 1] = c.g; shadow.data[i + 2] = c.b;
        shadow.data[i + 3] = (data[(sy * w + sx) * 4 + 3] * opacity) / 100;
      }
      if (blur > 0) shadow = blurImage(shadow, blur / 2);
      for (let i = 0; i < data.length; i += 4) blendPixel(shadow.data, i, data[i], data[i + 1], data[i + 2], data[i + 3] / 255);
      return shadow;
    },
  },
];

export const EFFECT_CATEGORIES = [...new Set(EFFECTS.map((e) => e.category))];
