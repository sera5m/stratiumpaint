// Paintbrush, pencil, eraser and clone stamp. They share one stroke engine.
//
// A stroke keeps the layer as it was (`orig`) and a coverage plane (`cov`). Each stamp raises
// coverage with max(), and pixels are recomputed from `orig` + coverage, so overlapping dabs inside
// one stroke never build up beyond the chosen opacity (same as Paint.NET).
//
// Both live in 64×64 tiles that are made the first time a dab reaches them, so starting a stroke
// copies nothing and a stroke costs memory and time only where it paints (the old engine copied
// the whole layer and zeroed a full coverage plane on every mouse-down).
import { createImage, blendPixel } from '../core/image.js';
import { maskBounds } from '../core/mask.js';
import { clamp, rectUnion } from '../core/util.js';
import { colorFor } from './common.js';

const TS = 6, T = 1 << TS, TM = T - 1; // tile size 64

/** Work counters for tests and benchmarks. */
export const brushStats = { strokes: 0, dabs: 0, backupPixels: 0, touches: 0, maskHits: 0, startCopied: 0 };

/** 0..1 coverage of a dab of radius r at distance d from its centre. */
export function coverage(d, r, hardness, aa, falloff = 'linear') {
  if (falloff === 'hard' || hardness >= 0.999) return aa ? clamp(r + 0.5 - d, 0, 1) : d <= r ? 1 : 0;
  if (d >= r) return 0;
  const t = d / r;
  if (falloff === 'gaussian') {
    const sigma = 0.28 + (1 - hardness) * 0.22;
    return Math.exp(-0.5 * (t / sigma) ** 2);
  }
  if (falloff === 'smooth') {
    const inner = hardness;
    if (t <= inner) return 1;
    const u = (t - inner) / Math.max(1e-4, 1 - inner);
    return 1 - u * u * (3 - 2 * u);
  }
  if (falloff === 'airbrush') return Math.exp(-2.4 * t * t) * (1 - t * 0.35);
  const inner = r * hardness;
  if (d <= inner) return 1;
  return (r - d) / (r - inner);
}


/**
 * coverage() specialised for one stroke: the same arithmetic (so the same bytes), without the
 * per-pixel option checks. Returns d → 0..1.
 */
export function coverageFn(r, hardness, aa, falloff = 'linear') {
  if (falloff === 'hard' || hardness >= 0.999) return aa ? (d) => clamp(r + 0.5 - d, 0, 1) : (d) => (d <= r ? 1 : 0);
  if (falloff === 'gaussian') {
    const sigma = 0.28 + (1 - hardness) * 0.22;
    return (d) => { if (d >= r) return 0; const t = d / r; return Math.exp(-0.5 * (t / sigma) ** 2); };
  }
  if (falloff === 'smooth') {
    const inner = hardness, span = Math.max(1e-4, 1 - inner);
    return (d) => { if (d >= r) return 0; const t = d / r; if (t <= inner) return 1; const u = (t - inner) / span; return 1 - u * u * (3 - 2 * u); };
  }
  if (falloff === 'airbrush') return (d) => { if (d >= r) return 0; const t = d / r; return Math.exp(-2.4 * t * t) * (1 - t * 0.35); };
  const inner = r * hardness;
  return (d) => { if (d >= r) return 0; if (d <= inner) return 1; return (r - d) / (r - inner); };
}

function mirrorPoints(x, y, mode, cx, cy) {
  const pts = [[x, y]];
  const hx = 2 * cx - x, vy = 2 * cy - y;
  if (mode === 'h' || mode === 'both') pts.push([hx, y]);
  if (mode === 'v' || mode === 'both') pts.push([x, vy]);
  if (mode === 'both') pts.push([hx, vy]);
  if (mode === 'radial4' || mode === 'radial8') {
    const n = mode === 'radial8' ? 8 : 4;
    const dx = x - cx, dy = y - cy;
    for (let k = 1; k < n; k++) {
      const a = (k / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      pts.push([cx + dx * c - dy * s, cy + dx * s + dy * c]);
    }
  }
  return pts;
}

function expandPoints(x, y, S) {
  const base = [[x, y]];
  const rx = S.repeatX | 0, ry = S.repeatY | 0, n = Math.max(1, S.repeatN | 0);
  if ((rx || ry) && n > 1) {
    base.length = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) base.push([x + i * rx, y + j * ry]);
  }
  if (!S.mirror || S.mirror === 'none') return base;
  const out = [];
  for (const [px, py] of base) out.push(...mirrorPoints(px, py, S.mirror, S.cx, S.cy));
  return out;
}

function stampMany(S, x, y) {
  for (const [px, py] of expandPoints(x, y, S)) stamp(S, px, py);
}

/** Make the backup + coverage tiles for pixel box [x0..x1]×[y0..y1] (inclusive). */
function ensureTiles(S, x0, y0, x1, y1) {
  const { layer, tiles, covT, ntx } = S, w = layer.width, h = layer.height, d = layer.img.data;
  for (let ty = y0 >> TS; ty <= y1 >> TS; ty++) {
    for (let tx = x0 >> TS; tx <= x1 >> TS; tx++) {
      const k = ty * ntx + tx;
      if (tiles[k]) continue;
      const tw = Math.min(T, w - (tx << TS)), th = Math.min(T, h - (ty << TS));
      const t = new Uint8ClampedArray(T * T * 4);
      for (let yy = 0; yy < th; yy++) {
        const src = (((ty << TS) + yy) * w + (tx << TS)) * 4;
        t.set(d.subarray(src, src + tw * 4), yy * T * 4);
      }
      tiles[k] = t;
      covT[k] = new Uint8Array(T * T);
      brushStats.backupPixels += tw * th;
    }
  }
}

/** Coverage bytes of a dab centred on the half-pixel grid over its (unclipped) box, cached per stroke. */
function dabMask(S, cx, cy, ux0, uy0, mw, mh) {
  // Exact-reuse only when cx, cy are multiples of 0.5: then (x + 0.5 - cx) is exact for every
  // pixel and the bytes cannot depend on where the dab is.
  const key = `${cx - ux0}|${cy - uy0}`;
  const hit = S.masks.get(key);
  if (hit) { brushStats.maskHits++; return hit; }
  const m = new Uint8Array(mw * mh);
  const cov = S.cov, R2 = (S.r + 0.5) * (S.r + 0.5) * (1 + 1e-9);
  for (let j = 0; j < mh; j++) {
    const dy = uy0 + j + 0.5 - cy, dy2 = dy * dy, row = j * mw;
    for (let i = 0; i < mw; i++) {
      const dx = ux0 + i + 0.5 - cx, d2 = dx * dx + dy2;
      // Beyond r + 0.5 every falloff is 0 (the antialiased hard edge ends there), skip the sqrt.
      m[row + i] = d2 >= R2 ? 0 : Math.round(cov(Math.sqrt(d2)) * 255);
    }
  }
  if (S.masks.size > 64) S.masks.clear();
  S.masks.set(key, m);
  return m;
}

function stamp(S, cx, cy) {
  const { layer, tiles, covT, ntx, mask, r, mode } = S;
  const w = layer.width, h = layer.height, d = layer.img.data;
  const ux0 = Math.floor(cx - r - 1), ux1 = Math.ceil(cx + r + 1), uy0 = Math.floor(cy - r - 1), uy1 = Math.ceil(cy + r + 1);
  const x0 = Math.max(0, ux0), x1 = Math.min(w - 1, ux1), y0 = Math.max(0, uy0), y1 = Math.min(h - 1, uy1);
  if (x1 < x0 || y1 < y0) return;
  brushStats.dabs++;
  ensureTiles(S, x0, y0, x1, y1);
  const mw = ux1 - ux0 + 1, mh = uy1 - uy0 + 1;
  // On the half-pixel grid (pencil, snapped strokes) the dab's bytes repeat: use a cached mask.
  const m = Number.isInteger(cx * 2) && Number.isInteger(cy * 2) ? dabMask(S, cx, cy, ux0, uy0, mw, mh) : null;
  const cov = S.cov, R2 = (r + 0.5) * (r + 0.5) * (1 + 1e-9);
  const md = mask ? mask.data : null, alpha = S.alpha, clone = mode === 'clone', erase = mode === 'erase';
  const { r: cr, g: cg, b: cb } = S.color;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy, dy2 = dy * dy;
    if (!m && dy2 >= R2) continue; // whole row outside the dab
    const mrow = (y - uy0) * mw - ux0, trow = (y >> TS) * ntx, toff = (y & TM) << TS;
    // Walk the row one tile at a time so the tile lookups happen per span, not per pixel.
    for (let x = x0; x <= x1;) {
      const tx = x >> TS, xe = Math.min(x1, (tx << TS) | TM), k = trow + tx, ct = covT[k], ot = tiles[k];
      let o = toff | (x & TM), i = y * w + x;
      for (; x <= xe; x++, o++, i++) {
        let c;
        if (m) c = m[mrow + x];
        else { const dx = x + 0.5 - cx, d2 = dx * dx + dy2; c = d2 >= R2 ? 0 : Math.round(cov(Math.sqrt(d2)) * 255); }
        if (!c || c <= ct[o]) continue;
        ct[o] = c;
        const sel = md ? md[i] : 255;
        if (!sel) continue;
        const a = (c / 255) * (sel / 255) * alpha, j = i * 4, q = o * 4;
        d[j] = ot[q]; d[j + 1] = ot[q + 1]; d[j + 2] = ot[q + 2]; d[j + 3] = ot[q + 3];
        if (erase) {
          d[j + 3] = ot[q + 3] * (1 - a);
        } else if (clone) {
          const sx = x + S.ox, sy = y + S.oy;
          if (sx >= 0 && sy >= 0 && sx < w && sy < h) {
            // The source as it was: its backup tile if this stroke has touched it, else the layer.
            const st = tiles[(sy >> TS) * ntx + (sx >> TS)];
            let src, p;
            if (st) { src = st; p = (((sy & TM) << TS) | (sx & TM)) * 4; } else { src = d; p = (sy * w + sx) * 4; }
            blendPixel(d, j, src[p], src[p + 1], src[p + 2], (src[p + 3] / 255) * a);
          }
        } else {
          blendPixel(d, j, cr, cg, cb, a);
        }
      }
    }
  }
  const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  S.dirty = rectUnion(S.dirty, box);
  S.pending = rectUnion(S.pending, box);
}

/** One layer update (and so one redraw request) per pointer event, not per dab. */
function flush(S) {
  if (!S.pending) return;
  brushStats.touches++;
  const p = S.pending;
  S.pending = null;
  S.layer.touch(p);
}

/** The stroke's painted tiles as history patches (their backups are the "before" pixels, no copy). */
function strokePatches(S) {
  const w = S.layer.width, h = S.layer.height, out = [];
  S.tiles.forEach((t, k) => {
    if (!t) return;
    const tx = k % S.ntx, ty = (k / S.ntx) | 0;
    out.push({ x: tx << TS, y: ty << TS, w: Math.min(T, w - (tx << TS)), h: Math.min(T, h - (ty << TS)), stride: T, before: t });
  });
  return out;
}

/** The layer as it was before the stroke, over rect r (backup tiles where painted, else the layer). */
function originalRegion(S, r) {
  const out = createImage(r.w, r.h), w = S.layer.width, d = S.layer.img.data;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w;) {
      const tx = x >> TS, end = Math.min(r.x + r.w, (tx + 1) << TS), t = S.tiles[(y >> TS) * S.ntx + tx];
      const dst = ((y - r.y) * r.w + (x - r.x)) * 4;
      if (t) { const s0 = (((y & TM) << TS) | (x & TM)) * 4; out.data.set(t.subarray(s0, s0 + (end - x) * 4), dst); }
      else { const s0 = (y * w + x) * 4; out.data.set(d.subarray(s0, s0 + (end - x) * 4), dst); }
      x = end;
    }
  }
  return out;
}

function strokeTo(S, x, y) {
  const dx = x - S.lx, dy = y - S.ly, len = Math.hypot(dx, dy);
  if (len === 0) return;
  let t = S.rem;
  while (t <= len) {
    const px = S.lx + (dx * t) / len, py = S.ly + (dy * t) / len;
    if (S.snap) stampMany(S, Math.floor(px) + 0.5, Math.floor(py) + 0.5);
    else stampMany(S, px, py);
    t += S.step;
  }
  S.rem = t - len;
  S.lx = x; S.ly = y;
  // the spacing loop can stop up to one step short of the pointer: always finish exactly under it
  if (S.snap) stampMany(S, Math.floor(x) + 0.5, Math.floor(y) + 0.5);
  else stampMany(S, x, y);
}

/**
 * kind: 'brush' | 'pencil' | 'eraser' | 'clone'
 * The pencil is always 1px, hard and unantialiased; the others use the toolbar options.
 */
function makeBrush({ id, name, kind, key, icon }) {
  let S = null;
  let source = null; // clone stamp source point

  const begin = (e, ed) => {
    const layer = ed.editableLayer();
    if (!layer) return null;
    const o = ed.opts, pencil = kind === 'pencil';
    const size = pencil ? 1 : o.size;
    const color = colorFor(ed, e);
    const r = size / 2, hardness = pencil ? 1 : o.hardness / 100, aa = pencil ? false : o.aa, falloff = pencil ? 'hard' : (o.falloff || 'linear');
    const ntx = Math.ceil(layer.width / T), nty = Math.ceil(layer.height / T);
    brushStats.strokes++;
    return {
      layer, mode: kind === 'eraser' ? 'erase' : kind === 'clone' ? 'clone' : 'paint',
      ntx, tiles: new Array(ntx * nty).fill(null), covT: new Array(ntx * nty).fill(null),
      cov: coverageFn(r, hardness, aa, falloff), masks: new Map(), pending: null,
      mask: ed.surface().selection,
      r, hardness, aa, falloff,
      step: pencil ? 1 : Math.max(1, size * 0.1), snap: pencil,
      alpha: (o.opacity / 100) * (kind === 'eraser' || kind === 'clone' ? 1 : color.a ?? 1), color,
      dirty: null, lx: e.x, ly: e.y, rem: 0, ox: 0, oy: 0,
      mirror: o.mirror || 'none', repeatX: o.repeatX || 0, repeatY: o.repeatY || 0, repeatN: o.repeatN || 1,
      cx: 0, cy: 0,
    };
  };

  return {
    id, name, key, icon, group: kind === 'pencil' ? 'pencil' : 'brush', cursor: 'crosshair', ring: kind !== 'pencil',
    options: kind === 'pencil' ? ['opacity', 'mirror', 'repeatX', 'repeatY', 'repeatN'] : ['size', 'hardness', 'opacity', 'aa', 'mirror', 'repeatX', 'repeatY', 'repeatN'],

    down(e, ed) {
      if (kind === 'clone' && e.ctrl) {
        source = { x: e.x, y: e.y };
        ed.toast('Clone source set. Drag to paint from it.');
        ed.requestOverlay();
        return;
      }
      if (kind === 'clone' && !source) { ed.toast('Ctrl+click first to choose what to copy from.'); return; }
      S = begin(e, ed);
      if (!S) return;
      const b = ed.doc.selection && maskBounds(ed.doc.selection);
      S.cx = b ? b.x + b.w / 2 : ed.doc.width / 2;
      S.cy = b ? b.y + b.h / 2 : ed.doc.height / 2;
      if (kind === 'clone') { S.ox = Math.round(source.x - e.x); S.oy = Math.round(source.y - e.y); }
      if (S.snap) stampMany(S, Math.floor(e.x) + 0.5, Math.floor(e.y) + 0.5);
      else stampMany(S, e.x, e.y);
      S.rem = S.step;
      flush(S);
    },

    move(e, ed) {
      if (!S) return;
      strokeTo(S, e.x, e.y);
      flush(S);
      if (kind === 'clone') ed.requestOverlay();
    },

    up(e, ed) {
      if (!S) return;
      const s = S;
      S = null;
      flush(s);
      if (!s.dirty) return;
      const surf = ed.surface();
      if (surf.commitPatches) surf.commitPatches(s.layer, strokePatches(s), name); // only the painted tiles
      else surf.commitRegion(s.layer, s.dirty, originalRegion(s, s.dirty), name);
    },

    cancel() {
      if (!S) return;
      const s = S;
      S = null;
      if (s.dirty) { // put the layer back exactly as it was (only the tiles the stroke reached)
        const w = s.layer.width, h = s.layer.height, d = s.layer.img.data;
        s.tiles.forEach((t, k) => {
          if (!t) return;
          const tx = k % s.ntx, ty = (k / s.ntx) | 0, tw = Math.min(T, w - (tx << TS)), th = Math.min(T, h - (ty << TS));
          for (let yy = 0; yy < th; yy++) d.set(t.subarray(yy * T * 4, (yy * T + tw) * 4), (((ty << TS) + yy) * w + (tx << TS)) * 4);
        });
        s.layer.touch(s.dirty);
      }
    },

    overlay(ctx, ed, v) {
      if (kind === 'clone' && source) {
        const p = v.toScreen(source.x, source.y);
        ctx.save();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(p.x - 7, p.y); ctx.lineTo(p.x + 7, p.y); ctx.moveTo(p.x, p.y - 7); ctx.lineTo(p.x, p.y + 7); ctx.stroke();
        ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      }
    },
  };
}

export const brushTools = () => [
  makeBrush({ id: 'brush', name: 'Paintbrush', kind: 'brush', key: 'B' }),
  makeBrush({ id: 'pencil', name: 'Pencil', kind: 'pencil', key: 'P' }),
  makeBrush({ id: 'eraser', name: 'Eraser', kind: 'eraser', key: 'E' }),
  makeBrush({ id: 'clone', name: 'Clone Stamp', kind: 'clone', key: 'L' }),
];
