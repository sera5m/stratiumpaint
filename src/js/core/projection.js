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

/**
 * The paint a projected shape leaves on the texture.
 * shape: { x, y, w, h, data } straight-alpha RGBA on the projector's image plane (pixels).
 * Returns null, or { x, y, w, h, data } straight-alpha RGBA in atlas pixels (alpha includes
 * opacity, facing fade and antialiasing), ready to blend onto the layer.
 */
export function projectPaint({ mount, projector: P, shape: S, atlasW: W, atlasH: H, opacity = 1, aa = true,
  hidden = [], offsets = [], maxAngle = 80, fade = 8, dilate = 2, depth = null }) {
  if (!mount?.uvs || !S?.w || !S?.h) return null;
  const R = { x: S.x - 2, y: S.y - 2, w: S.w + 4, h: S.h + 4 };
  const D = depth || depthMap(mount, P, R, { hidden, offsets });
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
  const BW = bx1 - bx0 + 1, BH = by1 - by0 + 1;
  const A = new Float32Array(BW * BH), C = new Uint8ClampedArray(BW * BH * 3);
  const pr = [0, 0, 0, 0], sm = [0, 0, 0, 0];
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
    for (let it = 0; it < dilate; it++) {
      const grow = [];
      for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
        const k = y * BW + x;
        if (cov[k] || A[k] > 0) continue;
        let best = -1, ba = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
          const xx = x + i, yy = y + j;
          if ((i || j) && xx >= 0 && yy >= 0 && xx < BW && yy < BH && A[yy * BW + xx] > ba) { ba = A[yy * BW + xx]; best = yy * BW + xx; }
        }
        if (best >= 0) grow.push(k, best);
      }
      for (let g = 0; g < grow.length; g += 2) {
        const k = grow[g], s = grow[g + 1];
        A[k] = A[s]; C[k * 3] = C[s * 3]; C[k * 3 + 1] = C[s * 3 + 1]; C[k * 3 + 2] = C[s * 3 + 2];
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
 * over the painted rectangle only. Returns the rect, or null.
 */
export function commitProjection(doc, layer, paint, name = 'Projected shape') {
  if (!paint) return null;
  const r = { x: paint.x, y: paint.y, w: paint.w, h: paint.h };
  const before = cropImage(layer.img, r);
  paintImage(layer.img, { width: paint.w, height: paint.h, data: paint.data }, paint.x, paint.y, null, 1);
  layer.touch(r);
  doc.commitRegion(layer, r, before, name);
  return r;
}
