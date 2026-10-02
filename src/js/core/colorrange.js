// Inclusive RGBA interval. A colour is {r,g,b} in 0..255 and a in 0..1 or 0..255.

function channel8(c, key) {
  const v = c?.[key];
  if (key === 'a') {
    if (v == null) return 255;
    return v <= 1 ? Math.round(v * 255) : Math.round(v);
  }
  return Math.round(v ?? 0);
}

export function rgba8(c) {
  return [channel8(c, 'r'), channel8(c, 'g'), channel8(c, 'b'), channel8(c, 'a')];
}

/** True when every channel of `px` (length 4, 0..255) sits between A and B, inclusive. Ends may be swapped. */
export function inColorInterval(px, a8, b8) {
  for (let i = 0; i < 4; i++) {
    const lo = a8[i] < b8[i] ? a8[i] : b8[i];
    const hi = a8[i] > b8[i] ? a8[i] : b8[i];
    if (px[i] < lo || px[i] > hi) return false;
  }
  return true;
}

/**
 * Copy of `img` where every pixel inside the A–B interval is deleted (alpha 0)
 * or replaced with `replace`. Returns { img, count }.
 */
export function applyColorRange(img, a, b, { mode = 'delete', replace = null } = {}) {
  const A = rgba8(a), B = rgba8(b);
  const rep = mode === 'replace' ? rgba8(replace ?? { r: 0, g: 0, b: 0, a: 0 }) : null;
  const data = img.data;
  const out = new Uint8ClampedArray(data);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (!inColorInterval([data[i], data[i + 1], data[i + 2], data[i + 3]], A, B)) continue;
    count++;
    if (rep) {
      out[i] = rep[0]; out[i + 1] = rep[1]; out[i + 2] = rep[2]; out[i + 3] = rep[3];
    } else {
      out[i + 3] = 0;
    }
  }
  return { img: { width: img.width, height: img.height, data: out }, count };
}
