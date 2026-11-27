// A path is a polyline of clicks. Enter (or leaving the tool) strokes it with the
// paintbrush, so size, hardness and symmetry are the brush's. Right-click drops the
// last point. Escape drops the whole path.
import { atlasOf, modelPaintLayer } from '../ui/place.js';

function pathTool() {
  let pts = [];

  const paint = (ed) => {
    if (pts.length < 2) return false;
    const brush = ed.tools.find((t) => t.id === 'brush');
    if (!brush) return false;
    const atlas = atlasOf(ed.doc);
    const onModel = !!(atlas && ed.doc?.mount);
    if (onModel) ed._modelTarget = atlas;
    const surf = ed.surface();
    const saved = pts;
    pts = [];
    try {
      surf.transaction('Path', () => {
        if (onModel) {
          const layer = modelPaintLayer(atlas);
          const i = atlas.layers.indexOf(layer);
          if (i >= 0) atlas.active = i;
        }
        const ev = (p) => ({ x: p.x, y: p.y, sx: 0, sy: 0, button: 0, shift: false, ctrl: false, alt: false });
        brush.down(ev(saved[0]), ed);
        for (let i = 1; i < saved.length; i++) brush.move(ev(saved[i]), ed);
        brush.up(ev(saved[saved.length - 1]), ed);
      });
    } finally {
      if (onModel) ed._modelTarget = null;
    }
    return true;
  };

  return {
    id: 'path', name: 'Path', key: 'I', group: 'path', cursor: 'crosshair',
    options: ['size', 'hardness', 'opacity', 'aa', 'symmetry'],
    points: () => pts,
    down(e, ed) {
      if (e.button === 2) {
        if (pts.length) pts.pop();
      } else {
        pts.push({ x: e.x, y: e.y });
      }
      ed.emit('path');
      ed.requestOverlay();
      if (e.button !== 2) ed.toast(pts.length < 2 ? 'Click the next point. Enter paints the path.' : `${pts.length} points. Enter paints, right-click undoes, Esc clears.`);
    },
    deactivate(ed) {
      const n = pts.length;
      if (n >= 2) paint(ed);
      else pts = [];
      ed.emit('path');
    },
    cancel(ed) {
      if (!pts.length) return;
      pts = [];
      ed.toast('Path cleared.');
      ed.emit('path');
      ed.requestOverlay();
    },
    overlay(ctx, ed, v) {
      if (pts.length < 1 || !v?.toScreen) return;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      pts.forEach((p, i) => {
        const s = v.toScreen(p.x, p.y);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      if (pts.length > 1) ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffd65a';
      for (const p of pts) {
        const s = v.toScreen(p.x, p.y);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  };
}

export const pathTools = () => [pathTool()];
