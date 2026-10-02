// Edge-colour background removal. No model: the border votes for a colour,
// then matching pixels are cleared. Contiguous keeps interior matches; global clears every match.

function borderMedian(data, w, h) {
  const sr = [], sg = [], sb = [];
  const push = (x, y) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 16) return;
    sr.push(data[i]); sg.push(data[i + 1]); sb.push(data[i + 2]);
  };
  for (let x = 0; x < w; x++) { push(x, 0); if (h > 1) push(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { push(0, y); if (w > 1) push(w - 1, y); }
  if (!sr.length) return null;
  const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
  return [med(sr), med(sg), med(sb)];
}

/**
 * @param {{tolerance?: number, global?: boolean}} opts
 * tolerance is 0..100. 0 is an exact match to the border colour; 100 is a wide band (~180 in RGB distance).
 */
export function removeBackground(img, { tolerance = 30, global = false } = {}) {
  const { width: w, height: h, data } = img;
  const bg = borderMedian(data, w, h);
  const out = new Uint8ClampedArray(data);
  if (!bg) return { img: { width: w, height: h, data: out }, count: 0, bg: null };
  const tol = (Math.max(0, Math.min(100, tolerance)) / 100) * 180;
  const tol2 = tol * tol;
  const near = (i) => {
    if (data[i + 3] < 16) return false;
    const dr = data[i] - bg[0], dg = data[i + 1] - bg[1], db = data[i + 2] - bg[2];
    return dr * dr + dg * dg + db * db <= tol2;
  };

  const clear = (p) => { out[p * 4 + 3] = 0; };
  let count = 0;

  if (global) {
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      if (near(i)) { clear(p); count++; }
    }
    return { img: { width: w, height: h, data: out }, count, bg };
  }

  const seen = new Uint8Array(w * h);
  const q = [];
  const tryAdd = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (seen[p]) return;
    if (!near(p * 4)) return;
    seen[p] = 1;
    q.push(p);
  };
  for (let x = 0; x < w; x++) { tryAdd(x, 0); if (h > 1) tryAdd(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { tryAdd(0, y); if (w > 1) tryAdd(w - 1, y); }
  for (let qi = 0; qi < q.length; qi++) {
    const p = q[qi];
    const x = p % w, y = (p / w) | 0;
    tryAdd(x + 1, y); tryAdd(x - 1, y); tryAdd(x, y + 1); tryAdd(x, y - 1);
    clear(p);
    count++;
  }
  return { img: { width: w, height: h, data: out }, count, bg };
}
