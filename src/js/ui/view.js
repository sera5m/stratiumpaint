// The canvas viewport: draws the document, the selection outline and tool overlays, and turns
// mouse/touch/pen input into tool events in document coordinates.
import { maskOutline } from '../core/mask.js';
import { clamp } from '../core/util.js';
import { h, raf } from './dom.js';

const MIN_ZOOM = 0.02, MAX_ZOOM = 64;
const outlines = new WeakMap(); // mask → marching-ants segments (computed once per mask)
const outlineFor = (mask) => {
  let o = outlines.get(mask);
  if (!o) { o = maskOutline(mask); outlines.set(mask, o); }
  return o;
};

export class View {
  constructor(ed, stage) {
    this.ed = ed;
    this.stage = stage;
    this.zoom = 1;
    this.ox = 0;
    this.oy = 0;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.spaceDown = false;
    this.pressed = null; // mouse button currently driving a tool
    this.panning = null;
    this.antPhase = 0;

    this.canvas = h('canvas', { class: 'view-canvas' });
    this.overlay = h('canvas', { class: 'overlay-canvas' });
    stage.append(this.canvas, this.overlay);
    this.ctx = this.canvas.getContext('2d');
    this.octx = this.overlay.getContext('2d');
    this.checker = null;

    this._draw = raf(() => this.#paint());
    this._needBase = true;
    this._needOverlay = true;

    new ResizeObserver(() => this.resize()).observe(stage);
    this.#bindPointer();
    this.#bindWheel();

    ed.on('doc', (doc) => this.attach(doc));
    ed.on('doc:render', () => this.requestRender());
    ed.on('doc:size', () => { const s = ed.doc?.viewState; if (s) s.fitted = true; this.fit(); });
    ed.on('doc:selection', () => this.requestOverlay());
    ed.on('overlay', () => this.requestOverlay());
    ed.on('tool', () => this.#updateCursor());
    ed.on('opts', () => this.requestOverlay());

    setInterval(() => { // animate the marching ants (skipped for huge outlines)
      const sel = ed.doc?.selection;
      if (!sel || outlineFor(sel).length > 4 * 20000) return;
      this.antPhase = (this.antPhase + 1) % 8;
      this.requestOverlay();
    }, 130);
  }

  // ------------------------------------------------------------------ geometry

  toScreen(x, y) { return { x: this.ox + x * this.zoom, y: this.oy + y * this.zoom }; }
  toDoc(sx, sy) { return { x: (sx - this.ox) / this.zoom, y: (sy - this.oy) / this.zoom }; }

  /** The part of the document currently on screen, in document pixels. */
  visibleRect() {
    const doc = this.ed.doc;
    if (!doc) return null;
    const a = this.toDoc(0, 0), b = this.toDoc(this.width, this.height);
    const x0 = clamp(Math.floor(a.x), 0, doc.width), y0 = clamp(Math.floor(a.y), 0, doc.height);
    return { x: x0, y: y0, w: clamp(Math.ceil(b.x), 0, doc.width) - x0, h: clamp(Math.ceil(b.y), 0, doc.height) - y0 };
  }

  resize() {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (!w || !h) return;
    this.dpr = window.devicePixelRatio || 1;
    this.width = w;
    this.height = h;
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
    }
    const s = this.ed.doc?.viewState;
    if (!s || s.fitted) this.fit(); else { this.#constrain(); this.requestRender(); }
  }

  attach(doc) {
    if (!doc) { this.requestRender(); this.ed.emit('view'); return; }
    if (!doc.viewState) doc.viewState = { fitted: true };
    const s = doc.viewState;
    if (s.fitted || s.zoom === undefined) this.fit();
    else { this.zoom = s.zoom; this.ox = s.ox; this.oy = s.oy; this.#constrain(); this.requestRender(); this.ed.emit('view'); }
    this.#updateCursor();
  }

  #save(fitted = false) {
    const doc = this.ed.doc;
    if (doc) doc.viewState = { zoom: this.zoom, ox: this.ox, oy: this.oy, fitted };
  }

  /** Keep the image reachable: centre it when it is smaller than the window, otherwise limit overscroll. */
  #constrain() {
    const doc = this.ed.doc;
    if (!doc || !this.width) return;
    const fit = (size, view, o) => {
      if (size <= view - 40) return Math.round((view - size) / 2);
      return Math.round(clamp(o, view - size - 120, 120));
    };
    this.ox = fit(doc.width * this.zoom, this.width, this.ox);
    this.oy = fit(doc.height * this.zoom, this.height, this.oy);
  }

  fit(allowUpscale = false) {
    const doc = this.ed.doc;
    if (!doc || !this.width) return;
    const z = Math.min((this.width - 48) / doc.width, (this.height - 48) / doc.height, allowUpscale ? MAX_ZOOM : 1);
    this.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
    this.ox = 0; this.oy = 0;
    this.#constrain();
    this.#save(true);
    this.requestRender();
    this.ed.emit('view');
  }

  setZoom(z, ax = this.width / 2, ay = this.height / 2) {
    const doc = this.ed.doc;
    if (!doc) return;
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const p = this.toDoc(ax, ay);
    this.zoom = z;
    this.ox = ax - p.x * z;
    this.oy = ay - p.y * z;
    this.#constrain();
    this.#save();
    this.requestRender();
    this.ed.emit('view');
  }

  zoomAt(factor, ax, ay) { this.setZoom(this.zoom * factor, ax, ay); }

  zoomToRect(x0, y0, x1, y1) {
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    if (w < 1 || h < 1) return;
    const z = clamp(Math.min(this.width / w, this.height / h), MIN_ZOOM, MAX_ZOOM);
    this.zoom = z;
    this.ox = this.width / 2 - ((x0 + x1) / 2) * z;
    this.oy = this.height / 2 - ((y0 + y1) / 2) * z;
    this.#constrain();
    this.#save();
    this.requestRender();
    this.ed.emit('view');
  }

  panBy(dx, dy) {
    this.ox += dx;
    this.oy += dy;
    this.#constrain();
    this.#save();
    this.requestRender();
    this.ed.emit('view');
  }

  // ------------------------------------------------------------------ drawing

  requestRender() { this._needBase = true; this._needOverlay = true; this._draw(); }
  requestOverlay() { this._needOverlay = true; this._draw(); }

  #paint() {
    if (this._needBase) { this._needBase = false; this.#paintBase(); }
    if (this._needOverlay) { this._needOverlay = false; this.#paintOverlay(); }
  }

  #checkerPattern() {
    if (this.checker) return this.checker;
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#cfcfd4'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
    this.checker = this.ctx.createPattern(c, 'repeat');
    return this.checker;
  }

  #paintBase() {
    const { ctx, dpr } = this, doc = this.ed.doc;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!doc) return;
    const z = this.zoom, w = doc.width * z, hh = doc.height * z;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.ox, this.oy, w, hh);
    ctx.clip();
    ctx.translate(this.ox, this.oy);
    ctx.fillStyle = this.#checkerPattern();
    ctx.fillRect(0, 0, w, hh);
    ctx.restore();
    ctx.imageSmoothingEnabled = z < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(doc.composite(), this.ox, this.oy, w, hh);
  }

  #paintOverlay() {
    const c = this.octx, { dpr } = this, ed = this.ed, doc = ed.doc;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.width, this.height);
    if (!doc) return;
    const z = this.zoom;

    c.strokeStyle = 'rgba(0,0,0,.55)';
    c.lineWidth = 1;
    c.strokeRect(this.ox - 0.5, this.oy - 0.5, doc.width * z + 1, doc.height * z + 1);

    if (ed.opts.grid && z >= 8) this.#paintGrid(c, doc);
    if (doc.selection) this.#paintAnts(c, doc.selection);
    ed.tool.overlay?.(c, ed, this);

    if (ed.tool.ring && ed.hover && !this.panning && !this.spaceDown) { // brush size ring
      const p = this.toScreen(ed.hover.x, ed.hover.y), r = Math.max(1, (ed.opts.size / 2) * z);
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(0,0,0,.8)';
      c.beginPath(); c.arc(p.x, p.y, r + 0.5, 0, Math.PI * 2); c.stroke();
      c.strokeStyle = 'rgba(255,255,255,.9)';
      c.beginPath(); c.arc(p.x, p.y, Math.max(0.5, r - 0.5), 0, Math.PI * 2); c.stroke();
    }
  }

  #paintGrid(c, doc) {
    const z = this.zoom;
    const a = this.toDoc(0, 0), b = this.toDoc(this.width, this.height);
    const x0 = Math.max(0, Math.floor(a.x)), x1 = Math.min(doc.width, Math.ceil(b.x));
    const y0 = Math.max(0, Math.floor(a.y)), y1 = Math.min(doc.height, Math.ceil(b.y));
    c.beginPath();
    for (let x = x0; x <= x1; x++) { const sx = Math.round(this.ox + x * z) + 0.5; c.moveTo(sx, this.oy + y0 * z); c.lineTo(sx, this.oy + y1 * z); }
    for (let y = y0; y <= y1; y++) { const sy = Math.round(this.oy + y * z) + 0.5; c.moveTo(this.ox + x0 * z, sy); c.lineTo(this.ox + x1 * z, sy); }
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(128,128,128,.35)';
    c.stroke();
  }

  #paintAnts(c, mask) {
    const segs = outlineFor(mask), z = this.zoom, off = this.ed.marchOffset ?? { dx: 0, dy: 0 };
    if (!segs.length) return;
    c.beginPath();
    for (let i = 0; i < segs.length; i += 4) {
      c.moveTo(this.ox + (segs[i] + off.dx) * z + 0.5, this.oy + (segs[i + 1] + off.dy) * z + 0.5);
      c.lineTo(this.ox + (segs[i + 2] + off.dx) * z + 0.5, this.oy + (segs[i + 3] + off.dy) * z + 0.5);
    }
    c.lineWidth = 1;
    c.setLineDash([]);
    c.strokeStyle = '#fff';
    c.stroke();
    c.setLineDash([4, 4]);
    c.lineDashOffset = -this.antPhase;
    c.strokeStyle = '#000';
    c.stroke();
    c.setLineDash([]);
  }

  // ------------------------------------------------------------------ input

  #updateCursor() {
    this.overlay.style.cursor = this.panning ? 'grabbing' : this.spaceDown ? 'grab' : this.ed.tool.cursor ?? 'crosshair';
  }

  setSpace(down) {
    if (this.spaceDown === down) return;
    this.spaceDown = down;
    this.#updateCursor();
  }

  #toolEvent(e) {
    const r = this.stage.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top, p = this.toDoc(sx, sy);
    return { x: p.x, y: p.y, sx, sy, button: e.button === 2 || (e.buttons & 2) ? 2 : 0, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
  }

  #bindPointer() {
    const o = this.overlay, ed = this.ed;
    o.addEventListener('contextmenu', (e) => e.preventDefault());
    // Backstop for Linux/X11's "middle-click pastes the primary selection" convention: pointerdown
    // below already preventDefault()s this, but suppress it as early as possible too, since that
    // convention lives outside pointer-event semantics on some platforms.
    o.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }, true);
    o.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

    o.addEventListener('pointerdown', (e) => {
      if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
        e.preventDefault(); // always suppress default middle-click behaviour, doc or no doc
        if (!ed.doc) return;
        o.setPointerCapture(e.pointerId);
        this.panning = { x: e.clientX, y: e.clientY };
        this.#updateCursor();
        return;
      }
      if (!ed.doc) return;
      o.setPointerCapture(e.pointerId);
      if (e.button !== 0 && e.button !== 2) return;
      if (this.pressed !== null) return; // ignore a second button while a stroke is running
      this.pressed = e.button;
      ed.pointer('down', this.#toolEvent(e));
    });

    o.addEventListener('pointermove', (e) => {
      if (!ed.doc) return;
      if (this.panning) {
        this.panBy(e.clientX - this.panning.x, e.clientY - this.panning.y);
        this.panning = { x: e.clientX, y: e.clientY };
        return;
      }
      const events = this.pressed !== null ? (e.getCoalescedEvents?.() ?? []) : [];
      const list = events.length ? events : [e];
      for (const ce of list) {
        const t = this.#toolEvent(ce);
        if (this.pressed !== null) { t.button = this.pressed; ed.pointer('move', t); }
      }
      const t = this.#toolEvent(e);
      ed.hover = { x: t.x, y: t.y };
      ed.emit('cursor', t.x, t.y);
      if (ed.tool.ring) this.requestOverlay();
    });

    const end = (e) => {
      if (this.panning) { this.panning = null; this.#updateCursor(); return; }
      if (this.pressed === null) return;
      const t = this.#toolEvent(e);
      t.button = this.pressed;
      this.pressed = null;
      ed.pointer('up', t);
    };
    o.addEventListener('pointerup', end);
    o.addEventListener('pointercancel', end);

    o.addEventListener('pointerleave', () => {
      ed.hover = null;
      ed.emit('cursor', null, null);
      if (ed.tool.ring) this.requestOverlay();
    });
  }

  #bindWheel() {
    this.overlay.addEventListener('wheel', (e) => {
      if (!this.ed.doc) return;
      e.preventDefault();
      const r = this.stage.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        this.zoomAt(Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 16 : 1)), e.clientX - r.left, e.clientY - r.top);
      } else {
        const k = e.deltaMode === 1 ? 16 : 1;
        if (e.shiftKey) this.panBy(-(e.deltaY || e.deltaX) * k, 0);
        else this.panBy(-e.deltaX * k, -e.deltaY * k);
      }
    }, { passive: false });
  }
}
