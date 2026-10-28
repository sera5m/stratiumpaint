// The mounted mesh. Left pane stays the texture; this pane shows it on the model.
// Paint draws on the solid or on the flat unwrap. Scroll zooms, middle-drag
// slides, Alt-drag turns. The corner cube snaps the view to a side.
import { buildBVH, raycastMesh } from '../core/mesh.js';
import { seamStep, uvCharts } from '../core/seam.js';
import { atlasOf, modelPaintLayer, reproject } from './place.js';
import { h } from './dom.js';
import { rectUnion } from '../core/util.js';
import { GpuMeshRenderer } from '../gpu/mesh.js';
import { projectPaint, commitProjection, decalMatrix, aimProjection, planeCoords, projectorAxes, eulerFromView } from '../core/projection.js';
import { gizmoHandles, hitGizmo, dragMove, dragRotate, AXIS_COLORS } from '../core/gizmo.js';
import { gpuProjectPaint } from '../gpu/projection.js';

const VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec2 aUv;
uniform mat4 uMvp;
uniform mat3 uN;
varying vec3 vN;
varying vec2 vUv;
varying vec3 vW;
void main() {
  vN = uN * aNrm;
  vUv = aUv;
  vW = aPos;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

// uDecal*: the Projection-mode preview, the shape projected onto every surface it faces (no
// occlusion test; the paint on release has one). uDecalM maps world → decal texture coords (xy/w).
const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 vN;
varying vec2 vUv;
varying vec3 vW;
uniform sampler2D uTex;
uniform sampler2D uDecal;
uniform mat4 uDecalM;
uniform vec4 uDecalP; // on, opacity, max u, max v
void main() {
  vec4 tex = texture2D(uTex, vUv); // texture row 0 = top of the image (uploaded unflipped)
  vec3 rgb = tex.rgb;
  if (uDecalP.x > 0.5) {
    vec4 q = uDecalM * vec4(vW, 1.0);
    if (q.w > 1e-6) {
      vec2 d = q.xy / q.w;
      if (d.x >= 0.0 && d.y >= 0.0 && d.x <= uDecalP.z && d.y <= uDecalP.w) {
        vec4 s = texture2D(uDecal, d);
        rgb = mix(rgb, s.rgb, s.a * uDecalP.y);
      }
    }
  }
  vec3 n = normalize(vN);
  float light = 0.62 + 0.38 * max(dot(n, normalize(vec3(0.35, 0.8, 0.4))), 0.0);
  gl_FragColor = vec4(rgb * light, 1.0);
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
    this.offsets = [];
    this.hidden = [];
    this.selectedGroup = 0;
    this.objectDrag = null;
    this.dragging = null;
    this.painting = false;
    this._texDirty = true;
    this._geomKey = null;
    this.proj = null; // Projection-mode drag
    this.decal = null; // its preview: { m, alpha, canvas, gen, w, h }
    this._decalGen = 0;

    const tool = (mode, label) => h('button', { type: 'button', class: `seg-btn${mode === 'paint' ? ' on' : ''}`, 'data-mode': mode, onClick: () => this.#tool(mode) }, label);
    const shape = (id, label) => h('button', { type: 'button', class: `seg-btn${id === 'solid' ? ' on' : ''}`, 'data-shape': id, onClick: () => this.#shape(id) }, label);
    const view = (id, label) => h('button', { type: 'button', class: 'vc-label', 'data-view': id, onClick: () => this.#look(id) }, label);
    this.hint = h('span', { class: 'mesh-hint' }, 'Scroll zooms · middle-drag slides · Alt-drag turns');
    this.canvas = h('canvas', { class: 'mesh-canvas' });
    this.hud = h('div', { class: 'mesh-tools' },
      h('div', { class: 'seg tools' }, tool('paint', 'Paint'), tool('move', 'Move')),
      h('div', { class: 'seg shape' }, shape('solid', 'Solid'), shape('flat', 'Flat')),
      h('div', { class: 'seg objects' },
        h('select', { class: 'obj-select', 'aria-label': 'Object', onChange: (e) => { this.selectedGroup = +e.target.value; this.#syncHide(); } }),
        h('button', { type: 'button', class: 'seg-btn obj-hide', onClick: () => this.#toggleHide() }, 'Hide'),
        h('button', { type: 'button', class: 'seg-btn obj-solo', title: 'Hide every other object (again to show them all)', onClick: () => this.#toggleIsolate() }, 'Isolate'),
        h('button', { type: 'button', class: 'seg-btn', onClick: () => this.#resetOffsets() }, 'Reset')),
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
    // The projector gizmo (Projection mode) is 2D-drawn over the model: no GPU work, no geometry.
    this.gizmoCanvas = h('canvas', { class: 'mesh-canvas mesh-gizmo' });
    this.gizmoCanvas.style.pointerEvents = 'none';
    this.gizmoStats = { drawn: 0, hidden: 0 };
    this.gizmoDrag = null;
    pane.append(this.canvas, this.gizmoCanvas, this.hud, this.cubeWidget);
    // WebGL2 when available: it can upload a sub-rectangle straight from the composite canvas.
    const glOpts = { antialias: true, alpha: false, preserveDrawingBuffer: true };
    this.gl = this.canvas.getContext('webgl2', glOpts) || this.canvas.getContext('webgl', glOpts);
    this.gl2 = typeof WebGL2RenderingContext !== 'undefined' && this.gl instanceof WebGL2RenderingContext;
    this.texStats = { full: 0, partial: 0, pixels: 0 }; // texture uploads, for tests and benchmarks
    this._texDamage = 'all'; // 'all' | {x,y,w,h} in texture (atlas) pixels | null
    if (this.gl) {
      try { this.#initGL(); } catch (err) { console.error(err); this.gl = null; }
    }

    this._frame = () => this.#draw();
    new ResizeObserver(() => this.#resize()).observe(pane);
    ed.on('doc', () => { this.#attach(); requestAnimationFrame(() => this.#resize()); });
    // The texture is the atlas's composite (or the document's). Its own change events carry the
    // changed rectangle, so only that part is re-uploaded (see #watchTexture). Edits of a source
    // document reach the atlas through reproject(), which reports 'model-texture'.
    ed.on('doc:render', () => this.#watchTexture());
    ed.on('model-texture', () => this.#damageTex(null));
    // When the 2D view runs on WebGPU the model is drawn with the same device, straight from the
    // compositor's resident texture (no uploads at all); otherwise WebGL as before.
    ed.on('renderer', () => this.#backend());
    ed.on('layout', () => requestAnimationFrame(() => this.#resize()));
    // Projector: redraw its gizmo when it or the mode changes; align it to the camera; arm placing.
    ed.on('opts', () => this.#request());
    ed.on('tool', () => this.#request());
    ed.on('projector:fromView', () => ed.setOpt('projRot', eulerFromView(this.yaw, this.pitch)));
    ed.on('projector:place', () => { this._placeArmed = true; ed.toast('Click the model to place the projector.'); });
    this.#bind();
    this.#attach();
    this.#backend();
  }

  /** Pick WebGPU (sharing the 2D compositor) or WebGL for drawing. Never throws. */
  #backend() {
    const comp = this.gl ? this.ed.gpuCompositor : null;
    if (comp && this.gpuMesh?.comp === comp) return;
    if (this.gpuMesh) {
      try { this.gpuMesh.destroy(); } catch { /* device gone */ }
      this.gpuMesh = null;
      this.gpuCanvas?.remove(); this.gpuCanvas = null;
      this.canvas.style.opacity = '';
      this.backend = 'webgl';
    }
    if (comp) {
      try {
        // Under the GL canvas, which stays on top (invisible) and keeps receiving the pointer.
        const c = h('canvas', { class: 'mesh-canvas mesh-gpu-canvas' });
        c.style.pointerEvents = 'none';
        c.width = this.canvas.width; c.height = this.canvas.height;
        this.canvas.before(c);
        this.gpuMesh = new GpuMeshRenderer(comp, c);
        this.gpuCanvas = c;
        if (this._geom) this.gpuMesh.setGeometry(this._geom.pos, this._geom.nrm, this._geom.uv, this._geom.count);
        this.canvas.style.opacity = '0';
        this.backend = 'webgpu';
      } catch (err) {
        console.warn('Stratum: 3D view stays on WebGL', err);
        this.gpuCanvas?.remove(); this.gpuCanvas = null; this.gpuMesh = null;
        this.backend = 'webgl';
      }
    } else this.backend = 'webgl';
    this.#damageTex(null);
  }

  #tool(mode) {
    this.mode = mode;
    for (const b of this.hud.querySelectorAll('.seg.tools .seg-btn')) b.classList.toggle('on', b.dataset.mode === mode);
    this.hint.textContent = mode === 'move'
      ? 'Drag the open image · Shift-drag moves the selected object'
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
      tex: gl.getUniformLocation(prog, 'uTex'),
      decal: gl.getUniformLocation(prog, 'uDecal'),
      decalM: gl.getUniformLocation(prog, 'uDecalM'),
      decalP: gl.getUniformLocation(prog, 'uDecalP'),
    };
    this.buf = { pos: gl.createBuffer(), nrm: gl.createBuffer(), uv: gl.createBuffer() };
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.decalTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.decalTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(prog);
    gl.uniform1i(this.loc.tex, 0);
    gl.uniform1i(this.loc.decal, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.07, 0.08, 0.1, 1);
  }

  #resetOffsets() {
    this.offsets = [];
    this.hidden = [];
    this.paintBvh = null;
    this.faceMap = null;
    this._paintKey = '';
    const mount = this.ed.doc?.mount;
    if (mount) this.#uploadGeom(mount);
    this.#syncHide();
    this.#request();
  }

  #toggleHide() {
    const mount = this.ed.doc?.mount;
    if (!mount?.groups?.length) return;
    const gi = Math.min(this.selectedGroup, mount.groups.length - 1);
    if (!this.hidden[gi]) this.hidden[gi] = true;
    else this.hidden[gi] = false;
    this.#uploadGeom(mount);
    this.#syncHide();
    this.#request();
  }

  /** Isolate: hide every object but the selected one, or, if that is already the case, show them all. */
  #toggleIsolate() {
    const mount = this.ed.doc?.mount;
    const n = mount?.groups?.length || 0;
    if (n < 2) return;
    const gi = Math.min(this.selectedGroup, n - 1);
    const solo = Array.from({ length: n }, (_, i) => i !== gi);
    const already = solo.every((h, i) => !!this.hidden[i] === h);
    this.hidden = already ? [] : solo;
    this.#uploadGeom(mount);
    this.#syncHide();
    this.#request();
  }

  #syncHide() {
    const mount = this.ed.doc?.mount;
    const btn = this.hud.querySelector('.obj-hide');
    if (!btn || !mount?.groups?.length) return;
    const gi = Math.min(this.selectedGroup, mount.groups.length - 1);
    const on = !!this.hidden[gi];
    btn.textContent = on ? 'Show' : 'Hide';
    btn.classList.toggle('on', on);
    const n = mount.groups.length;
    const solo = this.hud.querySelector('.obj-solo');
    if (solo) solo.classList.toggle('on', n > 1 && Array.from({ length: n }, (_, i) => i !== gi).every((h, i) => !!this.hidden[i] === h));
  }

  #syncObjects() {
    const mount = this.ed.doc?.mount;
    const seg = this.hud.querySelector('.seg.objects');
    if (!seg) return;
    const groups = mount?.groups || [];
    seg.hidden = groups.length < 2;
    if (groups.length < 2) return;
    const sel = seg.querySelector('.obj-select');
    const names = groups.map((g, i) => g.name || `object ${i + 1}`).join('\n');
    if (sel.dataset.names !== names) {
      sel.dataset.names = names;
      sel.innerHTML = '';
      groups.forEach((g, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = g.name || `object ${i + 1}`;
        sel.append(o);
      });
    }
    this.selectedGroup = Math.min(this.selectedGroup, groups.length - 1);
    sel.value = String(this.selectedGroup);
    this.#syncHide();
  }

  #groupAt(t, groups) {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (t >= g.start && t < g.start + g.count) return i;
    }
    return -1;
  }

  /** Solid-view positions with temporary offsets, and hidden groups left out of the raycast. */
  #refreshPaintMesh(mount) {
    if (this.shape === 'flat') { this.paintBvh = null; this.faceMap = null; return; }
    const groups = mount.groups || [];
    const off = this.offsets || [];
    const hid = this.hidden || [];
    let live = false;
    for (let i = 0; i < groups.length; i++) {
      const o = off[i];
      if (hid[i] || (o && (o[0] || o[1] || o[2]))) live = true;
    }
    if (!live) { this.paintBvh = null; this.faceMap = null; this._paintKey = ''; return; }
    const key = `${off.map((o) => o ? o.join(',') : '').join(';')}|${hid.map((h) => h ? 1 : 0).join('')}`;
    if (this._paintKey === key && this.paintBvh) return;
    this._paintKey = key;
    const n = mount.indices.length / 3;
    const map = [];
    const pos = [];
    const corners = [];
    for (let t = 0; t < n; t++) {
      const gi = this.#groupAt(t, groups);
      if (gi >= 0 && hid[gi]) continue;
      const o = gi >= 0 && off[gi] ? off[gi] : [0, 0, 0];
      map.push(t);
      for (let k = 0; k < 3; k++) {
        const v = mount.indices[t * 3 + k];
        corners.push(pos.length / 3);
        pos.push(mount.positions[v * 3] + o[0], mount.positions[v * 3 + 1] + o[1], mount.positions[v * 3 + 2] + o[2]);
      }
    }
    this.faceMap = map;
    this.paintBvh = map.length ? buildBVH(Float32Array.from(pos), Uint32Array.from(corners)) : null;
  }

  #attach() {
    const mount = this.ed.doc?.mount;
    if (!mount || !this.gl) { this.bvh = null; this.#syncObjects(); return; }
    const key = mount;
    if (key !== this._geomKey) {
      this._geomKey = key;
      this.flatBvh = null;
      this.cam = { solid: null, flat: null };
      this.offsets = [];
      this.hidden = [];
      this.selectedGroup = 0;
      this.paintBvh = null;
      this.faceMap = null;
      this._paintKey = '';
      this.bvh = buildBVH(mount.positions, mount.indices);
      this.#frame(mount);
      this.#uploadGeom(mount);
    } else if (this.shape === 'flat') this.#ensureFlat(mount);
    this.#syncObjects();
    this.#watchTexture();
    this.#damageTex(null);
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
    const groups = mount.groups || [];
    const off = this.offsets || [];
    const hid = this.hidden || [];
    let w = 0;
    for (let t = 0; t < n; t++) {
      const gi = flat ? -1 : this.#groupAt(t, groups);
      if (!flat && gi >= 0 && hid[gi]) continue;
      const o = !flat && gi >= 0 && off[gi] ? off[gi] : [0, 0, 0];
      const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
      const p = flat
        ? [0, 1, 2].map((k) => {
          const c = t * 3 + k;
          return [((uvs[c * 2] ?? 0) - 0.5) * 2, 0, ((uvs[c * 2 + 1] ?? 0) - 0.5) * 2];
        })
        : [ia, ib, ic].map((i) => [positions[i * 3] + o[0], positions[i * 3 + 1] + o[1], positions[i * 3 + 2] + o[2]]);
      const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
      const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      if (flat) { nx = 0; ny = 1; nz = 0; }
      for (let k = 0; k < 3; k++) {
        pos[(w * 3 + k) * 3] = p[k][0]; pos[(w * 3 + k) * 3 + 1] = p[k][1]; pos[(w * 3 + k) * 3 + 2] = p[k][2];
        nrm[(w * 3 + k) * 3] = nx; nrm[(w * 3 + k) * 3 + 1] = ny; nrm[(w * 3 + k) * 3 + 2] = nz;
        uv[(w * 3 + k) * 2] = uvs[(t * 3 + k) * 2];
        uv[(w * 3 + k) * 2 + 1] = uvs[(t * 3 + k) * 2 + 1];
      }
      w++;
    }
    const put = (buf, data) => { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); };
    put(this.buf.pos, pos); put(this.buf.nrm, nrm); put(this.buf.uv, uv);
    this.count = w * 3;
    this._geom = { pos, nrm, uv, count: this.count };
    this.gpuMesh?.setGeometry(pos, nrm, uv, this.count);
    this.#refreshPaintMesh(mount);
  }

  #resize() {
    const w = this.pane.clientWidth, h = this.pane.clientHeight;
    if (!w || !h || !this.gl) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    if (this.gpuCanvas) { this.gpuCanvas.width = this.canvas.width; this.gpuCanvas.height = this.canvas.height; }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.#request();
  }

  /** Follow change events of the document whose composite is the texture. */
  #watchTexture() {
    const src = atlasOf(this.ed.doc) || this.ed.doc || null;
    if (src === this._texDoc) return;
    this._texOff?.forEach((off) => off?.());
    this._texDoc = src;
    this._texDamage = 'all';
    if (!src) { this._texOff = null; return; }
    this._texOff = [
      src.on('render', (r) => this.#damageTex(r)),
      // A floating move: refresh at most ~10 times a second, over old ∪ new float bounds.
      src.on('float', (r) => {
        this._floatDamage = !r || this._floatDamage === 'all' ? 'all' : rectUnion(this._floatDamage, r);
        if (this._floatTimer) return;
        this._floatTimer = setTimeout(() => {
          const d = this._floatDamage;
          this._floatTimer = null; this._floatDamage = null;
          this.#damageTex(d === 'all' ? null : d);
        }, 100);
      }),
    ];
    this.#request();
  }

  /** Part of the texture changed (none = all of it); uploaded on the next frame. */
  #damageTex(r) {
    if (!r) this._texDamage = 'all';
    else if (this._texDamage !== 'all') this._texDamage = rectUnion(this._texDamage, r);
    this._texDirty = true;
    this.#request();
  }

  /** Bring the GL texture up to date with the composite: whole on size change, else the dirty rect. */
  #uploadTexture(src) {
    const gl = this.gl, W = src.width, H = src.height;
    let r = this._texDamage;
    this._texDamage = null;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (r === 'all' || !r || this._texW !== W || this._texH !== H) {
      // Straight from the composite canvas: the browser copies it GPU-side (no getImageData).
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      this._texW = W; this._texH = H;
      this.texStats.full++; this.texStats.pixels += W * H;
      return;
    }
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(W, Math.ceil(r.x + r.w)), y1 = Math.min(H, Math.ceil(r.y + r.h));
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0, h = y1 - y0;
    if (this.gl2) {
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    } else {
      // WebGL1 cannot take a part of a canvas: copy the part into a small canvas (GPU-side).
      const st = this._stage || (this._stage = document.createElement('canvas'));
      if (st.width < w || st.height < h) { st.width = Math.max(st.width, w); st.height = Math.max(st.height, h); }
      const c = st.getContext('2d');
      c.globalCompositeOperation = 'copy';
      c.drawImage(src, x0, y0, w, h, 0, 0, w, h);
      if (st.width === w && st.height === h) gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, gl.RGBA, gl.UNSIGNED_BYTE, st);
      else {
        const t = this._stageExact?.width === w && this._stageExact.height === h ? this._stageExact : (this._stageExact = Object.assign(document.createElement('canvas'), { width: w, height: h }));
        const tc = t.getContext('2d'); tc.globalCompositeOperation = 'copy'; tc.drawImage(st, 0, 0, w, h, 0, 0, w, h);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, gl.RGBA, gl.UNSIGNED_BYTE, t);
      }
    }
    this.texStats.partial++; this.texStats.pixels += w * h;
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
    const eye0 = this.#eye();
    if (this.gpuMesh) {
      // The compositor keeps the texture current from layer dirty rects; just draw.
      this._texDirty = false; this._texDamage = null;
      this.#watchTexture();
      const mvp = this.#mvp(eye0);
      this.gpuMesh.setDecal(this.decal);
      try { this.gpuMesh.render(atlasOf(doc) || doc, mvp, this._gpuTarget || null); } catch (err) { console.warn(err); this.ed.gpuCompositor = null; this.#backend(); }
      this.#drawGizmo();
      return;
    }
    if (this._texDirty) {
      this._texDirty = false;
      this.#watchTexture();
      this.#uploadTexture((atlasOf(doc) || doc).composite());
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    const mvp = this.#mvp();
    gl.uniformMatrix4fv(this.loc.mvp, false, mvp);
    const dc = this.decal;
    if (dc && this._decalCanvasGen !== dc.gen) {
      this._decalCanvasGen = dc.gen;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.decalTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, dc.canvas);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
    }
    gl.uniformMatrix4fv(this.loc.decalM, false, dc ? dc.m : new Float32Array(16));
    gl.uniform4f(this.loc.decalP, dc ? 1 : 0, dc ? dc.alpha : 0, 1, 1);
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
    this.#drawGizmo();
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

  /** The camera's view-projection (GL convention), as drawn. */
  #mvp(eye = this.#eye()) {
    return mul(perspective(0.7, this.canvas.width / this.canvas.height, 0.01, this.dist * 20 + 10), lookAt(eye, this.target, [0, 1, 0]));
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
    const bvh = this.shape === 'flat' ? this.flatBvh : (this.paintBvh || this.bvh);
    if (!bvh) return null;
    const { origin, dir } = this.#ray(e);
    const hit = raycastMesh(bvh, origin, dir);
    if (!hit) return null;
    const mount = this.ed.doc.mount;
    const face = this.shape !== 'flat' && this.faceMap ? this.faceMap[hit.tri] : hit.tri;
    const i = face * 3;
    const b0 = 1 - hit.u - hit.v, b1 = hit.u, b2 = hit.v;
    return {
      u: b0 * mount.uvs[i * 2] + b1 * mount.uvs[(i + 1) * 2] + b2 * mount.uvs[(i + 2) * 2],
      v: b0 * mount.uvs[i * 2 + 1] + b1 * mount.uvs[(i + 1) * 2 + 1] + b2 * mount.uvs[(i + 2) * 2 + 1],
      p3: [origin[0] + dir[0] * hit.t, origin[1] + dir[1] * hit.t, origin[2] + dir[2] * hit.t],
      face,
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
    const step = seamStep(this.stroke, hit, this.#gap(), this.shape === 'flat' || this.ed.opts.wrapShapes === false ? null : this.ed.doc?.mount);
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
    // Wrap seams on: one piece per lip the drag crossed, so the shape continues over the weld.
    // Wrap seams off: a single piece clipped to the chart the drag started on (per-chart only).
    const perChart = shape && this.shape !== 'flat' && this.ed.opts.wrapShapes === false;
    if (shape && (this.stroke?.wrapped || perChart) && this.stroke?.visits?.length) {
      const W = atlas.width, H = atlas.height;
      const visits = perChart ? this.stroke.visits.slice(0, 1) : this.stroke.visits;
      p.wrap = {
        pieces: visits.map((v) => ({
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

  // ------------------------------------------------------------------ Projection shape mode
  // The projector is an object (ed.opts.projLoc / projRot, see core/projection.js): click the
  // model to place it (Ctrl+click or Place to move it again), drag its arrows / rings to move /
  // turn it (Shift snaps 0.1 / 15°). A drag elsewhere draws the shape on the projector's plane
  // (through its location, facing its local −Z), previewed as a decal; on release it is fired
  // along the projector from one or several origins and every surface hit first gets paint
  // (core/projection.js; WebGPU when the 2D view runs on it). One history step.

  #projectionActive() {
    const ed = this.ed;
    return ed.tool?.group === 'shape' && ed.opts.shape3d === 'projection' && this.shape !== 'flat' && !!ed.doc?.mount?.uvs;
  }

  #projectionWanted() {
    if (!this.#projectionActive()) return false;
    if (!this.ed.tool.projectionImage) {
      if (!this._projToastShown) { this._projToastShown = true; this.ed.toast('Line / Curve paints on the surface; Projection works with the box shapes.'); }
      return false;
    }
    return true;
  }

  /** CSS-pixel point of a pointer event on the canvas. */
  #cssPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** World → CSS pixels on the canvas (null behind the camera). */
  #toScreen() {
    const m = this.#mvp(), r = this.canvas.getBoundingClientRect(), W = r.width || 1, H = r.height || 1;
    return (p) => {
      const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      if (w <= 1e-6) return null;
      return [((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w * 0.5 + 0.5) * W, (0.5 - (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w * 0.5) * H];
    };
  }

  /** World units per CSS pixel at world point p. */
  #pxWorld(p) {
    const eye = this.#eye(), f = norm(sub(this.target, eye));
    const d = Math.max(1e-4, Math.abs(f[0] * (p[0] - eye[0]) + f[1] * (p[1] - eye[1]) + f[2] * (p[2] - eye[2])));
    return (d * 2 * Math.tan(0.35)) / (this.canvas.getBoundingClientRect().height || 1);
  }

  #modelDiag() {
    const pos = this._geom?.pos;
    if (!pos || !this._geom.count) return 2;
    const b = bounds(pos.subarray(0, this._geom.count * 3));
    return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1;
  }

  /** Put the projector on the surface under the cursor, lifted by projOffset along the normal. */
  #placeProjector(hit, rayDir) {
    const m = this.ed.doc.mount, ix = m.indices, P = m.positions, t = hit.face;
    const v = (k) => [P[ix[t * 3 + k] * 3], P[ix[t * 3 + k] * 3 + 1], P[ix[t * 3 + k] * 3 + 2]];
    let n = norm(cross(sub(v(1), v(0)), sub(v(2), v(0))));
    if (n[0] * rayDir[0] + n[1] * rayDir[1] + n[2] * rayDir[2] > 0) n = scale(n, -1); // towards the viewer
    const off = +this.ed.opts.projOffset || 0;
    this.ed.setOpt('projLoc', add(hit.p3, scale(n, off)).map((x) => Math.round(x * 1e4) / 1e4));
    this.ed.toast('Projector placed. Drag to draw the shape; drag its arrows and rings to move and turn it.');
  }

  /** The projector gizmo's screen geometry (CSS px), or null: for tests and tools. */
  get gizmo() { return this.#projectionActive() ? this.#gizmo() : null; }

  #gizmo() {
    const o = this.ed.opts;
    if (!o.projLoc) return null;
    return gizmoHandles(o.projLoc, o.projRot, this.#toScreen(), this.#pxWorld(o.projLoc));
  }

  /** Projection for this drag (the projector as set now) and the map from pointer to its plane. */
  #projector() {
    const o = this.ed.opts, c = this.canvas;
    const loc = o.projLoc, ax = projectorAxes(o.projRot);
    const diag = this.#modelDiag();
    // One image pixel ≈ one device pixel at the projector, so Size means what it does on screen.
    const scl = this.#pxWorld(loc) * (c.getBoundingClientRect().width || 1) / (c.width || 1);
    const aim = aimProjection({
      n: ax.forward, U: ax.right, V: scale(ax.up, -1), anchor: loc, scale: scl,
      source: o.projSource === 'point' ? 'point' : 'parallel', base: scale(ax.forward, -diag * (+o.projDist || 150) / 100),
      points: +o.projPoints || 1, spread: +o.projSpread || 0,
      positions: this._geom?.pos?.subarray(0, this._geom.count * 3),
    });
    const toImg = (ev) => {
      const { origin: ro, dir: d } = this.#ray(ev);
      const den = d[0] * ax.forward[0] + d[1] * ax.forward[1] + d[2] * ax.forward[2];
      if (Math.abs(den) < 0.02) return null; // looking along the projector's plane
      const t = ((loc[0] - ro[0]) * ax.forward[0] + (loc[1] - ro[1]) * ax.forward[1] + (loc[2] - ro[2]) * ax.forward[2]) / den;
      if (t <= 0) return null;
      return planeCoords(aim.plane, add(ro, scale(d, t)));
    };
    return { aim, toImg };
  }

  #projStart(e) {
    const ed = this.ed;
    const { aim, toImg } = this.#projector();
    const a = toImg(e);
    if (!a || !aim.main) { ed.toast('Turn the view so you see the projector\u2019s plane (or turn the projector).'); return; }
    this.proj = { aim, P: aim.main, toImg, a, b: a, shift: e.shiftKey, swap: e.button === 2, tool: ed.tool, img: null };
  }

  #projMove(e) {
    const s = this.proj;
    const b = s.toImg(e);
    if (b) s.b = b;
    s.shift = e.shiftKey;
    s.img = s.tool.projectionImage(this.ed, s.a, s.b, { shift: s.shift, swap: s.swap, RW: s.P.RW, RH: s.P.RH });
    this.decal = s.img ? { m: decalMatrix(s.P, s.img), alpha: s.img.opacity, canvas: s.img.canvas, gen: ++this._decalGen, w: s.img.w, h: s.img.h } : null;
    this.#request();
  }

  /** The projector, its gizmo and (while drawing) the shape's frame, on the 2D overlay. */
  #drawGizmo() {
    const g = this.gizmoCanvas;
    if (!g) return;
    const r = this.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (g.width !== W || g.height !== H) { g.width = W; g.height = H; }
    const ctx = g.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const o = this.ed.opts;
    if (!this.#projectionActive() || !o.projLoc) { this.gizmoStats.hidden++; return; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ts = this.#toScreen(), loc = o.projLoc, pw = this.#pxWorld(loc), ax = projectorAxes(o.projRot);
    const h = gizmoHandles(loc, o.projRot, ts, pw);
    if (!h) return;
    const hot = this.gizmoDrag || this._gizmoHover;
    const line = (pts, col, w = 2, dash = null) => {
      if (pts.length < 2) return;
      ctx.beginPath(); ctx.moveTo(...pts[0]); for (const p of pts.slice(1)) ctx.lineTo(...p);
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]);
    };
    // the projector's frame: its image square (or the shape being drawn) on its plane, and where it fires
    const half = 40 * pw, U = ax.right, V = ax.up;
    const sq = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, b]) => ts(add(loc, add(scale(U, a * half), scale(V, b * half))))).filter(Boolean);
    line(sq, 'rgba(255,214,90,.9)', 1.5);
    const tip = ts(add(loc, scale(ax.forward, 110 * pw)));
    if (tip) { line([h.centre, tip], '#ffd65a', 2.5); ctx.beginPath(); ctx.arc(...tip, 4, 0, Math.PI * 2); ctx.fillStyle = '#ffd65a'; ctx.fill(); }
    const aimN = this.#gizmoOrigins(loc, ax);
    for (const q of aimN) {
      if (q.kind === 'point') {
        const e = ts(q.E);
        if (e) { for (const c of sq.slice(0, 4)) line([e, c], 'rgba(255,214,90,.45)', 1, [3, 3]); ctx.beginPath(); ctx.arc(...e, 3.5, 0, Math.PI * 2); ctx.fillStyle = '#ffd65a'; ctx.fill(); }
      } else if (aimN.length > 1) {
        const a = ts(add(loc, scale(q.d, -70 * pw))), b = ts(add(loc, scale(q.d, 40 * pw)));
        if (a && b) line([a, b], 'rgba(255,214,90,.55)', 1, [4, 3]);
      }
    }
    for (const ring of h.rings) line(ring.pts, AXIS_COLORS[ring.k], hot?.type === 'rotate' && hot.k === ring.k ? 3.5 : 1.6);
    for (const ar of h.arrows) {
      const wide = hot?.type === 'move' && hot.k === ar.k;
      line([ar.a, ar.b], AXIS_COLORS[ar.k], wide ? 4 : 2.5);
      const dx = ar.b[0] - ar.a[0], dy = ar.b[1] - ar.a[1], l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
      ctx.beginPath(); ctx.moveTo(...ar.b); ctx.lineTo(ar.b[0] - ux * 10 - uy * 5, ar.b[1] - uy * 10 + ux * 5); ctx.lineTo(ar.b[0] - ux * 10 + uy * 5, ar.b[1] - uy * 10 - ux * 5);
      ctx.closePath(); ctx.fillStyle = AXIS_COLORS[ar.k]; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(...h.centre, 4, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    this.gizmoStats.drawn++;
  }

  /** Origins as the gizmo shows them (cheap: no footprint sizing). */
  #gizmoOrigins(loc, ax) {
    const o = this.ed.opts, diag = this.#modelDiag();
    const aim = aimProjection({
      n: ax.forward, U: ax.right, V: scale(ax.up, -1), anchor: loc, scale: 1, view: { O: loc, RW: 1, RH: 1 },
      source: o.projSource === 'point' ? 'point' : 'parallel', base: scale(ax.forward, -diag * (+o.projDist || 150) / 100),
      points: +o.projPoints || 1, spread: +o.projSpread || 0,
    });
    return aim.origins;
  }

  async #projEnd(cancel) {
    const s = this.proj;
    this.proj = null;
    const ed = this.ed;
    const done = () => { this.decal = null; this.#request(); };
    if (cancel || !s.img) { done(); return; }
    const img = s.img;
    const doc = ed.doc, mount = doc.mount;
    const atlas = atlasOf(doc);
    const target = atlas || doc;
    const layer = atlas ? modelPaintLayer(atlas) : ed.editableLayer();
    if (!layer?.img) { done(); return; }
    const data = img.canvas.getContext('2d').getImageData(0, 0, img.w, img.h).data;
    const opts = {
      mount, projector: s.aim.projectors, shape: { x: img.x, y: img.y, w: img.w, h: img.h, data }, atlasW: layer.img.width, atlasH: layer.img.height,
      opacity: img.opacity, aa: img.aa, hidden: this.hidden.slice(), offsets: this.offsets.map((o) => o && o.slice()),
      maxAngle: +ed.opts.projAngle || 80,
    };
    let paint = null;
    const t0 = performance.now();
    const device = ed.gpuCompositor?.device;
    if (device) {
      try { paint = await gpuProjectPaint(device, opts); this.lastProjection = { backend: 'webgpu' }; } catch (err) { console.warn('Stratum: projection on the CPU', err); paint = undefined; }
    }
    if (!device || paint === undefined) { paint = projectPaint(opts); this.lastProjection = { backend: 'cpu' }; }
    this.lastProjection.ms = performance.now() - t0;
    if (ed.doc !== doc) { done(); return; } // switched documents meanwhile
    const r = commitProjection(target, layer, paint, `${s.tool.name} (projected)`, target.selection || null);
    this.lastProjection.rect = r;
    if (!r) ed.toast('The shape missed every visible surface.');
    done();
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
      if (this.mode === 'move' && e.button === 0 && e.shiftKey && ed.doc.mount.groups?.length) {
        const n = ed.doc.mount.groups.length;
        this.objectDrag = { x: e.clientX, y: e.clientY, gi: Math.min(this.selectedGroup, n - 1) };
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
      if (this.#projectionWanted()) {
        const o = ed.opts, sp = this.#cssPoint(e);
        if (!o.projLoc || this._placeArmed || e.ctrlKey || e.metaKey) {
          const hit = this.#hit(e);
          if (!hit) { ed.toast('Click the model to place the projector.'); return; }
          this._placeArmed = false;
          this.#placeProjector(hit, this.#ray(e).dir);
          return;
        }
        const g = hitGizmo(this.#gizmo(), sp);
        if (g) {
          const ts = this.#toScreen();
          this.gizmoDrag = { ...g, s0: sp, loc0: o.projLoc.slice(), rot0: o.projRot.slice(), centre: ts(o.projLoc) };
          return;
        }
        this.#projStart(e);
        return;
      }
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
      if (this.objectDrag) {
        const dx = e.clientX - this.objectDrag.x, dy = e.clientY - this.objectDrag.y;
        this.objectDrag.x = e.clientX; this.objectDrag.y = e.clientY;
        const gi = this.objectDrag.gi;
        const eye = this.#eye();
        const forward = norm(sub(this.target, eye));
        const right = norm(cross(forward, [0, 1, 0]));
        const up = cross(right, forward);
        const s = this.dist * 0.0025;
        if (!this.offsets[gi]) this.offsets[gi] = [0, 0, 0];
        const o = this.offsets[gi];
        o[0] += (right[0] * dx + up[0] * -dy) * s;
        o[1] += (right[1] * dx + up[1] * -dy) * s;
        o[2] += (right[2] * dx + up[2] * -dy) * s;
        this.#uploadGeom(ed.doc.mount);
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
      if (this.gizmoDrag) {
        const gd = this.gizmoDrag, sp = this.#cssPoint(e);
        if (gd.type === 'move') ed.setOpt('projLoc', dragMove(gd.loc0, gd.k, gd.s0, sp, this.#toScreen(), e.shiftKey));
        else ed.setOpt('projRot', dragRotate(gd.rot0, gd.k, gd.centre, gd.s0, sp, norm(sub(this.target, this.#eye())), e.shiftKey));
        return;
      }
      if (this.proj) { this.#projMove(e); return; }
      if (!this.painting && !this.dragging && this.#projectionActive()) {
        const g = hitGizmo(this.#gizmo(), this.#cssPoint(e));
        const key = g ? g.type + g.k : '';
        if (key !== (this._gizmoHoverKey || '')) { this._gizmoHoverKey = key; this._gizmoHover = g; c.style.cursor = g ? (g.type === 'move' ? 'move' : 'grab') : ''; this.#request(); }
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
    const end = (e) => {
      if (this.gizmoDrag) { this.gizmoDrag = null; this.#request(); return; }
      if (this.proj) { this.#projEnd(e?.type === 'pointercancel'); return; }
      this.dragging = null;
      this.objectDrag = null;
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
