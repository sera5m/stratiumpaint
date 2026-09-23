import test from 'node:test';
import assert from 'node:assert/strict';

import { createImage } from '../src/js/core/image.js';
import { flipImage, rotateImage, resizeImage, resizeCanvas } from '../src/js/core/transform.js';
import { rectMask } from '../src/js/core/mask.js';
import { ADJUSTMENTS, defaultParams } from '../src/js/core/adjustments.js';
import { Doc } from '../src/js/doc/document.js';
import { applyFilter, FilterSession, eraseSelection, fillSelection, extractSelection, pasteImage } from '../src/js/doc/ops.js';

const px = (img, x, y) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const setPx = (img, x, y, c) => img.data.set(c, (y * img.width + x) * 4);
const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255];
const adj = (id) => ADJUSTMENTS.find((a) => a.id === id);

function labelled() { // 3x2 image with distinct pixels
  const img = createImage(3, 2);
  for (let i = 0; i < 6; i++) img.data.set([i * 40, 0, 0, 255], i * 4);
  return img;
}

// ---------------------------------------------------------------- transforms

test('flip twice is the identity, and flips move the right pixels', () => {
  const img = labelled();
  assert.deepEqual(px(flipImage(img, true), 0, 0), px(img, 2, 0));
  assert.deepEqual(px(flipImage(img, false), 0, 0), px(img, 0, 1));
  assert.deepEqual(flipImage(flipImage(img, true), true).data, img.data);
  assert.deepEqual(flipImage(flipImage(img, false), false).data, img.data);
});

test('rotate: clockwise puts top-left in the top-right; four turns are the identity', () => {
  const img = labelled();
  const cw = rotateImage(img, 1);
  assert.equal(cw.width, 2); assert.equal(cw.height, 3);
  assert.deepEqual(px(cw, 1, 0), px(img, 0, 0));
  assert.deepEqual(px(cw, 1, 2), px(img, 2, 0));
  const ccw = rotateImage(img, 3);
  assert.deepEqual(px(ccw, 0, 2), px(img, 0, 0));
  assert.deepEqual(rotateImage(rotateImage(rotateImage(rotateImage(img, 1), 1), 1), 1).data, img.data);
  assert.deepEqual(rotateImage(rotateImage(img, 2), 2).data, img.data);
});

test('resize: shrinking averages, same size is (nearly) unchanged, nearest keeps hard pixels', () => {
  const chk = createImage(2, 2);
  setPx(chk, 0, 0, [255, 255, 255, 255]); setPx(chk, 1, 1, [255, 255, 255, 255]);
  setPx(chk, 1, 0, [0, 0, 0, 255]); setPx(chk, 0, 1, [0, 0, 0, 255]);
  const one = resizeImage(chk, 1, 1);
  assert.ok(Math.abs(one.data[0] - 128) <= 1 && one.data[3] === 255);

  const img = labelled();
  const same = resizeImage(img, 3, 2);
  for (let i = 0; i < img.data.length; i++) assert.ok(Math.abs(same.data[i] - img.data[i]) <= 1);

  const big = resizeImage(img, 6, 4, 'nearest');
  assert.deepEqual(px(big, 0, 0), px(img, 0, 0));
  assert.deepEqual(px(big, 5, 3), px(img, 2, 1));
});

test('resize keeps transparent pixels from bleeding colour', () => {
  const img = createImage(2, 1);
  setPx(img, 0, 0, [255, 0, 0, 255]); // right pixel stays fully transparent (and black)
  const out = resizeImage(img, 1, 1);
  assert.equal(out.data[0], 255); // still pure red, not darkened by the transparent neighbour
  assert.ok(Math.abs(out.data[3] - 128) <= 1);
});

test('resizeCanvas anchors content', () => {
  const img = createImage(1, 1);
  setPx(img, 0, 0, RED);
  assert.deepEqual(px(resizeCanvas(img, 3, 3, 0, 0), 0, 0), RED);
  assert.deepEqual(px(resizeCanvas(img, 3, 3, 1, 1), 2, 2), RED);
  assert.deepEqual(px(resizeCanvas(img, 3, 3, 0.5, 0.5), 1, 1), RED);
});

// ---------------------------------------------------------------- layers

test('add / delete / move / duplicate layers with undo and redo', () => {
  const d = new Doc(4, 4, { background: { r: 255, g: 255, b: 255 } });
  assert.equal(d.layers.length, 1);
  assert.equal(d.deleteLayer(), false, 'the last layer cannot be deleted');

  const a = d.addLayer();
  assert.equal(d.layers.length, 2); assert.equal(d.layer, a);
  d.undo();
  assert.equal(d.layers.length, 1); assert.equal(d.active, 0);
  d.redo();
  assert.equal(d.layers.length, 2); assert.equal(d.layer, a);

  d.moveLayer(-1);
  assert.equal(d.layers[0], a); assert.equal(d.active, 0);
  d.undo();
  assert.equal(d.layers[1], a); assert.equal(d.active, 1);

  const copy = d.duplicateLayer();
  assert.equal(copy.name, `${a.name} copy`);
  assert.equal(d.layers.length, 3);
  d.deleteLayer();
  assert.equal(d.layers.length, 2);
  d.undo();
  assert.equal(d.layers.length, 3); assert.equal(d.layer, copy);
});

test('layer properties are undoable and a no-op records nothing', () => {
  const d = new Doc(2, 2);
  const l = d.layer;
  assert.equal(d.setLayerProps(l, { name: 'Background' }), false);
  assert.equal(d.history.entries().length, 0);
  d.setLayerProps(l, { opacity: 0.5, visible: false, blend: 'multiply' });
  assert.equal(l.opacity, 0.5); assert.equal(l.visible, false); assert.equal(l.blend, 'multiply');
  d.undo();
  assert.equal(l.opacity, 1); assert.equal(l.visible, true); assert.equal(l.blend, 'source-over');
  d.redo();
  assert.equal(l.blend, 'multiply');
});

test('mergeDown blends the top layer into the one below and is one undo step', () => {
  const d = new Doc(2, 1, { background: { r: 0, g: 0, b: 255 } });
  const top = d.addLayer();
  setPx(top.img, 0, 0, RED);
  d.mergeDown();
  assert.equal(d.layers.length, 1);
  assert.deepEqual(px(d.layer.img, 0, 0), RED);
  assert.deepEqual(px(d.layer.img, 1, 0), BLUE);
  assert.equal(d.history.entries().at(-1).name, 'Merge Layer Down');
  d.undo();
  assert.equal(d.layers.length, 2);
  assert.deepEqual(px(d.layers[0].img, 0, 0), BLUE);
  assert.deepEqual(px(top.img, 0, 0), RED);
});

test('flatten collapses the stack and undoes cleanly', () => {
  const d = new Doc(2, 1, { background: { r: 0, g: 0, b: 255 } });
  const top = d.addLayer();
  setPx(top.img, 1, 0, RED);
  d.flatten();
  assert.equal(d.layers.length, 1);
  assert.deepEqual(px(d.layer.img, 1, 0), RED);
  d.undo();
  assert.equal(d.layers.length, 2);
  assert.equal(d.layer, top);
  d.redo();
  assert.equal(d.layers.length, 1);
});

// ---------------------------------------------------------------- history & selection

test('commitRegion undo/redo restores exactly the edited pixels', async () => {
  const { cropImage } = await import('../src/js/core/image.js');
  const d = new Doc(4, 4);
  const l = d.layer, r = { x: 1, y: 1, w: 2, h: 2 };
  const before = cropImage(l.img, r);
  setPx(l.img, 1, 1, RED); setPx(l.img, 2, 2, BLUE);
  d.commitRegion(l, r, before, 'Paint');
  d.undo();
  assert.deepEqual(px(l.img, 1, 1), [0, 0, 0, 0]);
  assert.deepEqual(px(l.img, 2, 2), [0, 0, 0, 0]);
  d.redo();
  assert.deepEqual(px(l.img, 1, 1), RED);
  assert.deepEqual(px(l.img, 2, 2), BLUE);
});

test('selection changes are history steps; invert of nothing selects all', () => {
  const d = new Doc(4, 4);
  d.setSelection(rectMask(4, 4, 0, 0, 2, 2), 'Rectangle Select');
  assert.ok(d.selection);
  d.deselect();
  assert.equal(d.selection, null);
  d.undo();
  assert.ok(d.selection);
  d.undo();
  assert.equal(d.selection, null);
  d.invertSelection();
  assert.equal(d.selection.data.every((v) => v === 255), true);
});

test('transaction folds several commands into one step', () => {
  const d = new Doc(4, 4);
  d.transaction('Combo', () => {
    d.addLayer();
    d.setSelection(rectMask(4, 4, 0, 0, 1, 1));
  });
  assert.equal(d.history.entries().length, 1);
  d.undo();
  assert.equal(d.layers.length, 1); assert.equal(d.selection, null);
  d.redo();
  assert.equal(d.layers.length, 2); assert.ok(d.selection);
});

test('modified flag follows the saved point through undo and redo', () => {
  const d = new Doc(2, 2);
  assert.equal(d.modified, false);
  d.addLayer();
  assert.equal(d.modified, true);
  d.markSaved();
  assert.equal(d.modified, false);
  d.undo();
  assert.equal(d.modified, true);
  d.redo();
  assert.equal(d.modified, false);
  d.undo();
  d.addLayer(); // a different branch: the saved state is gone for good
  assert.equal(d.modified, true);
  d.undo(); d.redo();
  assert.equal(d.modified, true);
});

// ---------------------------------------------------------------- geometry

test('resize / canvas size / flip / rotate / crop change every layer and undo together', () => {
  const d = new Doc(4, 2, { background: { r: 10, g: 20, b: 30 } });
  const top = d.addLayer();
  setPx(top.img, 0, 0, RED);

  d.rotate(1);
  assert.equal(d.width, 2); assert.equal(d.height, 4);
  assert.equal(top.width, 2); assert.equal(d.layers[0].height, 4);
  assert.deepEqual(px(top.img, 1, 0), RED);
  d.undo();
  assert.equal(d.width, 4); assert.equal(d.height, 2);
  assert.deepEqual(px(top.img, 0, 0), RED);

  d.flip(true);
  assert.deepEqual(px(top.img, 3, 0), RED);
  d.undo();

  d.canvasSize(6, 4, 0, 0);
  assert.equal(d.width, 6); assert.deepEqual(px(top.img, 0, 0), RED);
  d.undo();

  d.resize(8, 4, 'nearest');
  assert.equal(d.width, 8); assert.deepEqual(px(top.img, 1, 1), RED);
  d.undo();
  assert.equal(d.width, 4);
  d.redo();
  assert.equal(d.width, 8);
});

test('crop to selection keeps only the selected area and clears partly-selected pixels', () => {
  const d = new Doc(4, 4, { background: { r: 255, g: 255, b: 255 } });
  d.setSelection(rectMask(4, 4, 1, 1, 3, 3));
  assert.equal(d.cropToSelection(), true);
  assert.equal(d.width, 2); assert.equal(d.height, 2); assert.equal(d.selection, null);
  assert.deepEqual(px(d.layer.img, 0, 0), [255, 255, 255, 255]);
  d.undo();
  assert.equal(d.width, 4);
  assert.ok(d.selection, 'the selection returns on undo');
  d.deselect();
  assert.equal(d.cropToSelection(), false);
});

// ---------------------------------------------------------------- pixel ops

test('applyFilter honours the selection and is one undo step', () => {
  const d = new Doc(4, 1, { background: { r: 10, g: 20, b: 30 } });
  d.setSelection(rectMask(4, 1, 0, 0, 2, 1));
  assert.equal(applyFilter(d, d.layer, adj('invert'), {}), true);
  assert.deepEqual(px(d.layer.img, 0, 0), [245, 235, 225, 255]);
  assert.deepEqual(px(d.layer.img, 3, 0), [10, 20, 30, 255], 'outside the selection is untouched');
  d.undo();
  assert.deepEqual(px(d.layer.img, 0, 0), [10, 20, 30, 255]);
  d.redo();
  assert.deepEqual(px(d.layer.img, 1, 0), [245, 235, 225, 255]);
});

test('FilterSession previews repeatedly, cancel restores, commit records once', () => {
  const d = new Doc(2, 1, { background: { r: 100, g: 100, b: 100 } });
  const spec = adj('brightness-contrast');
  const s = new FilterSession(d, d.layer, spec);
  s.preview({ ...defaultParams(spec), brightness: 50 });
  const bright = px(d.layer.img, 0, 0)[0];
  assert.ok(bright > 100);
  s.preview({ ...defaultParams(spec), brightness: -50 });
  assert.ok(px(d.layer.img, 0, 0)[0] < 100);
  s.cancel();
  assert.deepEqual(px(d.layer.img, 0, 0), [100, 100, 100, 255]);
  assert.equal(d.history.entries().length, 0);

  s.preview({ ...defaultParams(spec), brightness: 50 });
  s.commit();
  assert.equal(d.history.entries().length, 1);
  assert.equal(px(d.layer.img, 0, 0)[0], bright);
  d.undo();
  assert.deepEqual(px(d.layer.img, 0, 0), [100, 100, 100, 255]);
});

test('an empty selection makes filters do nothing', () => {
  const d = new Doc(2, 2, { background: { r: 1, g: 2, b: 3 } });
  d.setSelection(rectMask(2, 2, 0, 0, 0, 0));
  assert.equal(applyFilter(d, d.layer, adj('invert'), {}), false);
  assert.equal(eraseSelection(d, d.layer), false);
});

test('erase and fill selection', () => {
  const d = new Doc(3, 1, { background: { r: 255, g: 255, b: 255 } });
  d.setSelection(rectMask(3, 1, 1, 0, 2, 1));
  eraseSelection(d, d.layer);
  assert.equal(px(d.layer.img, 1, 0)[3], 0);
  assert.equal(px(d.layer.img, 0, 0)[3], 255);
  fillSelection(d, d.layer, { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(px(d.layer.img, 1, 0), RED);
  d.undo(); d.undo();
  assert.equal(px(d.layer.img, 1, 0)[3], 255);

  d.deselect();
  eraseSelection(d, d.layer); // nothing selected = the whole layer
  assert.equal(px(d.layer.img, 0, 0)[3], 0);
});

test('extractSelection + pasteImage round trip', () => {
  const d = new Doc(4, 4);
  setPx(d.layer.img, 1, 1, RED);
  d.setSelection(rectMask(4, 4, 1, 1, 3, 3));
  const got = extractSelection(d, d.layer);
  assert.equal(got.img.width, 2); assert.equal(got.x, 1);
  assert.deepEqual(px(got.img, 0, 0), RED);

  d.deselect();
  const before = d.history.entries().length;
  pasteImage(d, got.img, 0, 0);
  assert.equal(d.history.entries().length, before + 1, 'paste is a single step');
  assert.equal(d.layers.length, 2);
  assert.deepEqual(px(d.layer.img, 0, 0), RED);
  assert.ok(d.selection);
  d.undo();
  assert.equal(d.layers.length, 1);
  assert.equal(d.selection, null);
});
