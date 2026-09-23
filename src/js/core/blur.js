// Gaussian blur approximated by three box blurs: O(pixels) regardless of radius.

function boxesForGauss(sigma, n) {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

function boxH(src, dst, w, h, r) {
  const k = 1 / (r + r + 1);
  for (let i = 0; i < h; i++) {
    let ti = i * w, li = ti, ri = ti + r;
    const fv = src[ti], lv = src[ti + w - 1];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[ti + j];
    for (let j = 0; j <= r; j++) { val += src[ri++] - fv; dst[ti++] = val * k; }
    for (let j = r + 1; j < w - r; j++) { val += src[ri++] - src[li++]; dst[ti++] = val * k; }
    for (let j = w - r; j < w; j++) { val += lv - src[li++]; dst[ti++] = val * k; }
  }
}

function boxV(src, dst, w, h, r) {
  const k = 1 / (r + r + 1);
  for (let i = 0; i < w; i++) {
    let ti = i, li = ti, ri = ti + r * w;
    const fv = src[ti], lv = src[ti + w * (h - 1)];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[ti + j * w];
    for (let j = 0; j <= r; j++) { val += src[ri] - fv; dst[ti] = val * k; ri += w; ti += w; }
    for (let j = r + 1; j < h - r; j++) { val += src[ri] - src[li]; dst[ti] = val * k; ri += w; li += w; ti += w; }
    for (let j = h - r; j < h; j++) { val += lv - src[li]; dst[ti] = val * k; li += w; ti += w; }
  }
}

/** Blur a Float32Array plane in place. */
export function blurPlane(plane, w, h, sigma) {
  if (sigma <= 0) return;
  const tmp = new Float32Array(plane.length);
  const maxR = Math.floor((Math.min(w, h) - 1) / 2);
  for (const size of boxesForGauss(sigma, 3)) {
    const r = Math.min((size - 1) >> 1, maxR);
    if (r < 1) continue;
    boxH(plane, tmp, w, h, r);
    boxV(tmp, plane, w, h, r);
  }
}

/** Returns a blurred copy of an RGBA image. Colour is blurred premultiplied so edges don't darken. */
export function blurImage(img, sigma) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const out = new Uint8ClampedArray(data.length);
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = data[i * 4 + 3];
  blurPlane(alpha, w, h, sigma);
  const plane = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) plane[i] = (data[i * 4 + c] * data[i * 4 + 3]) / 255;
    blurPlane(plane, w, h, sigma);
    for (let i = 0; i < n; i++) out[i * 4 + c] = alpha[i] > 0.001 ? (plane[i] * 255) / alpha[i] : 0;
  }
  for (let i = 0; i < n; i++) out[i * 4 + 3] = alpha[i];
  return { width: w, height: h, data: out };
}
