// Move Selected Pixels and Move Selection.
import { cloneImage, cropImage, stampImage } from '../core/image.js';
import { translateMask } from '../core/mask.js';
import { rectUnion, rectIntersect } from '../core/util.js';
import { targetRegion } from '../doc/ops.js';
import { paintImage } from '../doc/raster.js';
import { layerRect } from './common.js';

function movePixels() {
  let S = null;

  /** Redraw: put back the layer without the lifted pixels, then paint them at the new offset. */
  const render = (s) => {
    const nr = { x: s.r.x + s.dx, y: s.r.y + s.dy, w: s.r.w, h: s.r.h };
    const area = rectUnion(s.cur, nr);
    stampImage(s.layer.img, cropImage(s.base, area), area.x, area.y);
    paintImage(s.layer.img, s.lifted, nr.x, nr.y);
    s.layer.touch(area);
    s.cur = nr;
    s.total = rectUnion(s.total, nr);
  };

  return {
    id: 'move-pixels', name: 'Move Selected Pixels', key: 'M', group: 'move', cursor: 'move', options: [],
    down(e, ed) {
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
      S = { layer, r, mask, before, lifted, base, x0: e.x, y0: e.y, dx: 0, dy: 0, cur: r, total: r, moved: false };
    },
    move(e, ed) {
      if (!S) return;
      const dx = Math.round(e.x - S.x0), dy = Math.round(e.y - S.y0);
      if (dx === S.dx && dy === S.dy) return;
      S.dx = dx; S.dy = dy; S.moved = true;
      render(S);
      ed.marchOffset = { dx, dy };
      ed.requestOverlay();
    },
    up(e, ed) {
      if (!S) return;
      const s = S;
      S = null;
      ed.marchOffset = null;
      ed.requestOverlay();
      if (!s.moved || (!s.dx && !s.dy)) { // nothing really moved: put it all back
        stampImage(s.layer.img, cropImage(s.base, s.cur), s.cur.x, s.cur.y);
        stampImage(s.layer.img, s.before, s.r.x, s.r.y);
        s.layer.touch(s.total);
        return;
      }
      const total = rectIntersect(s.total, layerRect(s.layer));
      const original = cropImage(s.base, total); // the layer before the drag = base + the lifted pixels
      stampImage(original, s.before, s.r.x - total.x, s.r.y - total.y);
      ed.doc.transaction('Move Selected Pixels', () => {
        ed.doc.commitRegion(s.layer, total, original, 'Move Selected Pixels');
        if (s.mask) ed.doc.setSelection(translateMask(s.mask, s.dx, s.dy), 'Move Selection');
      });
    },
    cancel(ed) {
      if (!S) return;
      const s = S;
      S = null;
      stampImage(s.layer.img, cropImage(s.base, s.cur), s.cur.x, s.cur.y);
      stampImage(s.layer.img, s.before, s.r.x, s.r.y);
      s.layer.touch(s.total);
      if (ed) { ed.marchOffset = null; ed.requestOverlay(); }
    },
  };
}

function moveSelection() {
  let S = null;
  return {
    id: 'move-selection', name: 'Move Selection', key: 'M', group: 'move', cursor: 'move', options: [],
    down(e, ed) { if (ed.doc.selection) S = { mask: ed.doc.selection, x0: e.x, y0: e.y, dx: 0, dy: 0 }; },
    move(e, ed) {
      if (!S) return;
      S.dx = Math.round(e.x - S.x0);
      S.dy = Math.round(e.y - S.y0);
      ed.marchOffset = { dx: S.dx, dy: S.dy };
      ed.requestOverlay();
    },
    up(e, ed) {
      if (!S) return;
      const s = S;
      S = null;
      ed.marchOffset = null;
      ed.requestOverlay();
      if (s.dx || s.dy) ed.doc.setSelection(translateMask(s.mask, s.dx, s.dy), 'Move Selection');
    },
    cancel(ed) { S = null; if (ed) { ed.marchOffset = null; ed.requestOverlay(); } },
  };
}

export const moveTools = () => [movePixels(), moveSelection()];
