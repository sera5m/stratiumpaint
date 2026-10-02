// Text: click to place a box, type, then Enter (or right-click, or click elsewhere) to set it onto
// the layer. Shift+Enter inserts a line break instead. Escape also sets the text down — to discard
// it, clear the box first (an empty box commits nothing).
import { cropImage } from '../core/image.js';
import { paintImage, rasterize, hardenAlpha, createCanvas } from '../doc/raster.js';
import { rectIntersect } from '../core/util.js';
import { layerRect, rgbaCss } from './common.js';

const LINE = 1.2; // line height as a multiple of the font size

const cssFamily = (f) => f.split(',').map((p) => { p = p.trim(); return /^[\w-]+$/.test(p) || /^["']/.test(p) ? p : `"${p}"`; }).join(', ');
const fontString = (o) => `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${o.fontSize}px ${cssFamily(o.font)}`;

export function textTool() {
  let S = null; // { x, y, el, color, layer }

  const place = (v) => {
    if (!S) return;
    const p = v.toScreen(S.x, S.y), o = S.opts;
    Object.assign(S.el.style, {
      left: `${p.x}px`, top: `${p.y}px`,
      fontSize: `${o.fontSize * v.zoom}px`, fontFamily: cssFamily(o.font),
      fontWeight: o.bold ? '700' : '400', fontStyle: o.italic ? 'italic' : 'normal',
      color: rgbaCss(S.color), lineHeight: String(LINE),
    });
  };

  const fit = (el) => {
    const lines = el.value.split('\n');
    el.rows = Math.max(1, lines.length);
    el.cols = Math.max(4, ...lines.map((l) => l.length + 1));
  };

  const close = () => { S?.el.remove(); S = null; };

  const commit = (ed) => {
    if (!S) return;
    const s = S, text = s.el.value;
    close();
    if (!text.trim()) return;
    const doc = s.doc, layer = s.layer, o = s.opts;
    if (!doc.layers.includes(layer)) return;
    const measure = createCanvas(1, 1).getContext('2d');
    measure.font = fontString(o);
    const lines = text.split('\n');
    const lineH = Math.round(o.fontSize * LINE);
    const width = Math.ceil(Math.max(...lines.map((l) => measure.measureText(l).width))) + 4;
    const height = lineH * lines.length + 4;
    const img = rasterize(width, height, (ctx) => {
      ctx.font = fontString(o);
      ctx.textBaseline = 'top';
      ctx.fillStyle = rgbaCss(s.color);
      lines.forEach((l, i) => ctx.fillText(l, 2, 2 + i * lineH + (lineH - o.fontSize) / 2));
    });
    if (!o.aa) hardenAlpha(img);
    const dx = Math.round(s.x) - 2, dy = Math.round(s.y) - 2;
    const r = rectIntersect({ x: dx, y: dy, w: width, h: height }, layerRect(layer));
    if (!r) return;
    const before = cropImage(layer.img, r);
    paintImage(layer.img, img, dx, dy, doc.selection, o.opacity / 100);
    layer.touch(r);
    doc.commitRegion(layer, r, before, 'Text');
  };

  return {
    id: 'text', name: 'Text', key: 'T', group: 'text', cursor: 'text',
    options: ['font', 'fontSize', 'bold', 'italic', 'opacity', 'aa'],

    down(e, ed) {
      if (S) { commit(ed); }
      const layer = ed.editableLayer();
      if (!layer) return;
      const el = document.createElement('textarea');
      el.className = 'text-editor';
      el.spellcheck = false;
      el.rows = 1; el.cols = 6;
      el.addEventListener('input', () => fit(el));
      el.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Escape') { ev.preventDefault(); commit(ed); }
        else if (ev.key === 'Enter' && ev.shiftKey) {
          // Explicit newline: don't rely on the textarea's own default, since plain Enter below
          // now commits instead of the browser's usual "Enter = newline" behaviour.
          ev.preventDefault();
          const { selectionStart: s, selectionEnd: e2 } = el;
          el.value = `${el.value.slice(0, s)}\n${el.value.slice(e2)}`;
          el.selectionStart = el.selectionEnd = s + 1;
          fit(el);
        } else if (ev.key === 'Enter') { ev.preventDefault(); commit(ed); }
      });
      el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); commit(ed); });
      ed.view.stage.appendChild(el);
      S = { x: e.x, y: e.y, el, layer, doc: ed.doc, color: e.button === 2 ? ed.secondary : ed.primary, opts: { ...ed.opts } };
      place(ed.view);
      requestAnimationFrame(() => el.focus());
    },

    overlay(ctx, ed, v) { place(v); },
    deactivate(ed) { commit(ed); },
    cancel() { close(); },
  };
}
