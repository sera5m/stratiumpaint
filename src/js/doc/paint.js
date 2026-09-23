// PaintSession: a scratch canvas that tools draw into. The document composites it over the active
// layer for live preview (already clipped to the selection), then commits it as one history step.
import { rectIntersect, rectUnion } from '../core/util.js';

/** Draw an overlay descriptor {canvas,x,y,alpha,op,erase} onto a 2D context. */
export function applyOverlay(ctx, ov) {
  ctx.save();
  ctx.globalAlpha = ov.alpha;
  ctx.globalCompositeOperation = ov.erase ? 'destination-out' : ov.op;
  ctx.drawImage(ov.canvas, ov.x, ov.y);
  ctx.restore();
}

export class PaintSession {
  constructor(doc, { alpha = 1, op = 'source-over', erase = false, useSelection = true } = {}) {
    this.doc = doc;
    this.layer = doc.activeLayer;
    this.raw = doc.scratch('raw');
    this.ctx = this.raw.getContext('2d');
    this.masked = useSelection && doc.selection.active;
    this.out = this.masked ? doc.scratch('out') : this.raw;
    this.dirty = null;
    this.overlay = { layer: this.layer, canvas: this.out, x: 0, y: 0, alpha, op, erase, dirty: null };
    doc.overlay = this.overlay;
    this.done = false;
  }

  /** Tools call this after drawing into `ctx`, with the (padded) area they touched. */
  touch(r) {
    r = rectIntersect({ x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.w) + 1, h: Math.ceil(r.h) + 1 },
      { x: 0, y: 0, w: this.doc.width, h: this.doc.height });
    if (!r) return;
    this.dirty = rectUnion(this.dirty, r);
    this.overlay.dirty = this.dirty;
    if (this.masked) this.#refreshMasked(r);
    this.doc.invalidate();
  }

  /** Erase everything drawn so far (for previews that are redrawn from scratch). */
  clear() {
    if (!this.dirty) return;
    const d = this.dirty;
    this.ctx.clearRect(d.x, d.y, d.w, d.h);
    if (this.masked) this.out.getContext('2d').clearRect(d.x, d.y, d.w, d.h);
    this.dirty = this.overlay.dirty = null;
  }

  /** Threshold alpha in a region: the "antialiasing off" look. */
  hardenEdges(r) {
    r = rectIntersect(r, { x: 0, y: 0, w: this.doc.width, h: this.doc.height });
    if (!r) return;
    const img = this.ctx.getImageData(r.x, r.y, r.w, r.h), d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
    this.ctx.putImageData(img, r.x, r.y);
  }

  #refreshMasked(r) {
    const c = this.out.getContext('2d');
    c.save();
    c.beginPath();
    c.rect(r.x, r.y, r.w, r.h);
    c.clip();
    c.clearRect(r.x, r.y, r.w, r.h);
    c.drawImage(this.raw, 0, 0);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(this.doc.selection.maskCanvas(), 0, 0);
    c.restore();
  }

  commit(name) {
    if (this.done) return;
    this.done = true;
    if (this.dirty) this.doc.commitOverlay(name);
    else this.doc.cancelOverlay();
  }

  cancel() {
    if (this.done) return;
    this.done = true;
    this.doc.cancelOverlay();
  }
}
