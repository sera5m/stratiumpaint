// WebGPU compositor for the main 2D view (phase 1 of docs/WEBGPU_PLAN.md).
//
// Each layer gets a GPU texture mirroring layer.img (straight-alpha RGBA8). Only the rect a tool
// touched is re-uploaded (Layer#touch records it in layer._gpuDirty). Layers are blended into a
// premultiplied rgba16float accumulator, one pass per visible layer, ping-ponging between two
// scratch targets, using the blend shader generated from blendmath.js, and the result is kept in
// a resident texture. A change only recomposites the changed rect (scissored passes, then a
// copy of that rect into the resident texture); property or order changes recomposite all.
//
// While a move tool floats content (Doc#setFloat), the layers below and above the float's layer
// are kept as two resident composites, the lifted pixels are one texture uploaded once, and each
// frame runs one or two passes over just the area the float covered last frame and covers now.
// Nothing is uploaded and nothing is read back during the drag.
//
// The present pass draws the composite into the view canvas with pan/zoom and the checkerboard.
//
// layer.img stays the source of truth in phase 1: tools, history, export, the colour picker and
// flood fill keep working on the CPU exactly as before. Nothing here reads back from the GPU.
import { COMPOSITE_WGSL, PRESENT_WGSL, CLEAR_WGSL, FLOAT_WGSL } from './shaders.js';
import { modeIndex } from './blendmath.js';
import { invert, floatMatrix, rotatedBounds } from '../core/xform.js';

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
    this.stacks = new Map(); // 'main' | 'below' | 'above' → resident composite of a run of layers
    this.frame = null; // resident composite while something floats
    this.floatTex = null; // { id, tex } the lifted pixels
    this.stats = { passes: 0, uploads: 0, uploadPixels: 0, fullRecomposites: 0 }; // for the benchmark
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
    const clr = d.createShaderModule({ code: CLEAR_WGSL, label: 'clear' });
    this.clearPipe = d.createRenderPipeline({
      label: 'clear', layout: 'auto',
      vertex: { module: clr, entryPoint: 'vs' },
      fragment: { module: clr, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });
    const fl = d.createShaderModule({ code: FLOAT_WGSL, label: 'float' });
    this.floatPipe = d.createRenderPipeline({
      label: 'float', layout: 'auto',
      vertex: { module: fl, entryPoint: 'vs' },
      fragment: { module: fl, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });
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
      this.stats.uploads++;
      const r = dirty === 'all' ? { x: 0, y: 0, w, h } : clampRect(dirty, w, h);
      if (r) {
        this.stats.uploadPixels = (this.stats.uploadPixels || 0) + r.w * r.h;
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
    this.acc = { a: this.#tex16(w, h, 'acc a'), b: this.#tex16(w, h, 'acc b'), w, h };
    return this.acc;
  }

  #tex16(w, h, label) {
    return this.device.createTexture({
      label, size: [w, h], format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
  }

  #uniformsFor(n) {
    if (this.uniforms && this.uniformSlots >= n) return this.uniforms;
    this.uniforms?.destroy();
    this.uniformSlots = Math.max(8, n * 2);
    this.uniforms = this.device.createBuffer({ size: this.uniformSlots * SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return this.uniforms;
  }

  // ---------------------------------------------------------------- compositing

  /** One scissored pass writing `dst` from `src` + a layer (or premultiplied group) texture. */
  #layerPass(enc, src, dst, tex, slot, { opacity, mode, premul }, r) {
    const d = this.device, buf = this.uniforms;
    const u = new ArrayBuffer(16);
    new Float32Array(u, 0, 1)[0] = opacity;
    new Uint32Array(u, 4, 2).set([mode, premul ? 1 : 0]);
    d.queue.writeBuffer(buf, slot * SLOT, u);
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: dst.createView(), loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(this.compPipe);
    pass.setBindGroup(0, d.createBindGroup({
      layout: this.compPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: tex.createView() },
        { binding: 2, resource: { buffer: buf, offset: slot * SLOT, size: 16 } },
      ],
    }));
    pass.setScissorRect(r.x, r.y, r.w, r.h);
    pass.draw(3);
    pass.end();
    this.stats.passes++;
  }

  #clearPass(enc, dst, r) {
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: dst.createView(), loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(this.clearPipe);
    pass.setScissorRect(r.x, r.y, r.w, r.h);
    pass.draw(3);
    pass.end();
  }

  /**
   * Bring the resident composite of `layers` (a run of the stack) up to date, recompositing only
   * the rect that changed. Returns { res, stamp } where stamp changes whenever res did.
   */
  #updateStack(name, layers, w, h) {
    const visible = layers.filter((l) => l.visible && l.opacity > 0);
    const sig = `${w}x${h}|` + visible.map((l) => `${l.id}:${l.opacity}:${l.blend}`).join(',');
    let st = this.stacks.get(name);
    if (st && (st.w !== w || st.h !== h)) { st.res.destroy(); st = null; }
    if (!st) { st = { res: this.#tex16(w, h, `stack ${name}`), w, h, sig: null, versions: new Map(), stamp: 0 }; this.stacks.set(name, st); }
    let rect = null, full = st.sig !== sig;
    if (!full) {
      for (const l of visible) {
        if (st.versions.get(l) === l.version && this.layers.has(l)) continue;
        const dr = l._gpuDirty;
        if (!this.layers.has(l) || !dr || dr === 'all') { full = true; break; }
        rect = rect ? unionRect(rect, dr) : dr;
      }
      if (!full && !rect) return st; // nothing changed
    }
    const r = full ? { x: 0, y: 0, w, h } : clampRect(rect, w, h);
    st.sig = sig;
    st.versions = new Map(visible.map((l) => [l, l.version]));
    st.stamp++;
    if (!r) return st;
    if (full) this.stats.fullRecomposites++;
    const { a, b } = this.#targets(w, h);
    this.#uniformsFor(visible.length);
    const enc = this.device.createCommandEncoder({ label: `stack ${name}` });
    this.#clearPass(enc, a, r);
    let src = a, dst = b;
    visible.forEach((l, i) => {
      const tex = this.layerTexture(l);
      this.#layerPass(enc, src, dst, tex, i, { opacity: l.opacity, mode: modeIndex(l.blend), premul: false }, r);
      [src, dst] = [dst, src];
    });
    enc.copyTextureToTexture({ texture: src, origin: [r.x, r.y] }, { texture: st.res, origin: [r.x, r.y] }, [r.w, r.h]);
    this.device.queue.submit([enc.finish()]);
    return st;
  }

  #floatTexture(f) {
    const ft = this.floatTex;
    if (ft?.id === f.id && ft.content === (f.content || 0)) return ft.tex;
    const { width: w, height: h, data } = f.src;
    // A live canvas float (shape preview) changes size as it is dragged: keep a texture with
    // headroom and copy the canvas into its corner (the shader is told the used size).
    let tex = ft?.tex;
    if (!tex || ft.w < w || ft.h < h || (data && (ft.w !== w || ft.h !== h))) {
      tex?.destroy();
      const cw = data ? w : Math.ceil(w * 1.25) + 16, ch = data ? h : Math.ceil(h * 1.25) + 16;
      tex = this.device.createTexture({ label: 'float', size: [cw, ch], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      this.floatTex = { id: f.id, content: -1, tex, w: cw, h: ch };
    }
    if (data) this.device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: w * 4, rowsPerImage: h }, [w, h]); // once per lift
    else this.device.queue.copyExternalImageToTexture({ source: f.canvas }, { texture: tex, premultipliedAlpha: false }, [w, h]); // GPU-side copy
    this.stats.uploads++;
    this.stats.uploadPixels = (this.stats.uploadPixels || 0) + w * h;
    Object.assign(this.floatTex, { id: f.id, content: f.content || 0 });
    return tex;
  }

  /** The frame while something floats: below + (layer with float) + above, over the changed area. */
  #floatFrame(doc, f, below, above, aboveLayers) {
    const d = this.device, w = doc.width, h = doc.height, l = f.layer;
    const layerTex = this.layerTexture(l);
    const ftex = this.#floatTexture(f);
    const base = `${f.id}|${below.stamp}|${above ? above.stamp : aboveLayers.map((x) => `${x.id}:${x.version}:${x.visible}:${x.opacity}:${x.blend}`).join(',')}|${l.version}|${l.opacity}|${l.blend}|${w}x${h}`;
    let fr = this.frame;
    if (fr && (fr.w !== w || fr.h !== h)) { fr.res.destroy(); fr = null; }
    if (!fr) fr = this.frame = { res: this.#tex16(w, h, 'float frame'), w, h, base: null, version: -1, bounds: null };
    if (fr.base === base && fr.version === f.version) return fr.res;
    const now = rotatedBounds(f.box, f.angle);
    const grow = (r) => ({ x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 });
    const r = fr.base === base && fr.bounds ? clampRect(unionRect(grow(fr.bounds), grow(now)), w, h) : { x: 0, y: 0, w, h };
    if (r.w === w && r.h === h) this.stats.fullRecomposites++;
    fr.base = base; fr.version = f.version; fr.bounds = now;
    if (!r) return fr.res;
    const { a, b } = this.#targets(w, h);
    this.#uniformsFor(2 + aboveLayers.length);
    const enc = d.createCommandEncoder({ label: 'float frame' });
    // Pass 1: below + (layer ⊕ float) → a
    const inv = invert(floatMatrix(f.src.width, f.src.height, f.box, f.angle));
    const u = new ArrayBuffer(48);
    new Float32Array(u, 0, 1)[0] = l.visible ? l.opacity : 0;
    new Uint32Array(u, 4, 1)[0] = modeIndex(l.blend);
    new Float32Array(u, 8, 1)[0] = f.alpha ?? 1;
    new Float32Array(u, 16, 8).set([inv[0], inv[1], inv[2], inv[3], inv[4], inv[5], f.src.width, f.src.height]);
    d.queue.writeBuffer(this.uniforms, 0, u);
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: a.createView(), loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(this.floatPipe);
    pass.setBindGroup(0, d.createBindGroup({
      layout: this.floatPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: below.res.createView() },
        { binding: 1, resource: layerTex.createView() },
        { binding: 2, resource: ftex.createView() },
        { binding: 3, resource: { buffer: this.uniforms, offset: 0, size: 48 } },
      ],
    }));
    pass.setScissorRect(r.x, r.y, r.w, r.h);
    pass.draw(3);
    pass.end();
    this.stats.passes++;
    // Pass 2..: the layers above, as one pre-flattened group when they are all Normal.
    let src = a, dst = b;
    if (above) {
      this.#layerPass(enc, src, dst, above.res, 1, { opacity: 1, mode: 0, premul: true }, r);
      [src, dst] = [dst, src];
    } else {
      aboveLayers.filter((x) => x.visible && x.opacity > 0).forEach((x, i) => {
        this.#layerPass(enc, src, dst, this.layerTexture(x), 1 + i, { opacity: x.opacity, mode: modeIndex(x.blend), premul: false }, r);
        [src, dst] = [dst, src];
      });
    }
    enc.copyTextureToTexture({ texture: src, origin: [r.x, r.y] }, { texture: fr.res, origin: [r.x, r.y] }, [r.w, r.h]);
    d.queue.submit([enc.finish()]);
    return fr.res;
  }

  /** The document's composite as a resident texture, recomposited only where it changed. */
  composite(doc) {
    const w = doc.width, h = doc.height;
    const f = doc.float;
    const i = f ? doc.layers.indexOf(f.layer) : -1;
    if (i < 0) { this.frame = this.frame && (this.frame.base = null, this.frame); return this.#updateStack('main', doc.layers, w, h).res; }
    const up = doc.layers.slice(i + 1);
    const below = this.#updateStack('below', doc.layers.slice(0, i), w, h);
    const groupable = up.every((l) => !l.visible || l.blend === 'source-over');
    const above = groupable ? this.#updateStack('above', up, w, h) : null;
    const res = this.#floatFrame(doc, f, below, above, groupable ? [] : up);
    this.stacks.get('main') && (this.stacks.get('main').sig = null); // main is stale once the float lands
    return res;
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
    for (const st of this.stacks.values()) st.res.destroy();
    this.stacks.clear();
    this.frame?.res.destroy(); this.frame = null;
    this.floatTex?.tex.destroy(); this.floatTex = null;
    this.uniforms?.destroy();
    this.viewBuf?.destroy();
    this.empty?.destroy();
    try { this.ctx.unconfigure(); } catch { /* already gone */ }
    this.acc = null;
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

function unionRect(a, b) {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}
