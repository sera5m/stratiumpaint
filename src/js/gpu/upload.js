// WebGPU writeTexture requires offset and bytesPerRow to be multiples of 256. On Vulkan that
// rule is not enough: a row stride wider than the copy (padding, or the full image stride for a
// dirty rect) is read back as 256-byte rows. 256/4 = 64 pixels, so the rect tiles into squares.
// Every multi-row upload is therefore cut into 64px strips whose stride IS 256 and whose width
// IS 64 — a driver that honours bytesPerRow and one that ignores it and assumes 256 both write
// the same texels. A strip may overlap the dirty rect; those texels are the real pixels.

const STRIP = 64;
const ROW = STRIP * 4; // 256

/**
 * RGBA8 rect of a `fullW`-wide image → writeTexture arguments.
 * Each entry is { data, layout, origin, size }.
 */
export function planTextureUploads(data, fullW, rect) {
  const x0 = rect.x | 0, y0 = rect.y | 0, w = rect.w | 0, h = rect.h | 0;
  const x1 = x0 + w;
  if (w <= 0 || h <= 0 || fullW <= 0) return [];
  // One row does not need a stride (bytesPerRow is required only when the copy is taller than a
  // row). Images narrower than a strip cannot use the 64px path.
  if (h === 1 || fullW < STRIP) {
    const out = [];
    const rowBytes = w * 4;
    for (let row = 0; row < h; row++) {
      const s = ((y0 + row) * fullW + x0) * 4;
      out.push({
        data: new Uint8Array(data.subarray(s, s + rowBytes)),
        layout: { offset: 0 },
        origin: [x0, y0 + row],
        size: [w, 1],
      });
    }
    return out;
  }
  const out = [];
  let x = x0;
  while (x < x1) {
    let start = x;
    if (start + STRIP > fullW) start = fullW - STRIP;
    const packed = new Uint8Array(ROW * h);
    for (let row = 0; row < h; row++) {
      const s = ((y0 + row) * fullW + start) * 4;
      packed.set(data.subarray(s, s + ROW), row * ROW);
    }
    out.push({
      data: packed,
      layout: { offset: 0, bytesPerRow: ROW },
      origin: [start, y0],
      size: [STRIP, h],
    });
    const end = start + STRIP;
    if (end >= x1) break;
    x = end;
  }
  return out;
}

/** Upload `rect` of an RGBA8 image (`data`, stride `fullW`) into `texture` at the same origin. */
export function uploadTextureRect(device, texture, data, fullW, rect) {
  for (const u of planTextureUploads(data, fullW, rect)) {
    device.queue.writeTexture({ texture, origin: u.origin }, u.data, u.layout, u.size);
  }
}
