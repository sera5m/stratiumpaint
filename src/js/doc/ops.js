// Pixel operations on a document's active layer. All DOM-free, all recorded in history.
import { cropImage, cloneImage, stampImage, blendByMask } from '../core/image.js';
import { maskBounds, rectMask } from '../core/mask.js';
import { fillMask } from '../core/fill.js';
import { rectGrow, rectIntersect } from '../core/util.js';
import { paintImage } from './raster.js';

/**
 * The area an operation should touch: selection bounds (or the whole layer), grown by `margin`
 * so neighbourhood effects can see past the edge. null when the selection is empty.
 * `ignoreSelection` treats the document as if nothing were selected (the "whole image" toggle).
 */
export function targetRegion(doc, margin = 0, ignoreSelection = false) {
  const full = { x: 0, y: 0, w: doc.width, h: doc.height };
  let base = full;
  if (doc.selection && !ignoreSelection) {
    base = maskBounds(doc.selection);
    if (!base) return null;
  }
  return rectIntersect(rectGrow(base, margin), full);
}

/**
 * Previewable adjustment / effect. preview(params) can be called repeatedly (dialog sliders);
 * commit() records one history step; cancel() puts the layer back.
 * `ignoreSelection` applies across the whole layer even when a selection is active.
 */
export class FilterSession {
  constructor(doc, layer, spec, { ignoreSelection = false } = {}) {
    this.doc = doc;
    this.layer = layer;
    this.spec = spec;
    this.ignoreSelection = ignoreSelection;
    this.orig = cloneImage(layer.img);
    this.dirty = null;
  }

  #restore() {
    if (!this.dirty) return;
    const r = this.dirty;
    stampImage(this.layer.img, cropImage(this.orig, r), r.x, r.y);
    this.layer.touch(r);
    this.dirty = null;
  }

  preview(params) {
    const { doc, layer, spec, orig, ignoreSelection } = this;
    this.#restore();
    const region = targetRegion(doc, spec.margin ? spec.margin(params) : 0, ignoreSelection);
    if (!region) return false;
    const src = cropImage(orig, region);
    const mask = ignoreSelection ? null : doc.selection;
    const merged = blendByMask(src, spec.apply(src, params), mask, region.x, region.y);
    stampImage(layer.img, merged, region.x, region.y);
    layer.touch(region);
    this.dirty = region;
    return true;
  }

  commit() {
    if (!this.dirty) return false;
    this.doc.commitRegion(this.layer, this.dirty, cropImage(this.orig, this.dirty), this.spec.name);
    this.dirty = null;
    return true;
  }

  cancel() { this.#restore(); }
}

export function applyFilter(doc, layer, spec, params, ignoreSelection = false) {
  const s = new FilterSession(doc, layer, spec, { ignoreSelection });
  return s.preview(params) && s.commit();
}

/** Clear the selected pixels (or the whole layer when nothing is selected, or `ignoreSelection`). */
export function eraseSelection(doc, layer, ignoreSelection = false) {
  const r = targetRegion(doc, 0, ignoreSelection);
  if (!r) return false;
  const before = cropImage(layer.img, r);
  const { width: w, data } = layer.img, mask = ignoreSelection ? null : doc.selection;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const m = mask ? mask.data[y * w + x] : 255;
      if (m) data[(y * w + x) * 4 + 3] = (data[(y * w + x) * 4 + 3] * (255 - m)) / 255;
    }
  }
  layer.touch(r);
  doc.commitRegion(layer, r, before, 'Erase Selection');
  return true;
}

export function fillSelection(doc, layer, color, ignoreSelection = false) {
  const r = targetRegion(doc, 0, ignoreSelection);
  if (!r) return false;
  const before = cropImage(layer.img, r);
  fillMask(layer.img, ignoreSelection ? null : doc.selection, color);
  layer.touch(r);
  doc.commitRegion(layer, r, before, 'Fill Selection');
  return true;
}

/** Selected pixels of the layer as {img, x, y} (unselected parts transparent), or null. */
export function extractSelection(doc, layer) {
  const r = targetRegion(doc);
  if (!r) return null;
  const img = cropImage(layer.img, r);
  const mask = doc.selection;
  if (mask) {
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const m = mask.data[(r.y + y) * doc.width + r.x + x];
        if (m < 255) img.data[(y * r.w + x) * 4 + 3] = (img.data[(y * r.w + x) * 4 + 3] * m) / 255;
      }
    }
  }
  return { img, x: r.x, y: r.y };
}

/** Put `img` on a new layer at (x,y), select it, and record a single "Paste" step. */
export function pasteImage(doc, img, x, y, name = 'Paste') {
  doc.transaction(name, () => {
    const layer = doc.addLayer({ name: 'Pasted' });
    const r = rectIntersect({ x, y, w: img.width, h: img.height }, { x: 0, y: 0, w: doc.width, h: doc.height });
    if (r) {
      const before = cropImage(layer.img, r);
      paintImage(layer.img, img, x, y);
      layer.touch(r);
      doc.commitRegion(layer, r, before, name);
    }
    doc.setSelection(rectMask(doc.width, doc.height, x, y, x + img.width, y + img.height), 'Select');
  });
}
