// A cylinder is cut so it can lie flat. The two lips of that cut are the same
// edge on the model and opposite edges of the chart. A shape dragged across the
// cut used to connect those corners the long way. seamStep keeps a continuous
// chart coordinate instead, and each copy of the shape is clipped to one lip.

/**
 * Continue a drag across a UV cut.
 * `prev` is { u, v, offU, offV, p3, face }. `next` is { u, v, p3 }.
 * `geom` is the mounted mesh ({ positions, indices, uvs }) or null.
 * Returns the offset that makes `next` continuous with `prev`, and whether this step crossed.
 */
export function seamStep(prev, next, maxGap, geom) {
  const offU = prev.offU || 0, offV = prev.offV || 0;
  if (!prev.p3 || !next.p3 || !(maxGap > 0)) return { offU, offV, wrapped: false };
  const rawDu = next.u - prev.u, rawDv = next.v - prev.v;
  const d3x = next.p3[0] - prev.p3[0], d3y = next.p3[1] - prev.p3[1], d3z = next.p3[2] - prev.p3[2];
  const d3 = Math.hypot(d3x, d3y, d3z);
  if (!(d3 < maxGap)) return { offU, offV, wrapped: false };
  const pred = predictUV(prev.face, geom, d3x, d3y, d3z);
  const gap = Math.hypot(rawDu - pred.du, rawDv - pred.dv);
  const predLen = Math.hypot(pred.du, pred.dv);
  // A real weld jumps much further in UV than the surface itself moved.
  if (!(gap > 0.12) || !(gap > predLen * 2 + 0.08)) return { offU, offV, wrapped: false };
  const expU = prev.u + offU + pred.du;
  const expV = prev.v + offV + pred.dv;
  return { offU: expU - next.u, offV: expV - next.v, wrapped: true };
}

/** UV change implied by a 3D step, using the triangle the cursor was on before the cut. */
function predictUV(face, geom, d3x, d3y, d3z) {
  const none = { du: 0, dv: 0 };
  if (face == null || !geom?.positions || !geom.indices || !geom.uvs) return none;
  const p = geom.positions, id = geom.indices, uv = geom.uvs;
  const ia = id[face * 3], ib = id[face * 3 + 1], ic = id[face * 3 + 2];
  if (ia == null) return none;
  const e1x = p[ib * 3] - p[ia * 3], e1y = p[ib * 3 + 1] - p[ia * 3 + 1], e1z = p[ib * 3 + 2] - p[ia * 3 + 2];
  const e2x = p[ic * 3] - p[ia * 3], e2y = p[ic * 3 + 1] - p[ia * 3 + 1], e2z = p[ic * 3 + 2] - p[ia * 3 + 2];
  const a11 = e1x * e1x + e1y * e1y + e1z * e1z;
  const a12 = e1x * e2x + e1y * e2y + e1z * e2z;
  const a22 = e2x * e2x + e2y * e2y + e2z * e2z;
  const det = a11 * a22 - a12 * a12;
  if (!(Math.abs(det) > 1e-20)) return none;
  const b1 = e1x * d3x + e1y * d3y + e1z * d3z;
  const b2 = e2x * d3x + e2y * d3y + e2z * d3z;
  const a = (b1 * a22 - b2 * a12) / det;
  const b = (b2 * a11 - b1 * a12) / det;
  const c0 = face * 3, c1 = c0 + 1, c2 = c0 + 2;
  const du = a * (uv[c1 * 2] - uv[c0 * 2]) + b * (uv[c2 * 2] - uv[c0 * 2]);
  const dv = a * (uv[c1 * 2 + 1] - uv[c0 * 2 + 1]) + b * (uv[c2 * 2 + 1] - uv[c0 * 2 + 1]);
  if (!Number.isFinite(du) || !Number.isFinite(dv) || Math.hypot(du, dv) > 0.75) return none;
  return { du, dv };
}

/** One UV island per face. `boxes[face]` is {umin, vmin, umax, vmax}. */
export function uvCharts(indices, uvs) {
  const nF = (indices?.length || 0) / 3;
  const boxes = new Array(nF);
  if (!uvs || !nF) return boxes;
  const adj = Array.from({ length: nF }, () => []);
  const edges = new Map();
  for (let f = 0; f < nF; f++) {
    for (let k = 0; k < 3; k++) {
      const c0 = f * 3 + k, c1 = f * 3 + ((k + 1) % 3);
      const i0 = indices[c0], i1 = indices[c1];
      const key = i0 < i1 ? `${i0},${i1}` : `${i1},${i0}`;
      let list = edges.get(key);
      if (!list) edges.set(key, (list = []));
      const lo = i0 < i1;
      const ca = lo ? c0 : c1, cb = lo ? c1 : c0;
      list.push({ f, ulo: uvs[ca * 2], vlo: uvs[ca * 2 + 1], uhi: uvs[cb * 2], vhi: uvs[cb * 2 + 1] });
    }
  }
  for (const list of edges.values()) {
    if (list.length !== 2) continue;
    const a = list[0], b = list[1];
    const d = Math.hypot(a.ulo - b.ulo, a.vlo - b.vlo) + Math.hypot(a.uhi - b.uhi, a.vhi - b.vhi);
    if (d < 0.04) { adj[a.f].push(b.f); adj[b.f].push(a.f); }
  }
  const seen = new Uint8Array(nF);
  for (let f = 0; f < nF; f++) {
    if (seen[f]) continue;
    const stack = [f];
    const faces = [];
    seen[f] = 1;
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    while (stack.length) {
      const cur = stack.pop();
      faces.push(cur);
      for (let k = 0; k < 3; k++) {
        const o = (cur * 3 + k) * 2;
        const u = uvs[o], v = uvs[o + 1];
        if (u < minU) minU = u;
        if (v < minV) minV = v;
        if (u > maxU) maxU = u;
        if (v > maxV) maxV = v;
      }
      for (const n of adj[cur]) if (!seen[n]) { seen[n] = 1; stack.push(n); }
    }
    const box = { umin: minU, vmin: minV, umax: maxU, vmax: maxV };
    for (const face of faces) boxes[face] = box;
  }
  return boxes;
}

/**
 * Atlas pixel (px, py) of an axis-aligned shape drawn from (x0,y0) to (x1,y1)
 * in continuous pixels. Each piece `{dx, dy, clip}` is that shape shifted by
 * -dx/-dy and clipped, which is the copy that lands on one lip of the weld.
 */
export function wrapCovers(px, py, x0, y0, x1, y1, pieces) {
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  for (const p of pieces) {
    const dx = p.dx || 0, dy = p.dy || 0;
    const x = px + dx, y = py + dy;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    const c = p.clip;
    if (c && (px < c.x || py < c.y || px > c.x + c.w || py > c.y + c.h)) continue;
    return true;
  }
  return false;
}
