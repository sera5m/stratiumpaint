import test from 'node:test';
import assert from 'node:assert/strict';

import { viewProjector, axisProjector, project, projectPaint, depthMap, commitProjection, AXES } from '../src/js/core/projection.js';
import { Doc } from '../src/js/doc/document.js';

// ---- tiny mesh builder: axis-aligned quads, each with its own UV rect (u0,v0,u1,v1) and group
function meshOf(quads) {
  const pos = [], idx = [], uvs = [], groups = [];
  for (const q of quads) {
    const start = idx.length / 3, base = pos.length / 3;
    for (const p of q.corners) pos.push(...p);
    const [u0, v0, u1, v1] = q.uv;
    const cuv = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    for (const [a, b, c] of [[0, 1, 2], [0, 2, 3]]) { idx.push(base + a, base + b, base + c); uvs.push(...cuv[a], ...cuv[b], ...cuv[c]); }
    groups.push({ name: q.name || `g${groups.length}`, start, count: 2 });
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), uvs: new Float32Array(uvs), groups };
}
/** Horizontal quad at height y over [x0,x1]×[z0,z1]. */
const hquad = (y, x0, x1, z0, z1, uv, name) => ({ corners: [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], uv, name });
/** Vertical quad (constant z) over [x0,x1]×[y0,y1]. */
const vquad = (z, x0, x1, y0, y1, uv, name) => ({ corners: [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], uv, name });

/** A filled shape image on the projector plane: rect (x,y,w,h) of colour rgb. */
function solid(x, y, w, h, rgb = [255, 0, 0], a = 255) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, a], i * 4);
  return { x, y, w, h, data };
}
/** Down projector covering [-2,2]² in x/z with 100 px per world unit, standing at y = 5. */
const down = () => axisProjector('down', [-2, 5, -2], 0.01, 400, 400);
const W = 128, H = 128;
/** Alpha of the paint at atlas texel (x,y). */
const alphaAt = (p, x, y) => (!p || x < p.x || y < p.y || x >= p.x + p.w || y >= p.y + p.h) ? 0 : p.data[((y - p.y) * p.w + (x - p.x)) * 4 + 3];
/** Painted texel count inside atlas rect [u0,u1)×[v0,v1) (UV units). */
function paintedIn(p, u0, v0, u1, v1) {
  let n = 0;
  for (let y = Math.floor(v0 * H); y < Math.ceil(v1 * H); y++) for (let x = Math.floor(u0 * W); x < Math.ceil(u1 * W); x++) if (alphaAt(p, x, y) > 0) n++;
  return n;
}

// GL-style column-major helpers for the camera case.
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function lookAt(eye, target, up) {
  const sub = (a, b) => a.map((v, i) => v - b[i]), nrm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = nrm(sub(eye, target)), x = nrm(cross(up, z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}
function mul(a, b) { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; }

test('projection math: axis projector maps world to image pixels and depth', () => {
  const P = down();
  const o = project(P, -2, 5, -2);
  assert.deepEqual(o.slice(0, 3).map((v) => +v.toFixed(6)), [0, 0, 0]);
  const p = project(P, 0, 1, 0); // 2 units right / forward of origin, 4 below the plane
  assert.ok(Math.abs(p[0] - 200) < 1e-6 && Math.abs(p[1] - 200) < 1e-6 && Math.abs(p[2] - 4) < 1e-9);
  for (const [name, a] of Object.entries(AXES)) { // basis is orthonormal and right-handed enough to be a projection
    const d = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    assert.ok(Math.abs(d(a.U, a.V)) < 1e-9 && Math.abs(d(a.U, a.dir)) < 1e-9 && Math.abs(d(a.V, a.dir)) < 1e-9, name);
  }
});

test('projection math: view projector equals the GL camera mapping (ndc → pixels, depth = w)', () => {
  const eye = [1, 3, 4], mvp = mul(perspective(0.7, 1.5, 0.01, 50), lookAt(eye, [0, 0, 0], [0, 1, 0]));
  const P = viewProjector(mvp, 600, 400, eye);
  for (const pt of [[0, 0, 0], [0.3, -0.2, 0.5], [-1, 0.4, 0.2]]) {
    const cx = mvp[0] * pt[0] + mvp[4] * pt[1] + mvp[8] * pt[2] + mvp[12], cy = mvp[1] * pt[0] + mvp[5] * pt[1] + mvp[9] * pt[2] + mvp[13];
    const cw = mvp[3] * pt[0] + mvp[7] * pt[1] + mvp[11] * pt[2] + mvp[15];
    const q = project(P, ...pt);
    assert.ok(Math.abs(q[0] - (cx / cw * 0.5 + 0.5) * 600) < 1e-6);
    assert.ok(Math.abs(q[1] - (0.5 - cy / cw * 0.5) * 400) < 1e-6);
    assert.ok(Math.abs(q[2] - cw) < 1e-9);
  }
  // centre of the screen is the look-at target
  const c = project(P, 0, 0, 0);
  assert.ok(Math.abs(c[0] - 300) < 1e-6 && Math.abs(c[1] - 200) < 1e-6);
});

test('occlusion: two stacked planes, shape over both — only the top one gets paint', () => {
  const mount = meshOf([hquad(1, -1, 1, -1, 1, [0, 0, 0.5, 0.5], 'top'), hquad(0, -1, 1, -1, 1, [0.5, 0.5, 1, 1], 'bottom')]);
  const p = projectPaint({ mount, projector: down(), shape: solid(50, 50, 300, 300), atlasW: W, atlasH: H, dilate: 0 });
  assert.ok(paintedIn(p, 0, 0, 0.5, 0.5) > 0.9 * 64 * 64, 'top plane mostly painted');
  assert.equal(paintedIn(p, 0.5, 0.5, 1, 1), 0, 'bottom plane behind it got paint');
  // the same from a camera nearly overhead (at an oblique angle the far edge of the bottom plane really
  // is visible past the top plane's silhouette, and gets paint, as it should)
  const eye = [0.05, 4, 0.1], mvp = mul(perspective(0.7, 1, 0.01, 50), lookAt(eye, [0, 0, 0], [0, 0, -1]));
  const P = viewProjector(mvp, 400, 400, eye);
  const q = projectPaint({ mount, projector: P, shape: solid(0, 0, 400, 400), atlasW: W, atlasH: H, dilate: 0 });
  assert.ok(paintedIn(q, 0, 0, 0.5, 0.5) > 0.9 * 64 * 64);
  assert.equal(paintedIn(q, 0.5, 0.5, 1, 1), 0);
});

test('occlusion: the lower plane is painted where the upper one does not cover it', () => {
  const mount = meshOf([hquad(1, -1, 0, -1, 1, [0, 0, 0.5, 0.5], 'top-half'), hquad(0, -1, 1, -1, 1, [0.5, 0.5, 1, 1], 'floor')]);
  const p = projectPaint({ mount, projector: down(), shape: solid(0, 0, 400, 400), atlasW: W, atlasH: H, dilate: 0 });
  // floor: x in [-1,1] → u 0.5..1; the half under the top plane (x < 0 → u < 0.75) stays clean
  assert.equal(paintedIn(p, 0.5, 0.5, 0.74, 1), 0);
  assert.ok(paintedIn(p, 0.76, 0.5, 1, 1) > 0.9 * 0.24 * W * 0.5 * H);
});

test('multi-object: one shape across two separate objects and charts paints both', () => {
  const mount = meshOf([hquad(0.5, -1.5, -0.2, -1, 1, [0, 0, 0.4, 0.4], 'left box'), hquad(-0.3, 0.2, 1.5, -1, 1, [0.6, 0.6, 1, 1], 'right box')]);
  const p = projectPaint({ mount, projector: down(), shape: solid(40, 100, 320, 200), atlasW: W, atlasH: H, dilate: 0 });
  assert.ok(paintedIn(p, 0, 0, 0.4, 0.4) > 100);
  assert.ok(paintedIn(p, 0.6, 0.6, 1, 1) > 100);
});

test('hidden objects neither receive paint nor occlude; moved objects are painted where they are', () => {
  const mount = meshOf([hquad(1, -1, 1, -1, 1, [0, 0, 0.5, 0.5], 'top'), hquad(0, -1, 1, -1, 1, [0.5, 0.5, 1, 1], 'bottom')]);
  const shape = solid(50, 50, 300, 300);
  const p = projectPaint({ mount, projector: down(), shape, atlasW: W, atlasH: H, hidden: [true, false], dilate: 0 });
  assert.equal(paintedIn(p, 0, 0, 0.5, 0.5), 0, 'hidden top got paint');
  assert.ok(paintedIn(p, 0.5, 0.5, 1, 1) > 0.5 * 64 * 64, 'bottom not painted through the hidden top');
  // top moved aside (offset +3 in x): out of the footprint, so the bottom is painted, the top not
  const q = projectPaint({ mount, projector: down(), shape, atlasW: W, atlasH: H, offsets: [[3, 0, 0]], dilate: 0 });
  assert.equal(paintedIn(q, 0, 0, 0.5, 0.5), 0);
  assert.ok(paintedIn(q, 0.5, 0.5, 1, 1) > 0.5 * 64 * 64);
});

test('grazing faces: a wall parallel to the projection gets no paint; a tilted one fades', () => {
  const wall = meshOf([vquad(0, -1, 1, 0, 1, [0, 0, 0.5, 0.5], 'wall'), hquad(0, -1, 1, 0.2, 1.2, [0.5, 0.5, 1, 1], 'floor')]);
  const p = projectPaint({ mount: wall, projector: down(), shape: solid(0, 0, 400, 400), atlasW: W, atlasH: H, dilate: 0 });
  assert.equal(paintedIn(p, 0, 0, 0.5, 0.5), 0);
  assert.ok(paintedIn(p, 0.5, 0.5, 1, 1) > 0);
  // 45° slope with maxAngle 40: rejected; with 80: painted fully
  const slope = meshOf([{ corners: [[-1, 0, -1], [1, 0, -1], [1, 2, 1], [-1, 2, 1]], uv: [0, 0, 1, 1] }]);
  const a = projectPaint({ mount: slope, projector: down(), shape: solid(0, 0, 400, 400), atlasW: W, atlasH: H, maxAngle: 40, dilate: 0 });
  const b = projectPaint({ mount: slope, projector: down(), shape: solid(0, 0, 400, 400), atlasW: W, atlasH: H, maxAngle: 80, dilate: 0 });
  assert.equal(a, null);
  assert.ok(alphaAt(b, 64, 64) === 255);
});

test('antialiased edge, opacity, and dilation into the UV gutter only', () => {
  const mount = meshOf([hquad(0, -1, 1, -1, 1, [0.25, 0.25, 0.5, 0.5], 'a'), hquad(-1, -1, 1, -1, 1, [0.5, 0.25, 0.75, 0.5], 'b (under a)')]);
  // a soft-edged shape: the edge column at half alpha
  const s = solid(100, 100, 200, 200);
  for (let y = 0; y < 200; y++) s.data[(y * 200 + 199) * 4 + 3] = 128;
  const p = projectPaint({ mount, projector: down(), shape: s, atlasW: W, atlasH: H, opacity: 0.5, dilate: 2 });
  const full = alphaAt(p, 40, 40);
  assert.ok(Math.abs(full - 128) <= 1, `opacity 50% → ${full}`);
  // gutter: texels just outside chart a (u < 0.25) got paint from dilation; chart b's texels did not
  assert.ok(alphaAt(p, 31, 40) > 0, 'no dilation into the gutter');
  assert.equal(paintedIn(p, 0.5, 0.25, 0.75, 0.5), 0, 'dilated onto texels another face owns');
  const nod = projectPaint({ mount, projector: down(), shape: s, atlasW: W, atlasH: H, dilate: 0 });
  assert.equal(alphaAt(nod, 31, 40), 0);
});

test('history: one step, undo restores the texture exactly', () => {
  const mount = meshOf([hquad(1, -1, 1, -1, 1, [0, 0, 0.5, 0.5]), hquad(0, -1, 1, -1, 1, [0.5, 0.5, 1, 1])]);
  const doc = new Doc(W, H);
  const layer = doc.layers[0];
  for (let i = 0; i < layer.img.data.length; i++) layer.img.data[i] = (i * 7) & 255;
  layer.touch();
  const before = new Uint8ClampedArray(layer.img.data), h0 = doc.history.index;
  const paint = projectPaint({ mount, projector: down(), shape: solid(50, 50, 300, 300, [10, 200, 30]), atlasW: W, atlasH: H });
  const r = commitProjection(doc, layer, paint);
  assert.ok(r && r.w <= W / 2 + 4 && r.h <= H / 2 + 4, `rect ${JSON.stringify(r)} covers only the top plane's chart`);
  assert.equal(doc.history.index - h0, 1);
  const px = (40 * W + 40) * 4;
  assert.deepEqual([...layer.img.data.slice(px, px + 3)], [10, 200, 30]);
  doc.undo();
  assert.deepEqual(layer.img.data, before);
  doc.redo();
  assert.deepEqual([...layer.img.data.slice(px, px + 3)], [10, 200, 30]);
});

test('depth map: perspective-correct, nearest surface wins', () => {
  const mount = meshOf([hquad(1, -1, 1, -1, 1, [0, 0, 0.5, 0.5]), hquad(0, -2, 2, -2, 2, [0.5, 0.5, 1, 1])]);
  const D = depthMap(mount, down(), { x: 0, y: 0, w: 400, h: 400 });
  assert.ok(Math.abs(D[200 * 400 + 200] - 4) < 1e-5, 'top plane at depth 4');
  assert.ok(Math.abs(D[10 * 400 + 10] - 5) < 1e-5, 'floor at depth 5 outside the top plane');
});
