// The mounted mesh. Left pane stays the texture; this pane shows it on the model.
// Paint draws on the solid or on the flat unwrap. Scroll zooms, middle-drag
// slides, Alt-drag turns. The corner cube snaps the view to a side.
import { buildBVH, raycastMesh } from '../core/mesh.js';
import { seamStep, uvCharts } from '../core/seam.js';
import { atlasOf, modelPaintLayer, reproject } from './place.js';
import { h } from './dom.js';

const VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec2 aUv;
uniform mat4 uMvp;
uniform mat3 uN;
varying vec3 vN;
varying vec2 vUv;
void main() {
  vN = uN * aNrm;
  vUv = aUv;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

const FS = `
precision mediump float;
varying vec3 vN;
varying vec2 vUv;
uniform sampler2D uTex;
void main() {
  vec4 tex = texture2D(uTex, vec2(vUv.x, 1.0 - vUv.y));
  vec3 n = normalize(vN);
  float light = 0.62 + 0.38 * max(dot(n, normalize(vec3(0.35, 0.8, 0.4))), 0.0);
  gl_FragColor = vec4(tex.rgb * light, 1.0);
}`;

export class MeshView {
  constructor(ed, pane) {
    this.ed = ed;
    this.pane = pane;
    this.mode = 'paint';
    this.shape = 'solid';
    this.yaw = 0.6;
    this.pitch = 0.4;
    this.dist = 1;
    this.target = [0, 0, 0];
    this.cam = { solid: null, flat: null };
    this.dragging = null;
    this.painting = false;
    this._texDirty = true;
    this._geomKey = null;

    const tool = (mode, label) => h('button', { type: 'button', class: `seg-btn${mode === 'paint' ? ' on' : ''}`, 'data-mode': mode, onClick: () => this.#tool(mode) }, label);
    const shape = (id, label) => h('button', { type: 'button', class: `seg-btn${id === 'solid' ? ' on' : ''}`, 'data-shape': id, onClick: () => this.#shape(id) }, label);
    const view = (id, label) => h('button', { type: 'button', class: 'vc-label', 'data-view': id, onClick: () => this.#look(id) }, label);
    this.hint = h('span', { class: 'mesh-hint' }, 'Scroll zooms · middle-drag slides · Alt-drag turns');
    this.canvas = h('canvas', { class: 'mesh-canvas' });
    this.hud = h('div', { class: 'mesh-tools' },
      h('div', { class: 'seg tools' }, tool('paint', 'Paint'), tool('move', 'Move')),
      h('div', { class: 'seg shape' }, shape('solid', 'Solid'), shape('flat', 'Flat')),
      this.hint);
    const face = (id, label) => h('div', { class: `vc-face ${id}`, 'data-view': id }, label);
    this.cube = h('div', { class: 'vc-cube' },
      face('front', 'Front'), face('back', 'Back'), face('right', 'Right'),
      face('left', 'Left'), face('top', 'Top'), face('bottom', 'Bottom'));
    this.cubeScene = h('div', { class: 'vc-scene', title: 'Drag to turn. Click a face to jump there.' }, this.cube);
    this.cubeWidget = h('div', { class: 'viewcube' },
      view('top', 'Top'),
      h('div', { class: 'vc-mid' }, view('left', 'Left'), this.cubeScene, view('right', 'Right')),
      view('bottom', 'Bottom'),
      h('div', { class: 'vc-fb' }, view('front', 'Front'), view('back', 'Back')));
    pane.append(this.canvas, this.hud, this.cubeWidget);
    this.gl = this.canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (this.gl) {
      try { this.#initGL(); } catch (err) { console.error(err); this.gl = null; }
    }

    this._frame = () => this.#draw();
    new ResizeObserver(() => this.#resize()).observe(pane);
    ed.on('doc', () => { this.#attach(); requestAnimationFrame(() => this.#resize()); });
    ed.on('doc:render', () => { this._texDirty = true; this.#request(); });
    ed.on('model-texture', () => { this._texDirty = true; this.#request(); });
    ed.on('layout', () => requestAnimationFrame(() => this.#resize()));
    this.#bind();
    this.#attach();
  }

  #tool(mode) {
    this.mode = mode;
    for (const b of this.hud.querySelectorAll('.seg.tools .seg-btn')) b.classList.toggle('on', b.dataset.mode === mode);
    this.hint.textContent = mode === 'move'
      ? 'Drag the open image · scroll sizes it'
      : 'Scroll zooms · middle-drag slides · Alt-drag turns';
  }

  #shape(shape) {
    if (shape === this.shape) return;
    this.cam[this.shape] = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: this.target.slice() };
    this.shape = shape;
    for (const b of this.hud.querySelectorAll('.seg.shape .seg-btn')) b.classList.toggle('on', b.dataset.shape === shape);
    const mount = this.ed.doc?.mount;
    if (!mount) return;
    if (shape === 'flat') this.#ensureFlat(mount);
    this.#uploadGeom(mount);
    const saved = this.cam[shape];
    if (saved) {
      this.yaw = saved.yaw; this.pitch = saved.pitch; this.dist = saved.dist; this.target = saved.target.slice();
    } else this.#frame(mount);
    this.#request();
  }

  #initGL() {
    const gl = this.gl;
    const prog = program(gl, VS, FS);
    this.prog = prog;
    this.loc = {
      pos: gl.getAttribLocation(prog, 'aPos'),
      nrm: gl.getAttribLocation(prog, 'aNrm'),
      uv: gl.getAttribLocation(prog, 'aUv'),
      mvp: gl.getUniformLocation(prog, 'uMvp'),
      n: gl.getUniformLocation(prog, 'uN'),
    };
    this.buf = { pos: gl.createBuffer(), nrm: gl.createBuffer(), uv: gl.createBuffer() };
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.07, 0.08, 0.1, 1);
  }

  #attach() {
    const mount = this.ed.doc?.mount;
    if (!mount || !this.gl) { this.bvh = null; return; }
    const key = mount;
    if (key !== this._geomKey) {
      this._geomKey = key;
      this.flatBvh = null;
      this.cam = { solid: null, flat: null };
      this.bvh = buildBVH(mount.positions, mount.indices);
      this.#frame(mount);
      this.#uploadGeom(mount);
    } else if (this.shape === 'flat') this.#ensureFlat(mount);
    this._texDirty = true;
    this.#resize();
  }

  #frame(mount) {
    cancelAnimationFrame(this._lookRAF);
    const src = this.shape === 'flat' ? (this.#ensureFlat(mount), this.flatPos) : mount.positions;
    const box = bounds(src);
    this.target = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    const r = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) || 1;
    this.dist = r * (this.shape === 'flat' ? 1.15 : 1.4);
    if (this.shape === 'flat') { this.yaw = 0; this.pitch = 1.2; }
    else { this.yaw = 0.7; this.pitch = 0.35; }
  }

  #ensureFlat(mount) {
    if (this.flatBvh && this._flatKey === mount) return this.flatPos;
    const n = mount.indices.length;
    const pos = new Float32Array(n * 3);
    const idx = new Uint32Array(n);
    const span = 2;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = ((mount.uvs[i * 2] ?? 0) - 0.5) * span;
      pos[i * 3 + 1] = 0;
      pos[i * 3 + 2] = ((mount.uvs[i * 2 + 1] ?? 0) - 0.5) * span;
      idx[i] = i;
    }
    this.flatPos = pos;
    this.flatBvh = buildBVH(pos, idx);
    this._flatKey = mount;
    return pos;
  }

  #uploadGeom(mount) {
    const gl = this.gl;
    const { positions, indices, uvs } = mount;
    const n = indices.length / 3;
    const pos = new Float32Array(n * 9);
    const nrm = new Float32Array(n * 9);
    const uv = new Float32Array(n * 6);
    const flat = this.shape === 'flat';
    for (let t = 0; t < n; t++) {
      const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
      const p = flat
        ? [0, 1, 2].map((k) => {
          const c = t * 3 + k;
          return [((uvs[c * 2] ?? 0) - 0.5) * 2, 0, ((uvs[c * 2 + 1] ?? 0) - 0.5) * 2];
        })
        : [ia, ib, ic].map((i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
      const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
      const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      if (flat) { nx = 0; ny = 1; nz = 0; }
      for (let k = 0; k < 3; k++) {
        pos[(t * 3 + k) * 3] = p[k][0]; pos[(t * 3 + k) * 3 + 1] = p[k][1]; pos[(t * 3 + k) * 3 + 2] = p[k][2];
        nrm[(t * 3 + k) * 3] = nx; nrm[(t * 3 + k) * 3 + 1] = ny; nrm[(t * 3 + k) * 3 + 2] = nz;
        uv[(t * 3 + k) * 2] = uvs[(t * 3 + k) * 2];
        uv[(t * 3 + k) * 2 + 1] = uvs[(t * 3 + k) * 2 + 1];
      }
    }
    const put = (buf, data) => { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); };
    put(this.buf.pos, pos); put(this.buf.nrm, nrm); put(this.buf.uv, uv);
    this.count = n * 3;
  }

  #resize() {
    const w = this.pane.clientWidth, h = this.pane.clientHeight;
    if (!w || !h || !this.gl) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.#request();
  }

  #request() {
    if (this._pending || !this.ed.doc?.mount) return;
    this._pending = true;
    requestAnimationFrame(() => { this._pending = false; this.#draw(); });
  }

  #draw() {
    const gl = this.gl, doc = this.ed.doc, mount = doc?.mount;
    if (!gl || !mount || this.pane.hidden || !this.canvas.width) return;
    this.#syncCube();
    if (this._texDirty) {
      this._texDirty = false;
      const atlas = atlasOf(doc) || doc;
      const src = atlas.composite();
      const pixels = src.getContext('2d').getImageData(0, 0, src.width, src.height);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, pixels.width, pixels.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels.data);
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    const eye = this.#eye();
    const mvp = mul(perspective(0.7, this.canvas.width / this.canvas.height, 0.01, this.dist * 20 + 10), lookAt(eye, this.target, [0, 1, 0]));
    gl.uniformMatrix4fv(this.loc.mvp, false, mvp);
    gl.uniformMatrix3fv(this.loc.n, false, new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]));
    const bind = (loc, buf, size) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    bind(this.loc.pos, this.buf.pos, 3);
    bind(this.loc.nrm, this.buf.nrm, 3);
    bind(this.loc.uv, this.buf.uv, 2);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
  }

  #look(name) {
    const view = VIEWS[name];
    if (!view || !this.ed.doc?.mount) return;
    cancelAnimationFrame(this._lookRAF);
    const fromY = this.yaw, fromP = this.pitch;
    const toY = fromY + angDiff(view[0], fromY);
    const toP = view[1];
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / 220);
      const e = t * t * (3 - 2 * t);
      this.yaw = fromY + (toY - fromY) * e;
      this.pitch = fromP + (toP - fromP) * e;
      this.#syncCube();
      this.#request();
      if (t < 1) this._lookRAF = requestAnimationFrame(step);
    };
    this._lookRAF = requestAnimationFrame(step);
  }

  #syncCube() {
    if (!this.cube) return;
    this.cube.style.transform = `rotateX(${-this.pitch * 180 / Math.PI}deg) rotateY(${this.yaw * 180 / Math.PI}deg)`;
    let best = null, bestD = 0.28;
    for (const [name, [y, p]] of Object.entries(VIEWS)) {
      const d = Math.hypot(angDiff(this.yaw, y), this.pitch - p);
      if (d < bestD) { best = name; bestD = d; }
    }
    for (const b of this.cubeWidget.querySelectorAll('.vc-label')) b.classList.toggle('on', b.dataset.view === best);
  }

  #eye() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    return [
      this.target[0] + this.dist * cp * sy,
      this.target[1] + this.dist * sp,
      this.target[2] + this.dist * cp * cy,
    ];
  }

  #ray(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = -((e.clientY - r.top) / r.height) * 2 + 1;
    const eye = this.#eye();
    const forward = norm(sub(this.target, eye));
    const right = norm(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    const aspect = r.width / r.height;
    const tan = Math.tan(0.35);
    const dir = norm(add(forward, add(scale(right, x * tan * aspect), scale(up, y * tan))));
    return { origin: eye, dir };
  }

  /** Hit under the cursor: UV (v down), the 3D point, or null. */
  #hit(e) {
    if (!this.bvh || !this.ed.doc?.mount) return null;
    const bvh = this.shape === 'flat' ? this.flatBvh : this.bvh;
    if (!bvh) return null;
    const { origin, dir } = this.#ray(e);
    const hit = raycastMesh(bvh, origin, dir);
    if (!hit) return null;
    const mount = this.ed.doc.mount;
    const i = hit.tri * 3;
    const b0 = 1 - hit.u - hit.v, b1 = hit.u, b2 = hit.v;
    return {
      u: b0 * mount.uvs[i * 2] + b1 * mount.uvs[(i + 1) * 2] + b2 * mount.uvs[(i + 2) * 2],
      v: b0 * mount.uvs[i * 2 + 1] + b1 * mount.uvs[(i + 1) * 2 + 1] + b2 * mount.uvs[(i + 2) * 2 + 1],
      p3: [origin[0] + dir[0] * hit.t, origin[1] + dir[1] * hit.t, origin[2] + dir[2] * hit.t],
      face: hit.tri,
    };
  }

  /** 3D distance under which a UV jump is the weld, not a hop across the model. Flat never wraps. */
  #gap() {
    if (this.shape === 'flat') return 0;
    const mount = this.ed.doc?.mount;
    if (!mount?.positions) return 0;
    if (this._gapMount !== mount) {
      this._gapMount = mount;
      const box = bounds(mount.positions);
      const diag = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) || 1;
      this._gap = diag * 0.3;
    }
    return this._gap;
  }

  #charts() {
    const mount = this.ed.doc?.mount;
    if (!mount?.uvs) return null;
    if (this._chartMount !== mount) {
      this._chartMount = mount;
      this._charts = uvCharts(mount.indices, mount.uvs);
    }
    return this._charts;
  }

  /** Follow a drag across a UV cut so a shape wraps the weld instead of the chart. */
  #track(hit) {
    if (!this.stroke) {
      this.stroke = { u: hit.u, v: hit.v, offU: 0, offV: 0, wrapped: false, p3: hit.p3, face: hit.face, visits: [] };
      this.#visit(hit);
      return;
    }
    const step = seamStep(this.stroke, hit, this.#gap(), this.shape === 'flat' ? null : this.ed.doc?.mount);
    if (step.wrapped) {
      this.stroke.wrapped = true;
      this.stroke.offU = step.offU;
      this.stroke.offV = step.offV;
      this.#visit(hit);
    }
    this.stroke.u = hit.u;
    this.stroke.v = hit.v;
    this.stroke.p3 = hit.p3;
    this.stroke.face = hit.face;
  }

  #visit(hit) {
    const box = this.#charts()?.[hit.face] || null;
    const dx = this.stroke.offU, dy = this.stroke.offV;
    const visits = this.stroke.visits;
    if (visits.some((v) => Math.abs(v.dx - dx) < 0.02 && Math.abs(v.dy - dy) < 0.02)) return;
    visits.push({ dx, dy, box });
  }

  #docPoint(hit, { shape = false } = {}) {
    const atlas = atlasOf(this.ed.doc) || this.ed.doc;
    const u = shape ? hit.u + (this.stroke?.offU || 0) : hit.u;
    const v = shape ? hit.v + (this.stroke?.offV || 0) : hit.v;
    const p = { x: u * atlas.width, y: v * atlas.height };
    if (shape && this.stroke?.wrapped && this.stroke.visits?.length) {
      const W = atlas.width, H = atlas.height;
      p.wrap = {
        pieces: this.stroke.visits.map((v) => ({
          dx: v.dx * W,
          dy: v.dy * H,
          clip: v.box ? {
            x: v.box.umin * W, y: v.box.vmin * H,
            w: Math.max(1, (v.box.umax - v.box.umin) * W),
            h: Math.max(1, (v.box.vmax - v.box.vmin) * H),
          } : null,
        })),
      };
    }
    return p;
  }

  #source() {
    const doc = this.ed.doc;
    return doc?.session && !doc.atlas ? doc : null;
  }

  #bind() {
    const c = this.canvas, ed = this.ed;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      if (!ed.doc?.mount) return;
      c.setPointerCapture(e.pointerId);
      if ((e.button === 0 && e.altKey) || e.button === 1) {
        this.dragging = { x: e.clientX, y: e.clientY, mode: e.altKey ? 'rotate' : 'pan' };
        return;
      }
      if (this.mode === 'move' && e.button === 0) {
        const source = this.#source();
        const uv = this.#hit(e);
        if (!source) { ed.toast('Open the image tab you want to move.'); return; }
        if (!uv) return;
        this.moving = { source, u: uv.u, v: uv.v, place: { ...source.place } };
        return;
      }
      if (e.button !== 0 && e.button !== 2) return;
      const hit = this.#hit(e);
      if (!hit) return;
      this.stroke = null;
      this.#track(hit);
      const shape = ed.tool?.group === 'shape';
      const p = this.#docPoint(hit, { shape });
      const atlas = atlasOf(ed.doc);
      if (atlas) {
        ed._modelTarget = atlas;
        const layer = modelPaintLayer(atlas);
        const i = atlas.layers.indexOf(layer);
        if (i >= 0) atlas.active = i;
      }
      this.painting = true;
      this.paintButton = e.button;
      ed.hover = p;
      ed.pointer('down', { ...p, sx: 0, sy: 0, button: e.button === 2 ? 2 : 0, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: false });
    });
    c.addEventListener('pointermove', (e) => {
      if (this.dragging) {
        const dx = e.clientX - this.dragging.x, dy = e.clientY - this.dragging.y;
        this.dragging.x = e.clientX; this.dragging.y = e.clientY;
        if (this.dragging.mode === 'pan') this.#pan(dx, dy);
        else if (this.dragging.mode === 'zoom') this.dist = Math.max(0.02, this.dist * Math.pow(1.008, dy));
        else { this.yaw += dx * 0.01; this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + dy * 0.01)); }
        this.#request();
        return;
      }
      if (this.moving) {
        const uv = this.#hit(e);
        if (!uv) return;
        const s = this.moving;
        const p = s.place;
        s.source.place = { u: p.u + (uv.u - s.u), v: p.v + (uv.v - s.v), w: p.w, h: p.h };
        reproject(s.source, ed);
        return;
      }
      if (!this.painting) return;
      const hit = this.#hit(e);
      if (!hit) return;
      this.#track(hit);
      const shape = ed.tool?.group === 'shape';
      const p = this.#docPoint(hit, { shape });
      ed.hover = { x: hit.u * (atlasOf(ed.doc)?.width || ed.doc.width), y: hit.v * (atlasOf(ed.doc)?.height || ed.doc.height) };
      ed.pointer('move', { ...p, sx: 0, sy: 0, button: this.paintButton === 2 ? 2 : 0, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: false });
      ed.requestOverlay();
    });
    const end = () => {
      this.dragging = null;
      this.moving = null;
      this.stroke = null;
      if (!this.painting) return;
      this.painting = false;
      const p = ed.hover || { x: 0, y: 0 };
      ed.pointer('up', { ...p, sx: 0, sy: 0, button: this.paintButton === 2 ? 2 : 0, shift: false, ctrl: false, alt: false });
      ed._modelTarget = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      if (!ed.doc?.mount) return;
      e.preventDefault();
      const source = this.mode === 'move' ? this.#source() : null;
      if (source?.place) {
        const k = Math.pow(0.999, e.deltaY * (e.deltaMode === 1 ? 16 : 1));
        const p = source.place;
        const cx = p.u + p.w / 2, cy = p.v + p.h / 2;
        const w = Math.min(1.5, Math.max(0.02, p.w * k));
        const h = Math.min(1.5, Math.max(0.02, p.h * k));
        source.place = { u: cx - w / 2, v: cy - h / 2, w, h };
        reproject(source, ed);
        return;
      }
      this.dist *= Math.pow(1.0015, e.deltaY * (e.deltaMode === 1 ? 16 : 1));
      this.dist = Math.max(this.dist, 0.02);
      this.#request();
    }, { passive: false });
    const scene = this.cubeScene;
    scene.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !ed.doc?.mount) return;
      e.preventDefault();
      e.stopPropagation();
      cancelAnimationFrame(this._lookRAF);
      scene.setPointerCapture(e.pointerId);
      this.cubeDrag = { x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, moved: false, id: e.pointerId };
    });
    scene.addEventListener('pointermove', (e) => {
      const d = this.cubeDrag;
      if (!d || e.pointerId !== d.id) return;
      if (Math.hypot(e.clientX - d.ox, e.clientY - d.oy) > 3) d.moved = true;
      if (!d.moved) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      this.yaw += dx * 0.01;
      this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + dy * 0.01));
      this.#syncCube();
      this.#request();
    });
    const endCube = (e) => {
      const d = this.cubeDrag;
      if (!d || e.pointerId !== d.id) return;
      this.cubeDrag = null;
      if (d.moved) return;
      const face = e.target.closest?.('[data-view]');
      if (face) this.#look(face.dataset.view);
    };
    scene.addEventListener('pointerup', endCube);
    scene.addEventListener('pointercancel', endCube);
  }

  #pan(dx, dy) {
    const eye = this.#eye();
    const forward = norm(sub(this.target, eye));
    const right = norm(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    const k = this.dist * 0.0015;
    this.target = add(this.target, add(scale(right, -dx * k), scale(up, dy * k)));
  }
}

const VIEWS = {
  front: [0, 0],
  back: [Math.PI, 0],
  right: [Math.PI / 2, 0],
  left: [-Math.PI / 2, 0],
  top: [0, 1.2],
  bottom: [0, -1.2],
};

function angDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function bounds(p) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return { min, max };
}

function program(gl, vs, fs) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
  return p;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f;
  m[10] = (far + near) / (near - far); m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

function lookAt(eye, target, up) {
  const z = norm(sub(eye, target));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
    -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
    -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
    1,
  ]);
}

function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
