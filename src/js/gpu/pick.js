// Triangle ids for the GPU pick pass. The mesh is drawn with one flat colour per triangle;
// readPixels at the cursor decodes it. 0 is "nothing" (cleared framebuffer).

export function packPickId(tri) {
  const id = (tri | 0) + 1;
  return [id & 255, (id >> 8) & 255, (id >> 16) & 255, 255];
}

/** → triangle index, or -1 when the pixel is the clear colour. */
export function unpackPickId(rgba) {
  if (!rgba || !rgba[3]) return -1;
  return (rgba[0] | (rgba[1] << 8) | (rgba[2] << 16)) - 1;
}
