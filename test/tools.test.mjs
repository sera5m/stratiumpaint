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

test('move selected pixels floats: nothing is written to history until it is set down', () => {
  const { ed, doc } = session(20, 10);
  doc.layer.img.data.set([255, 0, 0, 255], (3 * 20 + 3) * 4);
  doc.setSelection(rectMask(20, 10, 2, 2, 5, 5));
  const before = doc.history.entries().length;

  ed.setTool('move-pixels');
  drag(ed, [[3, 3], [6, 3], [10, 5]]);

  assert.equal(alphaAt(doc.layer, 3, 3), 0, 'original spot is already empty');
  assert.equal(alphaAt(doc.layer, 10, 5), 0, 'the layer is not repainted per drag event: the pixels float');
  const shown = doc.compositeImage();
  assert.deepEqual([...shown.data.slice((5 * 20 + 10) * 4, (5 * 20 + 10) * 4 + 4)], [255, 0, 0, 255], 'moved pixels are visible at the new spot');
  assert.equal(doc.history.entries().length, before, 'no history step yet — it is only floating');
  assert.equal(doc.selection.data[3 * 20 + 3], 255, 'the selection mask itself has not moved yet either');

  ed.commitTool(); // Enter
  assert.equal(doc.history.entries().length, before + 1, 'now it is one step');
  assert.equal(doc.selection, null, 'set-down clears the selection');

  doc.undo();
  assert.deepEqual(px(doc.layer, 3, 3), [255, 0, 0, 255]);
  assert.equal(alphaAt(doc.layer, 10, 5), 0);
  assert.equal(doc.selection.data[3 * 20 + 3], 255);
  doc.redo();
  assert.deepEqual(px(doc.layer, 10, 5), [255, 0, 0, 255]);
});

/** A 4×4 red block at (2,2) with a selection around it, scaled to 8×8 through the options bar. */
function scaledFloat() {
  const s = session(20, 20);
  const { ed, doc } = s;
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) doc.layer.img.data.set([255, 0, 0, 255], (y * 20 + x) * 4);
  doc.setSelection(rectMask(20, 20, 2, 2, 4, 4));
  ed.setTool('move-pixels');
  assert.ok(ed.tool.setSize(ed, 8, 8));
  return s;
}

test('scaling a float is visual only until it is set down', () => {
  const { ed, doc } = scaledFloat();
  const before = doc.history.entries().length;
  assert.deepEqual(ed.tool.metrics(ed), { w: 8, h: 8, angle: 0 });
  assert.equal(alphaAt(doc.layer, 7, 7), 0, 'no resample yet: the layer is not painted while scaling');
  assert.equal(doc.history.entries().length, before);
  ed.commitPending(); // tool switch / undo / a menu command lands it straight away
  assert.equal(doc.history.entries().length, before + 1);
  assert.deepEqual(px(doc.layer, 7, 7), [255, 0, 0, 255], 'the resampled pixels are what landed');
  doc.undo();
  assert.deepEqual(px(doc.layer, 3, 3), [255, 0, 0, 255]);
  assert.equal(alphaAt(doc.layer, 7, 7), 0);
});

test('Enter on a scaled float waits for idle, then resamples into one history step', async () => {
  const { ed, doc } = scaledFloat();
  const before = doc.history.entries().length;
  ed.commitTool(); // Enter, right after the last size change
  assert.equal(doc.history.entries().length, before, 'still waiting out the idle time');
  ed.cancelTool(); // Escape after set-down does not throw the scale away
  assert.equal(doc.history.entries().length, before + 1);
  assert.deepEqual(px(doc.layer, 7, 7), [255, 0, 0, 255]);

  const s2 = scaledFloat();
  const n2 = s2.doc.history.entries().length;
  s2.ed.commitTool();
  assert.equal(s2.doc.history.entries().length, n2);
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(s2.doc.history.entries().length, n2 + 1, 'landed by itself after 0.5s idle');
  assert.deepEqual(px(s2.doc.layer, 7, 7), [255, 0, 0, 255]);
  s2.ed.commitPending(); // nothing left pending: no extra step
  assert.equal(s2.doc.history.entries().length, n2 + 1);
});

test('switching tools while a scale is waiting lands it instead of losing it', () => {
  const { ed, doc } = scaledFloat();
  const before = doc.history.entries().length;
  ed.commitTool();
  ed.setTool('move-selection');
  assert.equal(doc.history.entries().length, before + 1);
  assert.deepEqual(px(doc.layer, 7, 7), [255, 0, 0, 255]);
});

test('Escape before set-down reverts a scaled float', () => {
  const { ed, doc } = scaledFloat();
  const before = doc.history.entries().length;
  ed.cancelTool();
  assert.equal(doc.history.entries().length, before);
  assert.deepEqual(px(doc.layer, 3, 3), [255, 0, 0, 255]);
  assert.equal(alphaAt(doc.layer, 7, 7), 0);
});

test('a left-click outside the float sets it down at once', () => {
  const { ed, doc } = scaledFloat();
  const before = doc.history.entries().length;
  ed.pointer('down', ev(18, 18));
  ed.pointer('up', ev(18, 18));
  assert.equal(doc.history.entries().length, before + 1);
  assert.deepEqual(px(doc.layer, 7, 7), [255, 0, 0, 255]);
});
