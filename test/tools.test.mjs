import test from 'node:test';
import assert from 'node:assert/strict';

import { Editor } from '../src/js/ui/editor.js';
import { Doc } from '../src/js/doc/document.js';
import { rectMask } from '../src/js/core/mask.js';

const px = (layer, x, y) => [...layer.img.data.slice((y * layer.width + x) * 4, (y * layer.width + x) * 4 + 4)];
const alphaAt = (layer, x, y) => px(layer, x, y)[3];

function session(w = 40, h = 30, background = null) {
  const ed = new Editor();
  const doc = new Doc(w, h, { background });
  ed.addDoc(doc);
  ed.toasts = [];
  ed.on('toast', (m) => ed.toasts.push(m));
  return { ed, doc };
}

const ev = (x, y, extra = {}) => ({ x, y, sx: x, sy: y, button: 0, shift: false, ctrl: false, alt: false, ...extra });

/** Press at the first point, move through the rest, release at the last. */
function drag(ed, pts, extra = {}) {
  ed.pointer('down', ev(pts[0][0], pts[0][1], extra));
  for (const [x, y] of pts.slice(1)) ed.pointer('move', ev(x, y, extra));
  const [lx, ly] = pts[pts.length - 1];
  ed.pointer('up', ev(lx, ly, extra));
}

const RED = { r: 255, g: 0, b: 0, a: 1 }, BLUE = { r: 0, g: 0, b: 255, a: 1 };

// ---------------------------------------------------------------- editor

test('editor: tool cycling by shared key, options, colours, documents', () => {
  const { ed, doc } = session();
  ed.setTool('rect-select');
  ed.cycleTool('S'); assert.equal(ed.tool.id, 'ellipse-select');
  ed.cycleTool('S'); assert.equal(ed.tool.id, 'lasso');
  ed.cycleTool('S'); assert.equal(ed.tool.id, 'wand');
  ed.cycleTool('S'); assert.equal(ed.tool.id, 'rect-select');
  ed.cycleTool('B'); assert.equal(ed.tool.id, 'brush');
  assert.equal(ed.cycleTool('Q'), false);

  const seen = [];
  ed.on('opts', (k) => seen.push(k));
  ed.setOpt('size', 20); ed.setOpt('size', 20);
  assert.deepEqual(seen, ['size'], 'setting the same value again is silent');
  ed.nudgeSize(-1000);
  assert.equal(ed.opts.size, 1);

  ed.setPrimary(RED); ed.swapColors();
  assert.deepEqual(ed.secondary, RED);
  ed.resetColors();
  assert.deepEqual(ed.primary, { r: 0, g: 0, b: 0, a: 1 });

  const events = [];
  ed.on('doc:layers', () => events.push('layers'));
  doc.addLayer();
  assert.deepEqual(events, ['layers']);
  const second = new Doc(5, 5);
  ed.addDoc(second);
  assert.equal(ed.doc, second);
  doc.addLayer();
  assert.deepEqual(events, ['layers'], 'events from a background document are not forwarded');
  ed.closeDoc(second);
  assert.equal(ed.doc, doc);
});

test('a hidden layer refuses to be painted on and says why', () => {
  const { ed, doc } = session();
  doc.setLayerProps(doc.layer, { visible: false });
  ed.setTool('brush');
  drag(ed, [[5, 5], [10, 5]]);
  assert.equal(alphaAt(doc.layer, 5, 5), 0);
  assert.equal(ed.toasts.length, 1);
});

test('a tool that throws does not wedge the editor', () => {
  const { ed } = session();
  ed.tool.down = () => { throw new Error('boom'); };
  const orig = console.error; console.error = () => {};
  try { ed.pointer('down', ev(1, 1)); } finally { console.error = orig; }
  assert.match(ed.toasts[0], /boom/);
});

// ---------------------------------------------------------------- brush family

test('brush paints along the drag, is one undo step, and respects colour', () => {
  const { ed, doc } = session();
  ed.setTool('brush');
  ed.setOpt('size', 6); ed.setOpt('hardness', 100); ed.setPrimary(RED);
  drag(ed, [[5, 15], [20, 15], [35, 15]]);
  for (const x of [5, 12, 20, 34]) assert.deepEqual(px(doc.layer, x, 15), [255, 0, 0, 255], `x=${x}`);
  assert.equal(alphaAt(doc.layer, 20, 25), 0);
  assert.equal(doc.history.entries().length, 1);
  assert.equal(doc.history.entries()[0].name, 'Paintbrush');
  doc.undo();
  assert.equal(alphaAt(doc.layer, 20, 15), 0);
  doc.redo();
  assert.deepEqual(px(doc.layer, 20, 15), [255, 0, 0, 255]);
});

test('right button paints with the secondary colour', () => {
  const { ed, doc } = session();
  ed.setTool('brush'); ed.setOpt('size', 4); ed.setOpt('hardness', 100);
  ed.setPrimary(RED); ed.setSecondary(BLUE);
  drag(ed, [[10, 10], [15, 10]], { button: 2 });
  assert.deepEqual(px(doc.layer, 12, 10), [0, 0, 255, 255]);
});

test('opacity does not build up when a stroke overlaps itself', () => {
  const { ed, doc } = session();
  ed.setTool('brush'); ed.setOpt('size', 8); ed.setOpt('hardness', 100); ed.setOpt('opacity', 50); ed.setPrimary(RED);
  drag(ed, [[10, 15], [30, 15], [10, 15], [30, 15], [10, 15]]); // back and forth over the same pixels
  const a = alphaAt(doc.layer, 20, 15);
  assert.ok(Math.abs(a - 128) <= 1, `alpha ${a} should stay at ~50%`);
});

test('a soft brush fades toward its edge', () => {
  const { ed, doc } = session();
  ed.setTool('brush'); ed.setOpt('size', 20); ed.setOpt('hardness', 0); ed.setPrimary(RED);
  drag(ed, [[20, 15], [20, 15]]);
  const centre = alphaAt(doc.layer, 20, 15), mid = alphaAt(doc.layer, 25, 15), edge = alphaAt(doc.layer, 29, 15);
  assert.ok(centre > mid && mid > edge && edge >= 0, `${centre} > ${mid} > ${edge}`);
});

test('painting is limited to the selection', () => {
  const { ed, doc } = session();
  doc.setSelection(rectMask(40, 30, 0, 0, 20, 30));
  ed.setTool('brush'); ed.setOpt('size', 6); ed.setOpt('hardness', 100); ed.setPrimary(RED);
  drag(ed, [[5, 15], [35, 15]]);
  assert.equal(alphaAt(doc.layer, 10, 15), 255);
  assert.equal(alphaAt(doc.layer, 30, 15), 0);
});

test('pencil draws single hard pixels', () => {
  const { ed, doc } = session();
  ed.setTool('pencil'); ed.setPrimary(RED);
  drag(ed, [[3.4, 5.6], [9.2, 5.9]]);
  for (let x = 3; x <= 9; x++) assert.deepEqual(px(doc.layer, x, 5), [255, 0, 0, 255], `x=${x}`);
  assert.equal(alphaAt(doc.layer, 6, 4), 0);
  assert.equal(alphaAt(doc.layer, 6, 6), 0);
});

test('eraser removes paint', () => {
  const { ed, doc } = session(40, 30, { r: 10, g: 20, b: 30 });
  ed.setTool('eraser'); ed.setOpt('size', 6); ed.setOpt('hardness', 100);
  drag(ed, [[5, 15], [30, 15]]);
  assert.equal(alphaAt(doc.layer, 15, 15), 0);
  assert.equal(alphaAt(doc.layer, 15, 25), 255);
  doc.undo();
  assert.equal(alphaAt(doc.layer, 15, 15), 255);
});

test('clone stamp needs a source, then copies from it', () => {
  const { ed, doc } = session();
  ed.setTool('clone'); ed.setOpt('size', 6); ed.setOpt('hardness', 100);
  drag(ed, [[30, 10], [32, 10]]);
  assert.equal(doc.history.entries().length, 0);
  assert.match(ed.toasts.at(-1), /Ctrl\+click/);

  // put a red square on the layer via the brush, then clone it elsewhere
  ed.setTool('brush'); ed.setPrimary(RED); ed.setOpt('size', 6);
  drag(ed, [[8, 8], [8, 8]]);
  ed.setTool('clone');
  ed.pointer('down', ev(8, 8, { ctrl: true })); ed.pointer('up', ev(8, 8, { ctrl: true }));
  drag(ed, [[30, 20], [30, 20]]);
  assert.deepEqual(px(doc.layer, 30, 20), [255, 0, 0, 255]);
});

test('Escape mid-stroke puts the layer back', () => {
  const { ed, doc } = session();
  ed.setTool('brush'); ed.setOpt('size', 6); ed.setPrimary(RED);
  ed.pointer('down', ev(5, 5)); ed.pointer('move', ev(20, 5));
  assert.equal(alphaAt(doc.layer, 12, 5), 255);
  ed.cancelTool();
  assert.equal(alphaAt(doc.layer, 12, 5), 0);
  assert.equal(doc.history.entries().length, 0);
  ed.pointer('up', ev(20, 5));
  assert.equal(doc.history.entries().length, 0);
});

// ---------------------------------------------------------------- fills

test('paint bucket fills a contiguous region only, respects tolerance, selection and mode', () => {
  const { ed, doc } = session(10, 10, { r: 255, g: 255, b: 255 });
  // a vertical wall of black splits the canvas
  for (let y = 0; y < 10; y++) doc.layer.img.data.set([0, 0, 0, 255], (y * 10 + 5) * 4);
  ed.setTool('bucket'); ed.setOpt('tolerance', 0); ed.setPrimary(RED);
  drag(ed, [[1, 1], [1, 1]]);
  assert.deepEqual(px(doc.layer, 2, 8), [255, 0, 0, 255]);
  assert.deepEqual(px(doc.layer, 8, 8), [255, 255, 255, 255], 'other side of the wall is untouched');
  assert.deepEqual(px(doc.layer, 5, 5), [0, 0, 0, 255]);
  doc.undo();
  assert.deepEqual(px(doc.layer, 2, 8), [255, 255, 255, 255]);

  ed.setOpt('flood', 'global');
  drag(ed, [[1, 1], [1, 1]]);
  assert.deepEqual(px(doc.layer, 8, 8), [255, 0, 0, 255], 'global mode fills both sides');
  doc.undo();

  ed.setOpt('flood', 'contiguous');
  doc.setSelection(rectMask(10, 10, 0, 0, 3, 10));
  drag(ed, [[1, 1], [1, 1]]);
  assert.deepEqual(px(doc.layer, 2, 2), [255, 0, 0, 255]);
  assert.deepEqual(px(doc.layer, 4, 2), [255, 255, 255, 255], 'outside the selection is untouched');
});

test('paint bucket tolerance reaches similar colours', () => {
  const { ed, doc } = session(4, 1, { r: 100, g: 100, b: 100 });
  doc.layer.img.data.set([110, 110, 110, 255], 4);
  ed.setTool('bucket'); ed.setPrimary(RED);
  ed.setOpt('tolerance', 0);
  drag(ed, [[0, 0], [0, 0]]);
  assert.deepEqual(px(doc.layer, 1, 0), [110, 110, 110, 255]);
  doc.undo();
  ed.setOpt('tolerance', 20);
  drag(ed, [[0, 0], [0, 0]]);
  assert.deepEqual(px(doc.layer, 1, 0), [255, 0, 0, 255]);
});

test('gradient runs from primary to secondary and a plain click does nothing', () => {
  const { ed, doc } = session(21, 3);
  ed.setTool('gradient'); ed.setPrimary(RED); ed.setSecondary(BLUE);
  drag(ed, [[0, 1], [10, 1], [20, 1]]);
  assert.deepEqual(px(doc.layer, 0, 1).slice(0, 3), [255, 0, 0].map((v, i) => px(doc.layer, 0, 1)[i]));
  assert.ok(px(doc.layer, 0, 1)[0] > 240 && px(doc.layer, 0, 1)[2] < 15, 'starts red');
  assert.ok(px(doc.layer, 20, 1)[2] > 240 && px(doc.layer, 20, 1)[0] < 15, 'ends blue');
  const mid = px(doc.layer, 10, 1);
  assert.ok(Math.abs(mid[0] - 128) < 20 && Math.abs(mid[2] - 128) < 20, 'purple in the middle');
  assert.equal(doc.history.entries().length, 1);
  doc.undo();
  assert.equal(alphaAt(doc.layer, 10, 1), 0);

  const index = doc.history.index;
  drag(ed, [[5, 1], [5, 1]]);
  assert.equal(doc.history.index, index, 'no drag, no step');
  assert.equal(alphaAt(doc.layer, 10, 1), 0);
});

// ---------------------------------------------------------------- selection tools

test('rectangle select: drag selects, click clears, modifiers combine, shift squares', () => {
  const { ed, doc } = session();
  ed.setTool('rect-select');
  drag(ed, [[5, 5], [15, 12], [15, 12]]);
  assert.equal(doc.selection.data[8 * 40 + 10], 255);
  assert.equal(doc.selection.data[8 * 40 + 20], 0);

  drag(ed, [[25, 5], [30, 10]], { ctrl: true });
  assert.equal(doc.selection.data[8 * 40 + 10], 255, 'ctrl adds');
  assert.equal(doc.selection.data[7 * 40 + 27], 255);

  drag(ed, [[0, 0], [12, 12]], { alt: true });
  assert.equal(doc.selection.data[8 * 40 + 10], 0, 'alt subtracts');
  assert.equal(doc.selection.data[7 * 40 + 27], 255);

  drag(ed, [[2, 2], [2, 2]]);
  assert.equal(doc.selection, null, 'a click deselects');

  drag(ed, [[10, 10], [20, 14]], { shift: true });
  assert.equal(doc.selection.data[19 * 40 + 19], 255, 'shift makes a square (10x10)');
  assert.equal(doc.selection.data[9 * 40 + 19], 0);
});

test('ellipse and lasso selection', () => {
  const { ed, doc } = session();
  ed.setTool('ellipse-select');
  drag(ed, [[10, 5], [30, 25]]);
  assert.equal(doc.selection.data[15 * 40 + 20], 255);
  assert.equal(doc.selection.data[5 * 40 + 10], 0, 'corner of the box is outside the ellipse');

  ed.setTool('lasso');
  drag(ed, [[2, 2], [12, 2], [12, 12], [2, 12]]);
  assert.equal(doc.selection.data[7 * 40 + 7], 255);
  assert.equal(doc.selection.data[7 * 40 + 20], 0);
});

test('magic wand selects similar contiguous pixels', () => {
  const { ed, doc } = session(10, 10, { r: 255, g: 255, b: 255 });
  for (let y = 0; y < 10; y++) doc.layer.img.data.set([0, 0, 0, 255], (y * 10 + 5) * 4);
  ed.setTool('wand'); ed.setOpt('sampling', 'layer'); ed.setOpt('tolerance', 0);
  drag(ed, [[1, 1], [1, 1]]);
  assert.equal(doc.selection.data[3 * 10 + 2], 255);
  assert.equal(doc.selection.data[3 * 10 + 8], 0);
  assert.equal(doc.selection.data[3 * 10 + 5], 0);
});

// ---------------------------------------------------------------- move tools

test('move selected pixels: lifts the selection, is one undo step, and moves the selection with it', () => {
  const { ed, doc } = session(20, 10);
  doc.layer.img.data.set([255, 0, 0, 255], (3 * 20 + 3) * 4);
  doc.setSelection(rectMask(20, 10, 2, 2, 5, 5));
  const before = doc.history.entries().length;

  ed.setTool('move-pixels');
  drag(ed, [[3, 3], [6, 3], [10, 5]]);

  assert.equal(alphaAt(doc.layer, 3, 3), 0, 'original spot is empty');
  assert.deepEqual(px(doc.layer, 10, 5), [255, 0, 0, 255], 'moved by (7, 2)');
  assert.equal(doc.selection.data[4 * 20 + 9], 255);
  assert.equal(doc.selection.data[3 * 20 + 3], 0);
  assert.equal(doc.history.entries().length, before + 1);

  doc.undo();
  assert.deepEqual(px(doc.layer, 3, 3), [255, 0, 0, 255]);
  assert.equal(alphaAt(doc.layer, 10, 5), 0);
  assert.equal(doc.selection.data[3 * 20 + 3], 255);
  doc.redo();
  assert.deepEqual(px(doc.layer, 10, 5), [255, 0, 0, 255]);
});

test('moving with nothing selected moves the whole layer; a click without a drag changes nothing', () => {
  const { ed, doc } = session(10, 10);
  doc.layer.img.data.set([0, 255, 0, 255], (0 * 10 + 0) * 4);
  ed.setTool('move-pixels');
  drag(ed, [[4, 4], [4, 4]]);
  assert.equal(doc.history.entries().length, 0);
  assert.deepEqual(px(doc.layer, 0, 0), [0, 255, 0, 255]);

  drag(ed, [[4, 4], [7, 6]]);
  assert.deepEqual(px(doc.layer, 3, 2), [0, 255, 0, 255]);
  assert.equal(alphaAt(doc.layer, 0, 0), 0);
  assert.equal(doc.selection, null);
});

test('dragging pixels partly off the canvas clips them and still undoes exactly', () => {
  const { ed, doc } = session(10, 10, { r: 9, g: 9, b: 9 });
  ed.setTool('move-pixels');
  drag(ed, [[5, 5], [12, 5]]);
  assert.equal(alphaAt(doc.layer, 0, 5), 0);
  assert.equal(alphaAt(doc.layer, 9, 5), 255);
  doc.undo();
  for (let x = 0; x < 10; x++) assert.deepEqual(px(doc.layer, x, 5), [9, 9, 9, 255]);
});

test('move selection moves only the outline', () => {
  const { ed, doc } = session();
  doc.layer.img.data.set([255, 0, 0, 255], (3 * 40 + 3) * 4);
  doc.setSelection(rectMask(40, 30, 2, 2, 6, 6));
  ed.setTool('move-selection');
  drag(ed, [[3, 3], [13, 8]]);
  assert.equal(doc.selection.data[8 * 40 + 12], 255);
  assert.equal(doc.selection.data[3 * 40 + 3], 0);
  assert.deepEqual(px(doc.layer, 3, 3), [255, 0, 0, 255], 'pixels stay put');
});

test('colour picker takes the pixel under the cursor', () => {
  const { ed, doc } = session();
  doc.layer.img.data.set([12, 34, 56, 255], (4 * 40 + 6) * 4);
  ed.setTool('picker'); ed.setOpt('sampling', 'layer');
  drag(ed, [[6.5, 4.5], [6.5, 4.5]]);
  assert.deepEqual(ed.primary, { r: 12, g: 34, b: 56, a: 1 });
  drag(ed, [[6.5, 4.5], [6.5, 4.5]], { button: 2 });
  assert.deepEqual(ed.secondary, { r: 12, g: 34, b: 56, a: 1 });
});
