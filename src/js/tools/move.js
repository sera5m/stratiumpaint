// Move Selected Pixels and Move Selection.
//
// Both tools lift content on the first drag and then *float* it: releasing the mouse parks it in
// place rather than baking it into the layer, so you can keep nudging it with further drags, and
// it can safely go off-canvas and back without losing anything. Nothing is written to the
// document/history until it's explicitly set down — Enter (or starting any other action, which
// goes through Editor#commitPending), or a right-click on the canvas the way the text tool works.
// Escape (tool.cancel) reverts it to exactly how things were before you picked it up.
//
// Both tools move, scale and rotate. The border of the box (corners and the whole of each edge)
// resizes it (Shift keeps the proportions); the round knob above the top edge turns it about its
// centre (Shift snaps to 15°). Width, height and angle in the options bar do the same. The scroll
// wheel scales from the centre while a selection is active.
//
// Performance model: lifting is the only pixel work before set-down. It cuts the hole in the layer
// once and hands the lifted pixels to the document as a *float* (Doc#setFloat), which turns them
// into a canvas (Canvas 2D) / texture (WebGPU) once. Every pointer event after that only changes
// the float's box and angle (Doc#updateFloat): the view redraws on the next animation frame from
// cached layer composites, with the float drawn under a transform. No pixel copies, layer
// uploads, history entries or 3D re-uploads happen during a drag.
//
// The real resample happens once, from the original lifted pixels, combining scale and rotation
// (core/xform.js resampleFloat), so repeated adjustments never stack blur. A plain move lands at
// once; a scale or turn lands once it has been idle for 0.5s since the last change (a thin border
// fades meanwhile). A left-click outside the box, or anything that goes through
// Editor#commitPending (tool switch, undo, menu commands), lands it immediately. The landed result
// is the single history step.
import { cloneImage, cropImage, stampImage } from '../core/image.js';
import { scaleMask, translateMask, maskBounds } from '../core/mask.js';
import { rectUnion, rectIntersect } from '../core/util.js';
import { DEG, normAngle, snapAngle, boxCorners, rotatedBounds, toBoxFrame, fromBoxFrame, resampleFloat, transformMask } from '../core/xform.js';
import { targetRegion } from '../doc/ops.js';
import { paintImage } from '../doc/raster.js';
import { layerRect } from './common.js';

const KNOB = 24; // screen px from the top edge to the rotate knob

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

/** True if pointer is inside the box (not just the border). */
function insideBox(e, box) {
  const zoom = e?.zoom;
  if (!box) return false;
  if (!(zoom > 0) || e.ox == null || e.sx == null) {
    return e.x >= box.x && e.x <= box.x + box.w && e.y >= box.y && e.y <= box.y + box.h;
  }
  const x0 = e.ox + box.x * zoom, y0 = e.oy + box.y * zoom;
  const x1 = x0 + box.w * zoom, y1 = y0 + box.h * zoom;
  return e.sx >= x0 && e.sx <= x1 && e.sy >= y0 && e.sy <= y1;
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


/** Pointer event in the box's own (unturned) frame, so the axis-aligned hit tests keep working. */
function frameEvent(e, box, angle) {
  if (!angle || !box) return e;
  const [x, y] = toBoxFrame(e.x, e.y, box, angle);
  const z = e.zoom;
  return z > 0 && e.ox != null ? { ...e, x, y, sx: e.ox + x * z, sy: e.oy + y * z } : { ...e, x, y };
}

/** Is the pointer on the rotate knob (screen space, above the top edge's middle)? */
function hitKnob(e, box, angle) {
  const z = e?.zoom;
  if (!box || !(z > 0) || e.ox == null || e.sx == null) return false;
  const l = frameEvent(e, box, angle);
  const kx = e.ox + (box.x + box.w / 2) * z, ky = e.oy + box.y * z - KNOB;
  return Math.hypot(l.sx - kx, l.sy - ky) <= 9;
}

const pointAngle = (e, box) => Math.atan2(e.y - (box.y + box.h / 2), e.x - (box.x + box.w / 2));

/** What a press at `e` does to a box turned by `angle`: 'rotate', a scale handle id, 'inside' or null. */
function hitTarget(e, box, angle) {
  if (hitKnob(e, box, angle)) return 'rotate';
  const l = frameEvent(e, box, angle);
  const id = hitHandle(l, box);
  if (id) return id;
  return insideBox(l, box) ? 'inside' : null;
}

/** New (unturned) box while dragging handle `id` of a box turned by `angle`. The opposite side
 *  stays put on screen, also when turned: the resize happens in the box's frame and the new
 *  centre is mapped back out. */
function scaledTurned(id, box, angle, e, aspect) {
  if (!angle) return scaledRect(id, box, e.x, e.y, e.shift, aspect);
  const [lx, ly] = toBoxFrame(e.x, e.y, box, angle);
  const nb = scaledRect(id, box, lx, ly, e.shift, aspect);
  const [cx, cy] = fromBoxFrame(nb.x + nb.w / 2, nb.y + nb.h / 2, box, angle);
  return { x: cx - nb.w / 2, y: cy - nb.h / 2, w: nb.w, h: nb.h };
}

const turnCursor = 'grab';
const cursorFor = (id) => (id === 'rotate' ? turnCursor : HANDLE_CURSOR[id] || 'move');

function screenPoly(box, angle, v) {
  const z = v.zoom || 1;
  return boxCorners(box, angle).map(([x, y]) => [v.ox + x * z, v.oy + y * z]);
}

function drawHandles(ctx, box, v, angle = 0) {
  if (!box || !v) return;
  const z = v.zoom || 1;
  const poly = screenPoly(box, angle, v);
  ctx.save();
  ctx.strokeStyle = 'rgba(70, 130, 220, .95)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i ? ctx.lineTo(x + 0.5, y + 0.5) : ctx.moveTo(x + 0.5, y + 0.5)));
  ctx.closePath();
  ctx.stroke();
  // Rotate knob: above the middle of the top edge, along the box's own "up".
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const [tx, ty] = fromBoxFrame(box.x + box.w / 2, box.y, box, angle);
  const sx = v.ox + tx * z, sy = v.oy + ty * z;
  const kx = sx + sin * KNOB, ky = sy - cos * KNOB;
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(kx, ky); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#2a5ccc';
  ctx.beginPath(); ctx.arc(kx, ky, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  for (const [, px, py] of handlePoints(box)) {
    const [hx0, hy0] = fromBoxFrame(px, py, box, angle);
    const hx = v.ox + hx0 * z, hy = v.oy + hy0 * z;
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(angle);
    ctx.fillRect(-5, -5, 10, 10);
    ctx.strokeRect(-5.5, -5.5, 11, 11);
    ctx.restore();
  }
  ctx.restore();
}

/** Thin border shown while a set-down scale/turn waits to be resampled; it fades out as it lands. */
function drawSettleBorder(ctx, box, v, fade, angle = 0) {
  if (!box || !v || !(fade > 0)) return;
  const poly = screenPoly(box, angle, v);
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.strokeStyle = 'rgba(70, 130, 220, .95)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i ? ctx.lineTo(x + 0.5, y + 0.5) : ctx.moveTo(x + 0.5, y + 0.5)));
  ctx.closePath();
  ctx.stroke();
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
  // A scaled/turned float that has been set down waits here until it has been idle for SETTLE_MS
  // since the last change; only then is it resampled and written to history. While it waits,
  // S.pending is set and a thin border fades out.
  let fadeTimer = null;
  let fadeFrame = null;
  let fadeAlpha = 1;
  const SETTLE_MS = 500;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
  const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null;

  const stopFade = () => {
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    if (fadeFrame != null && caf) caf(fadeFrame);
    fadeFrame = null;
    fadeAlpha = 1;
  };

  const sized = (s) => s.cur.w !== s.r.w || s.cur.h !== s.r.h;
  const changed = (s) => s.cur.x !== s.r.x || s.cur.y !== s.r.y || sized(s) || !!s.angle;

  const syncAnts = (ed) => {
    if (!S?.mask) { ed.marchOffset = null; return; }
    ed.marchOffset = !sized(S) && !S.angle
      ? { dx: S.cur.x - S.r.x, dy: S.cur.y - S.r.y }
      : { from: S.r, to: S.cur, angle: S.angle };
  };

  /** Place the float. Only numbers change; the view redraws next frame. */
  const renderAt = (s, nr, angle = s.angle) => {
    const turned = !!angle;
    nr = {
      x: turned ? nr.x : Math.round(nr.x), y: turned ? nr.y : Math.round(nr.y),
      w: Math.max(1, Math.min(8192, Math.round(nr.w))),
      h: Math.max(1, Math.min(8192, Math.round(nr.h))),
    };
    if (nr.x === s.cur.x && nr.y === s.cur.y && nr.w === s.cur.w && nr.h === s.cur.h && angle === s.angle) return;
    if (nr.w !== s.cur.w || nr.h !== s.cur.h || angle !== s.angle) s.scaledAt = now();
    s.cur = nr;
    s.angle = angle;
    s.doc.updateFloat(nr, angle);
  };

  const boxNow = (ed) => {
    if (S) return S.cur;
    const r = ed.doc ? targetRegion(ed.doc) : null;
    return r && r.w > 0 && r.h > 0 ? r : null;
  };

  /** Put the layer back exactly as it was before the lift. Leaves S cleared. */
  const revert = (ed) => {
    stopFade();
    const s = S;
    S = null;
    s.doc.clearFloat();
    stampImage(s.layer.img, s.before, s.r.x, s.r.y);
    s.layer.touch(s.r);
    if (ed) { ed.marchOffset = null; ed.requestOverlay(); }
  };

  /** Resample once (scale + turn together, from the original pixels), paint it into the layer and
   *  record one undo step. Leaves S cleared. */
  const finalize = (ed, s) => {
    stopFade();
    if (S === s) S = null;
    const res = resampleFloat(s.src, s.cur, s.angle);
    const dst = { x: Math.round(res.x), y: Math.round(res.y), w: res.img.width, h: res.img.height };
    const total = rectIntersect(rectUnion(s.r, dst), layerRect(s.layer)) || rectIntersect(s.r, layerRect(s.layer));
    const original = cropImage(s.layer.img, total); // the layer with the hole…
    stampImage(original, s.before, s.r.x - total.x, s.r.y - total.y); // …and the hole filled = before the lift
    paintImage(s.layer.img, res.img, dst.x, dst.y);
    s.doc.clearFloat();
    s.layer.touch(total);
    ed.marchOffset = null;
    ed.requestOverlay();
    const name = s.angle ? 'Rotate Selected Pixels' : sized(s) ? 'Scale Selected Pixels' : 'Move Selected Pixels';
    s.doc.transaction(name, () => {
      s.doc.commitRegion(s.layer, total, original, name);
      if (s.mask) ed.doc.setSelection(null, 'Deselect');
    });
  };

  /** Finish a set-down that is still waiting out its idle time, right now. */
  const flush = (ed) => { if (S?.pending) finalize(ed, S); };

  /** Set the float down. A plain move lands at once. A scale or turn lands once it has been idle
   *  for SETTLE_MS since its last change (with a fading border meanwhile), or at once when
   *  `immediate` (outside click, tool switch, undo, any command via Editor#commitPending). */
  const settle = (ed, { immediate = false } = {}) => {
    const s = S;
    if (!s) return;
    if (s.pending) { if (immediate) finalize(ed, s); return; }
    if (!changed(s)) { revert(ed); return; }
    s.dragging = null;
    const xformed = sized(s) || !!s.angle;
    const wait = xformed && !immediate ? Math.max(0, SETTLE_MS - (now() - (s.scaledAt ?? 0))) : 0;
    if (wait <= 0 || !ed.doc) { finalize(ed, s); return; }
    s.pending = true;
    stopFade();
    const start = now();
    if (raf) {
      const step = () => {
        fadeFrame = null;
        if (S !== s || !s.pending) return;
        fadeAlpha = Math.max(0, 1 - (now() - start) / wait);
        ed.requestOverlay();
        if (fadeAlpha > 0) fadeFrame = raf(step);
      };
      fadeFrame = raf(step);
    }
    fadeTimer = setTimeout(() => { fadeTimer = null; if (S === s && s.pending) finalize(ed, s); }, wait);
    ed.requestOverlay();
  };

  /** The one pixel pass before set-down: cut the hole and hand the lifted pixels to the float. */
  const lift = (ed) => {
    const layer = ed.editableLayer();
    if (!layer) return false;
    const doc = ed.doc, r = targetRegion(doc);
    if (!r) return false;
    const owner = ed.surface?.() || doc;
    const mask = doc.selection, w = doc.width;
    const before = cropImage(layer.img, r);
    const lifted = cloneImage(before);
    const hole = cloneImage(before);
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const m = mask ? mask.data[(r.y + y) * w + r.x + x] : 255;
        const li = (y * r.w + x) * 4;
        if (m === 255) { hole.data[li + 3] = 0; continue; }
        lifted.data[li + 3] = (lifted.data[li + 3] * m) / 255;
        hole.data[li + 3] = (hole.data[li + 3] * (255 - m)) / 255;
      }
    }
    stampImage(layer.img, hole, r.x, r.y);
    const cur = { x: r.x, y: r.y, w: r.w, h: r.h };
    owner.setFloat({ layer, src: lifted, box: cur, angle: 0 });
    layer.touch(r); // the hole: uploaded once, not per frame
    S = { doc: owner, layer, r, mask, before, src: lifted, cur, angle: 0 };
    return true;
  };

  const startDrag = (e, hit) => {
    S.dragging = hit === 'rotate'
      ? { kind: 'rotate', a0: S.angle, p0: pointAngle(e, S.cur), box: { ...S.cur } }
      : hit && hit !== 'inside'
        ? { kind: 'scale', id: hit, box: { ...S.cur }, angle: S.angle }
        : { kind: 'move', x0: e.x, y0: e.y, box: { ...S.cur } };
  };

  const applyDrag = (e, ed) => {
    const d = S.dragging;
    if (d.kind === 'scale') renderAt(S, scaledTurned(d.id, d.box, d.angle, e, S.r.w / S.r.h));
    else if (d.kind === 'rotate') {
      const a = d.a0 + pointAngle(e, d.box) - d.p0;
      renderAt(S, S.cur, e.shift ? snapAngle(a) : normAngle(a));
    } else renderAt(S, { x: d.box.x + Math.round(e.x - d.x0), y: d.box.y + Math.round(e.y - d.y0), w: d.box.w, h: d.box.h });
    syncAnts(ed);
    ed.requestOverlay();
  };

  return {
    id: 'move-pixels', name: 'Move Selected Pixels', key: 'M', group: 'move', cursor: 'move', options: [],
    cursorAt(e, ed) {
      if (S?.dragging) return S.dragging.kind === 'move' ? 'move' : S.dragging.kind === 'rotate' ? 'grabbing' : HANDLE_CURSOR[S.dragging.id] || 'move';
      const hit = hitTarget(e, boxNow(ed), S?.angle || 0);
      return hit && hit !== 'inside' ? cursorFor(hit) : 'move';
    },
    overlay(ctx, ed, v) {
      const box = boxNow(ed);
      if (S?.pending) drawSettleBorder(ctx, box, v, fadeAlpha, S.angle);
      else drawHandles(ctx, box, v, S?.angle || 0);
    },
    /** Live width, height and angle (degrees) for the options bar. */
    metrics(ed) {
      const b = boxNow(ed);
      return b ? { w: b.w, h: b.h, angle: Math.round(((S?.angle || 0) / DEG) * 10) / 10 } : null;
    },
    /** Scale from the top-left of the current box. Floats until Enter / right-click / outside click. */
    setSize(ed, w, h) {
      const size = finiteSize(w, h);
      const box = boxNow(ed);
      if (!box) return false;
      if (S?.pending) return false; // already set down; it lands in a moment
      if (!S && size.w === box.w && size.h === box.h) return false;
      if (!S && !lift(ed)) return false;
      renderAt(S, { x: S.cur.x, y: S.cur.y, w: size.w, h: size.h });
      syncAnts(ed);
      ed.requestOverlay();
      return true;
    },
    /** Turn about the box centre, in degrees. */
    setAngle(ed, deg) {
      if (!Number.isFinite(+deg)) return false;
      if (S?.pending) return false;
      const a = normAngle(+deg * DEG);
      if (!S && !a) return false;
      if (!S && (!boxNow(ed) || !lift(ed))) return false;
      renderAt(S, S.cur, a);
      syncAnts(ed);
      ed.requestOverlay();
      return true;
    },
    /** Scroll scales the selection from its centre. Ctrl-scroll is left to the view, and so is scroll with nothing selected. */
    wheel(e, ed) {
      if (e.ctrlKey || e.metaKey) return false;
      flush(ed);
      if (!S && !ed.doc?.selection) return false;
      if (!S && !lift(ed)) return false;
      const k = e.deltaMode === 1 ? 16 : 1;
      const factor = Math.pow(1.0015, -e.deltaY * k);
      const box = S.cur;
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      const w = Math.max(1, Math.min(8192, Math.round(box.w * factor)));
      const h = Math.max(1, Math.min(8192, Math.round(box.h * factor)));
      renderAt(S, { x: S.angle ? cx - w / 2 : Math.round(cx - w / 2), y: S.angle ? cy - h / 2 : Math.round(cy - h / 2), w, h });
      syncAnts(ed);
      ed.requestOverlay();
      return true;
    },
    down(e, ed) {
      // A set-down scale still waiting for its idle time: any click lands it now and is used up.
      if (S?.pending) { flush(ed); return; }
      if (S) {
        if (e.button === 2) { settle(ed); return; }
        const hit = hitTarget(e, S.cur, S.angle);
        // Left-click outside the box sets it down straight away (no idle wait).
        if (e.button === 0 && !hit) { settle(ed, { immediate: true }); return; }
        startDrag(e, hit);
        return;
      }
      if (e.button === 2) return;
      const pre = boxNow(ed);
      const hit = pre ? hitTarget(e, pre, 0) : null;
      if (!lift(ed)) return;
      startDrag(e, hit);
    },
    move(e, ed) {
      if (!S?.dragging) return;
      applyDrag(e, ed);
    },
    up(e, ed) {
      if (!S?.dragging) return;
      applyDrag(e, ed);
      S.dragging = null;
      // Stay floating — parked here until Enter/right-click/outside-click sets it down or Escape cancels it.
    },
    /** Enter sets down (a scale/turn waits out its idle time); `immediate` from Editor#commitPending lands it now. */
    deactivate(ed, opts) { if (S) settle(ed, opts); },
    /** Escape reverts a float. Once it has been set down it is no longer floating, so it lands instead. */
    cancel(ed) { if (S?.pending) flush(ed); else if (S) revert(ed); },
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
    const same = S.cur.w === S.r.w && S.cur.h === S.r.h && !S.angle;
    ed.marchOffset = same
      ? { dx: S.cur.x - S.r.x, dy: S.cur.y - S.r.y }
      : { from: S.r, to: S.cur, angle: S.angle };
  };

  const begin = (ed) => {
    if (S) return true;
    const mask = ed.doc?.selection;
    const r = mask && maskBounds(mask);
    if (!r) return false;
    S = { mask, r, cur: { x: r.x, y: r.y, w: r.w, h: r.h }, angle: 0 };
    return true;
  };

  const place = (ed, nr, angle = S.angle) => {
    const size = finiteSize(nr.w, nr.h);
    S.cur = angle ? { x: nr.x, y: nr.y, w: size.w, h: size.h } : { x: Math.round(nr.x), y: Math.round(nr.y), w: size.w, h: size.h };
    S.angle = angle;
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
    if (!moved && !sized && !s.angle) return;
    const next = s.angle ? transformMask(s.mask, s.r, s.cur, s.angle)
      : sized ? scaleMask(s.mask, s.r, s.cur) : translateMask(s.mask, s.cur.x - s.r.x, s.cur.y - s.r.y);
    ed.doc.setSelection(next, s.angle ? 'Rotate Selection' : sized ? 'Scale Selection' : 'Move Selection');
  };
  const revert = (ed) => { S = null; ed.marchOffset = null; ed.requestOverlay(); };

  const startDrag = (e, hit) => {
    S.dragging = hit === 'rotate'
      ? { kind: 'rotate', a0: S.angle, p0: pointAngle(e, S.cur), box: { ...S.cur } }
      : hit && hit !== 'inside'
        ? { kind: 'scale', id: hit, box: { ...S.cur }, angle: S.angle }
        : { kind: 'move', x0: e.x, y0: e.y, box: { ...S.cur } };
  };

  const applyDrag = (e, ed) => {
    const d = S.dragging;
    if (d.kind === 'scale') place(ed, scaledTurned(d.id, d.box, d.angle, e, S.r.w / S.r.h));
    else if (d.kind === 'rotate') {
      const a = d.a0 + pointAngle(e, d.box) - d.p0;
      place(ed, S.cur, e.shift ? snapAngle(a) : normAngle(a));
    } else place(ed, { x: d.box.x + Math.round(e.x - d.x0), y: d.box.y + Math.round(e.y - d.y0), w: d.box.w, h: d.box.h });
  };

  return {
    id: 'move-selection', name: 'Move Selection', key: 'M', group: 'move', cursor: 'move', options: [],
    cursorAt(e, ed) {
      if (S?.dragging) return S.dragging.kind === 'move' ? 'move' : S.dragging.kind === 'rotate' ? 'grabbing' : HANDLE_CURSOR[S.dragging.id] || 'move';
      const hit = hitTarget(e, boxNow(ed), S?.angle || 0);
      return hit && hit !== 'inside' ? cursorFor(hit) : 'move';
    },
    overlay(ctx, ed, v) { drawHandles(ctx, boxNow(ed), v, S?.angle || 0); },
    metrics(ed) {
      const b = boxNow(ed);
      return b ? { w: b.w, h: b.h, angle: Math.round(((S?.angle || 0) / DEG) * 10) / 10 } : null;
    },
    setSize(ed, w, h) {
      if (!begin(ed)) return false;
      const size = finiteSize(w, h);
      place(ed, { x: S.cur.x, y: S.cur.y, w: size.w, h: size.h });
      return true;
    },
    setAngle(ed, deg) {
      if (!Number.isFinite(+deg) || !begin(ed)) return false;
      place(ed, S.cur, normAngle(+deg * DEG));
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
      place(ed, { x: cx - w / 2, y: cy - h / 2, w, h });
      return true;
    },
    down(e, ed) {
      if (S) {
        if (e.button === 2) { settle(ed); return; }
        const hit = hitTarget(e, S.cur, S.angle);
        if (e.button === 0 && !hit) { settle(ed); return; }
        startDrag(e, hit);
        return;
      }
      if (e.button === 2) return;
      const pre = boxNow(ed);
      const hit = pre ? hitTarget(e, pre, 0) : null;
      if (!begin(ed)) return;
      startDrag(e, hit);
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
