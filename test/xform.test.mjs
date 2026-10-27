import test from 'node:test';
import assert from 'node:assert/strict';

import { DEG, normAngle, snapAngle, floatMatrix, invert, apply, boxCorners, rotatedBounds, toBoxFrame, fromBoxFrame, resampleFloat, transformMask } from '../src/js/core/xform.js';
import { rectMask, maskBounds } from '../src/js/core/mask.js';
import { Editor } from '../src/js/ui/editor.js';
import { Doc } from '../src/js/doc/document.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('angles normalise and Shift-snap to 15°', () => {
  close(normAngle(3 * Math.PI), Math.PI);
  close(normAngle(-Math.PI / 2 - 2 * Math.PI), -Math.PI / 2);
  close(snapAngle(22 * DEG), 15 * DEG);
  close(snapAngle(23 * DEG), 30 * DEG);
  close(snapAngle(-7 * DEG), 0);
});

test('float matrix maps the source rect onto the turned box', () => {
  const box = { x: 10, y: 20, w: 40, h: 20 };
  const m = floatMatrix(20, 10, box, 0);
  assert.deepEqual(apply(m, 0, 0), [10, 20]);
  assert.deepEqual(apply(m, 20, 10), [50, 40]);
  const r = floatMatrix(20, 10, box, Math.PI / 2);
  const [cx, cy] = apply(r, 10, 5); // source centre stays at the box centre
  close(cx, 30); close(cy, 30);
  const [x, y] = apply(r, 20, 5); // the right edge's middle turns to below the centre
  close(x, 30); close(y, 50);
  const back = apply(invert(r), x, y);
  close(back[0], 20); close(back[1], 5);
});

test('corners, bounds and box frames agree', () => {
  const box = { x: 0, y: 0, w: 10, h: 10 };
  const c = boxCorners(box, Math.PI / 4);
  close(c[0][0], 5); close(c[0][1], 5 - Math.SQRT2 * 5);
  assert.deepEqual(rotatedBounds(box, 0), { x: 0, y: 0, w: 10, h: 10 });
  const b = rotatedBounds(box, Math.PI / 4);
  assert.ok(b.w >= 14 && b.w <= 16 && b.h >= 14 && b.h <= 16);
  const [lx, ly] = toBoxFrame(9, 2, box, 0.7);
  const [wx, wy] = fromBoxFrame(lx, ly, box, 0.7);
  close(wx, 9); close(wy, 2);
});

test('resample: no turn keeps the old exact path; a 90° turn moves pixels exactly', () => {
  const src = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) };
  const same = resampleFloat(src, { x: 3, y: 4, w: 2, h: 1 }, 0);
  assert.equal(same.img, src);
  assert.deepEqual([same.x, same.y], [3, 4]);
  // 4x2 block turned 90° clockwise about its centre lands as a 2x4 block.
  const s2 = { width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 4) };
  for (let i = 0; i < 8; i++) s2.data.set(i % 4 === 0 ? [255, 0, 0, 255] : [0, 255, 0, 255], i * 4);
  const r = resampleFloat(s2, { x: 0, y: 0, w: 4, h: 2 }, Math.PI / 2);
  assert.deepEqual([r.x, r.y, r.img.width, r.img.height], [1, -1, 2, 4]);
  const at = (x, y) => [...r.img.data.slice((y * r.img.width + x) * 4, (y * r.img.width + x) * 4 + 4)];
  assert.deepEqual(at(0, 0), [255, 0, 0, 255], 'the left column (red) is now the top row');
  assert.deepEqual(at(1, 0), [255, 0, 0, 255]);
  assert.deepEqual(at(0, 3), [0, 255, 0, 255]);
});

test('a mask turns with its box', () => {
  const m = rectMask(20, 20, 2, 8, 12, 10); // 10 wide, 2 tall
  const out = transformMask(m, { x: 2, y: 8, w: 10, h: 2 }, { x: 2, y: 8, w: 10, h: 2 }, Math.PI / 2);
  const b = maskBounds(out);
  assert.deepEqual([b.w, b.h], [2, 10]);
  assert.deepEqual([b.x, b.y], [6, 4]);
});

function session() {
  const ed = new Editor();
  const doc = new Doc(20, 20);
  ed.addDoc(doc);
  // a 6x2 red bar at (4,9)
  for (let y = 9; y < 11; y++) for (let x = 4; x < 10; x++) doc.layer.img.data.set([255, 0, 0, 255], (y * 20 + x) * 4);
  doc.setSelection(rectMask(20, 20, 4, 9, 10, 11));
  ed.setTool('move-pixels');
  return { ed, doc };
}
const alpha = (doc, x, y) => doc.layer.img.data[(y * 20 + x) * 4 + 3];

test('rotating lifted pixels lands one "Rotate" step that undoes cleanly', () => {
  const { ed, doc } = session();
  const n = doc.history.entries().length;
  assert.ok(ed.tool.setAngle(ed, 90));
  assert.equal(ed.tool.metrics(ed).angle, 90);
  assert.equal(doc.history.entries().length, n, 'turning is only visual until set-down');
  assert.equal(alpha(doc, 5, 9), 0, 'the layer holds the hole, not a resampled copy, while it floats');
  ed.commitPending();
  assert.equal(doc.history.entries().length, n + 1);
  assert.equal(doc.history.entries().at(-1).name, 'Rotate Selected Pixels');
  assert.equal(alpha(doc, 6, 7), 255, 'the bar now stands upright about its centre');
  assert.equal(alpha(doc, 7, 12), 255);
  assert.equal(alpha(doc, 4, 9), 0, 'its old ends are gone');
  doc.undo();
  for (let x = 4; x < 10; x++) assert.equal(alpha(doc, x, 9), 255);
  assert.equal(alpha(doc, 6, 7), 0);
  doc.redo();
  assert.equal(alpha(doc, 6, 7), 255);
});

test('scale and turn land as ONE resample from the original pixels', () => {
  const { ed, doc } = session();
  const n = doc.history.entries().length;
  ed.tool.setSize(ed, 12, 4);
  ed.tool.setAngle(ed, 45);
  ed.tool.setAngle(ed, 90);
  ed.tool.setSize(ed, 6, 2); // back to the original size: still exact, no accumulated blur
  ed.commitPending();
  assert.equal(doc.history.entries().length, n + 1);
  assert.equal(alpha(doc, 6, 7), 255);
  assert.equal(alpha(doc, 7, 7), 255);
  assert.equal(alpha(doc, 8, 7), 0, 'edges stay hard: one resample, not three');
});

test('rotate knob drag turns, Shift snaps to 15°', () => {
  const { ed, doc } = session();
  // Screen = document at zoom 1 with no offset. Knob sits 24px above the top edge's middle.
  const e = (x, y, extra = {}) => ({ x, y, sx: x, sy: y, zoom: 1, ox: 0, oy: 0, button: 0, shift: false, ctrl: false, alt: false, ...extra });
  ed.pointer('down', e(7, 9 - 24));
  ed.pointer('move', e(7 + 30, 10, { shift: true })); // drag round to the right of the centre
  ed.pointer('up', e(7 + 30, 10, { shift: true }));
  const a = ed.tool.metrics(ed).angle;
  assert.equal(a % 15, 0, `snapped (${a})`);
  assert.ok(a > 60 && a <= 105, `about a quarter turn (${a})`);
  assert.equal(doc.history.entries().at(-1)?.name === 'Rotate Selected Pixels', false, 'still floating');
  ed.cancelTool();
  for (let x = 4; x < 10; x++) assert.equal(alpha(doc, x, 9), 255, 'Escape puts it back');
});

test('Move Selection rotates the selection outline', () => {
  const ed = new Editor();
  const doc = new Doc(20, 20);
  ed.addDoc(doc);
  doc.setSelection(rectMask(20, 20, 2, 8, 12, 10));
  ed.setTool('move-selection');
  ed.tool.setAngle(ed, 90);
  assert.equal(ed.marchOffset.angle, Math.PI / 2, 'marching ants turn live');
  ed.commitTool();
  assert.equal(doc.history.entries().at(-1).name, 'Rotate Selection');
  const b = maskBounds(doc.selection);
  assert.deepEqual([b.w, b.h], [2, 10]);
  doc.undo();
  const b2 = maskBounds(doc.selection);
  assert.deepEqual([b2.w, b2.h], [10, 2]);
});
