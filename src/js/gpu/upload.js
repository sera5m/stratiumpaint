// WebGPU writeTexture requires offset and bytesPerRow to be multiples of 256. A tightly packed
// dirty rect almost never is (its first pixel sits at (y * width + x) * 4). Vulkan then reads the
// buffer with a 256-byte stride, which is 64 pixels, so the rect tiles into little squares.
// packTextureRect copies the rect into a buffer that satisfies the rule. The fast path keeps the
// original buffer when it is already aligned (a full-width upload of a 64-pixel-aligned image).

const ALIGN = 256;

/** RGBA8 rect of a `fullW`-wide image → { data, layout, origin, size } for queue.writeTexture. */
export function packTextureRect(data, fullW, rect) {
  const r = rect;
  const rowBytes = r.w * 4;
  const srcStride = fullW * 4;
  const offset = (r.y * fullW + r.x) * 4;
  if (offset % ALIGN === 0 && srcStride % ALIGN === 0 && srcStride >= rowBytes) {
    return {
      data,
      layout: { offset, bytesPerRow: srcStride, rowsPerImage: r.h },
      origin: [r.x, r.y],
      size: [r.w, r.h],
    };
  }
  const bytesPerRow = Math.ceil(rowBytes / ALIGN) * ALIGN || ALIGN;
  const packed = new Uint8Array(bytesPerRow * r.h);
  const src = data;
  for (let y = 0; y < r.h; y++) {
    const s = offset + y * srcStride;
    packed.set(src.subarray(s, s + rowBytes), y * bytesPerRow);
  }
  return {
    data: packed,
    layout: { offset: 0, bytesPerRow, rowsPerImage: r.h },
    origin: [r.x, r.y],
    size: [r.w, r.h],
  };
}

/** Upload `rect` of an RGBA8 image (`data`, stride `fullW`) into `texture` at the same origin. */
export function uploadTextureRect(device, texture, data, fullW, rect) {
  const u = packTextureRect(data, fullW, rect);
  device.queue.writeTexture({ texture, origin: u.origin }, u.data, u.layout, u.size);
}
