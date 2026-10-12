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

// ... (rest of original tests with the two post-commit assertions updated to expect null selection) ...

test('move selected pixels floats: nothing is written to history until it is set down', () => {
  const { ed, doc } = session(20, 10);
  doc.layer.img.data.set([255, 0, 0, 255], (3 * 20 + 3) * 4);
  doc.setSelection(rectMask(20, 10, 2, 2, 5, 5));
  const before = doc.history.entries().length;

  ed.setTool('move-pixels');
  drag(ed, [[3, 3], [6, 3], [10, 5]]);

  assert.equal(alphaAt(doc.layer, 3, 3), 0, 'original spot is already empty on screen');
  assert.deepEqual(px(doc.layer, 10, 5), [255, 0, 0, 255], 'moved pixels are visible at the new spot');
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
