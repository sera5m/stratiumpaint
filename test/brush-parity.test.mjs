import test from 'node:test';
import assert from 'node:assert/strict';

import { Editor } from '../src/js/ui/editor.js';
import { Doc } from '../src/js/doc/document.js';
import { rectMask, ellipseMask } from '../src/js/core/mask.js';
import { brushTools, brushStats, coverage, coverageFn } from '../src/js/tools/brush.js';
import { brushTools as referenceTools } from './fixtures/brush-reference.js';

// The tiled brush engine must produce the same bytes as the old whole-layer engine.

let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

function session(W, H, { selection = null, pattern = 1 } = {}) {
  const ed = new Editor();
  const doc = new Doc(W, H);
  const d = doc.layers[0].img.data;
  let s = pattern;
  for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) >>> 0; d[i] = (s >>> 24) & 255; }
  for (let i = 3; i < d.length; i += 8) d[i] = 0; // some transparent pixels
  doc.layers[0].touch();
  ed.addDoc(doc);
  if (selection) doc.setSelection(selection(W, H));
  ed.primary = { r: 30, g: 140, b: 220, a: 0.85 };
  return { ed, doc };
}

const ev = (x, y, extra = {}) => ({ x, y, sx: x, sy: y, button: 0, shift: false, ctrl: false, alt: false, ...extra });
const tool = (set, kind) => set.find((t) => t.id === kind);

function stroke(t, ed, pts, { cancel = false } = {}) {
  t.down(ev(pts[0][0], pts[0][1]), ed);
  for (const [x, y] of pts.slice(1)) t.move(ev(x, y), ed);
  if (cancel) t.cancel(ed); else t.up(ev(...pts[pts.length - 1]), ed);
}

function path(W, H, n) {
  const pts = [];
  let x = rnd() * W, y = rnd() * H;
  for (let i = 0; i < n; i++) { x = Math.max(-10, Math.min(W + 10, x + (rnd() - 0.5) * 40)); y = Math.max(-10, Math.min(H + 10, y + (rnd() - 0.5) * 40)); pts.push([x, y]); }
  return pts;
}

const CASES = [];
for (const kind of ['brush', 'pencil', 'eraser', 'clone']) {
  for (const falloff of kind === 'pencil' ? ['linear'] : ['linear', 'hard', 'smooth', 'gaussian', 'airbrush']) {
    for (const hardness of kind === 'pencil' ? [100] : [0, 50, 100]) {
      for (const aa of kind === 'pencil' ? [true] : [true, false]) CASES.push({ kind, falloff, hardness, aa });
    }
  }
}

test('brush engine: same bytes as the reference for every kind, falloff, hardness and antialiasing', () => {
  for (const c of CASES) {
    const W = 150 + ((rnd() * 60) | 0), H = 130 + ((rnd() * 40) | 0); // not tile multiples
    const opts = { size: 3 + ((rnd() * 40) | 0), hardness: c.hardness, opacity: 40 + ((rnd() * 60) | 0), aa: c.aa, falloff: c.falloff };
    const pts = path(W, H, 8), strokes = [pts, path(W, H, 5)];
    const A = session(W, H), B = session(W, H);
    Object.assign(A.ed.opts, opts); Object.assign(B.ed.opts, opts);
    const ta = tool(brushTools(), c.kind), tb = tool(referenceTools(), c.kind);
    if (c.kind === 'clone') { ta.down(ev(40, 30, { ctrl: true }), A.ed); tb.down(ev(40, 30, { ctrl: true }), B.ed); }
    for (const p of strokes) { stroke(ta, A.ed, p); stroke(tb, B.ed, p); }
    const label = JSON.stringify({ ...c, ...opts });
    assert.deepEqual(A.doc.layer.img.data, B.doc.layer.img.data, `painted bytes differ: ${label}`);
    A.doc.undo(); B.doc.undo();
    assert.deepEqual(A.doc.layer.img.data, B.doc.layer.img.data, `after undo: ${label}`);
    A.doc.undo(); B.doc.undo();
    assert.deepEqual(A.doc.layer.img.data, B.doc.layer.img.data, `after second undo: ${label}`);
    A.doc.redo(); B.doc.redo(); A.doc.redo(); B.doc.redo();
    assert.deepEqual(A.doc.layer.img.data, B.doc.layer.img.data, `after redo: ${label}`);
  }
});

test('brush engine: selection, mirror, repeat, edges and many overlapping dabs match the reference', () => {
  const variants = [
    { selection: (w, h) => ellipseMask(w, h, 20, 15, w - 30, h - 10), opts: { mirror: 'both' } },
    { selection: (w, h) => rectMask(w, h, 0, 0, w / 2, h), opts: { mirror: 'radial8' } },
    { opts: { repeatX: 37, repeatY: 23, repeatN: 3 } },
    { opts: { size: 120, hardness: 30 } }, // bigger than a tile, spans the edges
  ];
  for (const v of variants) {
    for (const kind of ['brush', 'eraser', 'clone', 'pencil']) {
      const W = 200, H = 140;
      const opts = { size: 21, hardness: 60, opacity: 70, aa: true, falloff: 'linear', ...v.opts };
      const A = session(W, H, v), B = session(W, H, v);
      Object.assign(A.ed.opts, opts); Object.assign(B.ed.opts, opts);
      const ta = tool(brushTools(), kind), tb = tool(referenceTools(), kind);
      if (kind === 'clone') { ta.down(ev(150, 100, { ctrl: true }), A.ed); tb.down(ev(150, 100, { ctrl: true }), B.ed); }
      const pts = [[5, 5], [60.3, 40.7], [61, 41], [120.5, 90.5], [199, 139], [-5, 70], [100, 70.25]];
      stroke(ta, A.ed, pts); stroke(tb, B.ed, pts);
      assert.deepEqual(A.doc.layer.img.data, B.doc.layer.img.data, `${kind} ${JSON.stringify(v.opts)}`);
      A.doc.undo(); B.doc.undo();
      assert.deepEqual(A.doc.layer.img.data, B.doc.layer.img.data, `${kind} undo ${JSON.stringify(v.opts)}`);
    }
  }
});

test('brush engine: cancel restores the layer exactly; history keeps only the stroke rectangle', () => {
  const W = 700, H = 500;
  const A = session(W, H);
  Object.assign(A.ed.opts, { size: 30, hardness: 50, opacity: 80, aa: true });
  const before = new Uint8ClampedArray(A.doc.layer.img.data);
  const t = tool(brushTools(), 'brush');
  stroke(t, A.ed, [[100, 100], [180, 130], [260, 90]], { cancel: true });
  assert.deepEqual(A.doc.layer.img.data, before, 'cancel left a difference');
  const h0 = A.doc.history.index;
  const s0 = { ...brushStats };
  stroke(t, A.ed, [[100, 100], [180, 130], [260, 90]]);
  assert.equal(A.doc.history.index - h0, 1);
  // Only tiles the stroke reached were backed up, never the whole layer.
  const backed = brushStats.backupPixels - s0.backupPixels;
  assert.ok(backed > 0 && backed < (W * H) / 4, `backed up ${backed} px of ${W * H}`);
  assert.equal(brushStats.startCopied, 0);
  // One layer update per pointer event, not per dab.
  assert.ok(brushStats.touches - s0.touches <= 3, `touches ${brushStats.touches - s0.touches}`);
  assert.ok(brushStats.dabs - s0.dabs > 20);
  A.doc.undo();
  assert.deepEqual(A.doc.layer.img.data, before, 'undo left a difference');
});

test('brush engine: a long diagonal stroke keeps history for its painted tiles, not its bounding box', () => {
  const W = 2000, H = 1500;
  const A = session(W, H);
  Object.assign(A.ed.opts, { size: 20, hardness: 50, opacity: 80, aa: true });
  const t = tool(brushTools(), 'brush');
  const before = new Uint8ClampedArray(A.doc.layer.img.data);
  const pts = []; for (let i = 0; i <= 40; i++) pts.push([100 + i * 45, 100 + i * 32]);
  let bytes = 0;
  const push = A.doc.push.bind(A.doc);
  A.doc.push = (cmd) => { bytes += cmd.bytes; return push(cmd); };
  stroke(t, A.ed, pts);
  const after = new Uint8ClampedArray(A.doc.layer.img.data);
  const bbox = 1800 * 1280; // what the old engine stored, twice (before + after)
  assert.ok(bytes > 0 && bytes < (bbox * 8) / 5, `history ${bytes} B for a ${bbox} px bounding box`);
  A.doc.undo(); assert.deepEqual(A.doc.layer.img.data, before);
  A.doc.redo(); assert.deepEqual(A.doc.layer.img.data, after);
});

test('brush engine: specialised coverage equals coverage() for every falloff', () => {
  for (const falloff of ['linear', 'hard', 'smooth', 'gaussian', 'airbrush']) {
    for (const r of [0.5, 1, 3.5, 12, 40]) for (const hardness of [0, 0.3, 0.999, 1]) for (const aa of [true, false]) {
      const f = coverageFn(r, hardness, aa, falloff);
      for (let d = 0; d < r + 2; d += 0.0371) assert.equal(f(d), coverage(d, r, hardness, aa, falloff));
    }
  }
});

test('brush engine: painting inside a selection no longer throws (maskBounds was not imported)', () => {
  const A = session(80, 60, { selection: (w, h) => rectMask(w, h, 10, 10, 50, 40) });
  A.ed.setTool('brush');
  A.ed.pointer('down', ev(20, 20)); A.ed.pointer('move', ev(60, 30)); A.ed.pointer('up', ev(60, 30));
  assert.equal(A.doc.layer.img.data[(5 * 80 + 5) * 4 + 3] !== undefined, true);
});
