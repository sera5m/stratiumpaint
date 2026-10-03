// One raster layer. `img` (RGBA, straight alpha) is the source of truth and is what tools and
// effects edit. `canvas` is a lazily-synced mirror used only for compositing on screen.
import { createImage } from '../core/image.js';
import { rectUnion, rectIntersect } from '../core/util.js';

let seq = 0;

export function claimLayerId(layer, id) {
  const n = +id;
  if (!Number.isFinite(n) || n <= 0) return;
  layer.id = n;
  if (n > seq) seq = n;
}

export class Layer {
  constructor(width, height, name = 'Layer') {
    this.id = ++seq;
    this.name = name;
    this.visible = true;
    this.opacity = 1; // 0..1
    this.blend = 'source-over';
    this.img = createImage(width, height);
    this.version = 0;
    this.onTouch = null; // set by the owning document
    this._canvas = null;
    this._dirty = null; // rect awaiting upload to the canvas, or 'all'
  }

  get width() { return this.img.width; }
  get height() { return this.img.height; }

  /** Call after editing `img`. Omit `r` when everything may have changed. */
  touch(r) {
    this.version++;
    if (this._canvas) {
      if (!r || this._dirty === 'all') this._dirty = 'all';
      else this._dirty = this._dirty ? rectUnion(this._dirty, r) : r;
    }
    this.onTouch?.(r);
  }

  /** Swap in a whole new pixel buffer (resize, rotate, undo of those…). */
  replaceImage(img) {
    this.img = img;
    this._canvas = null;
    this._dirty = null;
    this.touch();
  }

  /** Canvas mirror of `img`, brought up to date on demand (browser only). */
  get canvas() {
    const { width: w, height: h } = this.img;
    if (!this._canvas) {
      this._canvas = document.createElement('canvas');
      this._canvas.width = w;
      this._canvas.height = h;
      this._dirty = 'all';
    }
    if (this._dirty) {
      const ctx = this._canvas.getContext('2d');
      const id = new ImageData(this.img.data, w, h);
      if (this._dirty === 'all') ctx.putImageData(id, 0, 0);
      else {
        const r = rectIntersect(this._dirty, { x: 0, y: 0, w, h });
        if (r) ctx.putImageData(id, 0, 0, r.x, r.y, r.w, r.h);
      }
      this._dirty = null;
    }
    return this._canvas;
  }
}
