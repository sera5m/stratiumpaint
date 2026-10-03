// Stamp a source image onto the object's texture.
// Only the triangles you name receive pixels, and only where their UVs fall
// inside the image's rectangle. The source image is never written.

/** UV rectangle covering the named faces, or null. */
export function faceBounds(uvs, groups, faceNames) {
  const triCount = uvs.length / 6;
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity, n = 0;
  for (const [start, count] of ranges(groups, faceNames, triCount)) {
    for (let f = start; f < start + count && f < triCount; f++) {
      for (let k = 0; k < 3; k++) {
        const u = uvs[(f * 3 + k) * 2], v = uvs[(f * 3 + k) * 2 + 1];
        if (u < minU) minU = u;
        if (v < minV) minV = v;
        if (u > maxU) maxU = u;
        if (v > maxV) maxV = v;
        n++;
      }
    }
  }
  if (!n || maxU <= minU || maxV <= minV) return null;
  return { u: minU, v: minV, w: maxU - minU, h: maxV - minV };
}

function ranges(groups, faceNames, triCount) {
  if (faceNames == null) return [[0, triCount]];
  if (!faceNames.length) return [];
  const want = new Set(faceNames);
  return (groups ?? []).filter((g) => want.has(g.name) && g.count > 0).map((g) => [g.start, g.count]);
}

function sample(src, x, y) {
  const ix = Math.max(0, Math.min(src.width - 1, Math.floor(x)));
  const iy = Math.max(0, Math.min(src.height - 1, Math.floor(y)));
  const i = (iy * src.width + ix) * 4;
  return [src.data[i], src.data[i + 1], src.data[i + 2], src.data[i + 3]];
}

function bary(px, py, a, b, c) {
  const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(den) < 1e-8) return null;
  const w0 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / den;
  const w1 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / den;
  return [w0, w1, 1 - w0 - w1];
}

function stampTriangle(dst, src, place, tri) {
  const W = dst.width, H = dst.height;
  const p = tri.map(([u, v]) => [u * W, v * H]);
  let minx = Math.floor(Math.min(p[0][0], p[1][0], p[2][0]));
  let miny = Math.floor(Math.min(p[0][1], p[1][1], p[2][1]));
  let maxx = Math.ceil(Math.max(p[0][0], p[1][0], p[2][0]));
  let maxy = Math.ceil(Math.max(p[0][1], p[1][1], p[2][1]));
  if (minx < 0) minx = 0;
  if (miny < 0) miny = 0;
  if (maxx > W) maxx = W;
  if (maxy > H) maxy = H;
  const u0 = place.u, v0 = place.v, u1 = place.u + place.w, v1 = place.v + place.h;
  for (let y = miny; y < maxy; y++) {
    for (let x = minx; x < maxx; x++) {
      const w = bary(x + 0.5, y + 0.5, p[0], p[1], p[2]);
      if (!w || w[0] < -1e-4 || w[1] < -1e-4 || w[2] < -1e-4) continue;
      const u = w[0] * tri[0][0] + w[1] * tri[1][0] + w[2] * tri[2][0];
      const v = w[0] * tri[0][1] + w[1] * tri[1][1] + w[2] * tri[2][1];
      if (u < u0 || v < v0 || u > u1 || v > v1) continue;
      const sx = ((u - u0) / place.w) * src.width;
      const sy = ((v - v0) / place.h) * src.height;
      const pix = sample(src, sx, sy);
      if (pix[3] === 0) continue;
      const i = (y * W + x) * 4;
      dst.data[i] = pix[0]; dst.data[i + 1] = pix[1]; dst.data[i + 2] = pix[2]; dst.data[i + 3] = pix[3];
    }
  }
}

/**
 * Clear `dst` and stamp `src` onto the given faces.
 * `uvs` is one pair per corner (6 floats per triangle). `faceNames` null means every face.
 */
export function projectOnto(dst, src, place, uvs, groups, faceNames) {
  dst.data.fill(0);
  if (!place || place.w <= 0 || place.h <= 0) return dst;
  const triCount = uvs.length / 6;
  for (const [start, count] of ranges(groups, faceNames, triCount)) {
    for (let f = start; f < start + count && f < triCount; f++) {
      const o = f * 6;
      stampTriangle(dst, src, place, [
        [uvs[o], uvs[o + 1]],
        [uvs[o + 2], uvs[o + 3]],
        [uvs[o + 4], uvs[o + 5]],
      ]);
    }
  }
  return dst;
}
