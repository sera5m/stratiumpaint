import test from 'node:test';
import assert from 'node:assert/strict';

import { Editor } from '../src/js/ui/editor.js';
import { Doc } from '../src/js/doc/document.js';
import { fillFaces, mirrorFace, pixelMirror } from '../src/js/core/symmetry.js';

// Two quads: x = +1 and x = -1. The left half of the texture is +X, the right half is −X.
function mount() {
  const positions = new Float32Array([
    1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1,
    -1, 0, 0, -1, 0, 1, -1, 1, 0, -1, 1, 1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 1, 3, 2,
    4, 5, 6, 5, 7, 6,
  ]);
  const uvs = new Float32Array([
    0, 0, 0, 1, 0.5, 0,
    0, 1, 0.5, 1, 0.5, 0,
    1, 0, 0.5, 0, 1, 1,
    0.5, 0, 0.5, 1, 1, 1,
  ]);
  return {
    positions, indices, uvs,
    groups: [{ name: 'right', start: 0, count: 2 }, { name: 'left', start: 2, count: 2 }],
  };
}

const alpha = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];

function session() {
  const ed = new Editor();
  const doc = new Doc(16, 16);
  doc.mount = mount();
  ed.addDoc(doc);
  ed.primary = { r: 200, g: 20, b: 40, a: 1 };
  ed.opts.opacity = 100;
  ed.opts.aa = false;
  ed.opts.hardness = 100;
  ed.opts.size = 2;
  return { ed, doc };
}

const ev = (x, y, extra = {}) => ({ x, y, sx: x, sy: y, button: 0, shift: false, ctrl: false, alt: false, ...extra });

test('polygon fill paints one face, the object, and the mirrored side', () => {
  const { ed, doc } = session();
  const m = doc.mount;
  ed.setTool('poly-fill');
  ed.pointer('down', ev(2, 2, { face: 0 }));
  ed.pointer('up', ev(2, 2, { face: 0 }));
  assert.equal(alpha(doc.layer.img, 1, 1), 255, 'the clicked face');
  assert.equal(alpha(doc.layer.img, 1, 14), 0, 'the other triangle of the object stays clear');
  assert.equal(alpha(doc.layer.img, 12, 8), 0, 'the far side stays clear');
  doc.undo();
  assert.equal(alpha(doc.layer.img, 1, 1), 0);

  ed.opts.polyScope = 'object';
  ed.pointer('down', ev(2, 2, { face: 0 }));
  assert.equal(alpha(doc.layer.img, 1, 14), 255, 'object scope fills the whole group');
  doc.undo();

  ed.opts.polyScope = 'face';
  ed.opts.symmetry = 'x';
  const mirror = mirrorFace(m, 0, 'x');
  assert.ok(mirror === 2 || mirror === 3, `mirrored face ${mirror}`);
  ed.pointer('down', ev(2, 2, { face: 0 }));
  let far = 0;
  for (let y = 0; y < 16; y++) for (let x = 8; x < 16; x++) if (alpha(doc.layer.img, x, y)) far++;
  assert.ok(far > 0, 'symmetry filled the other side');
  assert.equal(doc.history.entries().at(-1).name, 'Polygon Fill');
});

test('a path strokes the points, and symmetry paints the other side, as one step', () => {
  const { ed, doc } = session();
  ed.setTool('path');
  ed.pointer('down', ev(2, 8));
  ed.pointer('up', ev(2, 8));
  ed.pointer('down', ev(2, 8, { button: 2 }));
  ed.pointer('up', ev(2, 8, { button: 2 }));
  assert.equal(ed.tool.points().length, 0, 'right-click drops the point');
  ed.pointer('down', ev(3, 4));
  ed.pointer('up', ev(3, 4));
  ed.pointer('down', ev(3, 12));
  ed.pointer('up', ev(3, 12));
  ed.opts.symmetry = 'x';
  const before = doc.history.index;
  ed.commitTool();
  assert.equal(ed.tool.points().length, 0);
  assert.ok(alpha(doc.layer.img, 3, 8) > 0, 'the path itself');
  let far = 0;
  for (let y = 0; y < 16; y++) for (let x = 8; x < 16; x++) if (alpha(doc.layer.img, x, y)) far++;
  assert.ok(far > 0, 'the mirrored side');
  assert.equal(doc.history.index, before + 1, 'one history step');
  assert.equal(doc.history.entries().filter((e) => e.applied).at(-1).name, 'Path');
  doc.undo();
  assert.equal(alpha(doc.layer.img, 3, 8), 0);
});

test('pixelMirror sends a +X texel to the −X side', () => {
  const m = mount();
  const sym = pixelMirror(m, 16, 16, 'x');
  const hit = sym(2.5, 8.5);
  assert.ok(hit && hit.x > 8, JSON.stringify(hit));
  const img = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const rect = fillFaces(img, uvs, [0], { r: 10, g: 20, b: 30, a: 1 }, null);
  assert.ok(rect);
  assert.equal(img.data[0], 10);
  assert.equal(img.data[3], 255);
});
