// Extra image encoders the browser canvas cannot write: BMP, GIF, TGA.
// Input is a non-premultiplied { width, height, data: Uint8ClampedArray RGBA }.

function u16(out, o, v) { out[o] = v & 255; out[o + 1] = (v >> 8) & 255; }
function u32(out, o, v) { u16(out, o, v); u16(out, o + 2, v >>> 16); }

/** Uncompressed 32-bit BMP, bottom-up BGRA. Most readers keep the alpha. */
export function encodeBmp(img) {
  const { width: w, height: h, data } = img;
  const row = w * 4;
  const pixels = row * h;
  const out = new Uint8Array(54 + pixels);
  out[0] = 0x42; out[1] = 0x4d; // BM
  u32(out, 2, out.length);
  u32(out, 10, 54);
  u32(out, 14, 40);
  u32(out, 18, w);
  u32(out, 22, h);
  u16(out, 26, 1);
  u16(out, 28, 32);
  u32(out, 34, pixels);
  let p = 54;
  for (let y = h - 1; y >= 0; y--) {
    const row0 = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row0 + x * 4;
      out[p++] = data[i + 2];
      out[p++] = data[i + 1];
      out[p++] = data[i];
      out[p++] = data[i + 3];
    }
  }
  return out;
}

/** Uncompressed true-color TGA, top-left origin, 32-bit BGRA. */
export function encodeTga(img) {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(18 + w * h * 4);
  out[2] = 2; // uncompressed true-color
  u16(out, 12, w);
  u16(out, 14, h);
  out[16] = 32;
  out[17] = 0x28; // 8-bit alpha, origin top-left
  let p = 18;
  for (let i = 0; i < data.length; i += 4) {
    out[p++] = data[i + 2];
    out[p++] = data[i + 1];
    out[p++] = data[i];
    out[p++] = data[i + 3];
  }
  return out;
}

function paletteOf(img) {
  const { data } = img;
  const colors = new Map();
  let transparent = false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) { transparent = true; continue; }
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (!colors.has(key)) colors.set(key, [data[i], data[i + 1], data[i + 2]]);
  }
  const limit = transparent ? 255 : 256;
  if (colors.size <= limit) {
    return { colors: [...colors.values()], transparent, exact: true };
  }
  // Drop precision until the set fits, then snap every opaque pixel to that grid.
  let bits = 7;
  let kept = colors;
  while (bits >= 2) {
    kept = new Map();
    const shift = 8 - bits;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const r = data[i] >> shift, g = data[i + 1] >> shift, b = data[i + 2] >> shift;
      const key = (r << 16) | (g << 8) | b;
      if (!kept.has(key)) kept.set(key, [r << shift, g << shift, b << shift]);
      if (kept.size > limit) break;
    }
    if (kept.size <= limit) break;
    bits--;
  }
  return { colors: [...kept.values()].slice(0, limit), transparent, exact: false, bits };
}

function indexPixels(img, pal) {
  const { width: w, height: h, data } = img;
  const trans = pal.transparent ? 0 : -1;
  const table = pal.colors;
  const lookup = new Map();
  table.forEach((c, i) => lookup.set((c[0] << 16) | (c[1] << 8) | c[2], trans >= 0 ? i + 1 : i));
  const idx = new Uint8Array(w * h);
  const shift = pal.bits ? 8 - pal.bits : 0;
  for (let p = 0, n = 0; p < data.length; p += 4, n++) {
    if (data[p + 3] < 128) { idx[n] = trans >= 0 ? 0 : 0; continue; }
    let r = data[p], g = data[p + 1], b = data[p + 2];
    if (shift) { r = (r >> shift) << shift; g = (g >> shift) << shift; b = (b >> shift) << shift; }
    const hit = lookup.get((r << 16) | (g << 8) | b);
    idx[n] = hit == null ? nearest(table, r, g, b, trans) : hit;
  }
  return idx;
}

function nearest(table, r, g, b, trans) {
  let best = trans >= 0 ? 1 : 0, bestD = Infinity;
  for (let i = 0; i < table.length; i++) {
    const c = table[i];
    const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
    if (d < bestD) { bestD = d; best = (trans >= 0 ? i + 1 : i); }
  }
  return best;
}

function lzwPairs(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  const dict = new Map();
  const bytes = [];
  let buf = 0, bits = 0;
  const emit = (code) => {
    buf |= code << bits;
    bits += codeSize;
    while (bits >= 8) { bytes.push(buf & 255); buf >>= 8; bits -= 8; }
  };
  const reset = () => { dict.clear(); codeSize = minCodeSize + 1; next = eoi + 1; };
  emit(clear);
  let w = String.fromCharCode(indices[0] ?? 0);
  for (let i = 1; i < indices.length; i++) {
    const k = String.fromCharCode(indices[i]);
    const wk = w + k;
    if (dict.has(wk) || wk.length === 1) { w = wk; continue; }
    emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
    if (next < 4096) {
      dict.set(wk, next++);
      if (next === (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      reset();
    }
    w = k;
  }
  if (w) emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
  emit(eoi);
  if (bits) bytes.push(buf & 255);
  return bytes;
}

/** GIF89a. Opaque colors are quantized to 256; pixels under half alpha become transparent. */
export function encodeGif(img) {
  const pal = paletteOf(img);
  const colors = pal.colors;
  const trans = pal.transparent;
  const count = colors.length + (trans ? 1 : 0);
  let size = 2;
  while ((1 << size) < count) size++;
  if (size < 2) size = 2;
  const tableLen = 1 << size;
  const indices = indexPixels(img, pal);
  const minCodeSize = Math.max(2, size);
  const compressed = lzwPairs(indices, minCodeSize);

  const header = 6 + 7 + tableLen * 3 + (trans ? 8 : 0) + 10;
  const blocks = Math.ceil(compressed.length / 255) || 1;
  const out = new Uint8Array(header + 1 + compressed.length + blocks + 2);
  out.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  let p = 6;
  u16(out, p, img.width); p += 2;
  u16(out, p, img.height); p += 2;
  out[p++] = 0x80 | ((size - 1) << 4) | (size - 1); // global table
  out[p++] = 0;
  out[p++] = 0;
  for (let i = 0; i < tableLen; i++) {
    const c = trans ? (i === 0 ? [0, 0, 0] : colors[i - 1]) : colors[i];
    out[p++] = c ? c[0] : 0;
    out[p++] = c ? c[1] : 0;
    out[p++] = c ? c[2] : 0;
  }
  if (trans) {
    out.set([0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00], p);
    p += 8;
  }
  out[p++] = 0x2c;
  u16(out, p, 0); p += 2;
  u16(out, p, 0); p += 2;
  u16(out, p, img.width); p += 2;
  u16(out, p, img.height); p += 2;
  out[p++] = 0;
  out[p++] = minCodeSize;
  for (let i = 0; i < compressed.length; i += 255) {
    const n = Math.min(255, compressed.length - i);
    out[p++] = n;
    out.set(compressed.slice(i, i + n), p);
    p += n;
  }
  out[p++] = 0;
  out[p++] = 0x3b;
  return out.subarray(0, p);
}
