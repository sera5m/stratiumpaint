// Projection painting for the 3D view: a 2D shape image lives on a projector's image plane (the
// camera's screen, or a plane looking along a world axis) and is shot onto the model. A texel is
// painted when its surface point projects inside the shape AND is the first surface the projector
// sees there (depth-map test, shadow-map style), so paint spans objects, UV charts and seams but
// never goes through a surface. Pure JS (CPU path, and the reference for the WebGPU path).
//
// A projector is four row vectors over homogeneous world points [x y z 1]:
//   px = rx·p / rw·p,  py = ry·p / rw·p  (image-plane pixels, y down),  depth = rd·p (world units).
// Perspective (camera): rw·p = clip w and depth = w (distance along the view axis). Ortho: rw = [0 0 0 1].
import { cropImage } from './image.js';
import { paintImage } from '../doc/raster.js';

/** From a GL-style column-major view-projection matrix and an image of RW×RH device pixels. */
export function viewProjector(mvp, RW, RH, eye) {
  const row = (i) => [mvp[i], mvp[4 + i], mvp[8 + i], mvp[12 + i]];
  const r0 = row(0), r1 = row(1), r3 = row(3);
  const rx = r0.map((v, k) => 0.5 * RW * (v + r3[k]));
  const ry = r1.map((v, k) => 0.5 * RH * (r3[k] - v));
  return { kind: 'view', rx, ry, rw: r3, rd: r3, RW, RH, eye: [...eye], dir: null };
}

/** World-axis projections: "from" names where the projector stands. dir = direction it shoots. */
export const AXES = {
  down: { dir: [0, -1, 0], U: [1, 0, 0], V: [0, 0, 1] }, // from above, shooting down (−Y)
  up: { dir: [0, 1, 0], U: [1, 0, 0], V: [0, 0, -1] }, // from below (+Y)
  front: { dir: [0, 0, -1], U: [1, 0, 0], V: [0, -1, 0] }, // from +Z towards −Z
  back: { dir: [0, 0, 1], U: [-1, 0, 0], V: [0, -1, 0] },
  right: { dir: [-1, 0, 0], U: [0, 0, -1], V: [0, -1, 0] }, // from +X
  left: { dir: [1, 0, 0], U: [0, 0, 1], V: [0, -1, 0] },
};

/**
 * Orthographic projector looking along AXES[name].dir. origin: world point at image pixel (0,0) on
 * the plane where depth = 0; scale: world units per image pixel.
 */
export function axisProjector(name, origin, scale, RW, RH) {
  const { dir, U, V } = AXES[name];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return {
    kind: 'axis', axis: name,
    rx: [U[0] / scale, U[1] / scale, U[2] / scale, -dot(U, origin) / scale],
    ry: [V[0] / scale, V[1] / scale, V[2] / scale, -dot(V, origin) / scale],
    rd: [dir[0], dir[1], dir[2], -dot(dir, origin)],
    rw: [0, 0, 0, 1], RW, RH, eye: null, dir: [...dir], origin: [...origin], scale, U: [...U], V: [...V],
  };
}

/**
 * Column-major 4×4 (GL / WGSL) taking a world point to decal coordinates of image rect `box`:
 * (u, v) = xy / w in 0..1 over the box, w > 0 in front of the projector. For the drag preview.
 */
export function decalMatrix(P, box) {
  const A = P.rx.map((v, i) => (v - box.x * P.rw[i]) / box.w);
  const B = P.ry.map((v, i) => (v - box.y * P.rw[i]) / box.h);
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++) { m[c * 4] = A[c]; m[c * 4 + 1] = B[c]; m[c * 4 + 2] = 0; m[c * 4 + 3] = P.rw[c]; }
  return m;
}

// ------------------------------------------------------------------ the projector object
// A projector is an object like a Blender camera or spot light: a location and an XYZ Euler
// rotation in degrees (Blender's default order: R = Rz · Ry · Rx, i.e. turn about X, then Y, then
// Z, all about the world axes). It fires along its local −Z; local +X is the image's right and
// local +Y its up. World is Y-up (glTF). Rotation (0, 0, 0) fires along −Z (the Front preset).
const D2R = Math.PI / 180;
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Rotation presets (XYZ Euler, degrees). View is the camera's, see eulerFromView. */
export const ROT_PRESETS = { down: [-90, 0, 0], up: [90, 0, 0], front: [0, 0, 0], back: [0, 180, 0], right: [0, 90, 0], left: [0, -90, 0] };

/** Rotate v by XYZ Euler angles (degrees): Rz · Ry · Rx · v. */
export function rotateEuler(v, [rx, ry, rz]) {
  let [x, y, z] = v;
  let c = Math.cos(rx * D2R), s = Math.sin(rx * D2R);
  [y, z] = [y * c - z * s, y * s + z * c];
  c = Math.cos(ry * D2R); s = Math.sin(ry * D2R);
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(rz * D2R); s = Math.sin(rz * D2R);
  [x, y] = [x * c - y * s, x * s + y * c];
  return [x, y, z];
}

/** The projector's axes for a rotation: right (+X), up (+Y), forward (the firing direction, −Z). */
export function projectorAxes(rot) {
  return { right: rotateEuler([1, 0, 0], rot), up: rotateEuler([0, 1, 0], rot), forward: rotateEuler([0, 0, -1], rot) };
}

/** Rotation that looks like the 3D view's camera (yaw / pitch in radians, as in MeshView). */
export function eulerFromView(yaw, pitch) {
  const w = (a) => { let d = ((a % 360) + 540) % 360 - 180; if (Math.abs(d) < 1e-9) d = 0; return d; };
  return [w(-pitch / D2R), w(yaw / D2R), 0];
}

/** Preset name of a rotation ('custom' if none); compared by direction and image up. */
export function presetOf(rot) {
  const a = projectorAxes(rot);
  for (const [name, r] of Object.entries(ROT_PRESETS)) {
    const b = projectorAxes(r);
    if (dot3(a.forward, b.forward) > 1 - 1e-9 && dot3(a.up, b.up) > 1 - 1e-9) return name;
  }
  return 'custom';
}

/** The axis that turning Euler component k (0 X, 1 Y, 2 Z) rotates about (gimbal, XYZ order). */
export function eulerAxis(rot, k) {
  if (k === 2) return [0, 0, 1];
  if (k === 1) return rotateEuler([0, 1, 0], [0, 0, rot[2]]);
  return rotateEuler([1, 0, 0], [0, rot[1], rot[2]]);
}

/** Image-plane axes for looking along n: U to the right, V down (as on screen; the axis presets'). */
export function basisFor(n) {
  const up = Math.abs(n[1]) > 0.999 ? (n[1] < 0 ? [0, 0, -1] : [0, 0, 1]) : [0, 1, 0];
  const U = norm3(cross3(n, up));
  return { U, V: cross3(n, U) };
}

/** v turned by `deg` degrees about the axis n × a (which takes n towards a). */
function tilt(v, n, a, deg) {
  const k = norm3(cross3(n, a)), t = deg * D2R, c = Math.cos(t), s = Math.sin(t);
  const kv = cross3(k, v), kd = dot3(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

/**
 * The origins a projection fires from: one, or `points` spread evenly in a ring `spread` degrees
 * around the main direction n. Parallel: { kind: 'parallel', d } (direction). Point: { kind:
 * 'point', E } (position), the main source at anchor + base, the ring turned about the anchor.
 */
export function ringOrigins({ n, U, V, anchor, source = 'parallel', base = null, points = 1, spread = 0 }) {
  const N = Math.max(1, Math.round(points) || 1), one = N === 1 || !(spread > 0);
  const out = [];
  for (let k = 0; k < (one ? 1 : N); k++) {
    const phi = (2 * Math.PI * k) / N, a = add3(mul3(U, Math.cos(phi)), mul3(V, Math.sin(phi)));
    const deg = one ? 0 : spread;
    if (source === 'point') out.push({ kind: 'point', E: add3(anchor, deg ? tilt(base, n, a, deg) : base) });
    else out.push({ kind: 'parallel', d: norm3(deg ? tilt(n, n, a, deg) : n) });
  }
  return out;
}

/**
 * Projector of one origin onto the shape plane (through plane.anchor, facing plane.n, image pixel
 * (x, y) at plane.O + U·x·scale + V·y·scale): a surface point maps to where its ray from the
 * origin crosses that plane. Parallel origins are orthographic (oblique when tilted), point
 * origins perspective. Null when the origin cannot reach the plane.
 */
export function originProjector(o, plane, RW, RH) {
  const { n, U, V, O, scale: s, anchor } = plane;
  if (o.kind === 'point') {
    const E = o.E, Dk = dot3(n, sub3(anchor, E));
    if (!(Dk > 1e-9)) return null;
    const rw = [n[0], n[1], n[2], -dot3(n, E)];
    const row = (X) => { const xe = dot3(X, sub3(E, O)); return [0, 1, 2, 3].map((i) => (xe * rw[i] + Dk * (i < 3 ? X[i] : -dot3(X, E))) / s); };
    return { kind: 'point', rx: row(U), ry: row(V), rd: rw.slice(), rw, RW, RH, eye: [...E], dir: null };
  }
  const d = o.d, nd = dot3(n, d);
  if (!(nd > 0.05)) return null; // (nearly) parallel to the plane, or firing away from it
  const nA = dot3(n, anchor);
  const row = (X) => { const k = dot3(X, d) / nd; return [X[0] - k * n[0], X[1] - k * n[1], X[2] - k * n[2], k * nA - dot3(X, O)].map((v) => v / s); };
  const reach = plane.reach || 1;
  return { kind: 'axis', rx: row(U), ry: row(V), rd: [d[0], d[1], d[2], -(dot3(d, anchor) - reach)], rw: [0, 0, 0, 1], RW, RH, eye: null, dir: [...d] };
}

/** Shape-plane pixel of world point Q on the plane. */
export function planeCoords(plane, Q) {
  const r = sub3(Q, plane.O);
  return [dot3(plane.U, r) / plane.scale, dot3(plane.V, r) / plane.scale];
}

/**
 * Everything one aimed projection needs: n (shooting direction), anchor (plane point, usually the
 * surface under the cursor), scale (world units per image pixel), source / base / points /
 * spread (see ringOrigins), positions (visible model, xyz) to size the image so the whole model's
 * footprint fits (capped at maxPx; the scale grows instead), or `view` = { O, RW, RH } to use a
 * fixed image (the screen). Returns { plane, origins, projectors, main, RW, RH }; `main` is the
 * centre (spread 0) projector, for the drag preview.
 */
export function aimProjection({ n, U = null, V = null, anchor, scale, source = 'parallel', base = null, points = 1, spread = 0,
  positions = null, view = null, maxPx = 4096 }) {
  n = norm3(n);
  if (!U || !V) ({ U, V } = basisFor(n));
  if (source === 'point' && !base) base = mul3(n, -1);
  const origins = ringOrigins({ n, U, V, anchor, source, base, points, spread });
  const mainO = ringOrigins({ n, U, V, anchor, source, base, points: 1 })[0];
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const step = positions ? Math.max(1, Math.floor(positions.length / 3 / 60000)) * 3 : 3;
  for (let i = 0; positions && i < positions.length; i += step) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], positions[i + k]); hi[k] = Math.max(hi[k], positions[i + k]); }
  const diag = positions && hi[0] >= lo[0] ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1 : 2;
  let O, RW, RH, s = scale;
  if (view) ({ O, RW, RH } = view);
  else {
    // Footprint of the model on the plane from every origin (world units from the anchor).
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    const lim = diag * 10, nA = dot3(n, anchor);
    for (const o of [...origins, mainO]) {
      for (let i = 0; positions && i < positions.length; i += step) {
        const p = [positions[i], positions[i + 1], positions[i + 2]];
        let q;
        if (o.kind === 'point') { const w = dot3(n, sub3(p, o.E)); if (!(w > 1e-9)) continue; q = add3(o.E, mul3(sub3(p, o.E), dot3(n, sub3(anchor, o.E)) / w)); }
        else { const nd = dot3(n, o.d); if (!(nd > 0.05)) continue; q = add3(p, mul3(o.d, (nA - dot3(n, p)) / nd)); }
        const r = sub3(q, anchor), u = Math.max(-lim, Math.min(lim, dot3(U, r))), v = Math.max(-lim, Math.min(lim, dot3(V, r)));
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
    }
    if (!(u1 >= u0)) { u0 = v0 = -diag; u1 = v1 = diag; }
    const pad = 0.05 * Math.max(u1 - u0, v1 - v0, 1e-3);
    u0 -= pad; v0 -= pad; u1 += pad; v1 += pad;
    if (Math.max(u1 - u0, v1 - v0) / s > maxPx) s = Math.max(u1 - u0, v1 - v0) / maxPx;
    O = add3(anchor, add3(mul3(U, u0), mul3(V, v0)));
    RW = Math.max(1, Math.ceil((u1 - u0) / s)); RH = Math.max(1, Math.ceil((v1 - v0) / s));
  }
  const plane = { n, U, V, O, scale: s, anchor: [...anchor], reach: diag * 2 };
  const projectors = origins.map((o) => originProjector(o, plane, RW, RH)).filter(Boolean);
  return { plane, origins, projectors, main: originProjector(mainO, plane, RW, RH), RW, RH };
}

/** World point → [px, py, depth, w] (w <= 0: behind the projector). */
export function project(P, x, y, z, out = [0, 0, 0, 0]) {
  const { rx, ry, rd, rw } = P;
  const w = rw[0] * x + rw[1] * y + rw[2] * z + rw[3];
  out[3] = w;
  out[2] = rd[0] * x + rd[1] * y + rd[2] * z + rd[3];
  if (w <= 1e-9) { out[0] = out[1] = NaN; return out; }
  out[0] = (rx[0] * x + rx[1] * y + rx[2] * z + rx[3]) / w;
  out[1] = (ry[0] * x + ry[1] * y + ry[2] * z + ry[3]) / w;
  return out;
}

/** Face → group index (-1 if none), from mount.groups [{ start, count }]. */
function faceGroups(mount) {
  const n = mount.indices.length / 3, fg = new Int32Array(n).fill(-1);
  (mount.groups || []).forEach((g, gi) => { for (let t = g.start; t < g.start + g.count && t < n; t++) fg[t] = gi; });
  return fg;
}

/** World corners of face t with the group's temporary offset. */
function corners(mount, t, off) {
  const { positions: p, indices: ix } = mount, o = off || [0, 0, 0];
  const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
  return [
    p[a] + o[0], p[a + 1] + o[1], p[a + 2] + o[2],
    p[b] + o[0], p[b + 1] + o[1], p[b + 2] + o[2],
    p[c] + o[0], p[c + 1] + o[1], p[c + 2] + o[2],
  ];
}

export const projectionStats = { depthTris: 0, uvTris: 0, texels: 0, painted: 0, dilated: 0 };

/**
 * Depth map of the visible mesh as the projector sees it, over image rect R (pixels).
 * Perspective-correct: depth/w and 1/w interpolate linearly on the image plane.
 */
export function depthMap(mount, P, R, { hidden = [], offsets = [] } = {}) {
  const D = new Float32Array(R.w * R.h).fill(Infinity);
  const fg = faceGroups(mount), n = mount.indices.length / 3;
  const q = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let t = 0; t < n; t++) {
    const gi = fg[t];
    if (gi >= 0 && hidden[gi]) continue;
    const c = corners(mount, t, gi >= 0 ? offsets[gi] : null);
    project(P, c[0], c[1], c[2], q[0]); project(P, c[3], c[4], c[5], q[1]); project(P, c[6], c[7], c[8], q[2]);
    if (q[0][3] <= 1e-9 || q[1][3] <= 1e-9 || q[2][3] <= 1e-9) continue; // crosses the projector plane
    const x0 = Math.max(R.x, Math.floor(Math.min(q[0][0], q[1][0], q[2][0]))), x1 = Math.min(R.x + R.w - 1, Math.ceil(Math.max(q[0][0], q[1][0], q[2][0])));
    const y0 = Math.max(R.y, Math.floor(Math.min(q[0][1], q[1][1], q[2][1]))), y1 = Math.min(R.y + R.h - 1, Math.ceil(Math.max(q[0][1], q[1][1], q[2][1])));
    if (x1 < x0 || y1 < y0) continue;
    const [ax, ay] = q[0], [bx, by] = q[1], [cx, cy] = q[2];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    projectionStats.depthTris++;
    const iw0 = 1 / q[0][3], iw1 = 1 / q[1][3], iw2 = 1 / q[2][3];
    const dw0 = q[0][2] * iw0, dw1 = q[1][2] * iw1, dw2 = q[2][2] * iw2;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const l1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area; // weight of b
        const l2 = ((ax - px) * (by - py) - (ay - py) * (bx - px)) / area; // weight of c
        const l0 = 1 - l1 - l2;
        if (l0 < 0 || l1 < 0 || l2 < 0) continue;
        const iw = l0 * iw0 + l1 * iw1 + l2 * iw2;
        const d = (l0 * dw0 + l1 * dw1 + l2 * dw2) / iw;
        const k = (y - R.y) * R.w + (x - R.x);
        if (d < D[k]) D[k] = d;
      }
    }
  }
  return D;
}

/** Premultiplied bilinear (or nearest) sample of a straight-alpha RGBA image at pixel coords. */
function sampleShape(S, px, py, aa, out) {
  if (!aa) {
    const x = Math.floor(px) - S.x, y = Math.floor(py) - S.y;
    if (x < 0 || y < 0 || x >= S.w || y >= S.h) { out[3] = 0; return out; }
    const i = (y * S.w + x) * 4, d = S.data;
    out[0] = d[i]; out[1] = d[i + 1]; out[2] = d[i + 2]; out[3] = d[i + 3] / 255;
    return out;
  }
  const fx = px - 0.5 - S.x, fy = py - 0.5 - S.y;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  let r = 0, g = 0, b = 0, a = 0;
  const d = S.data;
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const x = x0 + i, y = y0 + j;
    if (x < 0 || y < 0 || x >= S.w || y >= S.h) continue;
    const wgt = (i ? tx : 1 - tx) * (j ? ty : 1 - ty), k = (y * S.w + x) * 4, al = (d[k + 3] / 255) * wgt;
    r += d[k] * al; g += d[k + 1] * al; b += d[k + 2] * al; a += al;
  }
  if (a > 1e-6) { out[0] = r / a; out[1] = g / a; out[2] = b / a; } else { out[0] = out[1] = out[2] = 0; }
  out[3] = a;
  return out;
}

/** Smallest rect holding all of `boxes` ({x,y,w,h}). */
export function unionBox(boxes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Pass 1 of a projection (shared by the CPU and WebGPU paths): the faces that can receive paint
 * (visible, in front of the projector, over the shape) with their UV corners, normal and depth
 * bias, the atlas box they cover (grown by `dilate`) and the depth-map rect R. Null if none.
 */
export function projectionPlan({ mount, projector: P, shape: S, atlasW: W, atlasH: H,
  hidden = [], offsets = [], maxAngle = 80, fade = 8, dilate = 2 }) {
  if (!mount?.uvs || !S?.w || !S?.h) return null;
  const R = { x: S.x - 2, y: S.y - 2, w: S.w + 4, h: S.h + 4 };
  const fg = faceGroups(mount), n = mount.indices.length / 3, uv = mount.uvs;
  const cosMax = maxAngle >= 90 ? -1 : Math.cos((maxAngle * Math.PI) / 180);
  const cosFull = maxAngle >= 90 ? -1 : Math.cos((Math.max(0, maxAngle - fade) * Math.PI) / 180);
  // Pass 1: which faces can receive paint (visible, in front of the projector, over the shape),
  // and the atlas rect they cover.
  const cand = [];
  let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
  const q = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let t = 0; t < n; t++) {
    const gi = fg[t];
    if (gi >= 0 && hidden[gi]) continue;
    const c = corners(mount, t, gi >= 0 ? offsets[gi] : null);
    project(P, c[0], c[1], c[2], q[0]); project(P, c[3], c[4], c[5], q[1]); project(P, c[6], c[7], c[8], q[2]);
    if (q[0][3] <= 1e-9 || q[1][3] <= 1e-9 || q[2][3] <= 1e-9) continue;
    if (Math.max(q[0][0], q[1][0], q[2][0]) < S.x || Math.min(q[0][0], q[1][0], q[2][0]) > S.x + S.w) continue;
    if (Math.max(q[0][1], q[1][1], q[2][1]) < S.y || Math.min(q[0][1], q[1][1], q[2][1]) > S.y + S.h) continue;
    // Slope-scaled depth bias: how fast depth changes per image pixel across this face.
    const [ax, ay, ad] = q[0], [bx, by, bd] = q[1], [cx, cy, cd] = q[2];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    let gx = 0, gy = 0;
    if (Math.abs(area) > 1e-12) { gx = ((bd - ad) * (cy - ay) - (cd - ad) * (by - ay)) / area; gy = ((cd - ad) * (bx - ax) - (bd - ad) * (cx - ax)) / area; }
    const e1 = [c[3] - c[0], c[4] - c[1], c[5] - c[2]], e2 = [c[6] - c[0], c[7] - c[1], c[8] - c[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const span = Math.max(Math.abs(ad), Math.abs(bd), Math.abs(cd), 1e-3);
    const bias = Math.min(1.5 * (Math.abs(gx) + Math.abs(gy)), span * 0.05) + span * 2e-4;
    const i = t * 3;
    const us = [uv[i * 2] * W, uv[(i + 1) * 2] * W, uv[(i + 2) * 2] * W], vs = [uv[i * 2 + 1] * H, uv[(i + 1) * 2 + 1] * H, uv[(i + 2) * 2 + 1] * H];
    cand.push({ c, us, vs, n: [nx, ny, nz], bias });
    bx0 = Math.min(bx0, Math.floor(Math.min(...us))); bx1 = Math.max(bx1, Math.ceil(Math.max(...us)));
    by0 = Math.min(by0, Math.floor(Math.min(...vs))); by1 = Math.max(by1, Math.ceil(Math.max(...vs)));
  }
  if (!cand.length) return null;
  bx0 = Math.max(0, bx0 - dilate); by0 = Math.max(0, by0 - dilate); bx1 = Math.min(W - 1, bx1 + dilate); by1 = Math.min(H - 1, by1 + dilate);
  const box = { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
  return { R, cand, box, cosMax, cosFull };
}

/**
 * The paint a projected shape leaves on the texture.
 * shape: { x, y, w, h, data } straight-alpha RGBA on the projector's image plane (pixels).
 * Returns null, or { x, y, w, h, data } straight-alpha RGBA in atlas pixels (alpha includes
 * opacity, facing fade and antialiasing), ready to blend onto the layer.
 */
export function projectPaint(opts) {
  const { mount, shape: S, atlasW: W, atlasH: H, opacity = 1, aa = true, hidden = [], offsets = [], dilate = 2, depth = null } = opts;
  if (!mount?.uvs || !S?.w || !S?.h) return null;
  // Several origins (opts.projector an array): each has its own footprint, depth map and facing;
  // a texel keeps the strongest paint any origin gives it (union, best facing).
  const list = Array.isArray(opts.projector) ? opts.projector : [opts.projector];
  const plans = [];
  for (const P of list) { const pl = P && projectionPlan({ ...opts, projector: P }); if (pl) plans.push({ P, ...pl }); }
  if (!plans.length) return null;
  const box = unionBox(plans.map((p) => p.box));
  const bx0 = box.x, by0 = box.y, bx1 = box.x + box.w - 1, by1 = box.y + box.h - 1, BW = box.w;
  const A = new Float32Array(box.w * box.h), C = new Uint8ClampedArray(box.w * box.h * 3);
  const pr = [0, 0, 0, 0], sm = [0, 0, 0, 0];
  for (const { P, R, cand, cosMax, cosFull } of plans) {
    const D = (list.length === 1 && depth) || depthMap(mount, P, R, { hidden, offsets });
    // Pass 2: every texel of those faces: project, inside the shape, first hit, facing.
    for (const f of cand) {
      projectionStats.uvTris++;
      const { c, us, vs } = f;
      const area = (us[1] - us[0]) * (vs[2] - vs[0]) - (vs[1] - vs[0]) * (us[2] - us[0]);
      if (Math.abs(area) < 1e-12) continue;
      const x0 = Math.max(bx0, Math.floor(Math.min(...us))), x1 = Math.min(bx1, Math.ceil(Math.max(...us)));
      const y0 = Math.max(by0, Math.floor(Math.min(...vs))), y1 = Math.min(by1, Math.ceil(Math.max(...vs)));
      for (let y = y0; y <= y1; y++) {
        const ty = y + 0.5;
        for (let x = x0; x <= x1; x++) {
          const tx = x + 0.5;
          const l1 = ((us[2] - tx) * (vs[0] - ty) - (vs[2] - ty) * (us[0] - tx)) / area;
          const l2 = ((us[0] - tx) * (vs[1] - ty) - (vs[0] - ty) * (us[1] - tx)) / area;
          const l0 = 1 - l1 - l2;
          if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
          projectionStats.texels++;
          const wx = l0 * c[0] + l1 * c[3] + l2 * c[6], wy = l0 * c[1] + l1 * c[4] + l2 * c[7], wz = l0 * c[2] + l1 * c[5] + l2 * c[8];
          project(P, wx, wy, wz, pr);
          if (!(pr[3] > 1e-9)) continue;
          const px = pr[0], py = pr[1];
          if (px < S.x || py < S.y || px >= S.x + S.w || py >= S.y + S.h) continue;
          sampleShape(S, px, py, aa, sm);
          if (sm[3] <= 0) continue;
          const dk = (Math.floor(py) - R.y) * R.w + (Math.floor(px) - R.x);
          if (!(pr[2] <= D[dk] + f.bias)) continue; // something nearer the projector covers it
          // Facing: |cos| between the face normal and the projection ray (double-sided, like the view).
          let dx, dy, dz;
          if (P.eye) { dx = wx - P.eye[0]; dy = wy - P.eye[1]; dz = wz - P.eye[2]; const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l; } else [dx, dy, dz] = P.dir;
          const cs = Math.abs(f.n[0] * dx + f.n[1] * dy + f.n[2] * dz);
          if (cs <= cosMax) continue;
          const face = cs >= cosFull ? 1 : (cs - cosMax) / Math.max(1e-6, cosFull - cosMax);
          const a = sm[3] * face * opacity;
          const k = (y - by0) * BW + (x - bx0);
          if (a > A[k]) { A[k] = a; C[k * 3] = sm[0]; C[k * 3 + 1] = sm[1]; C[k * 3 + 2] = sm[2]; }
        }
      }
    }
  }
  return finishProjection(A, C, box, mount, W, H, dilate);
}

/**
 * Pass 3 (shared): A (alpha 0..1) and C (rgb) over atlas `box`; grow paint `dilate` texels into
 * the gutter, then crop to a tight straight-alpha RGBA rect. Null when nothing was painted.
 */
export function finishProjection(A, C, box, mount, W, H, dilate = 2) {
  const bx0 = box.x, by0 = box.y, bx1 = box.x + box.w - 1, by1 = box.y + box.h - 1, BW = box.w, BH = box.h;
  const n = mount.indices.length / 3, uv = mount.uvs;
  let painted = 0;
  for (let i = 0; i < A.length; i++) if (A[i] > 0) painted++;
  if (!painted) return null;
  projectionStats.painted += painted;
  // Pass 3: grow paint a few texels into the gutter (texels no face covers), so bilinear sampling
  // at UV seams does not show a gap. Never onto texels another face owns.
  if (dilate > 0) {
    const cov = new Uint8Array(BW * BH);
    for (let t = 0; t < n; t++) {
      const i = t * 3;
      const us = [uv[i * 2] * W, uv[(i + 1) * 2] * W, uv[(i + 2) * 2] * W], vs = [uv[i * 2 + 1] * H, uv[(i + 1) * 2 + 1] * H, uv[(i + 2) * 2 + 1] * H];
      const x0 = Math.max(bx0, Math.floor(Math.min(...us))), x1 = Math.min(bx1, Math.ceil(Math.max(...us)));
      const y0 = Math.max(by0, Math.floor(Math.min(...vs))), y1 = Math.min(by1, Math.ceil(Math.max(...vs)));
      if (x1 < x0 || y1 < y0) continue;
      const area = (us[1] - us[0]) * (vs[2] - vs[0]) - (vs[1] - vs[0]) * (us[2] - us[0]);
      if (Math.abs(area) < 1e-12) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const tx = x + 0.5, ty = y + 0.5;
        const l1 = ((us[2] - tx) * (vs[0] - ty) - (vs[2] - ty) * (us[0] - tx)) / area;
        const l2 = ((us[0] - tx) * (vs[1] - ty) - (vs[0] - ty) * (us[1] - tx)) / area;
        if (l1 >= -1e-9 && l2 >= -1e-9 && 1 - l1 - l2 >= -1e-9) cov[(y - by0) * BW + (x - bx0)] = 1;
      }
    }
    // Each gutter texel takes the largest neighbouring alpha and the alpha-weighted mean colour
    // (stable under tiny alpha differences, unlike copying one neighbour).
    for (let it = 0; it < dilate; it++) {
      const grow = [];
      for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
        const k = y * BW + x;
        if (cov[k] || A[k] > 0) continue;
        let ba = 0, sw = 0, r = 0, g = 0, b = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
          const xx = x + i, yy = y + j;
          if (!(i || j) || xx < 0 || yy < 0 || xx >= BW || yy >= BH) continue;
          const s2 = yy * BW + xx, a = A[s2];
          if (!(a > 0)) continue;
          if (a > ba) ba = a;
          sw += a; r += C[s2 * 3] * a; g += C[s2 * 3 + 1] * a; b += C[s2 * 3 + 2] * a;
        }
        if (ba > 0) grow.push(k, ba, r / sw, g / sw, b / sw);
      }
      for (let q = 0; q < grow.length; q += 5) {
        const k = grow[q];
        A[k] = grow[q + 1]; C[k * 3] = grow[q + 2]; C[k * 3 + 1] = grow[q + 3]; C[k * 3 + 2] = grow[q + 4];
        cov[k] = 1; projectionStats.dilated++;
      }
    }
  }
  // Tight rect around the paint.
  let x0 = BW, y0 = BH, x1 = -1, y1 = -1;
  for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) if (A[y * BW + x] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const ow = x1 - x0 + 1, oh = y1 - y0 + 1, data = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const k = (y + y0) * BW + (x + x0), o = (y * ow + x) * 4;
    if (!(A[k] > 0)) continue;
    data[o] = C[k * 3]; data[o + 1] = C[k * 3 + 1]; data[o + 2] = C[k * 3 + 2]; data[o + 3] = Math.round(Math.min(1, A[k]) * 255);
  }
  return { x: bx0 + x0, y: by0 + y0, w: ow, h: oh, data };
}

/**
 * Blend `paint` (from projectPaint) onto `layer` of `doc` (the atlas) and record one history step
 * over the painted rectangle only. mask: optional selection (layer-sized alpha) the paint is clipped
 * to. Returns the rect, or null.
 */
export function commitProjection(doc, layer, paint, name = 'Projected shape', mask = null) {
  if (!paint) return null;
  const r = { x: paint.x, y: paint.y, w: paint.w, h: paint.h };
  const before = cropImage(layer.img, r);
  paintImage(layer.img, { width: paint.w, height: paint.h, data: paint.data }, paint.x, paint.y, mask && mask.width === layer.img.width && mask.height === layer.img.height ? mask : null, 1);
  layer.touch(r);
  doc.commitRegion(layer, r, before, name);
  return r;
}
