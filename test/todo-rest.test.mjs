import test from 'node:test';
import assert from 'node:assert/strict';
import { evalExpr } from '../src/js/core/expr.js';
import { eulerFromAxes, projectorAxes, rollAbout, aimProjection, occlusionPreview, packDepthMap } from '../src/js/core/projection.js';
import { gizmoHandles, dragMove, dragRotate, hitGizmo } from '../src/js/core/gizmo.js';
import { packPickId, unpackPickId } from '../src/js/gpu/pick.js';
import { resampleSetDown } from '../src/js/gpu/resample.js';
import { xformStats, resampleFloat } from '../src/js/core/xform.js';
import { createImage } from '../src/js/core/image.js';
import { cssFilter, GPU_ADJUST_IDS, ADJUST_WGSL } from '../src/js/gpu/filters.js';
import { createTools } from '../src/js/tools/index.js';

const close = (a, b, eps = 1e-6, msg = '') => {
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < eps, `${msg} [${a}] vs [${b}]`);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const front = (p) => [200 + 50 * p[0], 200 - 50 * p[1]];

test('numeric fields accept sums, products and scientific notation', () => {
  assert.equal(evalExpr('1+2'), 3);
  assert.equal(evalExpr('(3*4)/2'), 6);
  assert.equal(evalExpr('-5+1.5'), -3.5);
  assert.equal(evalExpr('1e2'), 100);
  assert.equal(evalExpr(' 2 * (1+3) '), 8);
  assert.equal(evalExpr('abc'), null);
  assert.equal(evalExpr('1/0'), null);
  assert.equal(evalExpr(''), null);
  assert.equal(evalExpr('1.5'), 1.5);
});

test('eulerFromAxes round-trips the projector axes (not the raw gimbal angles)', () => {
  for (const rot of [[0, 0, 0], [10, 20, 30], [-90, 0, 0], [0, 90, 0], [0, 0, 90], [30, -40, 15]]) {
    const a = projectorAxes(rot);
    const back = projectorAxes(eulerFromAxes(a.right, a.up, a.forward));
    close(back.right, a.right, 1e-6, `right ${rot}`);
    close(back.up, a.up, 1e-6, `up ${rot}`);
    close(back.forward, a.forward, 1e-6, `forward ${rot}`);
  }
});

test('free-rotate ring rolls about the view and local arrows follow the projector', () => {
  const loc = [0.2, 0.1, -0.3];
  const h = gizmoHandles([0, 0, 0], [0, 0, 90], front, 1 / 50, [0, 0, -1]);
  const ax = h.arrows.find((a) => a.k === 0);
  assert.ok(ax.b[1] < ax.a[1], 'local +X at yaw 90 points up on screen');
  assert.ok(h.rings.some((r) => r.k === 3 && r.free), 'view ring');
  close(dragMove(loc, 0, [100, 100], [100, 50], front, false, [0, 1, 0]), [0.2, 1.1, -0.3], 1e-9);
  close(dragMove(loc, 0, [100, 100], [137, 100], front, true, [1, 0, 0]), [0.9, 0.1, -0.3], 1e-9, 'local snap');
  const spun = dragRotate([0, 0, 0], 3, [200, 200], [250, 200], [200, 150], [0, 0, -1]);
  const f = projectorAxes(spun);
  assert.ok(dot(f.forward, [0, 0, -1]) > 0.99, 'rolling about the view keeps the aim');
  assert.ok(Math.hypot(f.right[0] - 1, f.right[1], f.right[2]) > 0.2, 'the image turned');
  const id = gizmoHandles([0, 0, 0], [0, 0, 0], front, 1 / 50);
  assert.equal(hitGizmo(id, [200 + 50, 201]).k, 0);
});

test('pick ids and a CPU set-down still count as one resample', () => {
  assert.deepEqual(packPickId(0), [1, 0, 0, 255]);
  assert.equal(unpackPickId(packPickId(0)), 0);
  assert.equal(unpackPickId(packPickId(256)), 256);
  assert.equal(unpackPickId([0, 0, 0, 0]), -1);
  const src = createImage(4, 4);
  src.data.fill(255);
  const before = xformStats.resamples;
  const out = resampleSetDown(src, { x: 0, y: 0, w: 4, h: 4 }, 0, null);
  assert.equal(xformStats.resamples, before + 1);
  assert.equal(out.img.width, 4);
  // A live device must not take the canvas readback path: that returns 8×8 tiles.
  const scaled = resampleSetDown(src, { x: 1, y: 2, w: 6, h: 5 }, 0, {});
  const cpu = resampleFloat(src, { x: 1, y: 2, w: 6, h: 5 }, 0);
  assert.equal(xformStats.resamples, before + 3);
  assert.deepEqual(scaled.img.data, cpu.img.data);
  assert.equal(scaled.x, cpu.x);
  assert.equal(scaled.y, cpu.y);
  assert.equal(cssFilter('invert'), 'invert(1)');
  assert.equal(cssFilter('gaussian-blur', { radius: 2 }), 'blur(2px)');
  assert.ok(GPU_ADJUST_IDS.has('sepia') && ADJUST_WGSL.includes('sepia'));
});

test('line, brush and pencil can project; shapes can stamp along the stroke', () => {
  const tools = createTools();
  const by = (id) => tools.find((t) => t.id === id);
  assert.equal(typeof by('line').projectionImage, 'function');
  assert.equal(typeof by('brush').projectionStroke, 'function');
  assert.equal(typeof by('pencil').projectionImage, 'function');
  assert.equal(by('eraser').projectionStroke, undefined);
  assert.ok(by('rect').options.includes('stampAlong'));
  assert.ok(by('heart').options.includes('shape3d'));
  assert.ok(by('brush').options.includes('projImage'));
});

test('occlusion preview packs a hit and ignores empty depth', () => {
  const packed = packDepthMap(Float32Array.of(Infinity, 1, 3));
  assert.equal(packed.data[3], 0);
  assert.equal(packed.data[7], 255);
  assert.equal(packed.data[11], 255);
  assert.ok(packed.span > 1);
  const pos = [-1, 0, 0, 1, 0, 0, 0, 1, 0];
  const idx = [0, 1, 2];
  const uvs = [0, 0, 1, 0, 0, 1];
  const mount = { positions: new Float32Array(pos), indices: new Uint32Array(idx), uvs: new Float32Array(uvs), groups: [] };
  const ax = projectorAxes([0, 0, 0]);
  const aim = aimProjection({ n: ax.forward, U: ax.right, V: ax.up.map((v) => -v), anchor: [0, 0, 2], scale: 0.05, positions: mount.positions });
  const P = aim.main;
  assert.ok(P, 'projector');
  const prev = occlusionPreview(mount, P, { x: 0, y: 0, w: 32, h: 32 });
  assert.equal(prev.data.length, prev.w * prev.h * 4);
  assert.ok(prev.span > 0 && prev.P.rx.length === 4);
});
