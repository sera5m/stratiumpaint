import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rotateEuler, projectorAxes, eulerFromView, presetOf, eulerAxis, ROT_PRESETS, AXES,
  aimProjection, planeCoords, projectPaint, project, viewProjector,
} from '../src/js/core/projection.js';
import { gizmoHandles, hitGizmo, dragMove, dragRotate } from '../src/js/core/gizmo.js';
import { Editor, PERSISTED_OPTS } from '../src/js/ui/editor.js';

const close = (a, b, eps = 1e-9, msg = '') => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= eps, `${msg} [${a}] vs [${b}]`));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---------------------------------------------------------------- Euler → direction
test('Euler XYZ (Blender order): X first, then Y, then Z, about the world axes', () => {
  close(rotateEuler([1, 0, 0], [90, 90, 0]), [0, 0, -1], 1e-12, 'X then Y'); // Y-then-X would give +Y
  close(rotateEuler([0, 1, 0], [0, 0, 90]), [-1, 0, 0], 1e-12);
  close(projectorAxes([0, 0, 0]).forward, [0, 0, -1], 1e-12, 'rotation 0 fires along −Z');
});

test('presets: fire along the axis, image up as before, and round-trip through presetOf', () => {
  for (const [name, rot] of Object.entries(ROT_PRESETS)) {
    const ax = projectorAxes(rot);
    close(ax.forward, AXES[name].dir, 1e-12, name);
    close(ax.up.map((v) => -v), AXES[name].V, 1e-12, `${name} image down`);
    close(ax.right, AXES[name].U, 1e-12, `${name} image right`);
    assert.equal(presetOf(rot), name);
  }
  assert.equal(presetOf([-90, 0, 360]), 'down');
  assert.equal(presetOf([-90 + 0.01, 0, 0]), 'custom');
  assert.equal(presetOf([10, 20, 30]), 'custom');
});

test('eulerFromView aligns the projector with the 3D view camera', () => {
  for (const [yaw, pitch] of [[0.6, 0.4], [-2.5, -1.1], [3.1, 1.3]]) {
    const eye = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)]; // target at 0
    const ax = projectorAxes(eulerFromView(yaw, pitch));
    close(ax.forward, eye.map((v) => -v), 1e-9, 'forward');
    // camera up: lookAt with world up
    const f = eye.map((v) => -v), r = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0];
    const rl = Math.hypot(...r), R = r.map((v) => v / rl), up = [R[1] * f[2] - R[2] * f[1], R[2] * f[0] - R[0] * f[2], R[0] * f[1] - R[1] * f[0]];
    close(ax.up, up, 1e-9, 'up');
    close(ax.right, R, 1e-9, 'right');
  }
});

test('eulerAxis: changing one angle turns the projector about that (gimbal) axis', () => {
  const rot = [25, -40, 70], v = [0.3, -0.5, 0.8], d = 7;
  for (let k = 0; k < 3; k++) {
    const r2 = rot.slice(); r2[k] += d;
    const a = eulerAxis(rot, k), p = rotateEuler(v, rot), t = (d * Math.PI) / 180;
    const kx = [a[1] * p[2] - a[2] * p[1], a[2] * p[0] - a[0] * p[2], a[0] * p[1] - a[1] * p[0]], kd = dot(a, p) * (1 - Math.cos(t));
    const want = p.map((x, i) => x * Math.cos(t) + kx[i] * Math.sin(t) + a[i] * kd);
    close(rotateEuler(v, r2), want, 1e-9, `angle ${k}`);
  }
});

// ---------------------------------------------------------------- gizmo
// Front view, orthographic: screen x = 200 + 50 x, y = 200 − 50 y.
const front = (p) => [200 + 50 * p[0], 200 - 50 * p[1]];

test('gizmo axis drags move along that axis only, Shift snaps to 0.1', () => {
  const loc = [0.2, 0.1, -0.3];
  close(dragMove(loc, 0, [100, 100], [150, 120], front), [1.2, 0.1, -0.3], 1e-12, 'X: 50 px right = +1');
  close(dragMove(loc, 1, [100, 100], [130, 75], front), [0.2, 0.6, -0.3], 1e-12, 'Y: 25 px up = +0.5');
  close(dragMove(loc, 2, [100, 100], [180, 40], front), loc, 0, 'Z points at the viewer: no stable drag, unchanged');
  close(dragMove(loc, 0, [0, 0], [37, 0], front, true), [0.9, 0.1, -0.3], 1e-12, 'snap');
});

test('gizmo ring drags turn by the screen angle (right-hand rule), Shift snaps to 15°', () => {
  // ring Z faces the viewer (camera looks along −Z): right → up on screen is +90°
  close(dragRotate([0, 0, 0], 2, [200, 200], [250, 200], [200, 150], [0, 0, -1]), [0, 0, 90], 1e-9);
  close(dragRotate([0, 0, 0], 2, [200, 200], [250, 200], [200, 150], [0, 0, 1]), [0, 0, -90], 1e-9, 'seen from behind');
  const r = dragRotate([0, 0, 0], 2, [200, 200], [250, 200], [200 + 50 * Math.cos(-0.87), 200 + 50 * Math.sin(-0.87)], [0, 0, -1], true);
  close(r, [0, 0, 45], 1e-9, '≈50° snaps to 45°');
  close(dragRotate([0, 0, 170], 2, [200, 200], [250, 200], [200, 150], [0, 0, -1]), [0, 0, -100], 1e-9, 'wraps to ±180');
  // the turned projector: +X now points up, as dragged
  close(projectorAxes([0, 0, 90]).right, [0, 1, 0], 1e-12);
});

test('gizmo hit test: arrows, then rings, nothing far away', () => {
  const h = gizmoHandles([0, 0, 0], [0, 0, 0], front, 1 / 50); // 72 px arrows, 52 px rings
  assert.deepEqual(hitGizmo(h, [200 + 50, 201]), { type: 'move', k: 0 });
  assert.deepEqual(hitGizmo(h, [199, 200 - 40]), { type: 'move', k: 1 });
  assert.deepEqual(hitGizmo(h, [200 + 52 * Math.cos(0.8), 200 + 52 * Math.sin(0.8)]), { type: 'rotate', k: 2 });
  assert.equal(hitGizmo(h, [380, 380]), null);
  assert.notEqual(hitGizmo(h, [201, 201])?.type, 'move', 'the centre is not an arrow (the edge-on X ring may be)');
});

// ---------------------------------------------------------------- fields and persistence
test('fields: presets set the rotation, rotations show their preset, arrays compare by value', () => {
  const ed = new Editor();
  let n = 0; ed.on('opts', () => n++);
  ed.setOpt('projectFrom', 'right');
  assert.deepEqual(ed.opts.projRot, [0, 90, 0]);
  ed.setOpt('projRot', [12.5, 0, 0]);
  assert.equal(ed.opts.projectFrom, 'custom');
  ed.setOpt('projRot', [-90, 0, 0]);
  assert.equal(ed.opts.projectFrom, 'down');
  const before = n; ed.setOpt('projRot', [-90, 0, 0]); assert.equal(n, before, 'same value: no event');
  let asked = 0; ed.on('projector:fromView', () => asked++);
  ed.setOpt('projectFrom', 'view'); assert.equal(asked, 1, 'View asks the 3D view to align');
});

test('projector settings persist with the tool options, bad values ignored', () => {
  const store = new Map(), storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const a = new Editor(); a.persistOptions(storage);
  a.setOpt('shape3d', 'projection'); a.setOpt('projLoc', [1.25, -0.5, 3]); a.setOpt('projRot', [10, 20, 30]);
  a.setOpt('projSource', 'point'); a.setOpt('projPoints', 4); a.setOpt('projSpread', 35);
  const b = new Editor(); b.persistOptions(storage);
  for (const k of PERSISTED_OPTS) assert.deepEqual(b.opts[k], a.opts[k], k);
  store.set('stratum.toolOptions', JSON.stringify({ projLoc: [1, 'x', 2], projRot: 'up', projPoints: '9', shape3d: 'projection' }));
  const c = new Editor(); c.persistOptions(storage);
  assert.equal(c.opts.projLoc, null); assert.deepEqual(c.opts.projRot, [-90, 0, 0]); assert.equal(c.opts.projPoints, 1); assert.equal(c.opts.shape3d, 'projection');
});

// ---------------------------------------------------------------- firing from the projector
function meshOf(quads) {
  const pos = [], idx = [], uvs = [], groups = [];
  for (const q of quads) {
    const start = idx.length / 3, base = pos.length / 3;
    for (const p of q.corners) pos.push(...p);
    const [u0, v0, u1, v1] = q.uv, cuv = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    for (const [a, b, c] of [[0, 1, 2], [0, 2, 3]]) { idx.push(base + a, base + b, base + c); uvs.push(...cuv[a], ...cuv[b], ...cuv[c]); }
    groups.push({ start, count: 2 });
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), uvs: new Float32Array(uvs), groups };
}
const hq = (y, s, uv) => ({ corners: [[-s, y, -s], [s, y, -s], [s, y, s], [-s, y, s]], uv });
const W = 256, H = 256;
const alphaAt = (p, x, y) => (!p || x < p.x || y < p.y || x >= p.x + p.w || y >= p.y + p.h) ? 0 : p.data[((y - p.y) * p.w + (x - p.x)) * 4 + 3];
function fire(mount, { loc, rot, source = 'parallel', dist = 1, points = 1, spread = 0, shape = null }) {
  const ax = projectorAxes(rot);
  const aim = aimProjection({ n: ax.forward, U: ax.right, V: ax.up.map((v) => -v), anchor: loc, scale: 0.01, source, base: ax.forward.map((v) => -v * dist), points, spread, positions: mount.positions });
  // shape: world square on the projector plane (half size), or the whole image
  let S;
  if (shape) {
    const a = planeCoords(aim.plane, [loc[0] - shape, loc[1], loc[2] - shape]), b = planeCoords(aim.plane, [loc[0] + shape, loc[1], loc[2] + shape]);
    const x = Math.round(Math.min(a[0], b[0])), y = Math.round(Math.min(a[1], b[1])), w = Math.round(Math.abs(b[0] - a[0])), h = Math.round(Math.abs(b[1] - a[1]));
    S = { x, y, w, h, data: new Uint8ClampedArray(w * h * 4).fill(255) };
  } else S = { x: 0, y: 0, w: aim.RW, h: aim.RH, data: new Uint8ClampedArray(aim.RW * aim.RH * 4).fill(255) };
  return { aim, paint: projectPaint({ mount, projector: aim.projectors, shape: S, atlasW: W, atlasH: H, dilate: 0 }) };
}

test('a projector placed above fires down: the shape centred on its location, lid protects floor', () => {
  // lid y = 1, ±1 (texture top-left quarter); floor y = 0, ±2.5 (bottom-right quarter)
  const mount = meshOf([hq(1, 1, [0, 0, 0.5, 0.5]), hq(0, 2.5, [0.5, 0.5, 1, 1])]);
  const floorTex = (x, z) => [Math.floor((0.5 + ((x + 2.5) / 5) * 0.5) * W), Math.floor((0.5 + ((z + 2.5) / 5) * 0.5) * H)];
  const { paint } = fire(mount, { loc: [0, 2, 0], rot: ROT_PRESETS.down, shape: 2 });
  assert.equal(alphaAt(paint, ...floorTex(0, 0)), 0, 'floor under the lid');
  assert.equal(alphaAt(paint, ...floorTex(1.5, 0)), 255, 'open floor inside the shape');
  assert.equal(alphaAt(paint, ...floorTex(2.3, 0)), 0, 'floor outside the shape');
  assert.equal(alphaAt(paint, 64, 64), 255, 'lid');
});

test('point origin: perspective footprint grows with distance from the source', () => {
  const mount = meshOf([hq(0, 3, [0, 0, 1, 1])]); // floor ±3, u = (x+3)/6
  const tex = (x) => [Math.floor(((x + 3) / 6) * W), Math.floor((3 / 6) * H)];
  // projector at y = 1, shape ±0.25 on its plane; point source 1 behind it (y = 2): ×2 on the floor
  const par = fire(mount, { loc: [0, 1, 0], rot: ROT_PRESETS.down, shape: 0.25 }).paint;
  const pt = fire(mount, { loc: [0, 1, 0], rot: ROT_PRESETS.down, shape: 0.25, source: 'point', dist: 1 }).paint;
  assert.equal(alphaAt(par, ...tex(0.2)), 255); assert.equal(alphaAt(par, ...tex(0.4)), 0, 'parallel: ±0.25');
  assert.equal(alphaAt(pt, ...tex(0.4)), 255); assert.equal(alphaAt(pt, ...tex(0.6)), 0, 'point: ±0.5');
  const P = fire(mount, { loc: [0, 1, 0], rot: ROT_PRESETS.down, source: 'point', dist: 1 }).aim.projectors[0];
  assert.equal(P.kind, 'point'); close(P.eye, [0, 2, 0], 1e-12, 'source behind the projector');
});

test('several origins: union covers the sides of a box; 1 point equals the single projection', () => {
  // box x,z ±0.5, y 0..1: top (cell 0), +x (1), −x (2), +z (3), −z (4)
  const q = (c, uv) => ({ corners: c, uv });
  const cell = (k) => [k * 0.2 + 0.01, 0.01, k * 0.2 + 0.19, 0.19];
  const mount = meshOf([
    q([[-0.5, 1, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]], cell(0)),
    q([[0.5, 0, -0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5]], cell(1)),
    q([[-0.5, 0, 0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [-0.5, 1, 0.5]], cell(2)),
    q([[0.5, 0, 0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [0.5, 1, 0.5]], cell(3)),
    q([[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5]], cell(4)),
  ]);
  const centre = (k) => [Math.floor((k * 0.2 + 0.1) * W), Math.floor(0.1 * H)];
  const one = fire(mount, { loc: [0, 2, 0], rot: ROT_PRESETS.down }).paint;
  const one30 = fire(mount, { loc: [0, 2, 0], rot: ROT_PRESETS.down, points: 1, spread: 30 });
  assert.equal(one30.aim.projectors.length, 1);
  assert.deepEqual(one30.paint, one, '1 point ignores the spread');
  assert.equal(alphaAt(one, ...centre(0)), 255);
  for (let k = 1; k <= 4; k++) assert.equal(alphaAt(one, ...centre(k)), 0, `side ${k} with one origin`);
  const four = fire(mount, { loc: [0, 2, 0], rot: ROT_PRESETS.down, points: 4, spread: 45 });
  assert.equal(four.aim.projectors.length, 4);
  for (let k = 0; k <= 4; k++) assert.ok(alphaAt(four.paint, ...centre(k)) > 200, `face ${k} with four origins`);
  const pts = fire(mount, { loc: [0, 2, 0], rot: ROT_PRESETS.down, points: 4, spread: 45, source: 'point', dist: 2 });
  for (let k = 0; k <= 4; k++) assert.ok(alphaAt(pts.paint, ...centre(k)) > 200, `face ${k} with four point origins`);
});

test('several origins: a texel hidden from every origin stays clean (each has its own depth map)', () => {
  const mount = meshOf([hq(1, 1, [0, 0, 0.5, 0.5]), hq(0, 2.5, [0.5, 0.5, 1, 1])]);
  const floorTex = (x, z) => [Math.floor((0.5 + ((x + 2.5) / 5) * 0.5) * W), Math.floor((0.5 + ((z + 2.5) / 5) * 0.5) * H)];
  for (const source of ['parallel', 'point']) {
    // 30° ring: an origin sees at most tan 30° ≈ 0.58 under the lid's edge (1 unit up): centre hidden
    const { paint } = fire(mount, { loc: [0, 2, 0], rot: ROT_PRESETS.down, points: 6, spread: 30, source, dist: 3 });
    assert.equal(alphaAt(paint, ...floorTex(0, 0)), 0, `${source}: floor centre`);
    assert.equal(alphaAt(paint, ...floorTex(0.2, 0.1)), 0, `${source}: deep under the lid`);
    assert.equal(alphaAt(paint, ...floorTex(2, 0)), 255, `${source}: open floor`);
    // parallel origins look under the lid's edge; point sources converge on the projector, so not
    if (source === 'parallel') assert.ok(alphaAt(paint, ...floorTex(0.75, 0)) > 0, 'parallel: just under the edge, seen by a tilted origin');
  }
});

test('a projector aligned to the view with its point source at the eye reproduces the camera mapping', () => {
  const perspective = (f0, asp, n, f) => { const t = 1 / Math.tan(f0 / 2), nf = 1 / (n - f); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) * nf, -1, 0, 0, 2 * f * n * nf, 0]; };
  const yaw = 0.7, pitch = 0.35, eye = [3 * Math.cos(pitch) * Math.sin(yaw), 3 * Math.sin(pitch), 3 * Math.cos(pitch) * Math.cos(yaw)];
  const ax = projectorAxes(eulerFromView(yaw, pitch));
  const view = [...ax.right, 0, ...ax.up, 0, ...ax.forward.map((v) => -v), 0].concat([-dot(ax.right, eye), -dot(ax.up, eye), dot(ax.forward, eye), 1]);
  const V4 = [view[0], view[4], view[8], 0, view[1], view[5], view[9], 0, view[2], view[6], view[10], 0, view[12], view[13], view[14], 1];
  const P4 = perspective(0.7, 1.5, 0.01, 50), mvp = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) mvp[c * 4 + r] += P4[k * 4 + r] * V4[c * 4 + k];
  const cam = viewProjector(mvp, 600, 400, eye);
  // projector at a point on the view axis 2 units ahead; image = the screen
  const A = eye.map((v, i) => v + ax.forward[i] * 2), s = (2 * 2 * Math.tan(0.35)) / 400;
  const O = A.map((v, i) => v - ax.right[i] * 300 * s + ax.up[i] * 200 * s);
  const aim = aimProjection({ n: ax.forward, U: ax.right, V: ax.up.map((v) => -v), anchor: A, scale: s, source: 'point', base: eye.map((v, i) => v - A[i]), view: { O, RW: 600, RH: 400 } });
  for (const p of [[0, 0, 0], [0.4, -0.3, 0.2], [-0.8, 0.5, -0.6]]) {
    const a = project(cam, ...p), b = project(aim.main, ...p);
    close(b.slice(0, 2), a.slice(0, 2), 1e-6, 'pixel'); assert.ok(Math.abs(a[2] - b[2]) < 1e-9, 'depth');
  }
});
