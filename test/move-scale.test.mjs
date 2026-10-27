// Regression: moving a float after it has been scaled (or turned) must do exactly the same
// per-frame work as moving an unscaled one: no resample, no re-lift, no layer writes, no history,
// no idle timer. The one resample happens at set-down.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Editor } from '../src/js/ui/editor.js';
import { Doc } from '../src/js/doc/document.js';
import { rectMask } from '../src/js/core/mask.js';
import { xformStats, floatPlacement } from '../src/js/core/xform.js';

const ev = (x, y) => ({ x, y, sx: x, sy: y, button: 0, shift: false, ctrl: false, alt: false });

function lifted() {
  const ed = new Editor();
  const doc = new Doc(64, 64);
  ed.addDoc(doc);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) doc.layer.img.data.set([255, 0, 0, 255], (y * 64 + x) * 4);
  doc.setSelection(rectMask(64, 64, 10, 10, 30, 30));
  ed.setTool('move-pixels');
  return { ed, doc };
}

/** Per-frame work counters around `fn`. */
function work(ed, doc, fn) {
  const realTimeout = globalThis.setTimeout;
  let timers = 0;
  globalThis.setTimeout = (...a) => { timers++; return realTimeout(...a); };
  const f0 = doc.float, a = { res: xformStats.resamples, lv: doc.layer.version, hist: doc.history.index, fv: f0?.version ?? 0 };
  try { fn(); } finally { globalThis.setTimeout = realTimeout; }
  const f1 = doc.float;
  return {
    resamples: xformStats.resamples - a.res,
    layerWrites: doc.layer.version - a.lv,
    history: doc.history.index - a.hist,
    timers,
    sameFloat: f0 === f1 && f1?.src === f0?.src && f1?.canvas === f0?.canvas,
    updates: (f1?.version ?? 0) - a.fv,
  };
}

function dragBy(ed, doc, n, dx, dy) {
  const b = doc.float.box;
  let x = b.x + b.w / 2, y = b.y + b.h / 2;
  ed.pointer('down', ev(x, y));
  for (let i = 0; i < n; i++) ed.pointer('move', ev(x += dx, y += dy));
  ed.pointer('up', ev(x, y));
}

const ZERO = { resamples: 0, layerWrites: 0, history: 0, timers: 0, sameFloat: true };
const pick = (w) => ({ resamples: w.resamples, layerWrites: w.layerWrites, history: w.history, timers: w.timers, sameFloat: w.sameFloat });

test('a drag after scaling does the same work per frame as before scaling (none but the float update)', async () => {
  const { ed, doc } = lifted();
  ed.pointer('down', ev(20, 20)); ed.pointer('move', ev(21, 20)); ed.pointer('up', ev(21, 20)); // lift
  const plain = work(ed, doc, () => dragBy(ed, doc, 20, 1, 0));
  assert.deepEqual(pick(plain), ZERO);

  for (const [w, h] of [[30, 30], [40, 40], [10, 10]]) { // 1.5x, upscale 2x, downscale 0.5x
    const sc = work(ed, doc, () => ed.tool.setSize(ed, w, h));
    assert.deepEqual(pick(sc), ZERO, `scaling to ${w}x${h} is visual only`);
    const after = work(ed, doc, () => dragBy(ed, doc, 20, 1, 1));
    assert.deepEqual(pick(after), ZERO, `drag after scaling to ${w}x${h}`);
    assert.equal(after.updates, plain.updates, 'one float update per pointer event, like the unscaled drag');
  }

  // Wheel scale, then a pause longer than the 0.5 s idle time, then move again: still floating.
  const wheel = work(ed, doc, () => { for (let i = 0; i < 5; i++) ed.tool.wheel({ deltaY: -40, deltaMode: 0 }, ed); });
  assert.deepEqual(pick(wheel), ZERO);
  await new Promise((r) => setTimeout(r, 650));
  assert.ok(doc.float, 'a pause while floating does not set it down');
  const again = work(ed, doc, () => dragBy(ed, doc, 20, -1, 0));
  assert.deepEqual(pick(again), ZERO, 'drag after a pause');

  // Repeated scale + move cycles.
  const cycles = work(ed, doc, () => {
    for (let c = 0; c < 6; c++) { const m = ed.tool.metrics(ed); ed.tool.setSize(ed, m.w + (c % 2 ? -3 : 4), m.h + (c % 2 ? -3 : 4)); dragBy(ed, doc, 5, 1, 0); }
  });
  assert.deepEqual(pick(cycles), ZERO);

  // Set down: exactly one resample and one history step.
  const down = work(ed, doc, () => ed.commitPending());
  assert.equal(down.resamples, 1);
  assert.equal(down.history, 1);
  assert.equal(doc.float, null);
});

test('rotating, then moving: no resample until set-down', () => {
  const { ed, doc } = lifted();
  ed.tool.setAngle(ed, 30);
  const w = work(ed, doc, () => dragBy(ed, doc, 15, 1, 2));
  assert.deepEqual(pick(w), ZERO);
  const down = work(ed, doc, () => ed.commitPending());
  assert.equal(down.resamples, 1);
});

test('the cached preview bitmap stays valid while a scaled or turned float only moves', () => {
  for (const angle of [0, 0.4]) {
    const box = { x: angle ? 10.25 : 10, y: angle ? 7.5 : 7, w: 37, h: 21 };
    const p0 = floatPlacement(20, 20, box, angle);
    assert.equal(p0.exact, false);
    for (const [dx, dy] of [[1, 0], [5, -3], [-12, 40]]) {
      const p = floatPlacement(20, 20, { ...box, x: box.x + dx, y: box.y + dy }, angle);
      assert.equal(p.key, p0.key, 'whole-pixel move: same bitmap');
      assert.deepEqual([p.bounds.x - p0.bounds.x, p.bounds.y - p0.bounds.y, p.bounds.w, p.bounds.h], [dx, dy, p0.bounds.w, p0.bounds.h]);
    }
    assert.notEqual(floatPlacement(20, 20, { ...box, w: 38 }, angle).key, p0.key, 'resize rebuilds');
    assert.notEqual(floatPlacement(20, 20, box, angle + 0.1).key, p0.key, 'turn rebuilds');
  }
  assert.equal(floatPlacement(20, 20, { x: 3, y: 4, w: 20, h: 20 }, 0).exact, true, 'unscaled: plain blit, no bitmap');
});
