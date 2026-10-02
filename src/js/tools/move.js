// Move Selected Pixels and Move Selection.
//
// Both tools lift content on the first drag and then *float* it: releasing the mouse parks it in
// place rather than baking it into the layer, so you can keep nudging it with further drags, and
// it can safely go off-canvas and back without losing anything. Nothing is written to the
// document/history until it's explicitly set down — Enter (or starting any other action, which
// goes through Editor#commitPending), or a right-click on the canvas the way the text tool works.
// Escape (tool.cancel) reverts it to exactly how things were before you picked it up.
import { cloneImage, cropImage, stampImage } from '../core/image.js';
import { translateMask } from '../core/mask.js';
import { rectUnion, rectIntersect } from '../core/util.js';
import { targetRegion } from '../doc/ops.js';
import { paintImage } from '../doc/raster.js';
import { layerRect } from './common.js';

function movePixels() {
  let S = null;

  /** Redraw at absolute offset (ox,oy) from the lift point: put the background back, then paint. */
  const render = (s, ox, oy) => {
    const nr = { x: s.r.x + ox, y: s.r.y + oy, w: s.r.w, h: s.r.h };
    const area = rectUnion(s.cur, nr);
    stampImage(s.layer.img, cropImage(s.base, area), area.x, area.y);
    paintImage(s.layer.img, s.lifted, nr.x, nr.y);
    s.layer.touch(area);
    s.cur = nr;
    s.total = rectUnion(s.total, nr);
  };

  /** Undo everything back to the pristine, pre-lift layer. Leaves S cleared. */
  const revert = (ed) => {
    const s = S;
    S = null;
    stampImage(s.layer.img, cropImage(s.base, s.cur), s.cur.x, s.cur.y);
    stampImage(s.layer.img, s.before, s.r.x, s.r.y);
    s.layer.touch(s.total);
    if (ed) { ed.marchOffset = null; ed.requestOverlay(); }
  };

  /** Write the floated content into the document as one undo step. Leaves S cleared. */
  const settle = (ed) => {
    const s = S;
    S = null;
    ed.marchOffset = null;
    ed.requestOverlay();
    if (!s.ox && !s.oy) { // ended up back where it started (however many drags it took): not a step
      stampImage(s.layer.img, cropImage(s.base, s.cur), s.cur.x, s.cur.y);
      stampImage(s.layer.img, s.before, s.r.x, s.r.y);
      s.layer.touch(s.total);
      return;
    }
    const total = rectIntersect(s.total, layerRect(s.layer));
    const original = cropImage(s.base, total); // the layer before any of this = base + the lifted pixels
    stampImage(original, s.before, s.r.x - total.x, s.r.y - total.y);
    ed.doc.transaction('Move Selected Pixels', () => {
      ed.doc.commitRegion(s.layer, total, original, 'Move Selected Pixels');
      if (s.mask) ed.doc.setSelection(translateMask(s.mask, s.ox, s.oy), 'Move Selection');
    });
  };

  return {
    id: 'move-pixels', name: 'Move Selected Pixels', key: 'M', group: 'move', cursor: 'move', options: [],
    down(e, ed) {
      if (S) { // already floating from an earlier drag: keep going, don't re-lift
        if (e.button === 2) { settle(ed); return; }
        S.dragging = { x0: e.x, y0: e.y };
        return;
      }
      if (e.button === 2) return;
      const layer = ed.editableLayer();
      if (!layer) return;
      const doc = ed.doc, r = targetRegion(doc);
      if (!r) return;
      const mask = doc.selection, w = doc.width;
      const before = cropImage(layer.img, r);
      const lifted = cloneImage(before);
      const base = cloneImage(layer.img);
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const m = mask ? mask.data[(r.y + y) * w + r.x + x] : 255;
          if (m === 255) { base.data[((r.y + y) * w + r.x + x) * 4 + 3] = 0; continue; }
          const li = (y * r.w + x) * 4, bi = ((r.y + y) * w + r.x + x) * 4;
          lifted.data[li + 3] = (lifted.data[li + 3] * m) / 255;
          base.data[bi + 3] = (base.data[bi + 3] * (255 - m)) / 255;
        }
      }
      S = {
        layer, r, mask, before, lifted, base,
        ox: 0, oy: 0, cur: r, total: r,
        dragging: { x0: e.x, y0: e.y },
      };
    },
    move(e, ed) {
      if (!S?.dragging) return;
      const ox = S.ox + Math.round(e.x - S.dragging.x0), oy = S.oy + Math.round(e.y - S.dragging.y0);
      if (ox === S.cur.x - S.r.x && oy === S.cur.y - S.r.y) return;
      render(S, ox, oy);
      ed.marchOffset = { dx: ox, dy: oy };
      ed.requestOverlay();
    },
    up(e, ed) {
      if (!S?.dragging) return;
      S.ox += Math.round(e.x - S.dragging.x0);
      S.oy += Math.round(e.y - S.dragging.y0);
      S.dragging = null;
      // Stay floating — parked here until Enter/right-click sets it down or Escape cancels it —
      // so it can be picked up again (even after going off-canvas) without losing anything.
    },
    deactivate(ed) { if (S) settle(ed); },
    cancel(ed) { if (S) revert(ed); },
  };
}

function moveSelection() {
  let S = null;

  const settle = (ed) => {
    const s = S;
    S = null;
    ed.marchOffset = null;
    ed.requestOverlay();
    if (s.ox || s.oy) ed.doc.setSelection(translateMask(s.mask, s.ox, s.oy), 'Move Selection');
  };
  const revert = (ed) => { S = null; ed.marchOffset = null; ed.requestOverlay(); };

  return {
    id: 'move-selection', name: 'Move Selection', key: 'M', group: 'move', cursor: 'move', options: [],
    down(e, ed) {
      if (S) { if (e.button === 2) { settle(ed); return; } S.dragging = { x0: e.x, y0: e.y }; return; }
      if (e.button === 2 || !ed.doc.selection) return;
      S = { mask: ed.doc.selection, ox: 0, oy: 0, dragging: { x0: e.x, y0: e.y } };
    },
    move(e, ed) {
      if (!S?.dragging) return;
      const ox = S.ox + Math.round(e.x - S.dragging.x0), oy = S.oy + Math.round(e.y - S.dragging.y0);
      ed.marchOffset = { dx: ox, dy: oy };
      ed.requestOverlay();
    },
    up(e, ed) {
      if (!S?.dragging) return;
      S.ox += Math.round(e.x - S.dragging.x0);
      S.oy += Math.round(e.y - S.dragging.y0);
      S.dragging = null;
      // Parked, not yet written to the selection — Enter/right-click/Escape decide what happens.
    },
    deactivate(ed) { if (S) settle(ed); },
    cancel(ed) { if (S) revert(ed); },
  };
}

export const moveTools = () => [movePixels(), moveSelection()];
