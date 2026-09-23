// Selection masks: one byte of coverage (0..255) per pixel of the document.
import { clamp } from './util.js';

export const createMask = (w, h) => ({ width: w, height: h, data: new Uint8Array(w * h) });
export const cloneMask = (m) => ({ width: m.width, height: m.height, data: new Uint8Array(m.data) });

export function rectMask(w, h, x0, y0, x1, y1) {
  const m = createMask(w, h);
  const ax = clamp(Math.round(Math.min(x0, x1)), 0, w), bx = clamp(Math.round(Math.max(x0, x1)), 0, w);
  const ay = clamp(Math.round(Math.min(y0, y1)), 0, h), by = clamp(Math.round(Math.max(y0, y1)), 0, h);
  for (let y = ay; y < by; y++) m.data.fill(255, y * w + ax, y * w + bx);
  return m;
}

/** Anti-aliased ellipse inscribed in the box (x0,y0)-(x1,y1). */
export function ellipseMask(w, h, x0, y0, x1, y1) {
  const m = createMask(w, h);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
  if (rx < 0.5 || ry < 0.5) return m;
  const ya = Math.max(0, Math.floor(cy - ry - 1)), yb = Math.min(h - 1, Math.ceil(cy + ry + 1));
  const xa = Math.max(0, Math.floor(cx - rx - 1)), xb = Math.min(w - 1, Math.ceil(cx + rx + 1));
  const irx2 = 1 / (rx * rx), iry2 = 1 / (ry * ry);
  for (let y = ya; y <= yb; y++) {
    const dy = y + 0.5 - cy;
    for (let x = xa; x <= xb; x++) {
      const dx = x + 0.5 - cx;
      const f = dx * dx * irx2 + dy * dy * iry2;
      let cov;
      if (f < 1e-9) cov = 1;
      else {
        // (f-1)/|grad f| approximates the signed distance to the boundary in pixels
        const g = Math.hypot(2 * dx * irx2, 2 * dy * iry2);
        cov = clamp(0.5 - (f - 1) / g, 0, 1);
      }
      m.data[y * w + x] = Math.round(cov * 255);
    }
  }
  return m;
}

/** Anti-aliased even-odd polygon fill (4 sub-scanlines per row, exact horizontal coverage). */
export function polygonMask(w, h, pts) {
  const m = createMask(w, h);
  if (pts.length < 3) return m;
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(h - 1, Math.floor(maxY));
  const S = 4;
  const acc = new Float32Array(w);
  const xs = [];
  for (let y = y0; y <= y1; y++) {
    acc.fill(0);
    for (let s = 0; s < S; s++) {
      const sy = y + (s + 0.5) / S;
      xs.length = 0;
      for (let i = 0, n = pts.length; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        if ((a.y <= sy && b.y > sy) || (b.y <= sy && a.y > sy)) xs.push(a.x + ((sy - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, xs[k]), xb = Math.min(w, xs[k + 1]);
        if (xb <= xa) continue;
        const ia = Math.floor(xa), ib = Math.floor(xb);
        if (ia === ib) acc[ia] += xb - xa;
        else {
          acc[ia] += ia + 1 - xa;
          for (let x = ia + 1; x < ib; x++) acc[x] += 1;
          if (ib < w) acc[ib] += xb - ib;
        }
      }
    }
    const row = y * w;
    for (let x = 0; x < w; x++) m.data[row + x] = Math.min(255, Math.round((acc[x] / S) * 255));
  }
  return m;
}

/** mode: replace | union | subtract | intersect | xor. A null base counts as "nothing selected". */
export function combineMasks(base, add, mode = 'replace') {
  if (mode === 'replace' || (!base && (mode === 'union' || mode === 'xor'))) return cloneMask(add);
  if (!base) return createMask(add.width, add.height);
  const out = createMask(add.width, add.height);
  const a = base.data, b = add.data, o = out.data;
  const n = o.length;
  switch (mode) {
    case 'union': for (let i = 0; i < n; i++) o[i] = Math.round(a[i] + b[i] - (a[i] * b[i]) / 255); break;
    case 'subtract': for (let i = 0; i < n; i++) o[i] = Math.round((a[i] * (255 - b[i])) / 255); break;
    case 'intersect': for (let i = 0; i < n; i++) o[i] = Math.round((a[i] * b[i]) / 255); break;
    case 'xor': for (let i = 0; i < n; i++) o[i] = Math.round((a[i] * (255 - b[i]) + b[i] * (255 - a[i])) / 255); break;
    default: throw new Error(`unknown selection mode ${mode}`);
  }
  return out;
}

export function invertMask(m) {
  const out = createMask(m.width, m.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = 255 - m.data[i];
  return out;
}

export function translateMask(m, dx, dy) {
  const { width: w, height: h } = m;
  const out = createMask(w, h);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    const x0 = Math.max(0, dx), x1 = Math.min(w, w + dx);
    if (x1 <= x0) continue;
    out.data.set(m.data.subarray(sy * w + (x0 - dx), sy * w + (x1 - dx)), y * w + x0);
  }
  return out;
}

/** Tight bounds of pixels with coverage >= threshold, or null when empty. */
export function maskBounds(m, threshold = 1) {
  const { width: w, height: h, data } = m;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let first = -1;
    for (let x = 0; x < w; x++) if (data[row + x] >= threshold) { first = x; break; }
    if (first < 0) continue;
    let last = first;
    for (let x = w - 1; x > first; x--) if (data[row + x] >= threshold) { last = x; break; }
    if (minY === h) minY = y;
    maxY = y;
    if (first < minX) minX = first;
    if (last > maxX) maxX = last;
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Boundary of the >=128 region as merged axis-aligned segments,
 * flat Int32Array [x0,y0,x1,y1, ...] in pixel-corner coordinates. Used for marching ants.
 */
export function maskOutline(m, threshold = 128) {
  const { width: w, height: h, data } = m;
  const segs = [];
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[y * w + x] >= threshold ? 1 : 0);
  // horizontal edges lie between row y-1 and row y
  for (let y = 0; y <= h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const differ = x < w && at(x, y - 1) !== at(x, y);
      if (differ && start < 0) start = x;
      else if (!differ && start >= 0) { segs.push(start, y, x, y); start = -1; }
    }
  }
  // vertical edges lie between column x-1 and column x; runs merge down the rows
  const runStart = new Int32Array(w + 1).fill(-1);
  for (let y = 0; y <= h; y++) {
    for (let x = 0; x <= w; x++) {
      const differ = y < h && at(x - 1, y) !== at(x, y);
      if (differ && runStart[x] < 0) runStart[x] = y;
      else if (!differ && runStart[x] >= 0) { segs.push(x, runStart[x], x, y); runStart[x] = -1; }
    }
  }
  return Int32Array.from(segs);
}

export function rleEncode(data) {
  const out = [];
  let i = 0;
  const n = data.length;
  while (i < n) {
    const v = data[i];
    let j = i + 1;
    while (j < n && data[j] === v && j - i < 0xffffff) j++;
    out.push((j - i) * 256 + v);
    i = j;
  }
  return Uint32Array.from(out);
}

export function rleDecode(rle, length) {
  const out = new Uint8Array(length);
  let pos = 0;
  for (const x of rle) {
    const len = Math.floor(x / 256), v = x % 256;
    if (v) out.fill(v, pos, pos + len);
    pos += len;
  }
  return out;
}
