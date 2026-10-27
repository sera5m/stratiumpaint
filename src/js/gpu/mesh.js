// WebGPU renderer for the 3D view (phase 2). Shares the 2D view's GpuCompositor device and samples
// its resident composite texture directly: a paint stroke updates only the touched layer rect on the
// GPU (writeTexture in the compositor), and nothing is read back or re-uploaded for the 3D view.
// Same shading as the WebGL path in ui/meshview.js.

const MESH_WGSL = `
struct U { mvp: mat4x4f, nrm: mat4x4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct VOut { @builtin(position) pos: vec4f, @location(0) n: vec3f, @location(1) uv: vec2f };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f) -> VOut {
  var o: VOut;
  var c = u.mvp * vec4f(p, 1.0);
  c.z = 0.5 * (c.z + c.w); // GL clip depth (-1..1) to WebGPU (0..1)
  o.pos = c;
  o.n = (u.nrm * vec4f(n, 0.0)).xyz;
  o.uv = uv;
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let t = textureSample(tex, samp, i.uv);          // premultiplied composite
  let rgb = select(vec3f(0.0), t.rgb / t.a, t.a > 0.0); // the WebGL path samples straight colour
  let light = 0.62 + 0.38 * max(dot(normalize(i.n), normalize(vec3f(0.35, 0.8, 0.4))), 0.0);
  return vec4f(rgb * light, 1.0);
}`;

export class GpuMeshRenderer {
  /** comp: the 2D view's GpuCompositor. canvas: element to present into (or null for offscreen). */
  constructor(comp, canvas) {
    this.comp = comp;
    const d = (this.device = comp.device);
    this.format = comp.format;
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('webgpu') : null;
    if (canvas && !this.ctx) throw new Error('canvas has no webgpu context');
    this.ctx?.configure({ device: d, format: this.format, alphaMode: 'opaque' });
    const m = d.createShaderModule({ code: MESH_WGSL, label: 'mesh' });
    this.pipe = d.createRenderPipeline({
      label: 'mesh', layout: 'auto',
      vertex: {
        module: m, entryPoint: 'vs',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
        ],
      },
      fragment: { module: m, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: 4 },
    });
    this.ubuf = d.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.bufs = null;
    this.count = 0;
    this.stats = { frames: 0, bindGroups: 0 };
  }

  /** Non-indexed triangles: Float32Arrays pos (xyz), nrm (xyz), uv (uv); count vertices. */
  setGeometry(pos, nrm, uv, count) {
    const d = this.device;
    for (const b of Object.values(this.bufs || {})) b.destroy();
    const mk = (a) => { const b = d.createBuffer({ size: Math.max(16, a.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }); d.queue.writeBuffer(b, 0, a); return b; };
    this.bufs = { pos: mk(pos), nrm: mk(nrm), uv: mk(uv) };
    this.count = count;
  }

  #targets(w, h) {
    if (this.msaa?.width === w && this.msaa.height === h) return;
    this.msaa?.destroy(); this.depth?.destroy();
    const d = this.device;
    this.msaa = d.createTexture({ size: [w, h], format: this.format, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depth = d.createTexture({ size: [w, h], format: 'depth24plus', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }

  /** Draw `doc`'s composite on the mesh. mvp: Float32Array(16) column-major (GL convention). */
  render(doc, mvp, target = null) {
    const d = this.device;
    const out = target || this.ctx.getCurrentTexture();
    const w = out.width, h = out.height;
    this.#targets(w, h);
    const tex = this.comp.composite(doc); // resident, already up to date (dirty rects only)
    if (tex !== this._tex) {
      this._tex = tex;
      this.group = d.createBindGroup({
        layout: this.pipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.ubuf } }, { binding: 1, resource: tex.createView() }, { binding: 2, resource: this.sampler }],
      });
      this.stats.bindGroups++;
    }
    const u = new Float32Array(32);
    u.set(mvp, 0);
    u.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 16);
    d.queue.writeBuffer(this.ubuf, 0, u);
    const enc = d.createCommandEncoder({ label: 'mesh' });
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.msaa.createView(), resolveTarget: out.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0.07, 0.08, 0.1, 1] }],
      depthStencilAttachment: { view: this.depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1 },
    });
    if (this.bufs && this.count) {
      pass.setPipeline(this.pipe);
      pass.setBindGroup(0, this.group);
      pass.setVertexBuffer(0, this.bufs.pos); pass.setVertexBuffer(1, this.bufs.nrm); pass.setVertexBuffer(2, this.bufs.uv);
      pass.draw(this.count);
    }
    pass.end();
    d.queue.submit([enc.finish()]);
    this.stats.frames++;
  }

  destroy() {
    for (const b of Object.values(this.bufs || {})) b.destroy();
    this.msaa?.destroy(); this.depth?.destroy(); this.ubuf.destroy();
    try { this.ctx?.unconfigure(); } catch { /* gone */ }
  }
}
