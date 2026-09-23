// The document's selection: an immutable coverage mask (or null = nothing selected).
import { maskBounds, maskOutline, rleEncode, rleDecode } from '../core/mask.js';
import { makeCanvas, ctx2d } from './layer.js';

export class Selection {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.mask = null;
    this.bounds = null;
    this.version = 0;
    this.liveOffset = null; // {x,y} while pixels are being dragged; only used for drawing
    this.#cache = {};
  }
  #cache;

  get active() { return this.mask !== null; }

  /** Bounds of the selection, or the whole canvas when nothing is selected. */
  clipRect() {
    return this.bounds ?? { x: 0, y: 0, w: this.width, h: this.height };
  }

  set(mask) {
    const b = mask ? maskBounds(mask) : null;
    this.mask = b ? mask : null;
    this.bounds = b;
    this.version++;
  }

  clear() { this.set(null); }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.clear();
  }

  snapshot() {
    return this.mask ? { width: this.width, height: this.height, rle: rleEncode(this.mask.data) } : null;
  }

  restore(snap) {
    this.set(snap ? { width: snap.width, height: snap.height, data: rleDecode(snap.rle, snap.width * snap.height) } : null);
  }

  /** Coverage of pixel (x,y) 0..255; 255 everywhere when nothing is selected. */
  coverage(x, y) {
    if (!this.mask) return 255;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.mask.data[y * this.width + x];
  }

  /** Canvas whose alpha channel is the mask (cached per version). */
  maskCanvas() {
    if (this.#cache.canvas && this.#cache.canvasV === this.version) return this.#cache.canvas;
    const c = makeCanvas(this.width, this.height), cx = ctx2d(c);
    const img = cx.createImageData(this.width, this.height), d = img.data, m = this.mask.data;
    for (let i = 0; i < m.length; i++) d[i * 4 + 3] = m[i];
    cx.putImageData(img, 0, 0);
    this.#cache.canvas = c;
    this.#cache.canvasV = this.version;
    return c;
  }

  /** Marching-ants geometry as a Path2D in image space (cached per version). */
  outline() {
    if (this.#cache.outline && this.#cache.outlineV === this.version) return this.#cache.outline;
    const seg = maskOutline(this.mask), path = new Path2D();
    for (let i = 0; i < seg.length; i += 4) { path.moveTo(seg[i], seg[i + 1]); path.lineTo(seg[i + 2], seg[i + 3]); }
    this.#cache.outline = { path, segments: seg.length / 4 };
    this.#cache.outlineV = this.version;
    return this.#cache.outline;
  }
}
