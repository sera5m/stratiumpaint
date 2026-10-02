// The editor session: open documents, the active tool, colours and tool options.
// No DOM in here, so the whole thing can be driven from tests. The UI listens to its events:
//   'doc' 'docs' 'tool' 'colors' 'opts' 'toast' 'overlay' and 'doc:<event>' re-emitted from the active document.
import { Emitter, clamp } from '../core/util.js';
import { createTools } from '../tools/index.js';

export const DEFAULT_OPTS = {
  size: 12, hardness: 80, opacity: 100, aa: true, radius: 12,
  tolerance: 30, flood: 'contiguous', sampling: 'image',
  selMode: 'replace',
  shape: 'outline',
  gradient: 'linear',
  pattern: 'solid', patternSize: 16,
  font: 'DejaVu Sans', fontSize: 32, bold: false, italic: false,
  grid: false,
  wholeImage: false, // fill/erase/adjustments/effects ignore the selection and apply everywhere
};

const DOC_EVENTS = ['render', 'layers', 'selection', 'size', 'history', 'meta'];

export class Editor extends Emitter {
  constructor({ tools = createTools() } = {}) {
    super();
    this.docs = [];
    this.doc = null;
    this.primary = { r: 0, g: 0, b: 0, a: 1 };
    this.secondary = { r: 255, g: 255, b: 255, a: 1 };
    this.recentColors = []; // most-recent-first, deduped by rgba; see noteRecentColor
    this.opts = { ...DEFAULT_OPTS };
    this.tools = tools;
    this.tool = tools[0];
    this.view = null; // set by the UI
    this.hover = null; // last pointer position in document coordinates
    this.marchOffset = null; // selection outline offset while a move tool drags
    this.clipboard = null; // in-app fallback when the system clipboard is unavailable
    this._off = [];
  }

  // ---------------------------------------------------------------- tools

  toolById(id) { return this.tools.find((t) => t.id === id); }

  setTool(id) {
    const t = this.toolById(id);
    if (!t || t === this.tool) return;
    this.commitPending(); // finish (not discard) whatever the old tool was doing, e.g. an open text box
    this.tool = t;
    this.emit('tool', t);
    this.requestOverlay();
  }

  /**
   * Finalize the current tool's pending work without switching away from it: commits an open
   * text box, then cancels any leftover in-progress drag. Call this before anything that changes
   * the document out from under the active tool (switching tools/documents, menu commands, ...).
   */
  commitPending() {
    this.tool.deactivate?.(this);
    this.tool.cancel?.(this);
  }

  /** Pressing a tool's letter again cycles through the tools that share it. */
  cycleTool(key) {
    const group = this.tools.filter((t) => t.key === key);
    if (!group.length) return false;
    const i = group.indexOf(this.tool);
    this.setTool(group[(i + 1) % group.length].id);
    return true;
  }

  setOpt(key, value) {
    if (this.opts[key] === value) return;
    this.opts[key] = value;
    this.emit('opts', key);
    this.requestOverlay();
  }

  nudgeSize(delta) { this.setOpt('size', clamp(Math.round(this.opts.size + delta), 1, 500)); }

  // ---------------------------------------------------------------- colours

  setPrimary(c) { this.primary = { r: c.r, g: c.g, b: c.b, a: c.a ?? 1 }; this.#colorsChanged(); }
  setSecondary(c) { this.secondary = { r: c.r, g: c.g, b: c.b, a: c.a ?? 1 }; this.#colorsChanged(); }
  swapColors() { [this.primary, this.secondary] = [this.secondary, this.primary]; this.#colorsChanged(); }
  resetColors() {
    this.primary = { r: 0, g: 0, b: 0, a: 1 };
    this.secondary = { r: 255, g: 255, b: 255, a: 1 };
    this.#colorsChanged();
  }

  #colorsChanged() {
    this.emit('colors');
    this.tool.colorsChanged?.(this); // let a tool with an in-progress draw (e.g. a shape) live-update
  }

  /**
   * Record a colour as "recently used" (most-recent-first, capped, deduped by exact rgba).
   * Called when a colour pick is *finished* — a swatch click, a completed eyedropper sample, the
   * colour dialog's OK — not on every intermediate value while a slider or the SV square is dragged.
   */
  noteRecentColor(c) {
    const rgba = { r: c.r, g: c.g, b: c.b, a: c.a ?? 1 };
    const key = (x) => `${x.r},${x.g},${x.b},${x.a}`;
    this.recentColors = [rgba, ...this.recentColors.filter((x) => key(x) !== key(rgba))].slice(0, 12);
    this.emit('recentColors');
  }

  // ---------------------------------------------------------------- documents

  addDoc(doc) {
    this.docs.push(doc);
    this.activate(doc);
    this.emit('docs');
  }

  activate(doc) {
    if (doc === this.doc) return;
    this.commitPending();
    for (const off of this._off) off();
    this._off = [];
    this.doc = doc;
    if (doc) for (const ev of DOC_EVENTS) this._off.push(doc.on(ev, (...a) => this.emit(`doc:${ev}`, ...a)));
    this.emit('doc', doc);
  }

  closeDoc(doc) {
    const i = this.docs.indexOf(doc);
    if (i < 0) return;
    this.docs.splice(i, 1);
    if (doc === this.doc) this.activate(this.docs[Math.min(i, this.docs.length - 1)] ?? null);
    this.emit('docs');
  }

  /** The active layer if it can be painted on, otherwise null (with a hint for the user). */
  editableLayer() {
    const l = this.doc?.layer;
    if (!l) return null;
    if (!l.visible) { this.toast('The active layer is hidden. Show it to paint on it.'); return null; }
    return l;
  }

  // ---------------------------------------------------------------- plumbing for the UI

  toast(msg) { this.emit('toast', msg); }
  requestOverlay() { this.emit('overlay'); }

  /** e = {x, y, sx, sy, button, shift, ctrl, alt}: document coords, stage coords, mouse button, modifiers. */
  pointer(type, e) {
    const t = this.tool;
    if (!t || !this.doc) return;
    try {
      if (type === 'down') t.down?.(e, this);
      else if (type === 'move') t.move?.(e, this);
      else if (type === 'up') t.up?.(e, this);
    } catch (err) {
      console.error(err);
      this.toast(`${t.name} failed: ${err.message}`);
      t.cancel?.(this);
    }
  }

  /** Abort whatever drag is in progress (Escape). */
  cancelTool() { this.tool.cancel?.(this); this.requestOverlay(); }
  /** Enter: set down whatever the current tool has pending (a floating move, an open text box). */
  commitTool() { this.tool.deactivate?.(this); this.requestOverlay(); }
}
