// Paintbrush, pencil, eraser and clone stamp. They share one stroke engine.
//
// A stroke keeps a copy of the layer as it was (`orig`) and a coverage plane (`cov`). Each stamp
// raises coverage with max(), and pixels are recomputed from `orig` + coverage, so overlapping
// dabs inside one stroke never build up beyond the chosen opacity (same as Paint.NET).
import { cloneImage, cropImage, blendPixel } from '../core/image.js';
import { clamp, rectUnion } from '../core/util.js';
import { colorFor } from './common.js';

/** 0..1 coverage of a dab of radius r at distance d from its centre. */
export function coverage(d, r, hardness, aa) {
  if (hardness >= 0.999) return aa ? clamp(r + 0.5 - d, 0, 1) : d <= r ? 1 : 0;
  const inner = r * hardness;
  if (d <= inner) return 1;
  if (d >= r) return 0;
  return (r - d) / (r - inner);
}

function stamp(S, cx, cy) {
  const { layer, orig, cov, mask, r, hardness, aa, mode } = S;
  const w = layer.width, h = layer.height, d = layer.img.data, od = orig.data;
  const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(w - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(h - 1, Math.ceil(cy + r + 1));
  if (x1 < x0 || y1 < y0) return;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const c = Math.round(coverage(Math.sqrt(dx * dx + dy * dy), r, hardness, aa) * 255);
      const i = y * w + x;
      if (c <= cov[i]) continue;
      cov[i] = c;
      const sel = mask ? mask.data[i] : 255;
      if (!sel) continue;
      const a = (c / 255) * (sel / 255) * S.alpha, j = i * 4;
      d[j] = od[j]; d[j + 1] = od[j + 1]; d[j + 2] = od[j + 2]; d[j + 3] = od[j + 3];
      if (mode === 'erase') {
        d[j + 3] = od[j + 3] * (1 - a);
      } else if (mode === 'clone') {
        const sx = x + S.ox, sy = y + S.oy;
        if (sx >= 0 && sy >= 0 && sx < w && sy < h) {
          const k = (sy * w + sx) * 4;
          blendPixel(d, j, od[k], od[k + 1], od[k + 2], (od[k + 3] / 255) * a);
        }
      } else {
        blendPixel(d, j, S.color.r, S.color.g, S.color.b, a);
      }
    }
  }
  const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  S.dirty = rectUnion(S.dirty, box);
  layer.touch(box);
}

function strokeTo(S, x, y) {
  const dx = x - S.lx, dy = y - S.ly, len = Math.hypot(dx, dy);
  if (len === 0) return;
  let t = S.rem;
  while (t <= len) {
    const px = S.lx + (dx * t) / len, py = S.ly + (dy * t) / len;
    if (S.snap) stamp(S, Math.floor(px) + 0.5, Math.floor(py) + 0.5);
    else stamp(S, px, py);
    t += S.step;
  }
  S.rem = t - len;
  S.lx = x; S.ly = y;
  // the spacing loop can stop up to one step short of the pointer: always finish exactly under it
  if (S.snap) stamp(S, Math.floor(x) + 0.5, Math.floor(y) + 0.5);
  else stamp(S, x, y);
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
    return {
      layer, mode: kind === 'eraser' ? 'erase' : kind === 'clone' ? 'clone' : 'paint',
      orig: cloneImage(layer.img), cov: new Uint8Array(layer.width * layer.height), mask: ed.surface().selection,
      r: size / 2, hardness: pencil ? 1 : o.hardness / 100, aa: pencil ? false : o.aa,
      step: pencil ? 1 : Math.max(1, size * 0.1), snap: pencil,
      alpha: (o.opacity / 100) * (kind === 'eraser' || kind === 'clone' ? 1 : color.a ?? 1), color,
      dirty: null, lx: e.x, ly: e.y, rem: 0, ox: 0, oy: 0,
    };
  };

  return {
    id, name, key, icon, group: kind === 'pencil' ? 'pencil' : 'brush', cursor: 'crosshair', ring: kind !== 'pencil',
    options: kind === 'pencil' ? ['opacity'] : ['size', 'hardness', 'opacity', 'aa'],

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
      if (kind === 'clone') { S.ox = Math.round(source.x - e.x); S.oy = Math.round(source.y - e.y); }
      if (S.snap) stamp(S, Math.floor(e.x) + 0.5, Math.floor(e.y) + 0.5);
      else stamp(S, e.x, e.y);
      S.rem = S.step;
    },

    move(e, ed) {
      if (!S) return;
      strokeTo(S, e.x, e.y);
      if (kind === 'clone') ed.requestOverlay();
    },

    up(e, ed) {
      if (!S) return;
      const s = S;
      S = null;
      if (s.dirty) ed.surface().commitRegion(s.layer, s.dirty, cropImage(s.orig, s.dirty), name);
    },

    cancel() {
      if (!S) return;
      const s = S;
      S = null;
      if (s.dirty) { // put the layer back exactly as it was
        s.layer.img.data.set(s.orig.data);
        s.layer.touch();
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
