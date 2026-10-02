// The document model: layers, selection, undo history, and whole-image geometry operations.
// Every user-visible change goes through a method here so it lands in history exactly once.
//
// Events: 'render' (pixels changed) · 'layers' · 'selection' · 'size' · 'history' · 'meta'
import { Emitter, clamp } from '../core/util.js';
import { History } from '../core/history.js';
import { cropImage, cloneImage } from '../core/image.js';
import { flipImage, rotateImage, resizeImage, resizeCanvas } from '../core/transform.js';
import { invertMask, maskBounds, rectMask } from '../core/mask.js';
import { Layer } from './layer.js';
import { paintImage, createCanvas } from './raster.js';

const HAS_DOM = typeof document !== 'undefined';

export class Doc extends Emitter {
  constructor(width, height, { name = 'Untitled', background = null } = {}) {
    super();
    this.width = width;
    this.height = height;
    this.name = name;
    this.path = null;
    this.format = null; // file format it was opened from / last saved as
    this.quality = null; // last JPEG/WebP quality chosen
    this.backupKey = Math.random().toString(36).slice(2, 10);
    this.layers = [];
    this.active = 0;
    this.selection = null; // Uint8 mask the size of the document, or null = nothing selected
    this.history = new History();
    this.savedIndex = -1;
    this.viewState = null; // remembered zoom/pan, owned by the view
    this._tx = null;
    this._layerCount = 0;
    this._comp = null;
    this._compDirty = true;
    this.history.on('change', () => { this.emit('history'); this.emit('meta'); });

    const bg = this._adopt(new Layer(width, height, 'Background'));
    if (background) {
      const d = bg.img.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = background.r; d[i + 1] = background.g; d[i + 2] = background.b; d[i + 3] = Math.round((background.a ?? 1) * 255);
      }
    }
    this.layers.push(bg);
  }

  get layer() { return this.layers[this.active]; }
  get modified() { return this.history.index !== this.savedIndex; }
  markSaved() { this.savedIndex = this.history.index; this.emit('meta'); }
  rename(name, path = this.path) { this.name = name; this.path = path; this.emit('meta'); }

  /** Replace the layer stack without touching history (used when loading a file). Bottom-most first. */
  setLayers(list) {
    this.layers = list.map((l) => this._adopt(l));
    this.active = this.layers.length - 1;
    this._layerCount = this.layers.length;
    this._compDirty = true;
    this.emit('layers');
    this.emit('render');
  }

  _adopt(layer) {
    layer.onTouch = () => this._invalidate();
    return layer;
  }

  _invalidate() {
    this._compDirty = true;
    this.emit('render');
  }

  // ------------------------------------------------------------------ history plumbing

  push(cmd) {
    if (this._tx) { this._tx.push(cmd); return; }
    if (this.savedIndex > this.history.index) this.savedIndex = NaN; // the saved state is about to be discarded
    this.history.push(cmd);
  }

  /** Run fn and record everything it pushes as one history step. */
  transaction(name, fn) {
    if (this._tx) return fn();
    const cmds = [];
    this._tx = cmds;
    try {
      return fn();
    } finally {
      this._tx = null;
      if (cmds.length) {
        this.push({
          name,
          bytes: cmds.reduce((n, c) => n + (c.bytes ?? 0), 0),
          undo: () => { for (let i = cmds.length - 1; i >= 0; i--) cmds[i].undo(); },
          redo: () => { for (const c of cmds) c.redo(); },
        });
      }
    }
  }

  /** Record a pixel edit that has ALREADY been applied to `layer` inside rect r. */
  commitRegion(layer, r, before, name) {
    const after = cropImage(layer.img, r);
    const put = (src) => {
      const w = layer.img.width;
      for (let y = 0; y < r.h; y++) layer.img.data.set(src.data.subarray(y * r.w * 4, (y + 1) * r.w * 4), ((r.y + y) * w + r.x) * 4);
      layer.touch(r);
    };
    this.push({ name, bytes: before.data.length + after.data.length, undo: () => put(before), redo: () => put(after) });
  }

  undo() { return this.history.undo(); }
  redo() { return this.history.redo(); }

  // ------------------------------------------------------------------ compositing

  /** Canvas holding the visible layers blended together (browser only). Cached until something changes. */
  composite() {
    if (!this._comp) this._comp = createCanvas(this.width, this.height);
    if (this._comp.width !== this.width || this._comp.height !== this.height) {
      this._comp.width = this.width;
      this._comp.height = this.height;
      this._compDirty = true;
    }
    if (this._compDirty) {
      const ctx = this._comp.getContext('2d');
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, this.width, this.height);
      for (const l of this.layers) {
        if (!l.visible || l.opacity <= 0) continue;
        ctx.globalAlpha = l.opacity;
        ctx.globalCompositeOperation = l.blend;
        ctx.drawImage(l.canvas, 0, 0);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      this._compDirty = false;
    }
    return this._comp;
  }

  /** Flattened pixels. Uses the canvas when there is one; otherwise a plain source-over stack (tests). */
  compositeImage() {
    if (HAS_DOM) {
      const id = this.composite().getContext('2d').getImageData(0, 0, this.width, this.height);
      return { width: this.width, height: this.height, data: id.data };
    }
    const out = { width: this.width, height: this.height, data: new Uint8ClampedArray(this.width * this.height * 4) };
    for (const l of this.layers) if (l.visible) paintImage(out, l.img, 0, 0, null, l.opacity);
    return out;
  }

  /** Colour of one pixel: from the flattened image (browser) or the active layer. null when outside. */
  pixelAt(x, y, fromImage = false) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    if (fromImage && HAS_DOM) {
      const d = this.composite().getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    }
    const d = this.layer.img.data, i = (y * this.width + x) * 4;
    return { r: d[i], g: d[i + 1], b: d[i + 2], a: d[i + 3] / 255 };
  }

  // ------------------------------------------------------------------ layers

  _nextName() { return `Layer ${++this._layerCount}`; }

  selectLayer(i) {
    i = clamp(i, 0, this.layers.length - 1);
    if (i === this.active) return;
    this.active = i;
    this.emit('layers');
  }

  addLayer({ name, layer, index = this.active + 1, historyName = 'Add New Layer' } = {}) {
    const l = this._adopt(layer ?? new Layer(this.width, this.height, name ?? this._nextName()));
    const prevActive = this.active;
    index = clamp(index, 0, this.layers.length);
    const insert = () => { this.layers.splice(index, 0, l); this.active = index; this._layersChanged(); };
    const remove = () => {
      this.layers.splice(this.layers.indexOf(l), 1);
      this.active = clamp(prevActive, 0, this.layers.length - 1);
      this._layersChanged();
    };
    insert();
    this.push({ name: historyName, bytes: 0, undo: remove, redo: insert });
    return l;
  }

  deleteLayer(i = this.active) {
    if (this.layers.length < 2 || i < 0 || i >= this.layers.length) return false;
    const l = this.layers[i];
    const prevActive = this.active;
    const nextActive = i === prevActive ? Math.max(0, i - 1) : i < prevActive ? prevActive - 1 : prevActive;
    const remove = () => { this.layers.splice(this.layers.indexOf(l), 1); this.active = nextActive; this._layersChanged(); };
    const restore = () => { this.layers.splice(i, 0, l); this.active = prevActive; this._layersChanged(); };
    remove();
    this.push({ name: 'Delete Layer', bytes: 0, undo: restore, redo: remove });
    return true;
  }

  duplicateLayer() {
    const src = this.layer;
    const l = new Layer(this.width, this.height, `${src.name} copy`);
    l.replaceImage(cloneImage(src.img));
    Object.assign(l, { visible: src.visible, opacity: src.opacity, blend: src.blend });
    return this.addLayer({ layer: l, historyName: 'Duplicate Layer' });
  }

  /** dir +1 raises the active layer, -1 lowers it. */
  moveLayer(dir) {
    const i = this.active, j = i + dir;
    if (j < 0 || j >= this.layers.length) return false;
    const swap = (a, b) => {
      [this.layers[a], this.layers[b]] = [this.layers[b], this.layers[a]];
      this.active = b;
      this._layersChanged();
    };
    swap(i, j);
    this.push({ name: dir > 0 ? 'Move Layer Up' : 'Move Layer Down', bytes: 0, undo: () => swap(j, i), redo: () => swap(i, j) });
    return true;
  }

  /** Change name / visible / opacity / blend as one history step. */
  setLayerProps(layer, props, name = 'Layer Properties') {
    const before = {}, after = {};
    for (const k of Object.keys(props)) {
      if (layer[k] !== props[k]) { before[k] = layer[k]; after[k] = props[k]; }
    }
    if (!Object.keys(after).length) return false;
    const apply = (p) => { Object.assign(layer, p); this._layersChanged(); };
    apply(after);
    this.push({ name, bytes: 0, undo: () => apply(before), redo: () => apply(after) });
    return true;
  }

  mergeDown() {
    const i = this.active;
    if (i <= 0) return false;
    const top = this.layers[i], below = this.layers[i - 1];
    this.transaction('Merge Layer Down', () => {
      if (top.visible) {
        const r = { x: 0, y: 0, w: this.width, h: this.height };
        const before = cropImage(below.img, r);
        this._mergeInto(below, top);
        below.touch(r);
        this.commitRegion(below, r, before, 'Merge');
      }
      this.deleteLayer(i);
    });
    return true;
  }

  _mergeInto(dst, src) {
    if (HAS_DOM && src.blend !== 'source-over') {
      const c = createCanvas(this.width, this.height), ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(dst.canvas, 0, 0);
      ctx.globalAlpha = src.opacity;
      ctx.globalCompositeOperation = src.blend;
      ctx.drawImage(src.canvas, 0, 0);
      dst.img.data.set(ctx.getImageData(0, 0, this.width, this.height).data);
    } else {
      paintImage(dst.img, src.img, 0, 0, null, src.opacity);
    }
  }

  flatten() {
    if (this.layers.length < 2) return false;
    this._snapshotOp('Flatten', () => {
      const flat = new Layer(this.width, this.height, 'Background');
      flat.replaceImage(this.compositeImage());
      this.layers = [this._adopt(flat)];
      this.active = 0;
    });
    return true;
  }

  /** Re-composite and notify listeners after properties were changed directly (live previews). */
  refresh() { this._layersChanged(); }

  _layersChanged() {
    this._compDirty = true;
    this.emit('layers');
    this.emit('render');
  }

  // ------------------------------------------------------------------ selection

  setSelection(mask, name = 'Select') {
    const before = this.selection;
    if (before === mask) return false;
    const set = (m) => { this.selection = m; this.emit('selection'); };
    set(mask);
    this.push({ name, bytes: 0, undo: () => set(before), redo: () => set(mask) });
    return true;
  }

  selectAll() { return this.setSelection(rectMask(this.width, this.height, 0, 0, this.width, this.height), 'Select All'); }
  deselect() { return this.selection ? this.setSelection(null, 'Deselect') : false; }
  invertSelection() {
    return this.setSelection(this.selection ? invertMask(this.selection) : rectMask(this.width, this.height, 0, 0, this.width, this.height), 'Invert Selection');
  }

  // ------------------------------------------------------------------ whole-image geometry

  _snapshot() {
    return {
      w: this.width, h: this.height, layers: this.layers.slice(), imgs: this.layers.map((l) => l.img),
      active: this.active, selection: this.selection,
    };
  }

  _restore(s) {
    this.width = s.w;
    this.height = s.h;
    this.layers = s.layers.slice();
    s.layers.forEach((l, i) => l.replaceImage(s.imgs[i]));
    this.active = s.active;
    this.selection = s.selection;
    this._compDirty = true;
    this.emit('size');
    this.emit('layers');
    this.emit('selection');
    this.emit('render');
  }

  _snapshotOp(name, mutate) {
    const before = this._snapshot();
    mutate();
    const after = this._snapshot();
    const bytes = (s) => s.imgs.reduce((n, im) => n + im.data.length, 0);
    this.push({ name, bytes: bytes(before) + bytes(after), undo: () => this._restore(before), redo: () => this._restore(after) });
    this._restore(after); // re-emit everything once, the same way undo/redo would
  }

  _geometry(name, w, h, mapImage) {
    this._snapshotOp(name, () => {
      this.width = w;
      this.height = h;
      this.selection = null;
      for (const l of this.layers) l.replaceImage(mapImage(l.img));
    });
  }

  resize(w, h, mode = 'smooth') {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    this._geometry('Resize Image', w, h, (img) => resizeImage(img, w, h, mode));
  }

  canvasSize(w, h, ax = 0.5, ay = 0.5) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    this._geometry('Resize Canvas', w, h, (img) => resizeCanvas(img, w, h, ax, ay));
  }

  flip(horizontal) {
    this._geometry(horizontal ? 'Flip Horizontal' : 'Flip Vertical', this.width, this.height, (img) => flipImage(img, horizontal));
  }

  /** turns: 1 = 90° clockwise, 2 = 180°, 3 = 90° counter-clockwise */
  rotate(turns) {
    const names = { 1: 'Rotate 90° Clockwise', 2: 'Rotate 180°', 3: 'Rotate 90° Counter-clockwise' };
    const odd = turns % 2 === 1;
    this._geometry(names[turns], odd ? this.height : this.width, odd ? this.width : this.height, (img) => rotateImage(img, turns));
  }

  cropToSelection() {
    const mask = this.selection;
    const b = mask && maskBounds(mask);
    if (!b) return false;
    let partial = false;
    for (let y = 0; y < b.h && !partial; y++) {
      for (let x = 0; x < b.w; x++) if (mask.data[(b.y + y) * mask.width + b.x + x] < 255) { partial = true; break; }
    }
    this._geometry('Crop to Selection', b.w, b.h, (img) => {
      const out = cropImage(img, b);
      if (partial) {
        for (let y = 0; y < b.h; y++) {
          for (let x = 0; x < b.w; x++) {
            const m = mask.data[(b.y + y) * mask.width + b.x + x];
            if (m < 255) out.data[(y * b.w + x) * 4 + 3] = (out.data[(y * b.w + x) * 4 + 3] * m) / 255;
          }
        }
      }
      return out;
    });
    return true;
  }
}
