// Paint the other side of a model. A texel is mapped back to a triangle, reflected
// through the mesh bounds on X, Y or Z, then raycast onto the surface there.
// Offsets from "move out of the way" are view-only and not part of this.
import { buildBVH, raycastMesh } from './mesh.js';

const uvCache = new WeakMap();
const bvhCache = new WeakMap();

function bary(px, py, a, b, c) {
  const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(den) < 1e-12) return null;
  const w0 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / den;
  const w1 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / den;
  const w2 = 1 - w0 - w1;
  if (w0 < -1e-3 || w1 < -1e-3 || w2 < -1e-3) return null;
  return [w0, w1, w2];
}

function buildUVIndex(uvs) {
  const cells = 32;
  const buckets = Array.from({ length: cells * cells }, () => []);
  const n = uvs.length / 6;
  for (let f = 0; f < n; f++) {
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    const o = f * 6;
    for (let k = 0; k < 3; k++) {
      const u = uvs[o + k * 2], v = uvs[o + k * 2 + 1];
      if (u < minU) minU = u;
      if (v < minV) minV = v;
      if (u > maxU) maxU = u;
      if (v > maxV) maxV = v;
    }
    const x0 = Math.max(0, Math.min(cells - 1, Math.floor(minU * cells)));
    const y0 = Math.max(0, Math.min(cells - 1, Math.floor(minV * cells)));
    const x1 = Math.max(0, Math.min(cells - 1, Math.floor(Math.max(minU, maxU) * cells)));
    const y1 = Math.max(0, Math.min(cells - 1, Math.floor(Math.max(minV, maxV) * cells)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) buckets[y * cells + x].push(f);
  }
  return { cells, buckets, uvs };
}

function uvIndex(mount) {
  let idx = uvCache.get(mount);
  if (!idx) { idx = buildUVIndex(mount.uvs); uvCache.set(mount, idx); }
  return idx;
}

/** Triangle whose UV contains (u, v), or null. */
export function faceAtUV(mount, u, v) {
  if (!mount?.uvs) return null;
  const idx = uvIndex(mount);
  const { cells, buckets, uvs } = idx;
  const cx = Math.max(0, Math.min(cells - 1, Math.floor(u * cells)));
  const cy = Math.max(0, Math.min(cells - 1, Math.floor(v * cells)));
  const list = buckets[cy * cells + cx];
  for (let i = 0; i < list.length; i++) {
    const f = list[i], o = f * 6;
    const w = bary(u, v, [uvs[o], uvs[o + 1]], [uvs[o + 2], uvs[o + 3]], [uvs[o + 4], uvs[o + 5]]);
    if (w) return { face: f, w };
  }
  return null;
}

function cornerPos(mount, face) {
  const ix = mount.indices, P = mount.positions, out = [];
  for (let k = 0; k < 3; k++) {
    const v = ix[face * 3 + k];
    out.push([P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
  }
  return out;
}

function faceNormal(p) {
  const e1x = p[1][0] - p[0][0], e1y = p[1][1] - p[0][1], e1z = p[1][2] - p[0][2];
  const e2x = p[2][0] - p[0][0], e2y = p[2][1] - p[0][1], e2z = p[2][2] - p[0][2];
  let x = e1y * e2z - e1z * e2y, y = e1z * e2x - e1x * e2z, z = e1x * e2y - e1y * e2x;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

export function boundsCenter(positions) {
  let min0 = Infinity, min1 = Infinity, min2 = Infinity, max0 = -Infinity, max1 = -Infinity, max2 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < min0) min0 = x;
    if (y < min1) min1 = y;
    if (z < min2) min2 = z;
    if (x > max0) max0 = x;
    if (y > max1) max1 = y;
    if (z > max2) max2 = z;
  }
  return [(min0 + max0) / 2, (min1 + max1) / 2, (min2 + max2) / 2];
}

function modelSize(positions) {
  let min0 = Infinity, min1 = Infinity, min2 = Infinity, max0 = -Infinity, max1 = -Infinity, max2 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < min0) min0 = x;
    if (y < min1) min1 = y;
    if (z < min2) min2 = z;
    if (x > max0) max0 = x;
    if (y > max1) max1 = y;
    if (z > max2) max2 = z;
  }
  return Math.hypot(max0 - min0, max1 - min1, max2 - min2) || 1;
}

export function mirrorPoint(p, center, axis) {
  const q = [p[0], p[1], p[2]];
  const k = axis === 'y' ? 1 : axis === 'z' ? 2 : 0;
  q[k] = center[k] * 2 - p[k];
  return q;
}

function meshBVH(mount) {
  let hit = bvhCache.get(mount);
  if (!hit) {
    hit = {
      bvh: buildBVH(mount.positions, mount.indices),
      center: boundsCenter(mount.positions),
      maxDist: modelSize(mount.positions) * 0.05,
    };
    bvhCache.set(mount, hit);
  }
  return hit;
}

/** Ray from just outside `point` along `-normal`. Null when nothing is close. */
function raycastSurface(bvh, point, normal, maxDist) {
  const l = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const nx = normal[0] / l, ny = normal[1] / l, nz = normal[2] / l;
  const eps = 1e-3;
  const origin = [point[0] + nx * eps, point[1] + ny * eps, point[2] + nz * eps];
  const dir = [-nx, -ny, -nz];
  const hit = raycastMesh(bvh, origin, dir);
  if (!hit) return null;
  const hx = origin[0] + dir[0] * hit.t, hy = origin[1] + dir[1] * hit.t, hz = origin[2] + dir[2] * hit.t;
  if (Math.hypot(hx - point[0], hy - point[1], hz - point[2]) > maxDist) return null;
  return hit;
}

function uvOf(mount, hit) {
  const i = hit.tri * 3;
  const b0 = 1 - hit.u - hit.v, b1 = hit.u, b2 = hit.v;
  const uvs = mount.uvs;
  return {
    u: b0 * uvs[i * 2] + b1 * uvs[(i + 1) * 2] + b2 * uvs[(i + 2) * 2],
    v: b0 * uvs[i * 2 + 1] + b1 * uvs[(i + 1) * 2 + 1] + b2 * uvs[(i + 2) * 2 + 1],
  };
}

/** World position and outward normal of a UV, or null. */
export function worldAtUV(mount, u, v) {
  const at = faceAtUV(mount, u, v);
  if (!at) return null;
  const p = cornerPos(mount, at.face);
  const w = at.w;
  return {
    face: at.face,
    n: faceNormal(p),
    p: [
      w[0] * p[0][0] + w[1] * p[1][0] + w[2] * p[2][0],
      w[0] * p[0][1] + w[1] * p[1][1] + w[2] * p[2][1],
      w[0] * p[0][2] + w[1] * p[1][2] + w[2] * p[2][2],
    ],
  };
}

/** The triangle sitting on the mirrored side of `face`, or -1. */
export function mirrorFace(mount, face, axis) {
  if (!mount?.positions || face < 0 || !axis || axis === 'none') return -1;
  const p = cornerPos(mount, face);
  const c = [
    (p[0][0] + p[1][0] + p[2][0]) / 3,
    (p[0][1] + p[1][1] + p[2][1]) / 3,
    (p[0][2] + p[1][2] + p[2][2]) / 3,
  ];
  const { bvh, center, maxDist } = meshBVH(mount);
  const hit = raycastSurface(bvh, mirrorPoint(c, center, axis), mirrorPoint(faceNormal(p), [0, 0, 0], axis), maxDist);
  return hit ? hit.tri : -1;
}

/**
 * (x, y) document pixels → the mirrored pixel, or null. One mesh walk is built and reused
 * for the whole stroke. `width` / `height` are the texture the UVs cover.
 */
export function pixelMirror(mount, width, height, axis) {
  if (!mount?.uvs || !mount.positions || !axis || axis === 'none' || !(width > 0) || !(height > 0)) return null;
  const { bvh, center, maxDist } = meshBVH(mount);
  return (x, y) => {
    const world = worldAtUV(mount, x / width, y / height);
    if (!world) return null;
    const hit = raycastSurface(bvh, mirrorPoint(world.p, center, axis), mirrorPoint(world.n, [0, 0, 0], axis), maxDist);
    if (!hit) return null;
    const uv = uvOf(mount, hit);
    return { x: uv.u * width, y: uv.v * height };
  };
}

/** Faces of the object group that owns `face` (just that face when there is no group). */
export function groupFaces(groups, face, triCount) {
  const g = (groups || []).find((g) => face >= g.start && face < g.start + g.count);
  if (!g) return [face];
  const end = Math.min(triCount, g.start + g.count);
  const out = [];
  for (let i = g.start; i < end; i++) out.push(i);
  return out;
}

/** Pixel bounding box of the UV triangles, clipped to the image. Null when they miss it. */
export function facePixelBounds(uvs, faces, W, H) {
  let minx = W, miny = H, maxx = -1, maxy = -1;
  for (let n = 0; n < faces.length; n++) {
    const o = faces[n] * 6;
    if (o < 0 || o + 5 >= uvs.length) continue;
    for (let k = 0; k < 3; k++) {
      const x = uvs[o + k * 2] * W, y = uvs[o + k * 2 + 1] * H;
      const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.ceil(x) - 1, y1 = Math.ceil(y) - 1;
      if (x0 < minx) minx = x0;
      if (y0 < miny) miny = y0;
      if (x1 > maxx) maxx = x1;
      if (y1 > maxy) maxy = y1;
    }
  }
  if (maxx < minx || maxy < miny) return null;
  if (minx < 0) minx = 0;
  if (miny < 0) miny = 0;
  if (maxx >= W) maxx = W - 1;
  if (maxy >= H) maxy = H - 1;
  if (maxx < minx || maxy < miny) return null;
  return { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 };
}

/**
 * Fill UV triangles with a straight-alpha colour. `mask` (or null) limits it.
 * Returns the bounding rect of the pixels written, or null.
 */
export function fillFaces(img, uvs, faces, color, mask = null) {
  const W = img.width, H = img.height;
  const cr = color.r | 0, cg = color.g | 0, cb = color.b | 0;
  const ca = Math.max(0, Math.min(1, color.a ?? 1));
  if (!(ca > 0) || !uvs) return null;
  let minx = W, miny = H, maxx = -1, maxy = -1;
  const solid = ca >= 0.999;
  for (let n = 0; n < faces.length; n++) {
    const o = faces[n] * 6;
    if (o < 0 || o + 5 >= uvs.length) continue;
    const p = [[uvs[o] * W, uvs[o + 1] * H], [uvs[o + 2] * W, uvs[o + 3] * H], [uvs[o + 4] * W, uvs[o + 5] * H]];
    let x0 = Math.floor(Math.min(p[0][0], p[1][0], p[2][0]));
    let y0 = Math.floor(Math.min(p[0][1], p[1][1], p[2][1]));
    let x1 = Math.ceil(Math.max(p[0][0], p[1][0], p[2][0]));
    let y1 = Math.ceil(Math.max(p[0][1], p[1][1], p[2][1]));
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > W) x1 = W;
    if (y1 > H) y1 = H;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!bary(x + 0.5, y + 0.5, p[0], p[1], p[2])) continue;
        if (mask) {
          if (x >= mask.width || y >= mask.height) continue;
          if (mask.data[y * mask.width + x] === 0) continue;
        }
        const i = (y * W + x) * 4;
        if (solid) {
          img.data[i] = cr; img.data[i + 1] = cg; img.data[i + 2] = cb; img.data[i + 3] = 255;
        } else {
          const da = img.data[i + 3] / 255;
          const outA = ca + da * (1 - ca);
          if (!(outA > 0)) continue;
          img.data[i] = (cr * ca + img.data[i] * da * (1 - ca)) / outA;
          img.data[i + 1] = (cg * ca + img.data[i + 1] * da * (1 - ca)) / outA;
          img.data[i + 2] = (cb * ca + img.data[i + 2] * da * (1 - ca)) / outA;
          img.data[i + 3] = Math.round(outA * 255);
        }
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
      }
    }
  }
  if (maxx < minx) return null;
  return { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 };
}

/**
 * Pixels inside `region` that differ from `before` (a crop of that rect), copied to the
 * mirrored side. Each write is { x, y, before: Uint8ClampedArray(4), after: Uint8ClampedArray(4) }.
 * Nothing is written here.
 */
export function mirrorWrites(img, region, before, mount, axis) {
  const sym = pixelMirror(mount, img.width, img.height, axis);
  if (!sym || !before) return [];
  const W = img.width, seen = new Map();
  for (let y = 0; y < region.h; y++) {
    for (let x = 0; x < region.w; x++) {
      const sx = region.x + x, sy = region.y + y;
      if (sx < 0 || sy < 0 || sx >= W || sy >= img.height) continue;
      const i = (sy * W + sx) * 4, b = (y * region.w + x) * 4;
      if (img.data[i] === before.data[b] && img.data[i + 1] === before.data[b + 1]
        && img.data[i + 2] === before.data[b + 2] && img.data[i + 3] === before.data[b + 3]) continue;
      const m = sym(sx + 0.5, sy + 0.5);
      if (!m) continue;
      const mx = Math.round(m.x), my = Math.round(m.y);
      if (mx < 0 || my < 0 || mx >= W || my >= img.height) continue;
      if (mx === sx && my === sy) continue;
      const di = (my * W + mx) * 4;
      seen.set(di, {
        x: mx, y: my,
        before: img.data.slice(di, di + 4),
        after: img.data.slice(i, i + 4),
      });
    }
  }
  return [...seen.values()];
}

/** Write `writes` into the image. History is the caller's job. */
export function applyWrites(img, writes) {
  const W = img.width;
  for (const w of writes) img.data.set(w.after, (w.y * W + w.x) * 4);
}
