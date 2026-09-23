// Zoom, pan and colour picker.
import { dashedStroke } from './common.js';

function zoom() {
  let S = null;
  return {
    id: 'zoom', name: 'Zoom', key: 'Z', group: 'nav', cursor: 'zoom-in', options: [],
    down(e) { S = { sx0: e.sx, sy0: e.sy, sx1: e.sx, sy1: e.sy, x0: e.x, y0: e.y, x1: e.x, y1: e.y, button: e.button }; },
    move(e, ed) {
      if (!S) return;
      Object.assign(S, { sx1: e.sx, sy1: e.sy, x1: e.x, y1: e.y });
      ed.requestOverlay();
    },
    up(e, ed) {
      if (!S) return;
      const s = S;
      S = null;
      ed.requestOverlay();
      if (Math.hypot(s.sx1 - s.sx0, s.sy1 - s.sy0) > 6 && s.button !== 2) ed.view.zoomToRect(s.x0, s.y0, s.x1, s.y1);
      else ed.view.zoomAt(s.button === 2 ? 1 / 1.5 : 1.5, s.sx0, s.sy0);
    },
    cancel(ed) { S = null; ed?.requestOverlay(); },
    overlay(ctx) {
      if (!S) return;
      dashedStroke(ctx, () => ctx.rect(Math.min(S.sx0, S.sx1) + 0.5, Math.min(S.sy0, S.sy1) + 0.5, Math.abs(S.sx1 - S.sx0), Math.abs(S.sy1 - S.sy0)));
    },
  };
}

function pan() {
  let S = null;
  return {
    id: 'pan', name: 'Pan', key: 'H', group: 'nav', cursor: 'grab', options: [],
    down(e) { S = { sx: e.sx, sy: e.sy }; },
    move(e, ed) {
      if (!S) return;
      ed.view.panBy(e.sx - S.sx, e.sy - S.sy);
      S.sx = e.sx; S.sy = e.sy;
    },
    up() { S = null; },
    cancel() { S = null; },
  };
}

function picker() {
  const sample = (e, ed) => {
    const c = ed.doc.pixelAt(Math.floor(e.x), Math.floor(e.y), ed.opts.sampling === 'image');
    if (!c) return;
    if (e.button === 2) ed.setSecondary(c); else ed.setPrimary(c);
  };
  let down = false;
  return {
    id: 'picker', name: 'Color Picker', key: 'K', group: 'nav', cursor: 'crosshair', options: ['sampling'],
    down(e, ed) { down = true; sample(e, ed); },
    move(e, ed) { if (down) sample(e, ed); },
    up() { down = false; },
    cancel() { down = false; },
  };
}

export const navTools = () => [zoom(), pan(), picker()];
