// Paint bucket and gradient.
import { cropImage, stampImage } from '../core/image.js';
import { combineMasks, maskBounds } from '../core/mask.js';
import { floodMask } from '../core/flood.js';
import { fillMask, renderGradient } from '../core/fill.js';
import { targetRegion } from '../doc/ops.js';
import { paintImage } from '../doc/raster.js';
import { colorFor, withOpacity } from './common.js';
import { fillFaces, facePixelBounds, groupFaces, mirrorFace } from '../core/symmetry.js';

function bucket() {
  return {
    id: 'bucket', name: 'Paint Bucket', key: 'F', group: 'fill', cursor: 'crosshair',
    options: ['tolerance', 'flood', 'opacity', 'pattern', 'patternSize'],
    down(e, ed) {
      const layer = ed.editableLayer();
      if (!layer) return;
      const doc = ed.doc, x = Math.floor(e.x), y = Math.floor(e.y), o = ed.opts;
      if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
      let m = floodMask(layer.img, x, y, o.tolerance, o.flood === 'contiguous');
      if (doc.selection) m = combineMasks(doc.selection, m, 'intersect');
      const b = maskBounds(m);
      if (!b) return;
      const before = cropImage(layer.img, b);
      const primary = withOpacity(colorFor(ed, e), o.opacity);
      const other = withOpacity(e.button === 2 ? ed.primary : ed.secondary, o.opacity);
      fillMask(layer.img, m, primary, o.pattern === 'solid' ? {} : { pattern: o.pattern, secondary: other, patternSize: o.patternSize });
      layer.touch(b);
      doc.commitRegion(layer, b, before, 'Paint Bucket');
    },
  };
}

function gradient() {
  let S = null;

  const render = (ed, s) => {
    const { layer, region, before } = s;
    stampImage(layer.img, before, region.x, region.y);
    const img = renderGradient(region, ed.opts.gradient, s.p0, s.p1, s.c0, s.c1, ed.doc.selection, ed.doc.width);
    paintImage(layer.img, img, region.x, region.y, null, 1);
    layer.touch(region);
  };

  return {
    id: 'gradient', name: 'Gradient', key: 'G', group: 'fill', cursor: 'crosshair',
    options: ['gradient', 'gradientMode', 'opacity'],
    down(e, ed) {
      const layer = ed.editableLayer();
      if (!layer) return;
      const region = targetRegion(ed.doc);
      if (!region) return;
      const o = ed.opts, swap = e.button === 2;
      const c0 = withOpacity(swap ? ed.secondary : ed.primary, o.opacity);
      let c1 = withOpacity(swap ? ed.primary : ed.secondary, o.opacity);
      if (o.gradientMode === 'alpha') c1 = { ...c0, a: 0 };
      S = {
        layer, region, before: cropImage(layer.img, region), p0: { x: e.x, y: e.y }, p1: { x: e.x, y: e.y }, moved: false,
        c0, c1,
      };
    },
    move(e, ed) {
      if (!S) return;
      S.p1 = { x: e.x, y: e.y };
      S.moved = true;
      render(ed, S);
      ed.requestOverlay();
    },
    up(e, ed) {
      if (!S) return;
      const s = S;
      S = null;
      ed.requestOverlay();
      if (!s.moved || (s.p0.x === s.p1.x && s.p0.y === s.p1.y)) {
        stampImage(s.layer.img, s.before, s.region.x, s.region.y);
        s.layer.touch(s.region);
        return;
      }
      ed.doc.commitRegion(s.layer, s.region, s.before, 'Gradient');
    },
    cancel(ed) {
      if (!S) return;
      const s = S;
      S = null;
      stampImage(s.layer.img, s.before, s.region.x, s.region.y);
      s.layer.touch(s.region);
      ed?.requestOverlay();
    },
    overlay(ctx, ed, v) {
      if (!S || !S.moved) return;
      const a = v.toScreen(S.p0.x, S.p0.y), b = v.toScreen(S.p1.x, S.p1.y);
      ctx.save();
      ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.stroke();
      for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.stroke(); }
      ctx.restore();
    },
  };
}

function polyFill() {
  return {
    id: 'poly-fill', name: 'Polygon Fill', key: 'Y', group: 'fill', cursor: 'crosshair',
    options: ['opacity', 'polyScope', 'symmetry'],
    down(e, ed) {
      const mount = ed.doc?.mount;
      if (e.face == null || !mount?.uvs) {
        ed.toast('Polygon fill paints a face of the model. Click the 3D view.');
        return;
      }
      const layer = ed.editableLayer();
      if (!layer) return;
      const triCount = mount.uvs.length / 6;
      let faces = (ed.opts.polyScope === 'object' || e.shift)
        ? groupFaces(mount.groups, e.face, triCount)
        : [e.face];
      if (ed.opts.symmetry && ed.opts.symmetry !== 'none') {
        const have = new Set(faces);
        const extra = [];
        for (const f of faces) {
          const m = mirrorFace(mount, f, ed.opts.symmetry);
          if (m >= 0 && !have.has(m)) { have.add(m); extra.push(m); }
        }
        faces = faces.concat(extra);
      }
      const doc = ed.surface();
      const color = withOpacity(colorFor(ed, e), ed.opts.opacity);
      const rect = facePixelBounds(mount.uvs, faces, layer.width, layer.height);
      if (!rect) { ed.toast('That face has no pixels to fill.'); return; }
      const before = cropImage(layer.img, rect);
      if (!fillFaces(layer.img, mount.uvs, faces, color, doc.selection)) {
        ed.toast('That face has no pixels to fill.');
        return;
      }
      layer.touch(rect);
      doc.commitRegion(layer, rect, before, 'Polygon Fill');
    },
  };
}

export const fillTools = () => [bucket(), gradient(), polyFill()];
