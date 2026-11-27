// Phase 4: adjustments and a blur on the GPU.
// Per-pixel adjustments are a compute shader (ADJUST_WGSL). Gaussian blur uses the canvas filter
// (a GPU blur in Chromium) because a full separable-gaussian pipeline is more machine than the
// dialog needs, and the CPU effect stays the fallback when no device is attached.
// doc.gpuFilters selects this path; tests leave it unset and keep spec.apply.

export const GPU_ADJUST_IDS = new Set(['invert', 'black-white', 'sepia', 'brightness-contrast']);
export const GPU_FILTER_IDS = new Set([...GPU_ADJUST_IDS, 'gaussian-blur']);

export const ADJUST_WGSL = `
struct Params { kind: u32, bright: f32, contrast: f32, _pad: f32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&src)) { return; }
  let p = src[i];
  var c = vec3f(f32(p & 255u), f32((p >> 8u) & 255u), f32((p >> 16u) & 255u)) / 255.0;
  let a = p >> 24u;
  if (P.kind == 0u) { c = 1.0 - c; } // invert
  else if (P.kind == 1u) { c = vec3f(lum(c)); } // black and white
  else if (P.kind == 2u) { // sepia
    c = vec3f(dot(c, vec3f(0.393, 0.769, 0.189)), dot(c, vec3f(0.349, 0.686, 0.168)), dot(c, vec3f(0.272, 0.534, 0.131)));
  } else { // brightness / contrast, same curve as adjustments.js
    let C = P.contrast * 2.55;
    let f = (259.0 * (C + 255.0)) / (255.0 * (259.0 - C));
    c = f * (c - vec3f(0.5)) + vec3f(0.5) + vec3f(P.bright * 2.55 / 255.0);
  }
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  dst[i] = u32(c.r * 255.0) | (u32(c.g * 255.0) << 8u) | (u32(c.b * 255.0) << 16u) | (a << 24u);
}
`;

const KIND = { invert: 0, 'black-white': 1, sepia: 2, 'brightness-contrast': 3 };

/** CSS filter string for the canvas path, or null if this id is not a canvas filter. */
export function cssFilter(id, params = {}) {
  if (id === 'gaussian-blur') return `blur(${Math.max(0, +params.radius || 0)}px)`;
  if (id === 'black-white') return 'grayscale(1)';
  if (id === 'invert') return 'invert(1)';
  if (id === 'sepia') return 'sepia(1)';
  if (id === 'brightness-contrast') {
    const b = 1 + (+params.brightness || 0) / 100;
    const c = 1 + (+params.contrast || 0) / 100;
    return `brightness(${b}) contrast(${c})`;
  }
  return null;
}

/**
 * Run one adjustment on the GPU. Returns a new image, or null to keep the CPU apply.
 * `device` is a GPUDevice; without one, a canvas filter is used for the ids that have one.
 */
export async function adjustOnGPU(device, src, id, params = {}) {
  if (!GPU_FILTER_IDS.has(id)) return null;
  if (device && KIND[id] != null && src?.data) {
    try {
      const n = src.width * src.height;
      const words = new Uint32Array(n);
      const d = src.data;
      for (let i = 0; i < n; i++) words[i] = d[i * 4] | (d[i * 4 + 1] << 8) | (d[i * 4 + 2] << 16) | (d[i * 4 + 3] << 24);
      const dvc = device;
      const srcBuf = dvc.createBuffer({ size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const dstBuf = dvc.createBuffer({ size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const uni = dvc.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      dvc.queue.writeBuffer(srcBuf, 0, words);
      dvc.queue.writeBuffer(uni, 0, new Float32Array([KIND[id], +params.brightness || 0, +params.contrast || 0, 0]));
      const mod = dvc.createShaderModule({ code: ADJUST_WGSL, label: 'adjust' });
      const pipe = dvc.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
      const group = dvc.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uni } },
          { binding: 1, resource: { buffer: srcBuf } },
          { binding: 2, resource: { buffer: dstBuf } },
        ],
      });
      const enc = dvc.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(n / 64)); pass.end();
      const read = dvc.createBuffer({ size: words.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      enc.copyBufferToBuffer(dstBuf, 0, read, 0, words.byteLength);
      dvc.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const outW = new Uint32Array(read.getMappedRange());
      const out = { width: src.width, height: src.height, data: new Uint8ClampedArray(d.length) };
      for (let i = 0; i < n; i++) {
        const w = outW[i];
        out.data[i * 4] = w & 255; out.data[i * 4 + 1] = (w >> 8) & 255; out.data[i * 4 + 2] = (w >> 16) & 255; out.data[i * 4 + 3] = (w >> 24) & 255;
      }
      read.unmap();
      srcBuf.destroy(); dstBuf.destroy(); uni.destroy();
      return out;
    } catch {
      return null;
    }
  }
  return canvasFilter(src, id, params);
}

/** Canvas (GPU) filter. Null when there is no canvas or this id has no CSS filter. */
export function canvasFilter(src, id, params = {}) {
  const css = cssFilter(id, params);
  if (!css || typeof OffscreenCanvas === 'undefined' || typeof ImageData === 'undefined' || !src?.data) return null;
  try {
    const srcC = new OffscreenCanvas(src.width, src.height);
    const copy = new Uint8ClampedArray(src.data);
    srcC.getContext('2d').putImageData(new ImageData(copy, src.width, src.height), 0, 0);
    const c = new OffscreenCanvas(src.width, src.height);
    const ctx = c.getContext('2d');
    ctx.filter = css;
    ctx.drawImage(srcC, 0, 0);
    ctx.filter = 'none';
    const idata = ctx.getImageData(0, 0, src.width, src.height);
    return { width: src.width, height: src.height, data: idata.data };
  } catch {
    return null;
  }
}
