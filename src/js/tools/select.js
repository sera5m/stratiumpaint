// Selection tools: rectangle, ellipse, lasso, magic wand.
import { rectMask, ellipseMask, polygonMask, combineMasks } from '../core/mask.js';
import { floodMask } from '../core/flood.js';
import { dashedStroke } from './common.js';

/** Ctrl = add, Alt = subtract, Ctrl+Alt = intersect, right button = xor; otherwise the toolbar mode. */
function modeFor(ed, e) {
  if (e.ctrl && e.alt) return 'intersect';
  if (e.ctrl) return 'union';
  if (e.alt) return 'subtract';
  if (e.button === 2) return 'xor';
  return ed.opts.selMode;
}

/** Corner points of a drag; Shift makes it square. */
function box(s) {
  const x0 = Math.round(s.x0), y0 = Math.round(s.y0);
  let x1 = Math.round(s.x1), y1 = Math.round(s.y1);
  if (s.shift) {
    const dx = x1 - x0, dy = y1 - y0, d = Math.max(Math.abs(dx), Math.abs(dy));
    x1 = x0 + (dx < 0 ? -d : d);
    y1 = y0 + (dy < 0 ? -d : d);
  }
  return [x0, y0, x1, y1];
}

function boxSelect(id, name, shape, key) {
  let S = null;
  return {
    id, name, key, group: 'select', cursor: 'crosshair', options: ['selMode'],
    down(e, ed) { S = { x0: e.x, y0: e.y, x1: e.x, y1: e.y, mode: modeFor(ed, e), shift: e.shift }; },
    move(e, ed) {
      if (!S) return;
      S.x1 = e.x; S.y1 = e.y; S.shift = e.shift;
      ed.requestOverlay();
    },
    up(e, ed) {
      if (!S) return;
      const s = S;
      S = null;
      ed.requestOverlay();
      const [x0, y0, x1, y1] = box(s), doc = ed.doc;
      if (x0 === x1 || y0 === y1) { // a click without a drag clears the selection
        if (s.mode === 'replace') doc.deselect();
        return;
      }
      const m = (shape === 'rect' ? rectMask : ellipseMask)(doc.width, doc.height, x0, y0, x1, y1);
      doc.setSelection(combineMasks(doc.selection, m, s.mode), name);
    },
    cancel(ed) { S = null; ed?.requestOverlay(); },
    overlay(ctx, ed, v) {
      if (!S) return;
      const [x0, y0, x1, y1] = box(S);
      const a = v.toScreen(Math.min(x0, x1), Math.min(y0, y1)), b = v.toScreen(Math.max(x0, x1), Math.max(y0, y1));
      dashedStroke(ctx, () => {
        if (shape === 'rect') ctx.rect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
        else ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      });
    },
  };
}

function lasso() {
  let S = null;
  return {
    id: 'lasso', name: 'Lasso Select', key: 'S', group: 'select', cursor: 'crosshair', options: ['selMode'],
    down(e, ed) { S = { pts: [{ x: e.x, y: e.y }], mode: modeFor(ed, e) }; },
    move(e, ed) {
      if (!S) return;
      const last = S.pts[S.pts.length - 1];
      if (Math.hypot(e.x - last.x, e.y - last.y) < 0.75) return;
      S.pts.push({ x: e.x, y: e.y });
      ed.requestOverlay();
    },
    up(e, ed) {
      if (!S) return;
      const s = S;
      S = null;
      ed.requestOverlay();
      const doc = ed.doc;
      if (s.pts.length < 3) { if (s.mode === 'replace') doc.deselect(); return; }
      doc.setSelection(combineMasks(doc.selection, polygonMask(doc.width, doc.height, s.pts), s.mode), 'Lasso Select');
    },
    cancel(ed) { S = null; ed?.requestOverlay(); },
    overlay(ctx, ed, v) {
      if (!S || S.pts.length < 2) return;
      dashedStroke(ctx, () => {
        S.pts.forEach((p, i) => { const q = v.toScreen(p.x, p.y); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
        ctx.closePath();
      });
    },
  };
}

function magicWand() {
  return {
    id: 'wand', name: 'Magic Wand', key: 'S', group: 'select', cursor: 'crosshair',
    options: ['selMode', 'tolerance', 'flood', 'sampling'],
    down(e, ed) {
      const doc = ed.doc, x = Math.floor(e.x), y = Math.floor(e.y);
      if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
      const img = ed.opts.sampling === 'image' ? doc.compositeImage() : doc.layer.img;
      const m = floodMask(img, x, y, ed.opts.tolerance, ed.opts.flood === 'contiguous');
      doc.setSelection(combineMasks(doc.selection, m, modeFor(ed, e)), 'Magic Wand');
    },
  };
}

export const selectionTools = () => [
  boxSelect('rect-select', 'Rectangle Select', 'rect', 'S'),
  boxSelect('ellipse-select', 'Ellipse Select', 'ellipse', 'S'),
  lasso(),
  magicWand(),
];
