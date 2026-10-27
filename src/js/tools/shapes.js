// Line, rectangle, rounded rectangle and ellipse. The shape is drawn live into the layer while
// dragging (so what you see is what you get) and recorded as one history step on release.
// Box shapes can be drawn turned (Rotate option, degrees about the shape's centre); it is a
// vector rotation of the path, so edges stay crisp. To turn a shape that is already drawn,
// select it and use Move Selected Pixels' rotate knob.
import { cloneImage, cropImage, stampImage } from '../core/image.js';
import { rectUnion, rectIntersect, rectGrow } from '../core/util.js';
import { paintImage, rasterize, hardenAlpha } from '../doc/raster.js';
import { layerRect, rgbaCss } from './common.js';
import { rotatedBounds } from '../core/xform.js';

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function poly(ctx, x, y, w, h, n, rot = -Math.PI / 2) {
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    const px = cx + Math.cos(a) * rx, py = cy + Math.sin(a) * ry;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function starPath(ctx, x, y, w, h, points = 5, inner = 0.42) {
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  const n = points * 2;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const k = i % 2 === 0 ? 1 : inner;
    const px = cx + Math.cos(a) * rx * k, py = cy + Math.sin(a) * ry * k;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function arrowPath(ctx, x, y, w, h) {
  const x0 = x, y0 = y, x1 = x + w, y1 = y + h;
  const shaft = h * 0.35, head = w * 0.38;
  const cy = (y0 + y1) / 2;
  ctx.moveTo(x0, cy - shaft / 2);
  ctx.lineTo(x1 - head, cy - shaft / 2);
  ctx.lineTo(x1 - head, y0);
  ctx.lineTo(x1, cy);
  ctx.lineTo(x1 - head, y1);
  ctx.lineTo(x1 - head, cy + shaft / 2);
  ctx.lineTo(x0, cy + shaft / 2);
  ctx.closePath();
}

function tracePath(ctx, kind, x0, y0, x1, y1, radius, sides = 5) {
  ctx.beginPath();
  if (kind === 'line') { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); return; }
  const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  if (kind === 'rect') ctx.rect(x, y, w, h);
  else if (kind === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (kind === 'roundrect') roundRectPath(ctx, x, y, w, h, Math.min(radius, w / 2, h / 2));
  else if (kind === 'triangle') poly(ctx, x, y, w, h, 3);
  else if (kind === 'diamond') poly(ctx, x, y, w, h, 4);
  else if (kind === 'pentagon') poly(ctx, x, y, w, h, 5);
  else if (kind === 'hexagon') poly(ctx, x, y, w, h, 6, 0);
  else if (kind === 'polygon') poly(ctx, x, y, w, h, Math.max(3, sides | 0));
  else if (kind === 'star') starPath(ctx, x, y, w, h, Math.max(3, sides | 0));
  else if (kind === 'arrow') arrowPath(ctx, x, y, w, h);
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
    if (s.prev) stampImage(layer.img, cropImage(orig, s.prev), s.prev.x, s.prev.y);
    const pad = Math.ceil(o.size / 2) + 3;
    // A drag that crossed a weld carries one piece per lip: the shape lives in
    // continuous pixels and each piece shifts a copy back onto that lip.
    const pieces = s.wrap?.pieces?.length ? s.wrap.pieces : [{ dx: 0, dy: 0 }];
    const turn = kind === 'line' ? 0 : ((+o.shapeAngle || 0) * Math.PI) / 180;
    const gcx = (g.x0 + g.x1) / 2, gcy = (g.y0 + g.y1) / 2;
    let region = null;
    for (const piece of pieces) {
      const dx = piece.dx || 0, dy = piece.dy || 0;
      let b = {
        x: Math.floor(Math.min(g.x0, g.x1) - dx) - pad,
        y: Math.floor(Math.min(g.y0, g.y1) - dy) - pad,
        w: Math.ceil(Math.abs(g.x1 - g.x0)) + pad * 2,
        h: Math.ceil(Math.abs(g.y1 - g.y0)) + pad * 2,
      };
      if (turn) b = rotatedBounds(b, turn);
      const grown = piece.clip ? rectGrow(piece.clip, pad) : null;
      if (grown) b = rectIntersect(b, grown);
      if (b) {
        const x0 = Math.floor(b.x), y0 = Math.floor(b.y);
        const x1 = Math.ceil(b.x + b.w), y1 = Math.ceil(b.y + b.h);
        b = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
      }
      b = b && rectIntersect(b, layerRect(layer));
      if (b) region = region ? rectUnion(region, b) : b;
    }
    if (!region) { s.prev = null; return; }
    const paint = (ctx) => {
      ctx.lineWidth = Math.max(1, o.size);
      ctx.lineCap = 'round';
      ctx.lineJoin = kind === 'rect' ? 'miter' : 'round';
      if (kind === 'line' || o.shape === 'outline') { ctx.strokeStyle = rgbaCss(stroke); ctx.stroke(); }
      else if (o.shape === 'fill') { ctx.fillStyle = rgbaCss(stroke); ctx.fill(); }
      else { ctx.fillStyle = rgbaCss(fill); ctx.fill(); ctx.strokeStyle = rgbaCss(stroke); ctx.stroke(); }
    };
    const img = rasterize(region.w, region.h, (ctx) => {
      ctx.translate(-region.x, -region.y);
      for (const piece of pieces) {
        ctx.save();
        if (piece.clip) {
          const c = rectGrow(piece.clip, pad);
          ctx.beginPath(); ctx.rect(c.x, c.y, c.w, c.h); ctx.clip();
        }
        ctx.translate(-(piece.dx || 0), -(piece.dy || 0));
        if (turn) { ctx.translate(gcx, gcy); ctx.rotate(turn); ctx.translate(-gcx, -gcy); }
        tracePath(ctx, kind, g.x0, g.y0, g.x1, g.y1, o.radius, o.sides || 5);
        paint(ctx);
        ctx.restore();
      }
    });
    if (!o.aa) hardenAlpha(img);
    paintImage(layer.img, img, region.x, region.y, ed.doc.selection, o.opacity / 100);
    layer.touch(s.prev ? rectUnion(s.prev, region) : region);
    s.prev = region;
    s.all = rectUnion(s.all, region);
  };

  return {
    id, name, key, group: 'shape', cursor: 'crosshair',
    options: kind === 'line' ? ['size', 'opacity', 'aa', 'wrapShapes']
      : kind === 'roundrect' ? ['size', 'shape', 'radius', 'shapeAngle', 'opacity', 'aa', 'wrapShapes']
      : (kind === 'polygon' || kind === 'star') ? ['size', 'shape', 'sides', 'shapeAngle', 'opacity', 'aa', 'wrapShapes']
      : ['size', 'shape', 'shapeAngle', 'opacity', 'aa', 'wrapShapes'],

    down(e, ed) {
      const layer = ed.editableLayer();
      if (!layer) return;
      S = {
        layer, orig: cloneImage(layer.img), x0: e.x, y0: e.y, x1: e.x, y1: e.y, shift: e.shift,
        swap: e.button === 2,
        prev: null, all: null, moved: false, wrap: e.wrap || null,
      };
    },
    move(e, ed) {
      if (!S) return;
      S.x1 = e.x; S.y1 = e.y; S.shift = e.shift; S.moved = true;
      if (e.wrap) S.wrap = e.wrap;
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


/** Line that becomes a cubic Bézier after the drag. Drag the handles to bend it; Enter or right-click sets it down. */
function makeCurve() {
  let S = null;

  const samples = (a, c0, c1, b, n = 48) => {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      pts.push({
        x: u*u*u*a.x + 3*u*u*t*c0.x + 3*u*t*t*c1.x + t*t*t*b.x,
        y: u*u*u*a.y + 3*u*u*t*c0.y + 3*u*t*t*c1.y + t*t*t*b.y,
      });
    }
    return pts;
  };

  const boundsOf = (pts, pad) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { x: Math.floor(x0 - pad), y: Math.floor(y0 - pad), w: Math.ceil(x1 - x0 + pad * 2), h: Math.ceil(y1 - y0 + pad * 2) };
  };

  const draw = (ed) => {
    const s = S, o = ed.opts, layer = s.layer;
    const stroke = s.swap ? ed.secondary : ed.primary;
    if (s.prev) stampImage(layer.img, cropImage(s.orig, s.prev), s.prev.x, s.prev.y);
    const pts = samples(s.a, s.c0, s.c1, s.b);
    const pad = Math.ceil(o.size / 2) + 3;
    let region = rectIntersect(boundsOf(pts, pad), layerRect(layer));
    if (!region) { s.prev = null; return; }
    const img = rasterize(region.w, region.h, (ctx) => {
      ctx.translate(-region.x, -region.y);
      ctx.beginPath();
      ctx.moveTo(s.a.x, s.a.y);
      ctx.bezierCurveTo(s.c0.x, s.c0.y, s.c1.x, s.c1.y, s.b.x, s.b.y);
      ctx.lineWidth = Math.max(1, o.size);
      ctx.lineCap = 'round';
      ctx.strokeStyle = rgbaCss(stroke);
      ctx.stroke();
    });
    if (!o.aa) hardenAlpha(img);
    paintImage(layer.img, img, region.x, region.y, ed.doc.selection, o.opacity / 100);
    layer.touch(s.prev ? rectUnion(s.prev, region) : region);
    s.prev = region;
    s.all = s.all ? rectUnion(s.all, region) : region;
  };

  const settle = (ed) => {
    const s = S; S = null;
    if (s?.moved && s.all) ed.doc.commitRegion(s.layer, s.all, cropImage(s.orig, s.all), 'Line / Curve');
    ed.requestOverlay();
  };
  const revert = (ed) => {
    const s = S; S = null;
    if (s?.all) { stampImage(s.layer.img, cropImage(s.orig, s.all), s.all.x, s.all.y); s.layer.touch(s.all); }
    ed?.requestOverlay();
  };

  const hit = (e, s) => {
    const pts = { a: s.a, b: s.b, c0: s.c0, c1: s.c1 };
    let best = null, bestD = 10;
    for (const [id, p] of Object.entries(pts)) {
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d < bestD) { best = id; bestD = d; }
    }
    return best;
  };

  return {
    id: 'line', name: 'Line / Curve', key: 'O', group: 'shape', cursor: 'crosshair',
    options: ['size', 'opacity', 'aa', 'wrapShapes'],
    down(e, ed) {
      if (S?.editing) {
        if (e.button === 2) { settle(ed); return; }
        const h = hit(e, S);
        if (h) { S.dragging = h; return; }
        settle(ed);
      }
      const layer = ed.editableLayer();
      if (!layer) return;
      const p = { x: e.x, y: e.y };
      S = {
        layer, orig: cloneImage(layer.img), a: { ...p }, b: { ...p }, c0: { ...p }, c1: { ...p },
        shift: e.shift, swap: e.button === 2, prev: null, all: null, moved: false, editing: false, dragging: 'b',
      };
    },
    move(e, ed) {
      if (!S) return;
      if (S.editing && S.dragging) {
        S[S.dragging] = { x: e.x, y: e.y };
        // Keep the unused control on the chord until the user grabs it.
        if (S.dragging === 'a' && !S.c0moved) S.c0 = { ...S.a };
        if (S.dragging === 'b' && !S.c1moved) S.c1 = { ...S.b };
        if (S.dragging === 'c0') S.c0moved = true;
        if (S.dragging === 'c1') S.c1moved = true;
        draw(ed);
        ed.requestOverlay();
        return;
      }
      S.b = { x: e.x, y: e.y };
      if (e.shift) {
        const dx = S.b.x - S.a.x, dy = S.b.y - S.a.y;
        const len = Math.hypot(dx, dy), ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
        S.b = { x: S.a.x + Math.cos(ang) * len, y: S.a.y + Math.sin(ang) * len };
      }
      S.c1 = { ...S.b };
      S.moved = true;
      draw(ed);
    },
    up(e, ed) {
      if (!S) return;
      if (!S.editing) {
        S.editing = true;
        S.dragging = null;
        if (!S.c0moved) S.c0 = { x: S.a.x + (S.b.x - S.a.x) / 3, y: S.a.y + (S.b.y - S.a.y) / 3 };
        if (!S.c1moved) S.c1 = { x: S.a.x + (S.b.x - S.a.x) * 2 / 3, y: S.a.y + (S.b.y - S.a.y) * 2 / 3 };
        ed.requestOverlay();
        return;
      }
      S.dragging = null;
    },
    overlay(ctx, ed, v) {
      if (!S?.editing) return;
      const pts = [S.a, S.c0, S.c1, S.b].map((p) => v.toScreen(p.x, p.y));
      ctx.save();
      ctx.strokeStyle = 'rgba(70,130,220,.7)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pts[3].x, pts[3].y); ctx.lineTo(pts[2].x, pts[2].y); ctx.stroke();
      ctx.setLineDash([]);
      for (const p of pts) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#2a5ccc'; ctx.stroke();
      }
      ctx.restore();
    },
    colorsChanged(ed) { if (S?.moved) draw(ed); },
    deactivate(ed) { if (S) settle(ed); },
    cancel(ed) { if (S) revert(ed); },
  };
}

export const shapeTools = () => [
  makeCurve(),
  makeShape({ id: 'rect', name: 'Rectangle', kind: 'rect', key: 'R' }),
  makeShape({ id: 'roundrect', name: 'Rounded Rectangle', kind: 'roundrect', key: 'R' }),
  makeShape({ id: 'ellipse', name: 'Ellipse', kind: 'ellipse', key: 'O' }),
  makeShape({ id: 'triangle', name: 'Triangle', kind: 'triangle', key: 'O' }),
  makeShape({ id: 'diamond', name: 'Diamond', kind: 'diamond', key: 'O' }),
  makeShape({ id: 'pentagon', name: 'Pentagon', kind: 'pentagon', key: 'O' }),
  makeShape({ id: 'hexagon', name: 'Hexagon', kind: 'hexagon', key: 'O' }),
  makeShape({ id: 'polygon', name: 'Polygon', kind: 'polygon', key: 'O' }),
  makeShape({ id: 'star', name: 'Star', kind: 'star', key: 'O' }),
  makeShape({ id: 'arrow', name: 'Arrow', kind: 'arrow', key: 'O' }),
];
