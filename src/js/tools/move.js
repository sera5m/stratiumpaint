// Move Selected Pixels and Move Selection.
//
// Both tools lift content on the first drag and then *float* it: releasing the mouse parks it in
// place rather than baking it into the layer, so you can keep nudging it with further drags, and
// it can safely go off-canvas and back without losing anything. Nothing is written to the
// document/history until it's explicitly set down — Enter (or starting any other action, which
// goes through Editor#commitPending), or a right-click on the canvas the way the text tool works.
// Escape (tool.cancel) reverts it to exactly how things were before you picked it up.
//
// Both tools also scale. The border of the box — corners and the whole of each edge, not only
// the knobs — resizes it (Shift keeps the proportions). Width and height in the options bar do
// the same. The scroll wheel scales from the centre while a selection is active.
import { cloneImage, cropImage, stampImage } from '../core/image.js';
import { scaleMask, translateMask, maskBounds } from '../core/mask.js';
import { resizeImage } from '../core/transform.js';
import { rectUnion, rectIntersect } from '../core/util.js';
import { targetRegion } from '../doc/ops.js';
import { paintImage } from '../doc/raster.js';
import { layerRect } from './common.js';

const HANDLE_CURSOR = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
};

function handlePoints(box) {
  const x0 = box.x, y0 = box.y, x1 = box.x + box.w, y1 = box.y + box.h;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  return [
    ['nw', x0, y0], ['n', mx, y0], ['ne', x1, y0],
    ['e', x1, my], ['se', x1, y1], ['s', mx, y1],
    ['sw', x0, y1], ['w', x0, my],
  ];
}

/** Which handle is under the pointer, or null. The whole border scales, not only the knobs.
 *  Needs the view's zoom (tests that only pass doc coords keep moving). */
function hitHandle(e, box) {
  const zoom = e?.zoom;
  if (!box || !(zoom > 0) || e.ox == null || e.oy == null || e.sx == null) return null;
  const x0 = e.ox + box.x * zoom, y0 = e.oy + box.y * zoom;
  const x1 = x0 + box.w * zoom, y1 = y0 + box.h * zoom;
  const sw = x1 - x0, sh = y1 - y0;
  if (!(sw > 0) || !(sh > 0)) return null;
  const px = e.sx, py = e.sy;
  const pad = Math.min(12, Math.max(4, Math.min(sw, sh) * 0.22));
  if (px < x0 - pad || px > x1 + pad || py < y0 - pad || py > y1 + pad) return null;
  const dl = Math.abs(px - x0), dr = Math.abs(px - x1), dt = Math.abs(py - y0), db = Math.abs(py - y1);
  const onL = dl <= pad, onR = dr <= pad, onT = dt <= pad, onB = db <= pad;
  if (!(onL || onR || onT || onB)) return null;
  const c = Math.max(pad, Math.min(22, Math.min(sw, sh) * 0.35));
  if (dl <= c && dt <= c) return 'nw';
  if (dr <= c && dt <= c) return 'ne';
  if (dl <= c && db <= c) return 'sw';
  if (dr <= c && db <= c) return 'se';
  if (onT) return 'n';
  if (onB) return 's';
  if (onL) return 'w';
  return 'e';
}

/** New box while dragging `id`. The opposite side stays put. Shift locks the original aspect. */
function scaledRect(id, box, px, py, shift, aspect) {
  const L = box.x, T = box.y, R = box.x + box.w, B = box.y + box.h;
  let x0 = L, y0 = T, x1 = R, y1 = B;
  const west = id === 'nw' || id === 'w' || id === 'sw';
  const east = id === 'ne' || id === 'e' || id === 'se';
  const north = id === 'nw' || id === 'n' || id === 'ne';
  const south = id === 'sw' || id === 's' || id === 'se';
  if (west) x0 = px;
  if (east) x1 = px;
  if (north) y0 = py;
  if (south) y1 = py;
  if (shift && aspect > 0) {
    if ((east || west) && (north || south)) {
      const w = x1 - x0;
      const h = Math.sign(y1 - y0 || 1) * Math.abs(w) / aspect;
      if (north) y0 = y1 - h; else y1 = y0 + h;
    } else if (east || west) {
      const w = x1 - x0;
      const h = Math.abs(w) / aspect;
      const mid = (T + B) / 2;
      y0 = mid - h / 2; y1 = mid + h / 2;
    } else if (north || south) {
      const h = y1 - y0;
      const w = Math.abs(h) * aspect;
      const mid = (L + R) / 2;
      x0 = mid - w / 2; x1 = mid + w / 2;
    }
  }
  return {
    x: Math.round(Math.min(x0, x1)),
    y: Math.round(Math.min(y0, y1)),
    w: Math.max(1, Math.round(Math.abs(x1 - x0))),
    h: Math.max(1, Math.round(Math.abs(y1 - y0))),
  };
}

function drawHandles(ctx, box, v) {
  if (!box || !v) return;
  const z = v.zoom || 1;
  const x = v.ox + box.x * z, y = v.oy + box.y * z, w = box.w * z, h = box.h * z;
  ctx.save();
  ctx.strokeStyle = 'rgba(70, 130, 220, .95)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#2a5ccc';
  for (const [, px, py] of handlePoints(box)) {
    const hx = v.ox + px * z, hy = v.oy + py * z;
    ctx.fillRect(hx - 5, hy - 5, 10, 10);
    ctx.strokeRect(hx - 5.5, hy - 5.5, 11, 11);
  }
  ctx.restore();
}

function finiteSize(w, h) {
  return {
    w: Math.max(1, Math.min(8192, Math.round(w))),
    h: Math.max(1, Math.min(8192, Math.round(h))),
  };
}

function movePixels() {
  let S = null;

  const syncAnts = (ed) => {
    if (!S?.mask) { ed.marchOffset = null; return; }
    const same = S.cur.w === S.r.w && S.cur.h === S.r.h;
    ed.marchOffset = same
      ? { dx: S.cur.x - S.r.x, dy: S.cur.y - S.r.y }
      : { from: S.r, to: S.cur };
  };

  /** Redraw the floated pixels into `nr`. Always sampled from the original lift, so a scale is not generational. */
  const renderAt = (s, nr) => {
    nr = {
      x: Math.round(nr.x), y: Math.round(nr.y),
      w: Math.max(1, Math.min(8192, Math.round(nr.w))),
      h: Math.max(1, Math.min(8192, Math.round(nr.h))),
    };
    if (nr.x === s.cur.x && nr.y === s.cur.y && nr.w === s.cur.w && nr.h === s.cur.h) return;
    const img = nr.w === s.src.width && nr.h === s.src.height ? s.src : resizeImage(s.src, nr.w, nr.h, 'smooth');
    const area = rectUnion(s.cur, nr);
    stampImage(s.layer.img, cropImage(s.base, area), area.x, area.y);
    paintImage(s.layer.img, img, nr.x, nr.y);
    s.layer.touch(area);
    s.cur = nr;
    s.total = rectUnion(s.total, area);
  };

  const boxNow = (ed) => {
    if (S) return S.cur;
    const r = ed.doc ? targetRegion(ed.doc) : null;
    return r && r.w > 0 && r.h > 0 ? r : null;
  };

  /** Undo everything back to the pristine, pre-lift layer. Leaves S cleared. */
  const revert = (ed) => {
    const s = S;
    S = null;
    const area = rectIntersect(s.total, layerRect(s.layer)) || s.r;
    stampImage(s.layer.img, cropImage(s.base, area), area.x, area.y);
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
    const moved = s.cur.x !== s.r.x || s.cur.y !== s.r.y;
    const sized = s.cur.w !== s.r.w || s.cur.h !== s.r.h;
    if (!moved && !sized) {
      const area = rectIntersect(s.total, layerRect(s.layer)) || s.r;
      stampImage(s.layer.img, cropImage(s.base, area), area.x, area.y);
      stampImage(s.layer.img, s.before, s.r.x, s.r.y);
      s.layer.touch(s.total);
      return;
    }
    const total = rectIntersect(s.total, layerRect(s.layer));
    const original = cropImage(s.base, total); // the layer before any of this = base + the lifted pixels
    stampImage(original, s.before, s.r.x - total.x, s.r.y - total.y);
    const name = sized ? 'Scale Selected Pixels' : 'Move Selected Pixels';
    ed.doc.transaction(name, () => {
      ed.doc.commitRegion(s.layer, total, original, name);
      if (s.mask) {
        const next = sized ? scaleMask(s.mask, s.r, s.cur) : translateMask(s.mask, s.cur.x - s.r.x, s.cur.y - s.r.y);
        ed.doc.setSelection(next, sized ? 'Scale Selection' : 'Move Selection');
      }
    });
  };

  const lift = (ed) => {
    const layer = ed.editableLayer();
    if (!layer) return false;
    const doc = ed.doc, r = targetRegion(doc);
    if (!r) return false;
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
    S = { layer, r, mask, before, src: lifted, base, cur: { x: r.x, y: r.y, w: r.w, h: r.h }, total: { x: r.x, y: r.y, w: r.w, h: r.h } };
    return true;
  };

  const applyDrag = (e, ed) => {
    const d = S.dragging;
    if (d.kind === 'scale') renderAt(S, scaledRect(d.id, d.box, e.x, e.y, e.shift, S.r.w / S.r.h));
    else renderAt(S, { x: d.box.x + Math.round(e.x - d.x0), y: d.box.y + Math.round(e.y - d.y0), w: d.box.w, h: d.box.h });
    syncAnts(ed);
    ed.requestOverlay();
  };

  return {
    id: 'move-pixels', name: 'Move Selected Pixels', key: 'M', group: 'move', cursor: 'move', options: [],
    cursorAt(e, ed) {
      if (S?.dragging?.kind === 'scale') return HANDLE_CURSOR[S.dragging.id] || 'move';
      const id = hitHandle(e, boxNow(ed));
      return id ? HANDLE_CURSOR[id] : 'move';
    },
    overlay(ctx, ed, v) { drawHandles(ctx, boxNow(ed), v); },
    /** Live width and height for the options bar. */
    metrics(ed) {
      const b = boxNow(ed);
      return b ? { w: b.w, h: b.h } : null;
    },
    /** Scale from the top-left of the current box. Floats until Enter / right-click. */
    setSize(ed, w, h) {
      const size = finiteSize(w, h);
      const box = boxNow(ed);
      if (!box) return false;
      if (!S && size.w === box.w && size.h === box.h) return false;
      if (!S && !lift(ed)) return false;
      renderAt(S, { x: S.cur.x, y: S.cur.y, w: size.w, h: size.h });
      syncAnts(ed);
      ed.requestOverlay();
      return true;
    },
    /** Scroll scales the selection from its centre. Ctrl-scroll is left to the view, and so is scroll with nothing selected. */
    wheel(e, ed) {
      if (e.ctrlKey || e.metaKey) return false;
      if (!S && !ed.doc?.selection) return false;
      if (!S && !lift(ed)) return false;
      const k = e.deltaMode === 1 ? 16 : 1;
      const factor = Math.pow(1.0015, -e.deltaY * k);
      const box = S.cur;
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      const w = Math.max(1, Math.min(8192, Math.round(box.w * factor)));
      const h = Math.max(1, Math.min(8192, Math.round(box.h * factor)));
      renderAt(S, { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h });
      syncAnts(ed);
      ed.requestOverlay();
      return true;
    },
    down(e, ed) {
      if (S) {
        if (e.button === 2) { settle(ed); return; }
        const handle = hitHandle(e, S.cur);
        S.dragging = handle
          ? { kind: 'scale', id: handle, box: { ...S.cur } }
          : { kind: 'move', x0: e.x, y0: e.y, box: { ...S.cur } };
        return;
      }
      if (e.button === 2) return;
      if (!lift(ed)) return;
      const handle = hitHandle(e, S.cur);
      S.dragging = handle
        ? { kind: 'scale', id: handle, box: { ...S.cur } }
        : { kind: 'move', x0: e.x, y0: e.y, box: { ...S.cur } };
    },
    move(e, ed) {
      if (!S?.dragging) return;
      applyDrag(e, ed);
    },
    up(e, ed) {
      if (!S?.dragging) return;
      applyDrag(e, ed);
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

  const boxNow = (ed) => {
    if (S) return S.cur;
    const m = ed.doc?.selection;
    const r = m && maskBounds(m);
    return r && r.w > 0 && r.h > 0 ? r : null;
  };

  const sync = (ed) => {
    if (!S) { ed.marchOffset = null; return; }
    const same = S.cur.w === S.r.w && S.cur.h === S.r.h;
    ed.marchOffset = same
      ? { dx: S.cur.x - S.r.x, dy: S.cur.y - S.r.y }
      : { from: S.r, to: S.cur };
  };

  const begin = (ed) => {
    if (S) return true;
    const mask = ed.doc?.selection;
    const r = mask && maskBounds(mask);
    if (!r) return false;
    S = { mask, r, cur: { x: r.x, y: r.y, w: r.w, h: r.h } };
    return true;
  };

  const place = (ed, nr) => {
    const size = finiteSize(nr.w, nr.h);
    S.cur = { x: Math.round(nr.x), y: Math.round(nr.y), w: size.w, h: size.h };
    sync(ed);
    ed.requestOverlay();
  };

  const settle = (ed) => {
    const s = S;
    S = null;
    ed.marchOffset = null;
    ed.requestOverlay();
    const moved = s.cur.x !== s.r.x || s.cur.y !== s.r.y;
    const sized = s.cur.w !== s.r.w || s.cur.h !== s.r.h;
    if (!moved && !sized) return;
    const next = sized ? scaleMask(s.mask, s.r, s.cur) : translateMask(s.mask, s.cur.x - s.r.x, s.cur.y - s.r.y);
    ed.doc.setSelection(next, sized ? 'Scale Selection' : 'Move Selection');
  };
  const revert = (ed) => { S = null; ed.marchOffset = null; ed.requestOverlay(); };

  const applyDrag = (e, ed) => {
    const d = S.dragging;
    if (d.kind === 'scale') place(ed, scaledRect(d.id, d.box, e.x, e.y, e.shift, S.r.w / S.r.h));
    else place(ed, { x: d.box.x + Math.round(e.x - d.x0), y: d.box.y + Math.round(e.y - d.y0), w: d.box.w, h: d.box.h });
  };

  return {
    id: 'move-selection', name: 'Move Selection', key: 'M', group: 'move', cursor: 'move', options: [],
    cursorAt(e, ed) {
      if (S?.dragging?.kind === 'scale') return HANDLE_CURSOR[S.dragging.id] || 'move';
      const id = hitHandle(e, boxNow(ed));
      return id ? HANDLE_CURSOR[id] : 'move';
    },
    overlay(ctx, ed, v) { drawHandles(ctx, boxNow(ed), v); },
    metrics(ed) {
      const b = boxNow(ed);
      return b ? { w: b.w, h: b.h } : null;
    },
    setSize(ed, w, h) {
      if (!begin(ed)) return false;
      const size = finiteSize(w, h);
      place(ed, { x: S.cur.x, y: S.cur.y, w: size.w, h: size.h });
      return true;
    },
    wheel(e, ed) {
      if (e.ctrlKey || e.metaKey) return false;
      if (!begin(ed)) return false;
      const k = e.deltaMode === 1 ? 16 : 1;
      const factor = Math.pow(1.0015, -e.deltaY * k);
      const box = S.cur;
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      const w = Math.max(1, Math.min(8192, Math.round(box.w * factor)));
      const h = Math.max(1, Math.min(8192, Math.round(box.h * factor)));
      place(ed, { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h });
      return true;
    },
    down(e, ed) {
      if (S) {
        if (e.button === 2) { settle(ed); return; }
        const handle = hitHandle(e, S.cur);
        S.dragging = handle
          ? { kind: 'scale', id: handle, box: { ...S.cur } }
          : { kind: 'move', x0: e.x, y0: e.y, box: { ...S.cur } };
        return;
      }
      if (e.button === 2 || !begin(ed)) return;
      const handle = hitHandle(e, S.cur);
      S.dragging = handle
        ? { kind: 'scale', id: handle, box: { ...S.cur } }
        : { kind: 'move', x0: e.x, y0: e.y, box: { ...S.cur } };
    },
    move(e, ed) {
      if (!S?.dragging) return;
      applyDrag(e, ed);
    },
    up(e, ed) {
      if (!S?.dragging) return;
      applyDrag(e, ed);
      S.dragging = null;
    },
    deactivate(ed) { if (S) settle(ed); },
    cancel(ed) { if (S) revert(ed); },
  };
}

export const moveTools = () => [movePixels(), moveSelection()];
