// Set-down resample. resampleFloat (core/xform.js) is the only path that commits pixels.
// canvasBake is the drawImage equivalent, kept for reference; reading it back from a GPU canvas
// returns 8×8 tiles on Vulkan, so resampleSetDown does not use it. RESAMPLE_WGSL matches
// resampleFloat for a compute pass if a caller wants the same weights on the GPU.
import { createImage } from '../core/image.js';
import { resampleFloat, xformStats } from '../core/xform.js';
import { rotatedBounds } from '../core/xform.js';

export const RESAMPLE_WGSL = `
// One thread per output pixel. Inverse of the move-tool float matrix, bilinear, premultiplied,
// supersampled the same way as resampleFloat (n×n taps, n = 1..4 from the shrink).
struct Params { sw: u32, sh: u32, dw: u32, dh: u32, n: u32, ox: i32, oy: i32, angle: f32, bx: f32, by: f32, bw: f32, bh: f32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
fn tap(u: f32, v: f32) -> vec4f {
  let x = u - 0.5; let y = v - 0.5;
  let x0 = i32(floor(x)); let y0 = i32(floor(y));
  let fx = x - floor(x); let fy = y - floor(y);
  var acc = vec4f(0.0);
  for (var j = 0; j < 2; j++) {
    let yy = y0 + j;
    if (yy < 0 || yy >= i32(P.sh)) { continue; }
    let wy = select(1.0 - fy, fy, j == 1);
    for (var i = 0; i < 2; i++) {
      let xx = x0 + i;
      if (xx < 0 || xx >= i32(P.sw)) { continue; }
      let w = wy * select(1.0 - fx, fx, i == 1);
      let pix = src[u32(yy) * P.sw + u32(xx)];
      let a = f32(pix >> 24u) / 255.0 * w;
      acc += vec4f(f32(pix & 255u) / 255.0 * a, f32((pix >> 8u) & 255u) / 255.0 * a, f32((pix >> 16u) & 255u) / 255.0 * a, a);
    }
  }
  return acc;
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= P.dw || gid.y >= P.dh) { return; }
  // The CPU loop is the one that ships the pixels; this kernel matches it when a caller dispatches it.
  let nn = f32(max(P.n, 1u));
  var acc = vec4f(0.0);
  for (var j = 0u; j < P.n; j++) {
    for (var i = 0u; i < P.n; i++) {
      let px = f32(P.ox) + f32(gid.x) + (f32(i) + 0.5) / nn;
      let py = f32(P.oy) + f32(gid.y) + (f32(j) + 0.5) / nn;
      acc += tap(px, py);
    }
  }
  let a = acc.a / (nn * nn);
  if (a <= 0.0) { dst[gid.y * P.dw + gid.x] = 0u; return; }
  let rgb = acc.rgb / acc.a;
  dst[gid.y * P.dw + gid.x] = (u32(clamp(rgb.r, 0.0, 1.0) * 255.0))
    | (u32(clamp(rgb.g, 0.0, 1.0) * 255.0) << 8u)
    | (u32(clamp(rgb.b, 0.0, 1.0) * 255.0) << 16u)
    | (u32(clamp(a, 0.0, 1.0) * 255.0) << 24u);
}
`;

/** GPU drawImage bake. Null where there is no OffscreenCanvas (node tests). */
export function canvasBake(src, box, angle = 0) {
  if (typeof OffscreenCanvas === 'undefined' || typeof ImageData === 'undefined') return null;
  try {
    const b = angle ? rotatedBounds(box, angle) : { x: Math.round(box.x), y: Math.round(box.y), w: Math.max(1, Math.round(box.w)), h: Math.max(1, Math.round(box.h)) };
    const w = Math.max(1, b.w | 0), h = Math.max(1, b.h | 0);
    const srcC = new OffscreenCanvas(src.width, src.height);
    const copy = new Uint8ClampedArray(src.data);
    srcC.getContext('2d').putImageData(new ImageData(copy, src.width, src.height), 0, 0);
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(box.x + box.w / 2 - b.x, box.y + box.h / 2 - b.y);
    if (angle) ctx.rotate(angle);
    ctx.drawImage(srcC, -box.w / 2, -box.h / 2, box.w, box.h);
    const id = ctx.getImageData(0, 0, w, h);
    const img = createImage(w, h);
    img.data.set(id.data);
    return { img, x: b.x, y: b.y };
  } catch {
    return null;
  }
}

/**
 * The one resample at set-down. Always the CPU reference (resampleFloat).
 *
 * A GPU-backed OffscreenCanvas drawImage/getImageData round trip looks faster, but on Vulkan the
 * readback is the canvas's 8×8 tiles in the wrong order, so a scaled selection lands as cubes and
 * those cubes are real pixels from then on. `device` is accepted so callers can pass the
 * compositor without caring; it does not change the pixels.
 */
export function resampleSetDown(src, box, angle = 0, device = null) {
  void device;
  return resampleFloat(src, box, angle);
}
