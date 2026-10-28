// WebGPU path for projection painting (see core/projection.js for the model and the CPU reference).
// The two per-pixel passes run on the GPU: the projector's depth map (a depth-only render of the
// visible mesh into the shape's image rect) and the UV-space pass (every candidate face rasterized
// in atlas space; each texel projects its surface point, samples the shape, depth-tests against
// the map with the face's slope bias, and fades by facing). The face selection before and the
// gutter dilation after are the shared CPU code, so both paths agree up to edge rasterization.
import { projectionPlan, finishProjection, unionBox } from '../core/projection.js';

const COMMON = `
struct U {
  rx: vec4f, ry: vec4f, rd: vec4f, rw: vec4f,
  cx: vec4f, cy: vec4f, cz: vec4f,          // depth pass clip rows (cw = rw)
  eye: vec4f,                               // xyz, w = 1 for a camera (perspective) projector
  dir: vec4f,                               // ortho projection direction
  S: vec4f, R: vec4f, B: vec4f,             // shape rect, depth rect, atlas box (x y w h)
  z: vec4f,                                 // dmin, dmax, k, perspective?
  opt: vec4f,                               // opacity, aa, cosMax, cosFull
};
@group(0) @binding(0) var<uniform> u: U;
`;

const DEPTH_WGSL = COMMON + `
@vertex fn vs(@location(0) p: vec3f) -> @builtin(position) vec4f {
  let q = vec4f(p, 1.0);
  return vec4f(dot(u.cx, q), dot(u.cy, q), dot(u.cz, q), dot(u.rw, q));
}`;

const PAINT_WGSL = COMMON + `
@group(0) @binding(1) var shape: texture_2d<f32>;
@group(0) @binding(2) var depth: texture_depth_2d;
struct VOut { @builtin(position) pos: vec4f, @location(0) w: vec3f, @location(1) @interpolate(flat) nb: vec4f };
@vertex fn vs(@location(0) p: vec3f, @location(1) t: vec2f, @location(2) nb: vec4f) -> VOut {
  var o: VOut;
  o.pos = vec4f((t.x - u.B.x) / u.B.z * 2.0 - 1.0, 1.0 - (t.y - u.B.y) / u.B.w * 2.0, 0.5, 1.0);
  o.w = p; o.nb = nb;
  return o;
}
fn tap(x: i32, y: i32) -> vec4f {
  let sx = x - i32(u.S.x); let sy = y - i32(u.S.y);
  if (sx < 0 || sy < 0 || sx >= i32(u.S.z) || sy >= i32(u.S.w)) { return vec4f(0.0); }
  return textureLoad(shape, vec2i(sx, sy), 0) * 255.0;
}
fn worldDepth(z: f32) -> f32 {
  if (u.z.w > 0.5) { return 1.0 / (1.0 / u.z.x - z * u.z.z); }
  return u.z.x + z * (u.z.y - u.z.x);
}
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let q = vec4f(i.w, 1.0);
  let w = dot(u.rw, q);
  if (!(w > 1e-9)) { discard; }
  let px = dot(u.rx, q) / w; let py = dot(u.ry, q) / w; let d = dot(u.rd, q);
  if (px < u.S.x || py < u.S.y || px >= u.S.x + u.S.z || py >= u.S.y + u.S.w) { discard; }
  var col = vec3f(0.0); var a = 0.0;
  if (u.opt.y < 0.5) {
    let s = tap(i32(floor(px)), i32(floor(py)));
    col = s.rgb; a = s.a / 255.0;
  } else {
    let fx = px - 0.5; let fy = py - 0.5;
    let x0 = floor(fx); let y0 = floor(fy); let tx = fx - x0; let ty = fy - y0;
    var acc = vec3f(0.0);
    for (var j = 0; j < 2; j++) { for (var k = 0; k < 2; k++) {
      let s = tap(i32(x0) + k, i32(y0) + j);
      let wg = select(1.0 - tx, tx, k == 1) * select(1.0 - ty, ty, j == 1);
      let al = s.a / 255.0 * wg;
      acc += s.rgb * al; a += al;
    } }
    if (a > 1e-6) { col = acc / a; }
  }
  if (a <= 0.0) { discard; }
  let dk = vec2i(i32(floor(px)) - i32(u.R.x), i32(floor(py)) - i32(u.R.y));
  let zd = textureLoad(depth, dk, 0);
  if (!(d <= worldDepth(zd) + i.nb.w)) { discard; }
  var ray = u.dir.xyz;
  if (u.eye.w > 0.5) { ray = normalize(i.w - u.eye.xyz); }
  let cs = abs(dot(i.nb.xyz, ray));
  if (cs <= u.opt.z) { discard; }
  var face = 1.0;
  if (cs < u.opt.w) { face = (cs - u.opt.z) / max(1e-6, u.opt.w - u.opt.z); }
  let alpha = a * face * u.opt.x;
  if (alpha <= 0.0) { discard; }
  return vec4f(col / 255.0, alpha);
}`;

// Several origins: each paints its own layer; this keeps, per texel, the layer with the most alpha
// (the first on a tie), the CPU path's rule, so colours of different origins never mix.
const COMBINE_WGSL = `
@group(0) @binding(0) var layers: texture_2d_array<f32>;
@group(0) @binding(1) var<uniform> count: vec4u;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) q: vec4f) -> @location(0) vec4f {
  let xy = vec2i(q.xy);
  var best = vec4f(0.0);
  for (var i = 0u; i < count.x; i++) {
    let c = textureLoad(layers, xy, i32(i), 0);
    if (c.a > best.a) { best = c; }
  }
  return best;
}`;

const pipes = new WeakMap();
function pipelines(device) {
  let p = pipes.get(device);
  if (p) return p;
  const dm = device.createShaderModule({ code: DEPTH_WGSL, label: 'projection depth' });
  const pm = device.createShaderModule({ code: PAINT_WGSL, label: 'projection paint' });
  const cm = device.createShaderModule({ code: COMBINE_WGSL, label: 'projection combine' });
  p = {
    combine: device.createRenderPipeline({
      label: 'projection combine', layout: 'auto',
      vertex: { module: cm, entryPoint: 'vs' },
      fragment: { module: cm, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    }),
    depth: device.createRenderPipeline({
      label: 'projection depth', layout: 'auto',
      vertex: { module: dm, entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    }),
    paint: device.createRenderPipeline({
      label: 'projection paint', layout: 'auto',
      vertex: {
        module: pm, entryPoint: 'vs',
        buffers: [{ arrayStride: 36, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x2' },
          { shaderLocation: 2, offset: 20, format: 'float32x4' },
        ] }],
      },
      fragment: {
        module: pm, entryPoint: 'fs',
        targets: [{ format: 'rgba8unorm', blend: { color: { operation: 'max', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' } } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    }),
  };
  pipes.set(device, p);
  return p;
}

export const gpuProjectionStats = { runs: 0, depthTris: 0, uvTris: 0 };

/**
 * Same arguments and result as projectPaint (core/projection.js), on `device`, including several
 * origins (projector array: one depth map and one paint pass each into its own layer, then a
 * combine pass keeping the strongest per texel, like the CPU path).
 * Async (one readback of the painted atlas box). Throws if the device is lost; callers fall back
 * to the CPU.
 */
export async function gpuProjectPaint(device, opts) {
  const { mount, shape: S, atlasW: W, atlasH: H, opacity = 1, aa = true, hidden = [], offsets = [], dilate = 2 } = opts;
  if (!mount?.uvs || !S?.w || !S?.h) return null;
  const list = Array.isArray(opts.projector) ? opts.projector : [opts.projector];
  const plans = [];
  for (const P of list) { const pl = P && projectionPlan({ ...opts, projector: P }); if (pl) plans.push({ P, ...pl }); }
  if (!plans.length) return null;
  const box = unionBox(plans.map((p) => p.box));
  const lim = device.limits.maxTextureDimension2D;
  if (box.w > lim || box.h > lim || plans.some((p) => p.R.w > lim || p.R.h > lim)) throw new Error('projection larger than the GPU texture limit');

  const n = mount.indices.length / 3, pos = mount.positions, ix = mount.indices;
  const fg = new Int32Array(n).fill(-1);
  (mount.groups || []).forEach((g, gi) => { for (let t = g.start; t < g.start + g.count && t < n; t++) fg[t] = gi; });
  const { depth: dpipe, paint: ppipe, combine: cpipe } = pipelines(device);
  const live = [];
  const buf = (data, usage) => { const b = device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: usage | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(b, 0, data); live.push(b); return b; };
  const stex = device.createTexture({ size: [S.w, S.h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); live.push(stex);
  device.queue.writeTexture({ texture: stex }, S.data, { bytesPerRow: S.w * 4 }, [S.w, S.h]);
  const otex = device.createTexture({ size: [box.w, box.h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }); live.push(otex);
  const multi = plans.length > 1;
  if (multi && plans.length > device.limits.maxTextureArrayLayers) throw new Error('too many origins for the GPU');
  const ltex = multi ? device.createTexture({ size: [box.w, box.h, plans.length], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }) : null;
  if (ltex) live.push(ltex);
  const enc = device.createCommandEncoder({ label: 'projection' });
  const pw = (x, y, z, r) => r[0] * x + r[1] * y + r[2] * z + r[3];
  plans.forEach(({ P, R, cand, cosMax, cosFull }, pi) => {
    // Occluders: every visible face in front of this origin whose image overlaps R.
    const occ = new Float32Array(n * 9);
    let m = 0, dmin = Infinity, dmax = -Infinity;
    for (let t = 0; t < n; t++) {
      const gi = fg[t];
      if (gi >= 0 && hidden[gi]) continue;
      const o = (gi >= 0 && offsets[gi]) || [0, 0, 0];
      let ok = true, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, lo = Infinity, hi = -Infinity;
      const c = [];
      for (let k = 0; k < 3; k++) {
        const v = ix[t * 3 + k] * 3, x = pos[v] + o[0], y = pos[v + 1] + o[1], z = pos[v + 2] + o[2];
        const w = pw(x, y, z, P.rw);
        if (w <= 1e-9) { ok = false; break; }
        const px = pw(x, y, z, P.rx) / w, py = pw(x, y, z, P.ry) / w, d = pw(x, y, z, P.rd);
        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py); lo = Math.min(lo, d); hi = Math.max(hi, d);
        c.push(x, y, z);
      }
      if (!ok || x1 < R.x || x0 > R.x + R.w || y1 < R.y || y0 > R.y + R.h) continue;
      occ.set(c, m * 9); m++;
      dmin = Math.min(dmin, lo); dmax = Math.max(dmax, hi);
    }
    const persp = P.kind === 'view' || !!P.eye;
    const span = Math.max(1e-6, dmax - dmin);
    dmin -= span * 0.01 + 1e-6; dmax += span * 0.01 + 1e-6;
    if (persp) dmin = Math.max(dmin, 1e-4);
    const k = persp ? 1 / dmin - 1 / dmax : 0;
    const sub = (a, b, sc = 1) => a.map((v, i) => (v - b[i]) * sc);
    const cz = persp ? sub(P.rw.map((v) => v / dmin), [0, 0, 0, 1], 1 / k) : sub(P.rd, [0, 0, 0, dmin], 1 / (dmax - dmin));
    const cx = P.rx.map((v, i) => (2 * (v - R.x * P.rw[i])) / R.w - P.rw[i]);
    const cy = P.ry.map((v, i) => P.rw[i] - (2 * (v - R.y * P.rw[i])) / R.h);
    const ub = new Float32Array(15 * 4);
    const put = (i, v) => ub.set(v, i * 4);
    put(0, P.rx); put(1, P.ry); put(2, P.rd); put(3, P.rw); put(4, cx); put(5, cy); put(6, cz);
    put(7, P.eye ? [...P.eye, 1] : [0, 0, 0, 0]); put(8, P.dir ? [...P.dir, 0] : [0, 0, 0, 0]);
    put(9, [S.x, S.y, S.w, S.h]); put(10, [R.x, R.y, R.w, R.h]); put(11, [box.x, box.y, box.w, box.h]);
    put(12, [dmin, dmax, k, persp ? 1 : 0]); put(13, [opacity, aa ? 1 : 0, cosMax, cosFull]);
    const ubuf = buf(ub, GPUBufferUsage.UNIFORM);
    const dtex = device.createTexture({ size: [R.w, R.h], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }); live.push(dtex);
    const pv = new Float32Array(cand.length * 27);
    cand.forEach((f, i) => {
      for (let c = 0; c < 3; c++) pv.set([f.c[c * 3], f.c[c * 3 + 1], f.c[c * 3 + 2], f.us[c], f.vs[c], f.n[0], f.n[1], f.n[2], f.bias], (i * 3 + c) * 9);
    });
    const dp = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: dtex.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } });
    if (m) {
      dp.setPipeline(dpipe);
      dp.setBindGroup(0, device.createBindGroup({ layout: dpipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] }));
      dp.setVertexBuffer(0, buf(occ.subarray(0, m * 9), GPUBufferUsage.VERTEX));
      dp.draw(m * 3);
    }
    dp.end();
    const target = multi ? ltex.createView({ dimension: '2d', baseArrayLayer: pi, arrayLayerCount: 1 }) : otex.createView();
    const pp = enc.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    pp.setPipeline(ppipe);
    pp.setBindGroup(0, device.createBindGroup({
      layout: ppipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: stex.createView() }, { binding: 2, resource: dtex.createView() }],
    }));
    pp.setVertexBuffer(0, buf(pv, GPUBufferUsage.VERTEX));
    pp.draw(cand.length * 3);
    pp.end();
    gpuProjectionStats.depthTris += m; gpuProjectionStats.uvTris += cand.length;
  });
  if (multi) {
    const cp = enc.beginRenderPass({ colorAttachments: [{ view: otex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    cp.setPipeline(cpipe);
    cp.setBindGroup(0, device.createBindGroup({
      layout: cpipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: ltex.createView({ dimension: '2d-array' }) }, { binding: 1, resource: { buffer: buf(new Uint32Array([plans.length, 0, 0, 0]), GPUBufferUsage.UNIFORM) } }],
    }));
    cp.draw(3);
    cp.end();
  }
  const bpr = Math.ceil((box.w * 4) / 256) * 256;
  const rb = device.createBuffer({ size: bpr * box.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); live.push(rb);
  enc.copyTextureToBuffer({ texture: otex }, { buffer: rb, bytesPerRow: bpr }, [box.w, box.h]);
  device.queue.submit([enc.finish()]);
  gpuProjectionStats.runs++;
  try {
    await rb.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(rb.getMappedRange());
    const A = new Float32Array(box.w * box.h), C = new Uint8ClampedArray(box.w * box.h * 3);
    for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
      const s0 = y * bpr + x * 4, kk = y * box.w + x;
      if (!px[s0 + 3]) continue;
      A[kk] = px[s0 + 3] / 255; C[kk * 3] = px[s0]; C[kk * 3 + 1] = px[s0 + 1]; C[kk * 3 + 2] = px[s0 + 2];
    }
    rb.unmap();
    return finishProjection(A, C, box, mount, W, H, dilate);
  } finally {
    for (const r of live) r.destroy();
  }
}
