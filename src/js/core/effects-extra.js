// Extra effects: Paint.NET-style set plus dither / pixel-art tools.
import { clamp, mulberry32 } from './util.js';
import { cloneImage, createImage, sampleBilinear } from './image.js';
import { blurImage } from './blur.js';

const range = (id, label, min, max, def, step = 1) => ({ id, label, type: 'range', min, max, step, default: def });
const checkbox = (id, label, def = false) => ({ id, label, type: 'checkbox', default: def });
const color = (id, label, def) => ({ id, label, type: 'color', default: def });
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function at(data, w, x, y) {
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}
function put(data, w, x, y, px) {
  const i = (y * w + x) * 4;
  data[i] = px[0]; data[i + 1] = px[1]; data[i + 2] = px[2]; data[i + 3] = px[3];
}
function sample(src, x, y, px) { sampleBilinear(src, x, y, px); return px; }

function warp(src, map) {
  const { width: w, height: h } = src;
  const out = createImage(w, h);
  const pt = [0, 0], px = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    map(x, y, pt);
    sample(src, pt[0], pt[1], px);
    const i = (y * w + x) * 4;
    out.data[i] = px[0]; out.data[i + 1] = px[1]; out.data[i + 2] = px[2]; out.data[i + 3] = px[3];
  }
  return out;
}

function quant(v, n) { return n <= 1 ? 0 : Math.round(v / 255 * (n - 1)) * (255 / (n - 1)); }

const BAYER4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];
const BAYER8 = (() => {
  const b = new Uint8Array(64);
  const m = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
  for (let i = 0; i < 64; i++) b[i] = m[i];
  return b;
})();

function oilPaint(src, radius, bins) {
  const { width: w, height: h, data } = src;
  const out = createImage(w, h), r = clamp(radius | 0, 1, 8), nbin = clamp(bins | 0, 4, 32);
  const counts = new Uint16Array(nbin), sumR = new Float32Array(nbin), sumG = new Float32Array(nbin), sumB = new Float32Array(nbin), sumA = new Float32Array(nbin);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    counts.fill(0); sumR.fill(0); sumG.fill(0); sumB.fill(0); sumA.fill(0);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const sx = clamp(x + dx, 0, w - 1), sy = clamp(y + dy, 0, h - 1);
      const [cr, cg, cb, ca] = at(data, w, sx, sy);
      const bin = clamp(Math.floor(lum(cr, cg, cb) / 256 * nbin), 0, nbin - 1);
      counts[bin]++; sumR[bin] += cr; sumG[bin] += cg; sumB[bin] += cb; sumA[bin] += ca;
    }
    let best = 0;
    for (let i = 1; i < nbin; i++) if (counts[i] > counts[best]) best = i;
    const c = counts[best] || 1;
    put(out.data, w, x, y, [sumR[best] / c, sumG[best] / c, sumB[best] / c, sumA[best] / c]);
  }
  return out;
}

function median(src, radius) {
  const { width: w, height: h, data } = src;
  const out = createImage(w, h), r = clamp(radius | 0, 1, 4);
  const buf = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    buf.length = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const sx = clamp(x + dx, 0, w - 1), sy = clamp(y + dy, 0, h - 1);
      buf.push(at(data, w, sx, sy));
    }
    buf.sort((a, b) => lum(a[0], a[1], a[2]) - lum(b[0], b[1], b[2]));
    put(out.data, w, x, y, buf[buf.length >> 1]);
  }
  return out;
}

function errorDiffuse(src, levels, kernel) {
  const { width: w, height: h, data } = src;
  const out = createImage(w, h);
  const err = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  const n = clamp(levels | 0, 2, 16);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = i * 4;
    const px = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const v = clamp(data[j + c] + err[c][i], 0, 255);
      const q = quant(v, n);
      px[c] = q;
      const e = v - q;
      for (const [dx, dy, k] of kernel) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) err[c][ny * w + nx] += e * k;
      }
    }
    put(out.data, w, x, y, [px[0], px[1], px[2], data[j + 3]]);
  }
  return out;
}

const FS = [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]];
const ATK = [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]];

export const EXTRA_EFFECTS = [
  // ----- Artistic -----
  {
    id: 'oil-painting', name: 'Oil Painting', category: 'Artistic',
    params: [range('brush', 'Brush size', 1, 8, 3), range('bins', 'Detail', 4, 24, 12)],
    apply: (src, p) => oilPaint(src, p.brush, p.bins),
  },
  {
    id: 'ink-sketch', name: 'Ink Sketch', category: 'Artistic',
    params: [range('ink', 'Ink outline', 0, 100, 50), range('coloring', 'Coloring', 0, 100, 50)],
    apply(src, p) {
      const edges = blurImage(src, 1);
      const { width: w, height: h, data } = src;
      const out = createImage(w, h), ed = edges.data, k = p.ink / 100, col = p.coloring / 100;
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        const gx = lum(...at(data, w, x + 1, y)) - lum(...at(data, w, x - 1, y));
        const gy = lum(...at(data, w, x, y + 1)) - lum(...at(data, w, x, y - 1));
        const e = clamp(1 - Math.hypot(gx, gy) / 80 * k, 0, 1);
        const L = lum(data[i], data[i + 1], data[i + 2]);
        out.data[i] = L * (1 - col) + data[i] * col; out.data[i] *= e;
        out.data[i + 1] = (L * (1 - col) + data[i + 1] * col) * e;
        out.data[i + 2] = (L * (1 - col) + data[i + 2] * col) * e;
        out.data[i + 3] = data[i + 3];
      }
      return out;
    },
  },
  {
    id: 'pencil-sketch', name: 'Pencil Sketch', category: 'Artistic',
    params: [range('tip', 'Pencil tip', 1, 20, 4), range('range', 'Range', 0, 100, 40)],
    apply(src, p) {
      const soft = blurImage(src, p.tip / 2);
      const { width: w, height: h, data } = src;
      const out = createImage(w, h), sd = soft.data, k = 0.5 + p.range / 100;
      for (let i = 0; i < data.length; i += 4) {
        const L = lum(data[i], data[i + 1], data[i + 2]);
        const S = lum(sd[i], sd[i + 1], sd[i + 2]) || 1;
        const v = clamp(255 - (S - L) * k * 2, 0, 255);
        out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
        out.data[i + 3] = data[i + 3];
      }
      return out;
    },
  },
  {
    id: 'linocut', name: 'Linocut', category: 'Artistic',
    params: [range('threshold', 'Threshold', 0, 255, 128), color('ink', 'Ink', '#111111'), color('paper', 'Paper', '#f4efe4')],
    apply(src, p) {
      const { width: w, height: h, data } = src;
      const out = createImage(w, h);
      const ink = [0x11, 0x11, 0x11], paper = [0xf4, 0xef, 0xe4];
      for (let i = 0; i < data.length; i += 4) {
        const on = lum(data[i], data[i + 1], data[i + 2]) < p.threshold;
        const c = on ? ink : paper;
        out.data[i] = c[0]; out.data[i + 1] = c[1]; out.data[i + 2] = c[2]; out.data[i + 3] = data[i + 3];
      }
      return out;
    },
  },
  {
    id: 'mosaic', name: 'Mosaic', category: 'Artistic',
    params: [range('size', 'Tile size', 4, 80, 16), range('grout', 'Grout', 0, 8, 1)],
    apply(src, p) {
      const { width: w, height: h } = src;
      const out = createImage(w, h), cell = Math.max(2, p.size | 0), g = p.grout | 0;
      for (let y0 = 0; y0 < h; y0 += cell) for (let x0 = 0; x0 < w; x0 += cell) {
        let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
        for (let y = y0; y < Math.min(h, y0 + cell); y++) for (let x = x0; x < Math.min(w, x0 + cell); x++) {
          const [r, g2, b, a] = at(src.data, w, x, y); sr += r; sg += g2; sb += b; sa += a; n++;
        }
        const avg = [sr / n, sg / n, sb / n, sa / n];
        for (let y = y0; y < Math.min(h, y0 + cell); y++) for (let x = x0; x < Math.min(w, x0 + cell); x++) {
          const edge = (x - x0) < g || (y - y0) < g;
          put(out.data, w, x, y, edge ? [30, 30, 30, avg[3]] : avg);
        }
      }
      return out;
    },
  },
  {
    id: 'pointillism', name: 'Pointillism', category: 'Artistic',
    params: [range('size', 'Dot size', 2, 24, 6), range('seed', 'Seed', 0, 999, 1)],
    apply(src, p) {
      const { width: w, height: h } = src;
      const out = blurImage(src, 1), rng = mulberry32(p.seed | 0), step = Math.max(2, p.size | 0);
      for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
        const jx = clamp(x + Math.floor(rng() * step) - step / 2, 0, w - 1);
        const jy = clamp(y + Math.floor(rng() * step) - step / 2, 0, h - 1);
        const c = at(src.data, w, jx, jy);
        const rad = step * 0.45;
        for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
          if (dx * dx + dy * dy > rad * rad) continue;
          const sx = jx + dx, sy = jy + dy;
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
          put(out.data, w, sx, sy, c);
        }
      }
      return out;
    },
  },
  {
    id: 'stained-glass', name: 'Stained Glass', category: 'Artistic',
    params: [range('size', 'Cell size', 6, 60, 18), range('seed', 'Seed', 0, 999, 2)],
    apply(src, p) {
      const { width: w, height: h } = src;
      const out = createImage(w, h), cell = Math.max(4, p.size | 0), rng = mulberry32(p.seed | 0);
      const sites = [];
      for (let y = cell / 2; y < h; y += cell) for (let x = cell / 2; x < w; x += cell)
        sites.push([clamp(x + (rng() - 0.5) * cell, 0, w - 1), clamp(y + (rng() - 0.5) * cell, 0, h - 1)]);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let best = 0, bestD = Infinity;
        for (let i = 0; i < sites.length; i++) {
          const d = (x - sites[i][0]) ** 2 + (y - sites[i][1]) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
        const sx = clamp(sites[best][0] | 0, 0, w - 1), sy = clamp(sites[best][1] | 0, 0, h - 1);
        const c = at(src.data, w, sx, sy);
        const edge = Math.sqrt(bestD) % (cell * 0.5) < 1.2;
        put(out.data, w, x, y, edge ? [20, 20, 20, c[3]] : c);
      }
      return out;
    },
  },

  // ----- Blurs -----
  {
    id: 'zoom-blur', name: 'Zoom Blur', category: 'Blurs',
    params: [range('amount', 'Amount', 0, 100, 20), range('cx', 'Center X', 0, 100, 50), range('cy', 'Center Y', 0, 100, 50)],
    apply(src, p) {
      const { width: w, height: h } = src;
      const cx = (p.cx / 100) * w, cy = (p.cy / 100) * h, n = 12, k = p.amount / 100 * 0.4;
      return warp(src, (x, y, pt) => {
        // average handled below — warp is single sample; do custom
        pt[0] = x; pt[1] = y;
      }) && (() => {
        const out = createImage(w, h), px = [0, 0, 0, 0];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          let sr = 0, sg = 0, sb = 0, sa = 0;
          for (let i = 0; i < n; i++) {
            const t = 1 - (i / (n - 1)) * k;
            sample(src, cx + (x - cx) * t, cy + (y - cy) * t, px);
            sr += px[0]; sg += px[1]; sb += px[2]; sa += px[3];
          }
          const i = (y * w + x) * 4;
          out.data[i] = sr / n; out.data[i + 1] = sg / n; out.data[i + 2] = sb / n; out.data[i + 3] = sa / n;
        }
        return out;
      })();
    },
  },
  {
    id: 'radial-blur', name: 'Radial Blur', category: 'Blurs',
    params: [range('angle', 'Angle', 0, 90, 15), range('cx', 'Center X', 0, 100, 50), range('cy', 'Center Y', 0, 100, 50)],
    apply(src, p) {
      const { width: w, height: h } = src;
      const cx = (p.cx / 100) * w, cy = (p.cy / 100) * h, n = 10, a = (p.angle * Math.PI) / 180;
      const out = createImage(w, h), px = [0, 0, 0, 0];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let sr = 0, sg = 0, sb = 0, sa = 0;
        const dx = x - cx, dy = y - cy;
        for (let i = 0; i < n; i++) {
          const t = (i / (n - 1) - 0.5) * a, c = Math.cos(t), s = Math.sin(t);
          sample(src, cx + dx * c - dy * s, cy + dx * s + dy * c, px);
          sr += px[0]; sg += px[1]; sb += px[2]; sa += px[3];
        }
        const i = (y * w + x) * 4;
        out.data[i] = sr / n; out.data[i + 1] = sg / n; out.data[i + 2] = sb / n; out.data[i + 3] = sa / n;
      }
      return out;
    },
  },
  {
    id: 'fragment', name: 'Fragment', category: 'Blurs',
    params: [range('distance', 'Distance', 1, 40, 6), range('count', 'Fragments', 2, 8, 4)],
    apply(src, p) {
      const { width: w, height: h } = src;
      const out = createImage(w, h), n = clamp(p.count | 0, 2, 8), d = p.distance, px = [0, 0, 0, 0];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let sr = 0, sg = 0, sb = 0, sa = 0;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          sample(src, x + Math.cos(a) * d, y + Math.sin(a) * d, px);
          sr += px[0]; sg += px[1]; sb += px[2]; sa += px[3];
        }
        const i = (y * w + x) * 4;
        out.data[i] = sr / n; out.data[i + 1] = sg / n; out.data[i + 2] = sb / n; out.data[i + 3] = sa / n;
      }
      return out;
    },
  },
  {
    id: 'unfocus', name: 'Unfocus', category: 'Blurs',
    params: [range('radius', 'Radius', 0, 40, 6)],
    apply: (src, p) => blurImage(src, p.radius / 2),
  },
  {
    id: 'surface-blur', name: 'Surface Blur', category: 'Blurs',
    params: [range('radius', 'Radius', 1, 8, 3), range('threshold', 'Threshold', 1, 100, 20)],
    apply(src, p) {
      const { width: w, height: h, data } = src;
      const out = createImage(w, h), r = clamp(p.radius | 0, 1, 6), th = p.threshold;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const c0 = at(data, w, x, y), L0 = lum(...c0);
        let sr = 0, sg = 0, sb = 0, sa = 0, sw = 0;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const sx = clamp(x + dx, 0, w - 1), sy = clamp(y + dy, 0, h - 1);
          const c = at(data, w, sx, sy), dL = Math.abs(lum(...c) - L0);
          if (dL > th) continue;
          const wt = 1 - dL / th;
          sr += c[0] * wt; sg += c[1] * wt; sb += c[2] * wt; sa += c[3] * wt; sw += wt;
        }
        put(out.data, w, x, y, sw ? [sr / sw, sg / sw, sb / sw, sa / sw] : c0);
      }
      return out;
    },
  },
  {
    id: 'median-blur', name: 'Median', category: 'Blurs',
    params: [range('radius', 'Radius', 1, 4, 1)],
    apply: (src, p) => median(src, p.radius),
  },
  {
    id: 'square-blur', name: 'Square Blur', category: 'Blurs',
    params: [range('radius', 'Radius', 1, 30, 6)],
    apply(src, p) {
      const { width: w, height: h, data } = src;
      const out = createImage(w, h), r = p.radius | 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const sx = clamp(x + dx, 0, w - 1), sy = clamp(y + dy, 0, h - 1);
          const c = at(data, w, sx, sy); sr += c[0]; sg += c[1]; sb += c[2]; sa += c[3]; n++;
        }
        put(out.data, w, x, y, [sr / n, sg / n, sb / n, sa / n]);
      }
      return out;
    },
  },
  {
    id: 'bokeh', name: 'Bokeh', category: 'Blurs',
    params: [range('radius', 'Radius', 1, 20, 6), range('highlight', 'Highlight', 0, 100, 40)],
    apply(src, p) {
      const soft = blurImage(src, p.radius / 2);
      const { data } = src, od = soft.data, k = p.highlight / 100;
      for (let i = 0; i < data.length; i += 4) {
        const L = lum(data[i], data[i + 1], data[i + 2]);
        if (L > 200) {
          const boost = 1 + k * ((L - 200) / 55);
          od[i] = clamp(od[i] * boost, 0, 255);
          od[i + 1] = clamp(od[i + 1] * boost, 0, 255);
          od[i + 2] = clamp(od[i + 2] * boost, 0, 255);
        }
      }
      return soft;
    },
  },
  {
    id: 'sketch-blur', name: 'Sketch Blur', category: 'Blurs',
    params: [range('radius', 'Radius', 1, 12, 4)],
    apply: (src, p) => oilPaint(blurImage(src, 0.6), Math.max(1, (p.radius / 2) | 0), 8),
  },

  // ----- Distort -----
  {
    id: 'dents', name: 'Dents', category: 'Distort',
    params: [range('scale', 'Scale', 1, 40, 10), range('refraction', 'Refraction', 0, 100, 30), range('seed', 'Seed', 0, 999, 3)],
    apply(src, p) {
      const rng = mulberry32(p.seed | 0), amp = p.refraction / 100 * p.scale;
      return warp(src, (x, y, pt) => {
        const n = Math.sin(x * 0.15 + rng() * 0.01) + Math.cos(y * 0.17);
        pt[0] = x + n * amp; pt[1] = y + Math.cos(x * 0.11 + y * 0.13) * amp;
      });
    },
  },
  {
    id: 'frosted-glass', name: 'Frosted Glass', category: 'Distort',
    params: [range('amount', 'Amount', 1, 30, 6), range('seed', 'Seed', 0, 999, 4)],
    apply(src, p) {
      const rng = mulberry32(p.seed | 0), a = p.amount;
      return warp(src, (x, y, pt) => { pt[0] = x + (rng() - 0.5) * a * 2; pt[1] = y + (rng() - 0.5) * a * 2; });
    },
  },
  {
    id: 'polar-inversion', name: 'Polar Inversion', category: 'Distort',
    params: [range('amount', 'Amount', 0, 100, 100)],
    apply(src, p) {
      const { width: w, height: h } = src, cx = w / 2, cy = h / 2, k = p.amount / 100;
      const maxR = Math.hypot(cx, cy);
      return warp(src, (x, y, pt) => {
        const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy) || 1;
        const nr = maxR * maxR / r;
        const t = k, rr = r * (1 - t) + nr * t;
        pt[0] = cx + (dx / r) * rr; pt[1] = cy + (dy / r) * rr;
      });
    },
  },
  {
    id: 'tile-reflection', name: 'Tile Reflection', category: 'Distort',
    params: [range('tiles', 'Tiles', 1, 8, 2)],
    apply(src, p) {
      const { width: w, height: h } = src, n = Math.max(1, p.tiles | 0);
      return warp(src, (x, y, pt) => {
        const u = (x / w) * n, v = (y / h) * n;
        const fu = u % 2 < 1 ? u % 1 : 1 - (u % 1);
        const fv = v % 2 < 1 ? v % 1 : 1 - (v % 1);
        pt[0] = fu * (w - 1); pt[1] = fv * (h - 1);
      });
    },
  },
  {
    id: 'spherize', name: 'Spherize', category: 'Distort',
    params: [range('amount', 'Amount', -100, 100, 60)],
    apply(src, p) {
      const { width: w, height: h } = src, cx = w / 2, cy = h / 2, k = p.amount / 100;
      return warp(src, (x, y, pt) => {
        const nx = (x - cx) / cx, ny = (y - cy) / cy, r2 = nx * nx + ny * ny;
        if (r2 >= 1) { pt[0] = x; pt[1] = y; return; }
        const z = Math.sqrt(1 - r2), f = 1 - k * z;
        pt[0] = cx + nx * cx * f; pt[1] = cy + ny * cy * f;
      });
    },
  },
  {
    id: 'waves', name: 'Waves', category: 'Distort',
    params: [range('amplitude', 'Amplitude', 0, 40, 8), range('wavelength', 'Wavelength', 4, 80, 20), range('angle', 'Angle', 0, 360, 0)],
    apply(src, p) {
      const a = (p.angle * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
      return warp(src, (x, y, pt) => {
        const s = Math.sin((x * dx + y * dy) / p.wavelength * Math.PI * 2) * p.amplitude;
        pt[0] = x + -dy * s; pt[1] = y + dx * s;
      });
    },
  },
  {
    id: 'rotate-zoom', name: '3D Rotate / Zoom', category: 'Distort',
    params: [range('tilt', 'Tilt', -80, 80, 30), range('turn', 'Turn', -180, 180, 15), range('zoom', 'Zoom', 10, 300, 100)],
    apply(src, p) {
      const { width: w, height: h } = src, cx = w / 2, cy = h / 2;
      const tilt = (p.tilt * Math.PI) / 180, turn = (p.turn * Math.PI) / 180, z = p.zoom / 100;
      const ct = Math.cos(tilt), st = Math.sin(tilt), cr = Math.cos(turn), sr = Math.sin(turn);
      return warp(src, (x, y, pt) => {
        let nx = (x - cx) / z, ny = (y - cy) / z;
        const rx = nx * cr - ny * sr, ry = nx * sr + ny * cr;
        const py = ry / Math.max(0.2, ct);
        pt[0] = cx + rx; pt[1] = cy + py;
      });
    },
  },

  // ----- Noise / Photo -----
  {
    id: 'reduce-noise', name: 'Reduce Noise', category: 'Noise',
    params: [range('radius', 'Radius', 1, 6, 2), range('strength', 'Strength', 0, 100, 60)],
    apply(src, p) {
      const soft = blurImage(src, p.radius / 2);
      const out = cloneImage(src), k = p.strength / 100;
      for (let i = 0; i < out.data.length; i += 4) {
        out.data[i] = src.data[i] * (1 - k) + soft.data[i] * k;
        out.data[i + 1] = src.data[i + 1] * (1 - k) + soft.data[i + 1] * k;
        out.data[i + 2] = src.data[i + 2] * (1 - k) + soft.data[i + 2] * k;
      }
      return out;
    },
  },
  {
    id: 'glow', name: 'Glow', category: 'Photo',
    params: [range('radius', 'Radius', 1, 40, 8), range('brightness', 'Brightness', 0, 200, 80), range('contrast', 'Contrast', 0, 100, 50)],
    apply(src, p) {
      const soft = blurImage(src, p.radius / 2);
      const out = cloneImage(src), b = p.brightness / 100, c = p.contrast / 100;
      for (let i = 0; i < out.data.length; i += 4) {
        const L = lum(soft.data[i], soft.data[i + 1], soft.data[i + 2]) / 255;
        const g = Math.pow(L, 1 - c * 0.5) * b;
        out.data[i] = clamp(src.data[i] + soft.data[i] * g, 0, 255);
        out.data[i + 1] = clamp(src.data[i + 1] + soft.data[i + 1] * g, 0, 255);
        out.data[i + 2] = clamp(src.data[i + 2] + soft.data[i + 2] * g, 0, 255);
      }
      return out;
    },
  },
  {
    id: 'soften-portrait', name: 'Soften Portrait', category: 'Photo',
    params: [range('softness', 'Softness', 0, 100, 40), range('warmth', 'Warmth', 0, 100, 20)],
    apply(src, p) {
      const soft = blurImage(src, 1.5);
      const out = cloneImage(src), k = p.softness / 100, warm = p.warmth / 100 * 18;
      for (let i = 0; i < out.data.length; i += 4) {
        out.data[i] = clamp(src.data[i] * (1 - k) + soft.data[i] * k + warm, 0, 255);
        out.data[i + 1] = src.data[i + 1] * (1 - k) + soft.data[i + 1] * k;
        out.data[i + 2] = clamp(src.data[i + 2] * (1 - k) + soft.data[i + 2] * k - warm * 0.4, 0, 255);
      }
      return out;
    },
  },
  {
    id: 'red-eye', name: 'Red Eye Removal', category: 'Photo',
    params: [range('tolerance', 'Tolerance', 10, 80, 40)],
    apply(src, p) {
      const out = cloneImage(src), th = p.tolerance;
      for (let i = 0; i < out.data.length; i += 4) {
        const r = out.data[i], g = out.data[i + 1], b = out.data[i + 2];
        if (r > 80 && r > g + th && r > b + th) {
          const L = lum(r, g, b);
          out.data[i] = out.data[i + 1] = out.data[i + 2] = L * 0.6;
        }
      }
      return out;
    },
  },
  {
    id: 'straighten', name: 'Straighten', category: 'Photo',
    params: [range('angle', 'Angle', -20, 20, 0)],
    apply(src, p) {
      const { width: w, height: h } = src, a = (p.angle * Math.PI) / 180;
      const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
      const scale = Math.max((w * c + h * s) / w, (w * s + h * c) / h);
      const cx = w / 2, cy = h / 2, ca = Math.cos(-a), sa = Math.sin(-a);
      return warp(src, (x, y, pt) => {
        const dx = (x - cx) / scale, dy = (y - cy) / scale;
        pt[0] = cx + dx * ca - dy * sa; pt[1] = cy + dx * sa + dy * ca;
      });
    },
  },

  // ----- Render -----
  {
    id: 'clouds', name: 'Clouds', category: 'Render',
    params: [range('scale', 'Scale', 2, 40, 10), range('seed', 'Seed', 0, 999, 5), color('a', 'Colour A', '#ffffff'), color('b', 'Colour B', '#6688aa')],
    apply(src, p) {
      const { width: w, height: h } = src;
      const out = createImage(w, h), rng = mulberry32(p.seed | 0);
      const noise = new Float32Array(w * h);
      for (let i = 0; i < noise.length; i++) noise[i] = rng();
      const sc = p.scale;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const nx = (x / sc) | 0, ny = (y / sc) | 0;
        const v = noise[(ny % h) * w + (nx % w)];
        const i = (y * w + x) * 4;
        out.data[i] = 255 * v; out.data[i + 1] = 255 * v; out.data[i + 2] = 255 * v; out.data[i + 3] = 255;
      }
      return blurImage(out, sc / 3);
    },
  },
  {
    id: 'mandelbrot', name: 'Mandelbrot', category: 'Render',
    params: [range('zoom', 'Zoom', 1, 20, 4), range('iter', 'Iterations', 8, 80, 32)],
    apply(src, p) {
      const { width: w, height: h } = src;
      const out = createImage(w, h), z = p.zoom, n = p.iter | 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const cr = (x / w - 0.7) * 3 / z, ci = (y / h - 0.5) * 3 / z;
        let zr = 0, zi = 0, i = 0;
        while (i < n && zr * zr + zi * zi < 4) { const t = zr * zr - zi * zi + cr; zi = 2 * zr * zi + ci; zr = t; i++; }
        const t = i / n, col = [t * 40, t * 120, t * 255, 255];
        put(out.data, w, x, y, col);
      }
      return out;
    },
  },
  {
    id: 'julia', name: 'Julia', category: 'Render',
    params: [range('cx', 'C real', -100, 100, -70), range('cy', 'C imag', -100, 100, 27), range('iter', 'Iterations', 8, 80, 32)],
    apply(src, p) {
      const { width: w, height: h } = src;
      const out = createImage(w, h), cr = p.cx / 100, ci = p.cy / 100, n = p.iter | 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let zr = (x / w - 0.5) * 3, zi = (y / h - 0.5) * 3, i = 0;
        while (i < n && zr * zr + zi * zi < 4) { const t = zr * zr - zi * zi + cr; zi = 2 * zr * zi + ci; zr = t; i++; }
        const t = i / n;
        put(out.data, w, x, y, [t * 255, t * 80, 255 - t * 200, 255]);
      }
      return out;
    },
  },

  // ----- Stylize / Color -----
  {
    id: 'outline', name: 'Outline', category: 'Stylize',
    params: [range('radius', 'Radius', 1, 8, 2), range('strength', 'Strength', 0, 100, 70)],
    apply(src, p) {
      const { width: w, height: h, data } = src;
      const out = cloneImage(src), r = p.radius | 0, k = p.strength / 100;
      for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
        const L = lum(...at(data, w, x, y));
        let max = 0;
        for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
          max = Math.max(max, Math.abs(L - lum(...at(data, w, x + dx, y + dy))));
        }
        const e = clamp(max / 40, 0, 1) * k;
        const i = (y * w + x) * 4;
        out.data[i] = data[i] * (1 - e);
        out.data[i + 1] = data[i + 1] * (1 - e);
        out.data[i + 2] = data[i + 2] * (1 - e);
      }
      return out;
    },
  },
  {
    id: 'relief', name: 'Relief', category: 'Stylize',
    params: [range('angle', 'Angle', 0, 360, 45), range('strength', 'Strength', 1, 10, 3)],
    apply(src, p) {
      const { width: w, height: h, data } = src;
      const out = createImage(w, h), a = (p.angle * Math.PI) / 180, dx = Math.round(Math.cos(a)), dy = Math.round(Math.sin(a)), k = p.strength;
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const c = at(data, w, x, y), n = at(data, w, clamp(x + dx, 0, w - 1), clamp(y + dy, 0, h - 1));
        put(out.data, w, x, y, [
          clamp(128 + (c[0] - n[0]) * k, 0, 255),
          clamp(128 + (c[1] - n[1]) * k, 0, 255),
          clamp(128 + (c[2] - n[2]) * k, 0, 255),
          c[3],
        ]);
      }
      return out;
    },
  },
  {
    id: 'quantize', name: 'Quantize', category: 'Color',
    params: [range('levels', 'Levels', 2, 16, 6)],
    apply(src, p) {
      const out = cloneImage(src), n = p.levels | 0;
      for (let i = 0; i < out.data.length; i += 4) {
        out.data[i] = quant(out.data[i], n);
        out.data[i + 1] = quant(out.data[i + 1], n);
        out.data[i + 2] = quant(out.data[i + 2], n);
      }
      return out;
    },
  },
  {
    id: 'ordered-dither', name: 'Ordered Dither', category: 'Color',
    params: [range('levels', 'Levels', 2, 8, 2), range('matrix', 'Matrix', 4, 8, 4)],
    apply(src, p) {
      const { width: w, height: h, data } = src;
      const out = createImage(w, h), n = p.levels | 0, m = p.matrix >= 6 ? 8 : 4, mat = m === 8 ? BAYER8 : BAYER4;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const t = (mat[(y % m) * m + (x % m)] + 0.5) / (m * m) - 0.5;
        const i = (y * w + x) * 4;
        out.data[i] = quant(clamp(data[i] + t * (255 / n), 0, 255), n);
        out.data[i + 1] = quant(clamp(data[i + 1] + t * (255 / n), 0, 255), n);
        out.data[i + 2] = quant(clamp(data[i + 2] + t * (255 / n), 0, 255), n);
        out.data[i + 3] = data[i + 3];
      }
      return out;
    },
  },

  // ----- Pixel art / dither -----
  {
    id: 'bayer-dither', name: 'Bayer Dither', category: 'Pixel Art',
    params: [range('levels', 'Levels', 2, 8, 2), checkbox('mono', 'Monochrome', false)],
    apply(src, p) {
      const { width: w, height: h, data } = src;
      const out = createImage(w, h), n = p.levels | 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const t = (BAYER4[(y % 4) * 4 + (x % 4)] + 0.5) / 16 - 0.5;
        const i = (y * w + x) * 4;
        if (p.mono) {
          const L = lum(data[i], data[i + 1], data[i + 2]);
          const v = quant(clamp(L + t * (255 / n), 0, 255), n);
          out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
        } else {
          out.data[i] = quant(clamp(data[i] + t * (255 / n), 0, 255), n);
          out.data[i + 1] = quant(clamp(data[i + 1] + t * (255 / n), 0, 255), n);
          out.data[i + 2] = quant(clamp(data[i + 2] + t * (255 / n), 0, 255), n);
        }
        out.data[i + 3] = data[i + 3];
      }
      return out;
    },
  },
  {
    id: 'floyd-steinberg', name: 'Floyd–Steinberg', category: 'Pixel Art',
    params: [range('levels', 'Levels', 2, 8, 2), checkbox('mono', 'Monochrome', false)],
    apply(src, p) {
      const img = p.mono ? (() => {
        const g = cloneImage(src);
        for (let i = 0; i < g.data.length; i += 4) {
          const L = lum(g.data[i], g.data[i + 1], g.data[i + 2]);
          g.data[i] = g.data[i + 1] = g.data[i + 2] = L;
        }
        return g;
      })() : src;
      return errorDiffuse(img, p.levels, FS);
    },
  },
  {
    id: 'atkinson', name: 'Atkinson Dither', category: 'Pixel Art',
    params: [range('levels', 'Levels', 2, 8, 2), checkbox('mono', 'Monochrome', true)],
    apply(src, p) {
      const img = p.mono ? (() => {
        const g = cloneImage(src);
        for (let i = 0; i < g.data.length; i += 4) {
          const L = lum(g.data[i], g.data[i + 1], g.data[i + 2]);
          g.data[i] = g.data[i + 1] = g.data[i + 2] = L;
        }
        return g;
      })() : src;
      return errorDiffuse(img, p.levels, ATK);
    },
  },
  {
    id: 'pixel-downscale', name: 'Pixel Downscale', category: 'Pixel Art',
    params: [range('factor', 'Factor', 2, 16, 4)],
    apply(src, p) {
      const { width: w, height: h, data } = src;
      const out = createImage(w, h), f = Math.max(2, p.factor | 0);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = clamp((x / f | 0) * f, 0, w - 1), sy = clamp((y / f | 0) * f, 0, h - 1);
        put(out.data, w, x, y, at(data, w, sx, sy));
      }
      return out;
    },
  },
  {
    id: 'palette-reduce', name: 'Palette Reduce', category: 'Pixel Art',
    params: [range('colors', 'Colours', 2, 32, 8)],
    apply(src, p) {
      const out = cloneImage(src), bits = Math.max(1, Math.round(Math.log2(p.colors)));
      const n = 1 << Math.min(4, bits);
      for (let i = 0; i < out.data.length; i += 4) {
        out.data[i] = quant(out.data[i], n);
        out.data[i + 1] = quant(out.data[i + 1], n);
        out.data[i + 2] = quant(out.data[i + 2], n);
      }
      return out;
    },
  },
];
