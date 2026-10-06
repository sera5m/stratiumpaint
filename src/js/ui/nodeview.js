// Canvas node editor. Blender-style: search to add, drag sockets, box select, groups, frames,
// mute, reroute, a viewer backdrop, and a sidebar. Graph undo stays off the paint history.
import { clamp } from '../core/util.js';
import { ADDABLE, CATEGORIES, NODE_TYPES, categoryColor, socketsOf } from '../nodes/types.js';
import {
  addNode, beginEdit, copySelection, currentScope, cutLinks, deleteNodes, duplicateNodes,
  endEdit, ensureGraph, enterGroup, exitGroup, frameNodes, groupNodes, linkSockets, markGraph,
  moveNodes, nodeBox, nodeLabel, pasteClipboard, setCollapsed, setColor, setMuted, setParam,
  setParamLive, socketXY, undoGraph, redoGraph, ungroupNode,
} from '../nodes/graph.js';
import { applyToLayer, evaluateGraph, makeContext, previewSize, primaryOutput } from '../nodes/eval.js';
import { compileFormula, drawFormula } from '../nodes/formula.js';
import { extractCommands, ollamaEndpoint, repairPrompt, runCommands, taskPrompt, checkModelName } from '../nodes/agent.js';
import { ollamaGenerate } from './platform.js';
import { h } from './dom.js';

const TAGS = ['', '#6aa2ff', '#7dba5a', '#e2a24a', '#e06a6a', '#d46ad4', '#8a84e0'];

export class NodeView {
  constructor(ed, root) {
    this.ed = ed;
    this.root = root;
    this.panX = 40;
    this.panY = 30;
    this.zoom = 1;
    this.sideOpen = true;
    this.backdrop = true;
    this.values = new Map();
    this.errors = [];
    this.thumbs = new Map();
    this.drag = null;
    this.grab = null;
    this.space = false;
    this.search = null;
    this.pendingLink = null;
    this.sideSig = '';

    root.classList.add('nodes-root');
    this.main = h('div', { class: 'nodes-main' });
    this.bar = h('div', { class: 'nodes-bar' });
    this.modelRow = h('div', { class: 'nodes-model' });
    this.modelLog = h('pre', { class: 'nodes-model-log', hidden: true });
    this.wrap = h('div', { class: 'nodes-wrap' });
    this.canvas = h('canvas', { class: 'nodes-canvas' });
    this.side = h('aside', { class: 'nodes-side' });
    this.wrap.append(this.canvas);
    this.main.append(this.bar, this.modelRow, this.modelLog, this.wrap);
    root.append(this.main, this.side);

    this.ctx = this.canvas.getContext('2d');
    this.#bar();
    this.#model();
    this.#listen();
    ed.on('doc', () => this.schedule());
    ed.on('nodes', () => this.schedule());
    ed.on('surface', () => { if (ed.surfaceMode === 'nodes') this.show(); });
  }

  show() {
    this.#resize();
    this.schedule();
    this.canvas.focus?.();
  }

  graph() {
    return this.ed.doc ? ensureGraph(this.ed.doc) : null;
  }

  schedule() {
    clearTimeout(this._evalT);
    this._evalT = setTimeout(() => this.evaluate(), 30);
  }

  evaluate() {
    const doc = this.ed.doc;
    const g = this.graph();
    if (!doc || !g || this.ed.surfaceMode !== 'nodes') { this.draw(); return; }
    const size = previewSize(doc, 180);
    try {
      const { values, errors } = evaluateGraph(g, makeContext(doc, size.width, size.height));
      this.values = values;
      this.errors = errors;
      this.thumbs = new Map();
    } catch (err) {
      this.errors = [{ id: '', error: err.message }];
    }
    this.draw();
    this.#side();
  }

  #changed() {
    markGraph(this.ed.doc);
    this.ed.emit('nodes');
  }

  #listen() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.#down(e));
    c.addEventListener('pointermove', (e) => this.#move(e));
    window.addEventListener('pointerup', (e) => this.#up(e));
    c.addEventListener('wheel', (e) => this.#wheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); this.#menu(e); });
    c.addEventListener('dblclick', (e) => this.#dbl(e));
    const ro = new ResizeObserver(() => this.#resize());
    ro.observe(this.wrap);
  }

  #resize() {
    const r = this.wrap.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.cw = Math.max(1, r.width);
    this.ch = Math.max(1, r.height);
    this.canvas.width = Math.round(this.cw * dpr);
    this.canvas.height = Math.round(this.ch * dpr);
    this.draw();
  }

  world(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.worldAt(e.clientX - r.left, e.clientY - r.top);
  }

  worldAt(sx, sy) {
    return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom };
  }

  #down(e) {
    if (this.ed.surfaceMode !== 'nodes') return;
    this.canvas.setPointerCapture?.(e.pointerId);
    const g = this.graph();
    if (!g) return;
    const w = this.world(e);
    if (e.button === 1 || (e.button === 0 && this.space)) {
      this.drag = { kind: 'pan', x: e.clientX, y: e.clientY, panX: this.panX, panY: this.panY };
      return;
    }
    if (e.button !== 0) return;
    if (this.grab) { this.#endGrab(true); return; }
    if (e.altKey) {
      this.drag = { kind: 'cut', x0: w.x, y0: w.y, x1: w.x, y1: w.y };
      return;
    }
    const hit = this.#hit(w.x, w.y);
    if (hit?.sock) {
      this.drag = { kind: 'link', dir: hit.sock.dir, node: hit.node.id, sock: hit.sock.id, x: w.x, y: w.y };
      return;
    }
    if (hit?.resize) {
      beginEdit(g);
      this.drag = { kind: 'resize', id: hit.node.id, x: w.x, y: w.y, w: hit.node.params.w, h: hit.node.params.h };
      return;
    }
    if (hit?.node) {
      if (e.shiftKey && (e.ctrlKey || e.metaKey)) { this.#toViewer(hit.node); return; }
      if (e.shiftKey) {
        const i = g.selected.indexOf(hit.node.id);
        g.selected = i >= 0 ? g.selected.filter((id) => id !== hit.node.id) : [...g.selected, hit.node.id];
      } else if (!g.selected.includes(hit.node.id)) g.selected = [hit.node.id];
      beginEdit(g);
      this.drag = { kind: 'move', x: w.x, y: w.y, lx: w.x, ly: w.y, ids: [...g.selected] };
      this.#side();
      this.draw();
      return;
    }
    if (!e.shiftKey) g.selected = [];
    this.drag = { kind: 'box', x0: w.x, y0: w.y, x1: w.x, y1: w.y, shift: e.shiftKey, base: [...g.selected] };
    this.draw();
  }

  #move(e) {
    const w = this.world(e);
    const d = this.drag;
    if (this.grab && !d) {
      const dx = w.x - this.grab.x;
      const dy = w.y - this.grab.y;
      const g = this.graph();
      for (const [id, p] of this.grab.origin) {
        const n = currentScope(g).nodes.find((node) => node.id === id);
        if (n) { n.x = p.x + dx; n.y = p.y + dy; }
      }
      this.draw();
      return;
    }
    if (!d) {
      this.canvas.style.cursor = this.#cursor(w);
      return;
    }
    if (d.kind === 'pan') {
      this.panX = d.panX + (e.clientX - d.x);
      this.panY = d.panY + (e.clientY - d.y);
    } else if (d.kind === 'move') {
      const g = this.graph();
      moveNodes(g, d.ids, w.x - d.lx, w.y - d.ly, { snap: e.ctrlKey || e.metaKey });
      d.lx = w.x; d.ly = w.y;
    } else if (d.kind === 'resize') {
      const n = currentScope(this.graph()).nodes.find((node) => node.id === d.id);
      if (n) {
        n.params.w = Math.max(80, d.w + (w.x - d.x));
        n.params.h = Math.max(50, d.h + (w.y - d.y));
      }
    } else if (d.kind === 'box' || d.kind === 'cut' || d.kind === 'link') {
      d.x1 = w.x; d.y1 = w.y;
      if (d.kind === 'link') { d.x = w.x; d.y = w.y; }
      if (d.kind === 'box') this.#selectBox(d);
    }
    this.draw();
  }

  #up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const g = this.graph();
    if (!g) return;
    if (d.kind === 'move' || d.kind === 'resize') {
      if (endEdit(g)) this.#changed();
      else this.draw();
    } else if (d.kind === 'cut') {
      cutLinks(g, d.x0, d.y0, d.x1, d.y1);
      this.#changed();
    } else if (d.kind === 'link') {
      const hit = this.#hit(d.x, d.y);
      if (hit?.sock && hit.node.id !== d.node && hit.sock.dir !== d.dir) {
        const from = d.dir === 'out' ? d : { node: hit.node.id, sock: hit.sock.id };
        const to = d.dir === 'in' ? d : { node: hit.node.id, sock: hit.sock.id };
        try { linkSockets(g, from.node, from.sock, to.node, to.sock); this.#changed(); }
        catch (err) { this.ed.toast(err.message); this.draw(); }
      } else if (!hit?.node) {
        const rect = this.canvas.getBoundingClientRect();
        this.pendingLink = d.dir === 'out'
          ? { from: d.node, out: d.sock }
          : { to: d.node, in: d.sock };
        this.openSearch(rect.left + (d.x * this.zoom + this.panX), rect.top + (d.y * this.zoom + this.panY));
      } else this.draw();
    } else if (d.kind === 'box') {
      this.#side();
      this.draw();
    }
  }

  #wheel(e) {
    if (this.ed.surfaceMode !== 'nodes') return;
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const before = this.worldAt(sx, sy);
    this.zoom = clamp(this.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), 0.2, 2.4);
    this.panX = sx - before.x * this.zoom;
    this.panY = sy - before.y * this.zoom;
    this.draw();
  }

  #dbl(e) {
    const w = this.world(e);
    const g = this.graph();
    if (!g) return;
    const link = this.#hitLink(w.x, w.y);
    if (link) {
      const n = addNode(g, 'reroute', { x: w.x - 8, y: w.y - 8 });
      linkSockets(g, link.from, link.out, n.id, 'in');
      linkSockets(g, n.id, 'out', link.to, link.in);
      const scope = currentScope(g);
      scope.links = scope.links.filter((l) => l !== link);
      this.#changed();
      return;
    }
    const hit = this.#hit(w.x, w.y);
    if (hit?.node?.type === 'group') {
      enterGroup(g, hit.node.id);
      this.#changed();
    }
  }

  #hit(x, y) {
    const scope = currentScope(this.graph());
    const nodes = [...scope.nodes].reverse();
    for (const node of nodes) {
      if (node.type === 'frame') continue;
      const sock = this.#hitSock(node, x, y);
      if (sock) return { node, sock };
      const box = nodeBox(node);
      if (x >= node.x && y >= node.y && x <= node.x + box.w && y <= node.y + box.h) return { node };
    }
    for (const node of nodes) {
      if (node.type !== 'frame') continue;
      const box = nodeBox(node);
      if (x >= node.x && y >= node.y && x <= node.x + box.w && y <= node.y + box.h) {
        const resize = x > node.x + box.w - 14 && y > node.y + box.h - 14;
        return { node, resize };
      }
    }
    return null;
  }

  #hitSock(node, x, y) {
    const socks = socketsOf(node);
    for (const s of [...socks.outputs.map((s0) => ({ ...s0, dir: 'out' })), ...socks.inputs.map((s0) => ({ ...s0, dir: 'in' }))]) {
      const p = socketXY(node, s.dir, s.id);
      if ((p.x - x) ** 2 + (p.y - y) ** 2 <= 81) return s;
    }
    return null;
  }

  #hitLink(x, y) {
    const g = this.graph();
    const scope = currentScope(g);
    let best = null, bestD = 8;
    for (const l of scope.links) {
      const a = scope.nodes.find((n) => n.id === l.from);
      const b = scope.nodes.find((n) => n.id === l.to);
      if (!a || !b) continue;
      const p = socketXY(a, 'out', l.out);
      const q = socketXY(b, 'in', l.in);
      const d = pointSeg(x, y, p.x, p.y, q.x, q.y);
      if (d < bestD) { bestD = d; best = l; }
    }
    return best;
  }

  #selectBox(d) {
    const g = this.graph();
    const x0 = Math.min(d.x0, d.x1), y0 = Math.min(d.y0, d.y1);
    const x1 = Math.max(d.x0, d.x1), y1 = Math.max(d.y0, d.y1);
    const hit = currentScope(g).nodes.filter((n) => {
      if (n.type === 'frame') return false;
      const b = nodeBox(n);
      return n.x < x1 && n.y < y1 && n.x + b.w > x0 && n.y + b.h > y0;
    }).map((n) => n.id);
    g.selected = d.shift ? [...new Set([...d.base, ...hit])] : hit;
  }

  #cursor(w) {
    const hit = this.graph() ? this.#hit(w.x, w.y) : null;
    if (hit?.sock) return 'crosshair';
    if (hit?.resize) return 'nwse-resize';
    if (hit?.node) return 'grab';
    return 'default';
  }

  #toViewer(node) {
    const g = this.graph();
    const scope = currentScope(g);
    let view = scope.nodes.find((n) => n.type === 'viewer');
    if (!view) view = addNode(g, 'viewer', { x: node.x + 240, y: node.y });
    const out = socketsOf(node).outputs[0];
    if (!out) return;
    try { linkSockets(g, node.id, out.id, view.id, 'image'); this.#changed(); }
    catch (err) { this.ed.toast(err.message); }
  }

  handleKey(e, phase = 'down') {
    if (this.ed.surfaceMode !== 'nodes') return false;
    if (phase === 'up') {
      if (e.key === ' ') { this.space = false; return true; }
      return false;
    }
    const g = this.graph();
    if (!g) return false;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (k === ' ') { this.space = true; return true; }
    if (k === 'Escape') {
      this.closeSearch();
      if (this.grab) { this.#endGrab(false); return true; }
      g.selected = [];
      this.draw(); this.#side();
      return true;
    }
    if (k === 'Enter' && this.grab) { this.#endGrab(true); return true; }
    if ((k === 'a' || k === 'A') && e.shiftKey && !ctrl) { this.openSearch(80, 120); return true; }
    if ((k === 'a' || k === 'A') && !e.shiftKey && !e.altKey) {
      g.selected = currentScope(g).nodes.filter((n) => n.type !== 'frame').map((n) => n.id);
      this.draw(); this.#side(); return true;
    }
    if (k === 'a' && e.altKey) { g.selected = []; this.draw(); this.#side(); return true; }
    if (k === 'Delete' || k === 'Backspace' || (k === 'x' && !ctrl) || (k === 'X' && !ctrl)) {
      deleteNodes(g, g.selected); this.#changed(); return true;
    }
    if (ctrl && (k === 'x' || k === 'X')) { deleteNodes(g, g.selected, { reconnect: true }); this.#changed(); return true; }
    if (e.shiftKey && (k === 'd' || k === 'D') && !ctrl) { duplicateNodes(g, g.selected); this.#changed(); return true; }
    if ((k === 'm' || k === 'M') && !ctrl) {
      const on = currentScope(g).nodes.some((n) => g.selected.includes(n.id) && !n.muted);
      setMuted(g, g.selected, on); this.#changed(); return true;
    }
    if ((k === 'h' || k === 'H') && !ctrl) {
      const on = currentScope(g).nodes.some((n) => g.selected.includes(n.id) && !n.collapsed);
      setCollapsed(g, g.selected, on); this.#changed(); return true;
    }
    if (ctrl && (k === 'g' || k === 'G') && !e.shiftKey) {
      try { groupNodes(g, g.selected); this.#changed(); } catch (err) { this.ed.toast(err.message); }
      return true;
    }
    if (ctrl && e.shiftKey && (k === 'g' || k === 'G')) {
      const id = g.selected.find((n) => currentScope(g).nodes.find((node) => node.id === n)?.type === 'group');
      if (id) { try { ungroupNode(g, id); this.#changed(); } catch (err) { this.ed.toast(err.message); } }
      return true;
    }
    if (k === 'Tab' && !ctrl) {
      if (e.shiftKey) { if (exitGroup(g)) this.#changed(); return true; }
      const id = g.selected.find((n) => currentScope(g).nodes.find((node) => node.id === n)?.type === 'group');
      if (id) { enterGroup(g, id); this.#changed(); }
      return true;
    }
    if (ctrl && (k === 'j' || k === 'J')) {
      try { frameNodes(g, g.selected); this.#changed(); } catch (err) { this.ed.toast(err.message); }
      return true;
    }
    if (ctrl && (k === 'c' || k === 'C')) { copySelection(g); return true; }
    if (ctrl && (k === 'v' || k === 'V') && !e.shiftKey) {
      const w = this.worldAt(this.cw / 2, this.ch / 2);
      pasteClipboard(g, w.x, w.y); this.#changed(); return true;
    }
    if (ctrl && !e.shiftKey && (k === 'z' || k === 'Z')) { if (undoGraph(g)) this.#changed(); return true; }
    if ((ctrl && (k === 'y' || k === 'Y')) || (ctrl && e.shiftKey && (k === 'z' || k === 'Z'))) {
      if (redoGraph(g)) this.#changed(); return true;
    }
    if ((k === 'f' || k === 'F') && !ctrl) { this.#frame(g.selected); return true; }
    if (k === 'Home') { this.#frame(null); return true; }
    if ((k === 'n' || k === 'N') && !ctrl && !e.shiftKey) { this.sideOpen = !this.sideOpen; this.side.hidden = !this.sideOpen; this.#resize(); return true; }
    if ((k === 'v' || k === 'V') && !ctrl) { this.backdrop = !this.backdrop; this.#syncBar(); this.draw(); return true; }
    if ((k === 'l' || k === 'L') && !ctrl) { this.#linked(e.shiftKey); return true; }
    if ((k === 'g' || k === 'G') && !ctrl) { this.#startGrab(); return true; }
    return false;
  }

  #startGrab() {
    const g = this.graph();
    const scope = currentScope(g);
    const ids = g.selected.filter((id) => scope.nodes.some((n) => n.id === id));
    if (!ids.length) return;
    beginEdit(g);
    const origin = new Map(ids.map((id) => {
      const n = scope.nodes.find((node) => node.id === id);
      return [id, { x: n.x, y: n.y }];
    }));
    const w = this.worldAt(this.cw / 2, this.ch / 2);
    this.grab = { origin, x: w.x, y: w.y };
  }

  #endGrab(keep) {
    const g = this.graph();
    if (!keep) {
      for (const [id, p] of this.grab.origin) {
        const n = currentScope(g).nodes.find((node) => node.id === id);
        if (n) { n.x = p.x; n.y = p.y; }
      }
      g._editing = null;
    } else if (endEdit(g)) { this.grab = null; this.#changed(); return; }
    this.grab = null;
    this.draw();
  }

  #linked(sameType) {
    const g = this.graph();
    const scope = currentScope(g);
    const seed = scope.nodes.filter((n) => g.selected.includes(n.id));
    if (!seed.length) return;
    if (sameType) {
      const types = new Set(seed.map((n) => n.type));
      g.selected = scope.nodes.filter((n) => types.has(n.type)).map((n) => n.id);
    } else {
      const ids = new Set(seed.map((n) => n.id));
      let grew = true;
      while (grew) {
        grew = false;
        for (const l of scope.links) {
          if (ids.has(l.from) && !ids.has(l.to)) { ids.add(l.to); grew = true; }
          if (ids.has(l.to) && !ids.has(l.from)) { ids.add(l.from); grew = true; }
        }
      }
      g.selected = [...ids];
    }
    this.draw(); this.#side();
  }

  #frame(ids) {
    const scope = currentScope(this.graph());
    const nodes = ids?.length ? scope.nodes.filter((n) => ids.includes(n.id)) : scope.nodes;
    if (!nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      const b = nodeBox(n);
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + b.w); y1 = Math.max(y1, n.y + b.h);
    }
    const pad = 48;
    const zw = (this.cw - pad * 2) / Math.max(1, x1 - x0);
    const zh = (this.ch - pad * 2) / Math.max(1, y1 - y0);
    this.zoom = clamp(Math.min(zw, zh), 0.2, 1.6);
    this.panX = (this.cw - (x1 - x0) * this.zoom) / 2 - x0 * this.zoom;
    this.panY = (this.ch - (y1 - y0) * this.zoom) / 2 - y0 * this.zoom;
    this.draw();
  }

  openSearch(sx = 120, sy = 80) {
    this.search?.remove();
    this.search = null;
    const input = h('input', { type: 'text', placeholder: 'Search nodes', class: 'node-search-input' });
    const list = h('div', { class: 'node-search-list' });
    const pop = h('div', { class: 'node-search', style: { left: `${sx}px`, top: `${sy}px` } }, input, list);
    const render = () => {
      list.replaceChildren();
      const q = input.value.trim().toLowerCase();
      const items = ADDABLE.filter((t) => !q || t.label.toLowerCase().includes(q) || t.id.includes(q) || t.category.includes(q));
      let last = '';
      for (const t of items.slice(0, 40)) {
        if (t.category !== last) {
          last = t.category;
          list.append(h('div', { class: 'node-search-cat' }, CATEGORIES.find((c) => c[0] === t.category)?.[1] || t.category));
        }
        list.append(h('button', { type: 'button', class: 'node-search-item', onClick: () => this.#pick(t.id) },
          h('i', { style: { background: categoryColor(t.category) } }), t.label));
      }
    };
    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.closeSearch(); }
      if (e.key === 'Enter') {
        const q = input.value.trim().toLowerCase();
        const hit = ADDABLE.find((t) => !q || t.label.toLowerCase().includes(q) || t.id.includes(q));
        if (hit) { e.preventDefault(); this.#pick(hit.id); }
      }
    });
    document.body.append(pop);
    this.search = pop;
    render();
    input.focus();
  }

  closeSearch() {
    this.search?.remove();
    this.search = null;
    this.pendingLink = null;
  }

  #pick(type) {
    const g = this.graph();
    const pending = this.pendingLink;
    const w = this.worldAt(Math.max(40, this.cw / 2 - 80), 80 + Math.random() * 40);
    const anchor = pending ? this.worldAt(
      (parseFloat(this.search.style.left) || 0) - this.canvas.getBoundingClientRect().left,
      (parseFloat(this.search.style.top) || 0) - this.canvas.getBoundingClientRect().top,
    ) : w;
    this.closeSearch();
    const node = addNode(g, type, { x: anchor.x, y: anchor.y });
    if (pending?.from) {
      const inn = socketsOf(node).inputs[0];
      if (inn) { try { linkSockets(g, pending.from, pending.out, node.id, inn.id); } catch { /* type mismatch shown on next edit */ } }
    } else if (pending?.to) {
      const out = socketsOf(node).outputs[0];
      if (out) { try { linkSockets(g, node.id, out.id, pending.to, pending.in); } catch { /* ignore */ } }
    }
    this.#changed();
  }

  #menu(e) {
    this.closeSearch();
    const w = this.world(e);
    const hit = this.#hit(w.x, w.y);
    const g = this.graph();
    if (hit?.node && !g.selected.includes(hit.node.id)) g.selected = [hit.node.id];
    const item = (label, fn) => h('button', { type: 'button', class: 'menu-item', onClick: () => { pop.remove(); fn(); } }, h('span', { class: 'label' }, label));
    const pop = h('div', { class: 'menu', style: { left: `${e.clientX}px`, top: `${e.clientY}px` } },
      item('Add', () => this.openSearch(e.clientX, e.clientY)),
      hit?.node ? item('Duplicate', () => { duplicateNodes(g, g.selected); this.#changed(); }) : null,
      hit?.node ? item('Mute', () => { setMuted(g, g.selected, true); this.#changed(); }) : null,
      hit?.node ? item('Delete', () => { deleteNodes(g, g.selected); this.#changed(); }) : null,
      hit?.node ? item('Delete and Reconnect', () => { deleteNodes(g, g.selected, { reconnect: true }); this.#changed(); }) : null,
      item('Frame Selected', () => { try { frameNodes(g, g.selected); this.#changed(); } catch (err) { this.ed.toast(err.message); } }),
      item('Group', () => { try { groupNodes(g, g.selected); this.#changed(); } catch (err) { this.ed.toast(err.message); } }),
      item('Apply to Layer', () => this.apply()),
    );
    document.body.append(pop);
    setTimeout(() => {
      const close = (ev) => { if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('pointerdown', close, true); } };
      document.addEventListener('pointerdown', close, true);
    }, 0);
  }

  apply() {
    const doc = this.ed.doc;
    if (!doc) return;
    try {
      const result = applyToLayer(doc);
      if (result.errors?.length) this.ed.toast(`Applied with ${result.errors.length} node error${result.errors.length > 1 ? 's' : ''}.`);
      else this.ed.toast('Applied the composite to the active layer.');
    } catch (err) { this.ed.toast(err.message); }
  }

  #bar() {
    this.crumb = h('span', { class: 'nodes-crumb' });
    this.backBtn = h('button', {
      type: 'button', class: 'btn', title: 'Viewer backdrop (V)',
      onClick: () => { this.backdrop = !this.backdrop; this.#syncBar(); this.draw(); },
    }, 'Backdrop');
    const apply = h('button', { type: 'button', class: 'btn primary', onClick: () => this.apply() }, 'Apply');
    const add = h('button', { type: 'button', class: 'btn', onClick: () => this.openSearch(160, 90) }, 'Add');
    const time = h('input', { type: 'range', min: 0, max: 4, step: 0.01, value: 0, title: 'Time' });
    time.addEventListener('pointerdown', () => beginEdit(this.graph()));
    time.addEventListener('input', () => {
      const g = this.graph();
      if (!g) return;
      g.time = Number(time.value);
      this.schedule();
    });
    time.addEventListener('pointerup', () => { if (endEdit(this.graph())) markGraph(this.ed.doc); });
    this.time = time;
    this.bar.append(
      h('button', { type: 'button', class: 'btn', onClick: () => { this.ed.surfaceMode = 'canvas'; this.ed.emit('surface', 'canvas'); } }, 'Canvas'),
      h('button', { type: 'button', class: 'btn on', onClick: () => {} }, 'Nodes'),
      this.crumb, h('span', { class: 'opt-spacer' }),
      h('label', { class: 'opt' }, 'Time ', time),
      this.backBtn, add, apply,
    );
    this.#syncBar();
  }

  #model() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('stratum.model') || '{}'); } catch { /* private mode */ }
    this.modelName = h('input', {
      type: 'text', class: 'model-name', spellcheck: false, placeholder: 'qwen2.5-coder:7b',
      value: saved.model || '', title: 'Ollama model on this computer',
    });
    this.modelTask = h('input', {
      type: 'text', class: 'model-task', placeholder: 'Ask the local model… slow red to blue waves',
      title: 'The model replies with script lines. Stratum runs them here.',
    });
    this.modelRetry = h('input', { type: 'checkbox', title: 'Ask once more if a command fails. Leave off for a thinking model.' });
    this.modelBtn = h('button', { type: 'button', class: 'btn', onClick: () => this.#askModel() }, 'Ask');
    this.modelName.addEventListener('change', () => this.#rememberModel());
    this.modelTask.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.#askModel(); }
    });
    this.modelRow.append(
      this.modelName,
      this.modelTask,
      h('label', { class: 'opt', title: 'One more completion if a line fails' }, this.modelRetry, 'Retry'),
      this.modelBtn,
    );
  }

  #rememberModel() {
    try { localStorage.setItem('stratum.model', JSON.stringify({ model: this.modelName.value.trim() })); } catch { /* ignore */ }
  }

  async #askModel() {
    const doc = this.ed.doc;
    if (!doc) { this.ed.toast('Open an image first.'); return; }
    let model;
    try { model = checkModelName(this.modelName.value); }
    catch (err) { this.ed.toast(err.message); return; }
    const task = this.modelTask.value.trim();
    if (!task) { this.ed.toast('Say what the picture should do.'); return; }
    this.#rememberModel();
    this.modelBtn.disabled = true;
    this.modelLog.hidden = false;
    this.modelLog.textContent = 'Waiting for the model. A thinking model can take a minute. VRAM stays with Ollama.';
    const url = ollamaEndpoint('http://127.0.0.1:11434');
    try {
      ensureGraph(doc);
      let text = await ollamaGenerate({ url, model, prompt: taskPrompt(task, doc) });
      let commands = extractCommands(text);
      if (!commands.length) {
        this.modelLog.textContent = 'No commands came back. The pipe still accepts JSON lines if you would rather send them yourself.\n' + String(text || '').slice(0, 600);
        return;
      }
      let results = runCommands(this.ed, commands);
      this.#changed();
      if (this.modelRetry.checked && results.some((r) => !r.ok)) {
        this.modelLog.textContent = 'A command failed. Asking once more…';
        text = await ollamaGenerate({ url, model, prompt: repairPrompt(task, doc, results) });
        const more = extractCommands(text);
        if (more.length) results = results.concat(runCommands(this.ed, more));
        this.#changed();
      }
      this.modelLog.textContent = results.map((r) => JSON.stringify(r)).join('\n');
      const bad = results.filter((r) => !r.ok).length;
      this.ed.toast(bad ? `${bad} command${bad > 1 ? 's' : ''} failed.` : 'The model updated the graph.');
    } catch (err) {
      this.modelLog.textContent = err.message || String(err);
      this.ed.toast(err.message || String(err));
    } finally {
      this.modelBtn.disabled = false;
    }
  }

  #syncBar() {
    this.backBtn?.classList.toggle('on', this.backdrop);
    const g = this.graph();
    if (!g || !this.crumb) return;
    if (this.time && document.activeElement !== this.time) this.time.value = String(g.time || 0);
    const bits = [h('button', { type: 'button', class: 'linkish', onClick: () => { g.path = []; this.#changed(); } }, 'Graph')];
    let scope = g;
    const path = [];
    for (const id of g.path || []) {
      const n = scope.nodes.find((node) => node.id === id);
      if (!n) break;
      path.push(id);
      const here = [...path];
      bits.push(h('span', null, ' / '), h('button', {
        type: 'button', class: 'linkish',
        onClick: () => { g.path = here.slice(0, -1).concat(id); g.path = here; this.#changed(); },
      }, nodeLabel(n)));
      scope = n.params.graph;
    }
    // The last crumb should exit to that level, not include itself as a deeper path.
    this.crumb.replaceChildren(...bits);
  }

  #side() {
    this.#syncBar();
    const g = this.graph();
    if (!g) { this.side.replaceChildren(); return; }
    const sig = `${(g.path || []).join('/')}:${(g.selected || []).join(',')}:${g.rev || 0}`;
    const typing = this.side.contains(document.activeElement);
    if (typing && this.sideSig === `${(g.path || []).join('/')}:${(g.selected || []).join(',')}`) return;
    this.sideSig = `${(g.path || []).join('/')}:${(g.selected || []).join(',')}`;
    const scope = currentScope(g);
    const node = scope.nodes.find((n) => n.id === g.selected[0]);
    const kids = [
      h('h3', null, 'Node'),
      h('p', { class: 'dim nodes-help' }, 'Shift+A add · drag a socket · M mute · H collapse · Ctrl+G group · Tab inside · G grab · Alt-drag cuts links · Ctrl+Shift-click views a node.'),
    ];
    if (!node) {
      kids.push(h('p', { class: 'dim' }, 'Nothing selected.'));
    } else {
      const err = this.errors.find((e) => e.id === node.id);
      if (err) kids.push(h('p', { class: 'nodes-error' }, err.error));
      kids.push(h('label', { class: 'opt nodes-field' }, 'Name', h('input', {
        type: 'text', value: node.label || '',
        onChange: (e) => { node.label = e.target.value; this.#changed(); },
      })));
      const spec = NODE_TYPES[node.type];
      for (const f of spec?.params || []) {
        if (f.id === 'graph') continue;
        kids.push(this.#field(g, node, f));
      }
      if (node.type === 'formula') kids.push(this.#formula(node));
      kids.push(h('div', { class: 'nodes-tags' }, TAGS.map((c) => h('button', {
        type: 'button', class: `tag${node.color === c ? ' on' : ''}`, title: c || 'Default',
        style: { background: c || '#3a3f48' },
        onClick: () => { setColor(g, [node.id], c); this.#changed(); },
      }))));
      const preview = this.#thumb(node, primaryOutput(this.values, node));
      if (preview) kids.push(preview);
    }
    this.side.replaceChildren(...kids);
    void sig;
  }

  #field(g, node, f) {
    const value = node.params?.[f.id];
    const commit = (v, live) => {
      if (live) setParamLive(g, node.id, f.id, v);
      else setParam(g, node.id, f.id, v);
      this.schedule();
    };
    let control;
    if (f.type === 'select') {
      control = h('select', { onChange: (e) => { beginEdit(g); commit(e.target.value, true); endEdit(g); markGraph(this.ed.doc); } },
        ...(f.options || []).map(([id, label]) => h('option', { value: id, selected: String(value ?? f.default) === id }, label)));
    } else if (f.type === 'bool') {
      control = h('input', { type: 'checkbox', checked: !!value, onChange: (e) => { beginEdit(g); commit(e.target.checked, true); endEdit(g); markGraph(this.ed.doc); } });
    } else if (f.type === 'text') {
      control = h('textarea', { rows: f.id === 'latex' || f.id === 'stops' || f.id === 'curve' ? 3 : 2, value: value ?? '' });
      control.addEventListener('focus', () => beginEdit(g));
      control.addEventListener('input', () => commit(control.value, true));
      control.addEventListener('blur', () => { if (endEdit(g)) markGraph(this.ed.doc); if (f.id === 'latex') this.#side(); });
    } else if (f.type === 'color') {
      const c = value || f.default || { r: 1, g: 1, b: 1, a: 1 };
      control = h('input', { type: 'color', value: rgbHex(c) });
      control.addEventListener('input', () => {
        const n = parseInt(control.value.slice(1), 16);
        commit({ r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: c.a ?? 1 }, true);
      });
      control.addEventListener('pointerdown', () => beginEdit(g));
      control.addEventListener('change', () => { if (endEdit(g)) markGraph(this.ed.doc); });
    } else {
      control = h('input', { type: 'number', min: f.min, max: f.max, step: f.step ?? 0.01, value: value ?? f.default ?? 0 });
      control.addEventListener('focus', () => beginEdit(g));
      control.addEventListener('input', () => commit(Number(control.value), true));
      control.addEventListener('blur', () => { if (endEdit(g)) markGraph(this.ed.doc); });
    }
    return h('label', { class: 'opt nodes-field' }, f.label, control);
  }

  #formula(node) {
    const canvas = h('canvas', { width: 240, height: 72, class: 'formula-canvas' });
    try {
      const { ast } = compileFormula(node.params?.latex || '0');
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 240, 72);
      drawFormula(ctx, ast, 8, 36, 18);
    } catch (err) {
      return h('p', { class: 'nodes-error' }, err.message);
    }
    return canvas;
  }

  #thumb(node, value) {
    if (!value) return null;
    const canvas = document.createElement('canvas');
    const src = value.kind === 'image' ? value : null;
    canvas.width = src?.width || 8;
    canvas.height = src?.height || 8;
    const ctx = canvas.getContext('2d');
    if (!src) {
      const c = value.kind === 'color' ? value : { r: value.v || 0, g: value.v || 0, b: value.v || 0, a: 1 };
      ctx.fillStyle = `rgba(${clamp(c.r, 0, 1) * 255},${clamp(c.g, 0, 1) * 255},${clamp(c.b, 0, 1) * 255},${c.a ?? 1})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      const id = ctx.createImageData(src.width, src.height);
      for (let i = 0; i < id.data.length; i++) {
        const n = src.data[i];
        id.data[i] = n <= 0 ? 0 : n >= 1 ? 255 : Math.round(n * 255);
      }
      ctx.putImageData(id, 0, 0);
    }
    canvas.className = 'node-thumb';
    this.thumbs.set(node.id, canvas);
    return canvas;
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx || !this.cw) return;
    const dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    ctx.fillStyle = '#14161b';
    ctx.fillRect(0, 0, this.cw, this.ch);
    if (this.backdrop) this.#backdrop(ctx);
    this.#grid(ctx);
    const g = this.graph();
    if (!g) return;
    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);
    const scope = currentScope(g);
    for (const n of scope.nodes) if (n.type === 'frame') this.#frameNode(ctx, n, g);
    for (const l of scope.links) this.#link(ctx, scope, l);
    for (const n of scope.nodes) if (n.type !== 'frame') this.#node(ctx, n, g);
    const d = this.drag;
    if (d?.kind === 'link') {
      const node = scope.nodes.find((n) => n.id === d.node);
      if (node) {
        const p = socketXY(node, d.dir, d.sock);
        this.#wire(ctx, d.dir === 'out' ? p.x : d.x, d.dir === 'out' ? p.y : d.y, d.dir === 'out' ? d.x : p.x, d.dir === 'out' ? d.y : p.y, '#9ec1ff');
      }
    }
    if (d?.kind === 'cut') {
      ctx.strokeStyle = '#ff8080'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(d.x0, d.y0); ctx.lineTo(d.x1, d.y1); ctx.stroke(); ctx.setLineDash([]);
    }
    if (d?.kind === 'box') {
      ctx.strokeStyle = '#4c9dff'; ctx.fillStyle = 'rgba(76,157,255,.12)'; ctx.lineWidth = 1;
      const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
      ctx.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
    ctx.restore();
  }

  #backdrop(ctx) {
    const g = this.graph();
    if (!g) return;
    const node = g.nodes.find((n) => n.type === 'viewer') || g.nodes.find((n) => n.type === 'composite');
    const value = node && primaryOutput(this.values, node);
    const thumb = node && (this.thumbs.get(node.id) || this.#thumb(node, value));
    if (!thumb) return;
    const pad = 24;
    const s = Math.min((this.cw - pad * 2) / thumb.width, (this.ch - pad * 2) / thumb.height);
    const w = thumb.width * s, h = thumb.height * s;
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.drawImage(thumb, (this.cw - w) / 2, (this.ch - h) / 2, w, h);
    ctx.restore();
  }

  #grid(ctx) {
    const step = 24 * this.zoom;
    if (step < 8) return;
    ctx.strokeStyle = 'rgba(255,255,255,.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const ox = ((this.panX % step) + step) % step;
    const oy = ((this.panY % step) + step) % step;
    for (let x = ox; x < this.cw; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, this.ch); }
    for (let y = oy; y < this.ch; y += step) { ctx.moveTo(0, y); ctx.lineTo(this.cw, y); }
    ctx.stroke();
  }

  #frameNode(ctx, n, g) {
    const b = nodeBox(n);
    const on = g.selected.includes(n.id);
    ctx.fillStyle = 'rgba(255,255,255,.03)';
    ctx.strokeStyle = n.color || (on ? '#4c9dff' : '#3c424c');
    ctx.lineWidth = on ? 2 : 1;
    roundRect(ctx, n.x, n.y, b.w, b.h, 8);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#c5cad3';
    ctx.font = '12px sans-serif';
    ctx.fillText(nodeLabel(n), n.x + 10, n.y + 16);
  }

  #node(ctx, n, g) {
    if (n.type === 'reroute') {
      const on = g.selected.includes(n.id);
      ctx.beginPath();
      ctx.arc(n.x + 8, n.y + 8, 7, 0, Math.PI * 2);
      ctx.fillStyle = n.color || '#9aa3b2';
      ctx.fill();
      if (on) { ctx.strokeStyle = '#4c9dff'; ctx.lineWidth = 2; ctx.stroke(); }
      return;
    }
    const b = nodeBox(n);
    const spec = NODE_TYPES[n.type];
    const head = n.color || categoryColor(spec?.category);
    const on = g.selected.includes(n.id);
    ctx.fillStyle = '#23262d';
    ctx.strokeStyle = this.errors.some((e) => e.id === n.id) ? '#ff6b6b' : (on ? '#4c9dff' : '#3a404a');
    ctx.lineWidth = on ? 2 : 1;
    roundRect(ctx, n.x, n.y, b.w, b.h, 7);
    ctx.fill(); ctx.stroke();
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, n.x, n.y, b.w, 26, 7);
    ctx.clip();
    ctx.fillStyle = head;
    ctx.globalAlpha = n.muted ? 0.45 : 1;
    ctx.fillRect(n.x, n.y, b.w, 26);
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#15171c';
    ctx.font = '12px sans-serif';
    ctx.fillText(nodeLabel(n), n.x + 8, n.y + 17);
    if (!n.collapsed && (n.type === 'viewer' || n.type === 'composite')) {
      const thumb = this.thumbs.get(n.id);
      if (thumb) ctx.drawImage(thumb, n.x + 8, n.y + b.h - 64, b.w - 16, 56);
    }
    const socks = socketsOf(n);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#c5cad3';
    if (!n.collapsed) {
      socks.inputs.forEach((s) => {
        const p = socketXY(n, 'in', s.id);
        dot(ctx, p.x, p.y, '#d7dbe3');
        if (s.name) ctx.fillText(s.name, p.x + 8, p.y + 3);
      });
      socks.outputs.forEach((s) => {
        const p = socketXY(n, 'out', s.id);
        dot(ctx, p.x, p.y, '#d7dbe3');
        if (s.name) {
          const tw = ctx.measureText(s.name).width;
          ctx.fillText(s.name, p.x - 8 - tw, p.y + 3);
        }
      });
    } else {
      if (socks.inputs.length) dot(ctx, n.x, n.y + 13, '#d7dbe3');
      if (socks.outputs.length) dot(ctx, n.x + b.w, n.y + 13, '#d7dbe3');
    }
  }

  #link(ctx, scope, l) {
    const a = scope.nodes.find((n) => n.id === l.from);
    const b = scope.nodes.find((n) => n.id === l.to);
    if (!a || !b) return;
    const p = socketXY(a, 'out', l.out);
    const q = socketXY(b, 'in', l.in);
    this.#wire(ctx, p.x, p.y, q.x, q.y, '#8ea0b8');
  }

  #wire(ctx, x0, y0, x1, y1, color) {
    const dx = Math.max(36, Math.abs(x1 - x0) * 0.45);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.bezierCurveTo(x0 + dx, y0, x1 - dx, y1, x1, y1);
    ctx.stroke();
  }
}

function rgbHex(c) {
  const n = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${n(c.r)}${n(c.g)}${n(c.b)}`;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function dot(ctx, x, y, color) {
  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function pointSeg(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((px - x0) * dx + (py - y0) * dy) / l2;
  t = clamp(t, 0, 1);
  const x = x0 + t * dx, y = y0 + t * dy;
  return Math.hypot(px - x, py - y);
}
