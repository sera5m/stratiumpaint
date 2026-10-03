// The mounted mesh. Left pane stays the texture; this pane shows it on the model.
// Left-drag paints the active layer (a brush dab lands on the UV under the cursor).
// Alt-drag or Orbit mode tumbles the view. Scroll zooms. Middle-drag pans.
import { buildBVH, raycastMesh } from '../core/mesh.js';
import { placeToPixel } from './session.js';
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
    this.yaw = 0.6;
    this.pitch = 0.4;
    this.dist = 1;
    this.target = [0, 0, 0];
    this.dragging = null;
    this.painting = false;
    this._texDirty = true;
    this._geomKey = null;

    this.canvas = h('canvas', { class: 'mesh-canvas' });
    this.hud = h('div', { class: 'mesh-hud' },
      h('div', { class: 'seg' },
        h('button', { type: 'button', class: 'seg-btn on', onClick: () => this.#mode('paint') }, 'Paint'),
        h('button', { type: 'button', class: 'seg-btn', onClick: () => this.#mode('orbit') }, 'Orbit')),
      h('span', null, 'Alt+drag orbits · scroll zooms · a stroke paints this tab'));
    pane.append(this.canvas, this.hud);
    this.gl = this.canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (this.gl) {
      try { this.#initGL(); } catch (err) { console.error(err); this.gl = null; }
    }

    this._frame = () => this.#draw();
    new ResizeObserver(() => this.#resize()).observe(pane);
    ed.on('doc', () => { this.#attach(); requestAnimationFrame(() => this.#resize()); });
    ed.on('doc:render', () => { this._texDirty = true; this.#request(); });
    ed.on('layout', () => requestAnimationFrame(() => this.#resize()));
    this.#bind();
    this.#attach();
  }

  #mode(mode) {
    this.mode = mode;
    for (const b of this.hud.querySelectorAll('.seg-btn')) b.classList.toggle('on', b.textContent.toLowerCase() === mode);
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
      this.#uploadGeom(mount);
      this.bvh = buildBVH(mount.positions, mount.indices);
      const box = bounds(mount.positions);
      this.target = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
      const r = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) || 1;
      this.dist = r * 1.4;
      this.yaw = 0.7;
      this.pitch = 0.35;
    }
    this._texDirty = true;
    this.#resize();
  }

  #uploadGeom(mount) {
    const gl = this.gl;
    const { positions, indices, uvs } = mount;
    const n = indices.length / 3;
    const pos = new Float32Array(n * 9);
    const nrm = new Float32Array(n * 9);
    const uv = new Float32Array(n * 6);
    for (let t = 0; t < n; t++) {
      const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
      const p = [ia, ib, ic].map((i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
      const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
      const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
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
    if (this._texDirty) {
      this._texDirty = false;
      const src = this.#stackedTexture(doc);
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

  /** Every image tab on this mesh, bottom to top, drawn into the atlas. */
  #stackedTexture(doc) {
    const members = doc.session?.members?.length ? doc.session.members : [doc];
    const mount = doc.mount;
    const w = mount.width || doc.width;
    const h = mount.height || doc.height;
    if (members.length === 1 && doc.width === w && doc.height === h && !(doc.place && (doc.place.u || doc.place.v || doc.place.w !== 1 || doc.place.h !== 1))) {
      return doc.composite();
    }
    if (!this._stack || this._stack.width !== w || this._stack.height !== h) {
      this._stack = document.createElement('canvas');
      this._stack.width = w;
      this._stack.height = h;
    }
    const ctx = this._stack.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    for (const member of members) {
      const p = member.place || { u: 0, v: 0, w: 1, h: 1 };
      ctx.drawImage(member.composite(), p.u * w, p.v * h, p.w * w, p.h * h);
    }
    return this._stack;
  }

  #hitDoc(e) {
    if (!this.bvh) return null;
    const { origin, dir } = this.#ray(e);
    const hit = raycastMesh(this.bvh, origin, dir);
    if (!hit) return null;
    const mount = this.ed.doc.mount;
    const doc = this.ed.doc;
    const i = hit.tri * 3;
    const b0 = 1 - hit.u - hit.v, b1 = hit.u, b2 = hit.v;
    const u = b0 * mount.uvs[i * 2] + b1 * mount.uvs[(i + 1) * 2] + b2 * mount.uvs[(i + 2) * 2];
    const v = b0 * mount.uvs[i * 2 + 1] + b1 * mount.uvs[(i + 1) * 2 + 1] + b2 * mount.uvs[(i + 2) * 2 + 1];
    return placeToPixel(doc, u, v);
  }

  #bind() {
    const c = this.canvas, ed = this.ed;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      if (!ed.doc?.mount) return;
      c.setPointerCapture(e.pointerId);
      const orbit = e.button === 1 || e.altKey || (e.button === 0 && this.mode === 'orbit');
      if (orbit && e.button !== 2) {
        this.dragging = { x: e.clientX, y: e.clientY, button: e.button, alt: e.altKey };
        return;
      }
      if (e.button !== 0 && e.button !== 2) return;
      const p = this.#hitDoc(e);
      if (!p) return;
      this.painting = true;
      this.paintButton = e.button;
      ed.hover = p;
      ed.pointer('down', { ...p, sx: 0, sy: 0, button: e.button === 2 ? 2 : 0, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: false });
    });
    c.addEventListener('pointermove', (e) => {
      if (this.dragging) {
        const dx = e.clientX - this.dragging.x, dy = e.clientY - this.dragging.y;
        this.dragging.x = e.clientX; this.dragging.y = e.clientY;
        if (this.dragging.button === 1) this.#pan(dx, dy);
        else { this.yaw += dx * 0.01; this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + dy * 0.01)); }
        this.#request();
        return;
      }
      if (!this.painting) return;
      const p = this.#hitDoc(e);
      if (!p) return;
      ed.hover = p;
      ed.pointer('move', { ...p, sx: 0, sy: 0, button: this.paintButton === 2 ? 2 : 0, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: false });
      ed.requestOverlay();
    });
    const end = () => {
      this.dragging = null;
      if (!this.painting) return;
      this.painting = false;
      const p = ed.hover || { x: 0, y: 0 };
      ed.pointer('up', { ...p, sx: 0, sy: 0, button: this.paintButton === 2 ? 2 : 0, shift: false, ctrl: false, alt: false });
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      if (!ed.doc?.mount) return;
      e.preventDefault();
      this.dist *= Math.pow(1.0015, e.deltaY * (e.deltaMode === 1 ? 16 : 1));
      this.dist = Math.max(this.dist, 0.02);
      this.#request();
    }, { passive: false });
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
