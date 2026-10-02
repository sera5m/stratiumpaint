// Line, rectangle, rounded rectangle and ellipse. The shape is drawn live into the layer while
// dragging (so what you see is what you get) and recorded as one history step on release.
import { cloneImage, cropImage, stampImage } from '../core/image.js';
import { rectUnion, rectIntersect } from '../core/util.js';
import { paintImage, rasterize, hardenAlpha } from '../doc/raster.js';
import { layerRect, rgbaCss } from './common.js';

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function tracePath(ctx, kind, x0, y0, x1, y1, radius) {
  ctx.beginPath();
  if (kind === 'line') { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); return; }
  const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  if (kind === 'rect') ctx.rect(x, y, w, h);
  else if (kind === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else roundRectPath(ctx, x, y, w, h, Math.min(radius, w / 2, h / 2));
}

/** End point after Shift: lines snap to 15° steps, boxes become square. */
function constrain(kind, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  if (kind === 'line') {
    const len = Math.hypot(dx, dy), ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
    return [x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len];
  }
  const d = Math.max(Math.abs(dx), Math.abs(dy));
  return [x0 + (dx < 0 ? -d : d), y0 + (dy < 0 ? -d : d)];
}

function makeShape({ id, name, kind, key }) {
  let S = null;

  const geometry = (s) => {
    let { x0, y0, x1, y1 } = s;
    if (s.shift) [x1, y1] = constrain(kind, x0, y0, x1, y1);
    if (kind !== 'line') { x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1); }
    return { x0, y0, x1, y1 };
  };

  const draw = (ed, s) => {
    const { layer, orig } = s, o = ed.opts, g = geometry(s);
    // Read colour live rather than what was captured at mousedown, so changing the primary/secondary
    // colour mid-drag (e.g. via a keyboard shortcut) updates the shape before it's released.
    const stroke = s.swap ? ed.secondary : ed.primary, fill = s.swap ? ed.primary : ed.secondary;
    if (s.prev) { // put back what the previous frame covered
      stampImage(layer.img, cropImage(orig, s.prev), s.prev.x, s.prev.y);
    }
    const pad = Math.ceil(o.size / 2) + 3;
    const region = rectIntersect({
      x: Math.floor(Math.min(g.x0, g.x1)) - pad, y: Math.floor(Math.min(g.y0, g.y1)) - pad,
      w: Math.ceil(Math.abs(g.x1 - g.x0)) + pad * 2, h: Math.ceil(Math.abs(g.y1 - g.y0)) + pad * 2,
    }, layerRect(layer));
    if (!region) { s.prev = null; return; }
    const img = rasterize(region.w, region.h, (ctx) => {
      ctx.translate(-region.x, -region.y);
      tracePath(ctx, kind, g.x0, g.y0, g.x1, g.y1, o.radius);
      ctx.lineWidth = Math.max(1, o.size);
      ctx.lineCap = 'round';
      ctx.lineJoin = kind === 'rect' ? 'miter' : 'round';
      if (kind === 'line' || o.shape === 'outline') { ctx.strokeStyle = rgbaCss(stroke); ctx.stroke(); }
      else if (o.shape === 'fill') { ctx.fillStyle = rgbaCss(stroke); ctx.fill(); }
      else { ctx.fillStyle = rgbaCss(fill); ctx.fill(); ctx.strokeStyle = rgbaCss(stroke); ctx.stroke(); }
    });
    if (!o.aa) hardenAlpha(img);
    paintImage(layer.img, img, region.x, region.y, ed.doc.selection, o.opacity / 100);
    layer.touch(s.prev ? rectUnion(s.prev, region) : region);
    s.prev = region;
    s.all = rectUnion(s.all, region);
  };

  return {
    id, name, key, group: 'shape', cursor: 'crosshair',
    options: kind === 'line' ? ['size', 'opacity', 'aa']
      : kind === 'roundrect' ? ['size', 'shape', 'radius', 'opacity', 'aa'] : ['size', 'shape', 'opacity', 'aa'],

    down(e, ed) {
      const layer = ed.editableLayer();
      if (!layer) return;
      S = {
        layer, orig: cloneImage(layer.img), x0: e.x, y0: e.y, x1: e.x, y1: e.y, shift: e.shift,
        swap: e.button === 2,
        prev: null, all: null, moved: false,
      };
    },
    move(e, ed) {
      if (!S) return;
      S.x1 = e.x; S.y1 = e.y; S.shift = e.shift; S.moved = true;
      draw(ed, S);
    },
    // Redraw immediately if the colour changes mid-drag, so you don't have to nudge the mouse to
    // see it. Only once a real drag is underway — draw() marks the stroke as "something to commit
    // or revert", so calling it before any move() would happen is not safe.
    colorsChanged(ed) { if (S?.moved) draw(ed, S); },
    up(e, ed) {
      if (!S) return;
      const s = S;
      S = null;
      if (s.moved && s.all) ed.doc.commitRegion(s.layer, s.all, cropImage(s.orig, s.all), name);
    },
    cancel() {
      if (!S) return;
      const s = S;
      S = null;
      if (s.all) { s.layer.img.data.set(s.orig.data); s.layer.touch(); }
    },
  };
}

export const shapeTools = () => [
  makeShape({ id: 'line', name: 'Line', kind: 'line', key: 'O' }),
  makeShape({ id: 'rect', name: 'Rectangle', kind: 'rect', key: 'R' }),
  makeShape({ id: 'roundrect', name: 'Rounded Rectangle', kind: 'roundrect', key: 'R' }),
  makeShape({ id: 'ellipse', name: 'Ellipse', kind: 'ellipse', key: 'O' }),
];
