// WebGPU compositor for the main 2D view (phase 1 of docs/WEBGPU_PLAN.md).
//
// Each layer gets a GPU texture mirroring layer.img (straight-alpha RGBA8). Only the rect a tool
// touched is re-uploaded (Layer#touch records it in layer._gpuDirty). Layers are blended into a
// premultiplied rgba16float accumulator, one full-screen pass per visible layer, ping-ponging
// between two targets, using the blend shader generated from blendmath.js. The present pass then
// draws that composite into the view canvas with pan/zoom and the checkerboard.
//
// layer.img stays the source of truth in phase 1: tools, history, export, the colour picker and
// flood fill keep working on the CPU exactly as before. Nothing here reads back from the GPU.
import { COMPOSITE_WGSL, PRESENT_WGSL } from './shaders.js';
import { modeIndex } from './blendmath.js';

const SLOT = 256; // uniform buffer offset alignment

export class GpuCompositor {
  /** gpu: { device, format } from getGPU(). canvas: the element to present into. */
  constructor(gpu, canvas) {
    this.device = gpu.device;
    this.format = gpu.format;
    this.canvas = canvas;
    this.ctx = canvas.getContext('webgpu');
    if (!this.ctx) throw new Error('canvas has no webgpu context');
    this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
    this.maxTexture = this.device.limits.maxTextureDimension2D;
    this.layers = new WeakMap(); // Layer → { tex, w, h }
    this.acc = null; // { a, b, w, h }
    this.result = null; // texture holding the latest composite
    this.compKey = '';
    this.compDoc = null;
    this.uniforms = null;
    this.uniformSlots = 0;
    this.#pipelines();
  }

  #pipelines() {
    const d = this.device;
    const comp = d.createShaderModule({ code: COMPOSITE_WGSL, label: 'composite' });
    this.compPipe = d.createRenderPipeline({
      label: 'composite', layout: 'auto',
      vertex: { module: comp, entryPoint: 'vs' },
      fragment: { module: comp, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });
    const pres = d.createShaderModule({ code: PRESENT_WGSL, label: 'present' });
    this.presPipe = d.createRenderPipeline({
      label: 'present', layout: 'auto',
      vertex: { module: pres, entryPoint: 'vs' },
      fragment: { module: pres, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.nearest = d.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.linear = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.viewBuf = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.empty = d.createTexture({ size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  }

  /** Whether this document fits on the GPU. */
  canDraw(doc) { return !!doc && doc.width <= this.maxTexture && doc.height <= this.maxTexture; }

  // ---------------------------------------------------------------- layer textures

  /** GPU texture for a layer, created or brought up to date (dirty rect only). */
  layerTexture(layer) {
    const img = layer.img, w = img.width, h = img.height;
    let e = this.layers.get(layer);
    if (e && (e.w !== w || e.h !== h)) { e.tex.destroy(); e = null; }
    if (!e) {
      const tex = this.device.createTexture({
        label: `layer ${layer.id}`, size: [w, h], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      });
      e = { tex, w, h };
      this.layers.set(layer, e);
      layer._gpuTracked = true;
      layer._gpuDirty = 'all';
    }
    const dirty = layer._gpuDirty;
    if (dirty) {
      layer._gpuDirty = null;
      const r = dirty === 'all' ? { x: 0, y: 0, w, h } : clampRect(dirty, w, h);
      if (r) {
        this.device.queue.writeTexture(
          { texture: e.tex, origin: [r.x, r.y] },
          img.data,
          { offset: (r.y * w + r.x) * 4, bytesPerRow: w * 4, rowsPerImage: r.h },
          [r.w, r.h],
        );
      }
    }
    return e.tex;
  }

  #targets(w, h) {
    if (this.acc && this.acc.w === w && this.acc.h === h) return this.acc;
    if (this.acc) { this.acc.a.destroy(); this.acc.b.destroy(); }
    const make = (label) => this.device.createTexture({
      label, size: [w, h], format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.acc = { a: make('acc a'), b: make('acc b'), w, h };
    this.compKey = '';
    return this.acc;
  }

  #uniformsFor(n) {
    if (this.uniforms && this.uniformSlots >= n) return this.uniforms;
    this.uniforms?.destroy();
    this.uniformSlots = Math.max(8, n * 2);
    this.uniforms = this.device.createBuffer({ size: this.uniformSlots * SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return this.uniforms;
  }

  // ---------------------------------------------------------------- compositing

  /** Blend the document's visible layers into a texture. Skipped when nothing changed. */
  composite(doc) {
    const visible = doc.layers.filter((l) => l.visible && l.opacity > 0);
    const key = `${doc.width}x${doc.height}|` + visible.map((l) => `${l.id}:${l.version}:${l.opacity}:${l.blend}:${l._gpuDirty ? 'd' : ''}`).join(',');
    const { a, b } = this.#targets(doc.width, doc.height);
    if (key === this.compKey && this.compDoc === doc && this.result) return this.result;
    const d = this.device;
    const buf = this.#uniformsFor(visible.length);
    const enc = d.createCommandEncoder({ label: 'composite' });
    // Clear the first target: that is the empty backdrop.
    enc.beginRenderPass({ colorAttachments: [{ view: a.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end();
    let src = a, dst = b;
    visible.forEach((layer, i) => {
      const tex = this.layerTexture(layer);
      const u = new ArrayBuffer(16);
      new Float32Array(u, 0, 1)[0] = layer.opacity;
      new Uint32Array(u, 4, 1)[0] = modeIndex(layer.blend);
      d.queue.writeBuffer(buf, i * SLOT, u);
      const group = d.createBindGroup({
        layout: this.compPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: src.createView() },
          { binding: 1, resource: tex.createView() },
          { binding: 2, resource: { buffer: buf, offset: i * SLOT, size: 16 } },
        ],
      });
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: dst.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      pass.setPipeline(this.compPipe);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
      [src, dst] = [dst, src];
    });
    d.queue.submit([enc.finish()]);
    this.result = src; // last written (or the cleared backdrop when nothing is visible)
    this.compKey = key;
    this.compDoc = doc;
    return src;
  }

  /** Draw the document into the canvas. v: { ox, oy, zoom, width, height, dpr } in CSS pixels. */
  present(doc, v) { this.renderView(doc, v, this.ctx.getCurrentTexture()); }

  /** The present pass into any texture of the canvas format (the canvas, or an offscreen target in tests). */
  renderView(doc, v, target) {
    const d = this.device;
    const comp = doc ? this.composite(doc) : this.empty;
    const enc = d.createCommandEncoder({ label: 'present' });
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    if (doc) {
      const z = v.zoom;
      const taps = z < 1 ? Math.min(4, Math.max(1, Math.ceil(1 / (z * v.dpr)))) : 1;
      d.queue.writeBuffer(this.viewBuf, 0, new Float32Array([v.ox, v.oy, doc.width * z, doc.height * z, doc.width, doc.height, v.dpr, taps]));
      const group = d.createBindGroup({
        layout: this.presPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: comp.createView() },
          { binding: 1, resource: z < 1 ? this.linear : this.nearest },
          { binding: 2, resource: { buffer: this.viewBuf } },
        ],
      });
      pass.setPipeline(this.presPipe);
      pass.setBindGroup(0, group);
      pass.draw(3);
    }
    pass.end();
    d.queue.submit([enc.finish()]);
  }

  /** Read the composite back as straight-alpha RGBA8 (tests and future export). Async. */
  async readComposite(doc) {
    const d = this.device, w = doc.width, h = doc.height;
    const comp = this.composite(doc);
    // Convert the float accumulator to RGBA8 straight alpha with a tiny pass, then copy out.
    if (!this.readPipe) {
      const m = d.createShaderModule({ code: READ_WGSL, label: 'readback' });
      this.readPipe = d.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } });
    }
    const out = d.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const bpr = Math.ceil((w * 4) / 256) * 256;
    const buf = d.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    pass.setPipeline(this.readPipe);
    pass.setBindGroup(0, d.createBindGroup({ layout: this.readPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: comp.createView() }] }));
    pass.draw(3);
    pass.end();
    enc.copyTextureToBuffer({ texture: out }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) data.set(src.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
    buf.unmap(); buf.destroy(); out.destroy();
    return { width: w, height: h, data };
  }

  destroy() {
    this.acc?.a.destroy(); this.acc?.b.destroy();
    this.uniforms?.destroy();
    this.viewBuf?.destroy();
    this.empty?.destroy();
    try { this.ctx.unconfigure(); } catch { /* already gone */ }
    this.acc = null; this.result = null;
  }
}

const READ_WGSL = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@group(0) @binding(0) var comp: texture_2d<f32>;
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let c = textureLoad(comp, vec2i(pos.xy), 0);
  if (c.a <= 0.0) { return vec4f(0.0); }
  return vec4f(c.rgb / c.a, c.a);
}`;

function clampRect(r, w, h) {
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.w)), y1 = Math.min(h, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
