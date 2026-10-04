// Toolbox, tool options bar, layers / history / colours panels, document tabs and the status bar.
import { GRADIENT_TYPES, PATTERN_TYPES } from '../core/fill.js';
import { maskBounds } from '../core/mask.js';
import { rgbToHex } from '../core/color.js';
import { debounce, clear, h } from './dom.js';
import { icon } from './icons.js';
import { colorDialog } from './dialogs.js';

// ---------------------------------------------------------------------- toolbox

export function buildToolbox(root, ed) {
  const buttons = new Map();
  let lastGroup = null;
  for (const t of ed.tools) {
    if (lastGroup && t.group !== lastGroup) root.append(h('div', { class: 'tool-sep' }));
    lastGroup = t.group;
    const b = h('button', {
      class: 'tool-btn', type: 'button', title: `${t.name} (${t.key})`, 'aria-label': t.name,
      onClick: () => ed.setTool(t.id),
    }, icon(t.id, 20));
    buttons.set(t.id, b);
    root.append(b);
  }
  const sync = () => buttons.forEach((b, id) => b.classList.toggle('active', ed.tool.id === id));
  ed.on('tool', sync);
  sync();
}

// ---------------------------------------------------------------------- tool options

const FONTS = ['DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans', 'Liberation Serif', 'Liberation Mono',
  'Noto Sans', 'Noto Serif', 'Noto Sans Mono', 'Ubuntu', 'Cantarell', 'Inter', 'Roboto', 'Fira Sans', 'JetBrains Mono',
  'Source Code Pro', 'Arial', 'Times New Roman', 'Courier New', 'sans-serif', 'serif', 'monospace'];

const OPTIONS = {
  selMode: { type: 'seg', label: 'Mode', items: [['replace', 'Replace'], ['union', 'Add'], ['subtract', 'Subtract'], ['xor', 'Xor'], ['intersect', 'Intersect']] },
  size: { type: 'range', label: 'Size', min: 1, max: 200, unit: 'px' },
  hardness: { type: 'range', label: 'Hardness', min: 0, max: 100, unit: '%' },
  opacity: { type: 'range', label: 'Opacity', min: 0, max: 100, unit: '%' },
  radius: { type: 'range', label: 'Corners', min: 0, max: 100, unit: 'px' },
  tolerance: { type: 'range', label: 'Tolerance', min: 0, max: 100, unit: '%' },
  patternSize: { type: 'range', label: 'Cell', min: 2, max: 128, unit: 'px' },
  fontSize: { type: 'number', label: 'Size', min: 4, max: 500 },
  aa: { type: 'toggle', label: 'Antialiasing' },
  bold: { type: 'toggle', label: 'B', title: 'Bold', cls: 'bold' },
  italic: { type: 'toggle', label: 'I', title: 'Italic', cls: 'italic' },
  flood: { type: 'select', label: 'Fill', items: [['contiguous', 'Contiguous'], ['global', 'Global']] },
  sampling: { type: 'select', label: 'Sample', items: [['image', 'Image'], ['layer', 'Layer']] },
  shape: { type: 'select', label: 'Style', items: [['outline', 'Outline'], ['fill', 'Filled'], ['both', 'Outline + fill']] },
  gradient: { type: 'select', label: 'Type', items: GRADIENT_TYPES },
  pattern: { type: 'select', label: 'Fill with', items: [['solid', 'Solid colour'], ...PATTERN_TYPES] },
  font: { type: 'font', label: 'Font' },
};

export function buildOptionsBar(root, ed) {
  let syncs = [];

  const control = (key) => {
    const def = OPTIONS[key];
    if (!def) return null;
    const get = () => ed.opts[key];
    const wrap = (...kids) => h('label', { class: 'opt' }, def.label ? h('span', { class: 'opt-label' }, def.label) : null, ...kids);

    switch (def.type) {
      case 'range': {
        const rng = h('input', { type: 'range', min: def.min, max: def.max, step: 1, value: get(), 'aria-label': def.label });
        const out = h('span', { class: 'opt-value' });
        const sync = () => { rng.value = get(); out.textContent = `${get()}${def.unit ?? ''}`; };
        rng.addEventListener('input', () => ed.setOpt(key, parseInt(rng.value, 10)));
        syncs.push(sync); sync();
        return wrap(rng, out);
      }
      case 'number': {
        const num = h('input', { type: 'number', class: 'num', min: def.min, max: def.max, step: 1, value: get(), 'aria-label': def.label });
        num.addEventListener('input', () => { const v = parseInt(num.value, 10); if (v >= def.min && v <= def.max) ed.setOpt(key, v); });
        syncs.push(() => { if (document.activeElement !== num) num.value = get(); });
        return wrap(num);
      }
      case 'toggle': {
        const b = h('button', { type: 'button', class: `opt-toggle ${def.cls ?? ''}`, title: def.title ?? def.label, onClick: () => ed.setOpt(key, !get()) }, def.label);
        const sync = () => { b.classList.toggle('on', !!get()); b.setAttribute('aria-pressed', String(!!get())); };
        syncs.push(sync); sync();
        return h('div', { class: 'opt' }, b);
      }
      case 'select': {
        const sel = h('select', { 'aria-label': def.label }, def.items.map(([v, l]) => h('option', { value: v }, l)));
        sel.addEventListener('change', () => ed.setOpt(key, sel.value));
        syncs.push(() => { sel.value = get(); }); sel.value = get();
        return wrap(sel);
      }
      case 'seg': {
        const group = h('div', { class: 'seg', role: 'group', 'aria-label': def.label });
        const btns = def.items.map(([v, l]) => {
          const b = h('button', { type: 'button', title: l, class: `seg-btn seg-${v}`, onClick: () => ed.setOpt(key, v) }, l);
          group.append(b);
          return [v, b];
        });
        const sync = () => btns.forEach(([v, b]) => b.classList.toggle('on', get() === v));
        syncs.push(sync); sync();
        return h('div', { class: 'opt' }, h('span', { class: 'opt-label' }, def.label), group);
      }
      case 'font': {
        const inp = h('input', { type: 'text', class: 'font-input', list: 'font-list', value: get(), spellcheck: false, 'aria-label': 'Font family' });
        inp.addEventListener('input', () => { if (inp.value.trim()) ed.setOpt(key, inp.value.trim()); });
        syncs.push(() => { if (document.activeElement !== inp) inp.value = get(); });
        return wrap(inp);
      }
      default:
        return null;
    }
  };

  const rebuild = () => {
    syncs = [];
    clear(root);
    root.append(h('span', { class: 'opt-tool' }, ed.tool.name));
    for (const key of ed.tool.options ?? []) {
      const c = control(key);
      if (c) root.append(c);
    }
    root.append(h('span', { class: 'opt-spacer' }));
    if (ed.tool.id === 'clone') root.append(h('span', { class: 'opt-hint' }, 'Ctrl+click to set the source'));
    if (ed.tool.id === 'text') root.append(h('span', { class: 'opt-hint' }, 'Ctrl+Enter to commit'));
  };

  document.getElementById('font-list')?.append(...FONTS.map((f) => h('option', { value: f })));
  ed.on('tool', rebuild);
  ed.on('opts', () => syncs.forEach((s) => s()));
  rebuild();
}

// ---------------------------------------------------------------------- document tabs

export function buildTabs(root, ed, closeDoc) {
  const render = () => {
    clear(root);
    for (const doc of ed.docs) {
      const tab = h('div', {
        class: `tab${doc === ed.doc ? ' active' : ''}${doc.session ? ' on-model' : ''}`, role: 'tab',
        title: doc.session ? `${doc.name} — on the model` : (doc.path ?? doc.name),
        onPointerdown: (e) => { if (e.button === 1) { e.preventDefault(); closeDoc(doc); } else if (e.button === 0) ed.activate(doc); },
      },
      h('span', { class: 'tab-name' }, doc.name), doc.modified ? h('span', { class: 'tab-dot', title: 'Unsaved changes' }, '•') : null,
      h('button', {
        class: 'tab-close', type: 'button', 'aria-label': `Close ${doc.name}`,
        onPointerdown: (e) => e.stopPropagation(), onClick: (e) => { e.stopPropagation(); closeDoc(doc); },
      }, icon('x', 12)));
      root.append(tab);
    }
    root.hidden = ed.docs.length === 0;
  };
  ed.on('docs', render);
  ed.on('doc', render);
  ed.on('doc:meta', render);
  render();
}

// ---------------------------------------------------------------------- layers

export function buildLayersPanel(root, ed, cmds) {
  const list = h('div', { class: 'layer-list', role: 'listbox', 'aria-label': 'Layers' });
  const iconBtn = (name, title, id) => h('button', {
    class: 'icon-btn', type: 'button', title, 'aria-label': title,
    onClick: () => { const c = cmds.get(id); if (c && (!c.enabled || c.enabled())) c.run(); },
  }, icon(name, 16));
  const buttons = h('div', { class: 'panel-buttons' },
    iconBtn('plus', 'Add new layer', 'layerAdd'), iconBtn('copy', 'Duplicate layer', 'layerDuplicate'),
    iconBtn('trash', 'Delete layer', 'layerDelete'), iconBtn('up', 'Move layer up', 'layerUp'),
    iconBtn('down', 'Move layer down', 'layerDown'), iconBtn('merge', 'Merge layer down', 'layerMerge'),
    iconBtn('props', 'Layer properties', 'layerProps'));
  root.append(h('h3', null, 'Layers'), list, buttons);

  const thumbs = new Map(); // layer → canvas

  const drawThumb = (canvas, layer) => {
    const g = canvas.getContext('2d'), w = canvas.width, hh = canvas.height;
    g.clearRect(0, 0, w, hh);
    const k = Math.min(w / layer.width, hh / layer.height), dw = layer.width * k, dh = layer.height * k;
    g.imageSmoothingQuality = 'medium';
    g.drawImage(layer.canvas, (w - dw) / 2, (hh - dh) / 2, dw, dh);
  };

  const render = () => {
    clear(list);
    thumbs.clear();
    const doc = ed.doc;
    if (!doc) return;
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      const thumb = h('canvas', { class: 'thumb', width: 44, height: 32 });
      thumbs.set(l, thumb);
      drawThumb(thumb, l);
      const row = h('div', {
        class: `layer-row${i === doc.active ? ' active' : ''}${l.visible ? '' : ' hidden-layer'}`, role: 'option', 'aria-selected': String(i === doc.active),
        onClick: () => doc.selectLayer(i),
        onDblclick: () => cmds.get('layerProps').run(),
      },
      h('button', {
        class: 'eye', type: 'button', title: l.visible ? 'Hide layer' : 'Show layer', 'aria-label': l.visible ? 'Hide layer' : 'Show layer',
        onClick: (e) => { e.stopPropagation(); doc.setLayerProps(l, { visible: !l.visible }, l.visible ? 'Hide Layer' : 'Show Layer'); },
      }, icon(l.visible ? 'eye' : 'eye-off', 16)),
      thumb,
      h('div', { class: 'layer-info' },
        h('span', { class: 'layer-name' }, l.name),
        h('span', { class: 'layer-sub' }, `${Math.round(l.opacity * 100)}%${l.blend !== 'source-over' ? ` · ${l.blend}` : ''}`)));
      list.append(row);
    }
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  const refreshThumbs = debounce(() => { for (const [l, c] of thumbs) drawThumb(c, l); }, 250);
  ed.on('doc', render);
  ed.on('doc:layers', render);
  ed.on('doc:size', render);
  ed.on('doc:render', refreshThumbs);
  render();
}

// ---------------------------------------------------------------------- history

export function buildHistoryPanel(root, ed) {
  const list = h('div', { class: 'history-list', role: 'tree', 'aria-label': 'History' });
  const undo = h('button', { class: 'icon-btn', type: 'button', title: 'Undo', 'aria-label': 'Undo', onClick: () => ed.doc?.undo() }, icon('undo', 16));
  const redo = h('button', { class: 'icon-btn', type: 'button', title: 'Redo', 'aria-label': 'Redo', onClick: () => ed.doc?.redo() }, icon('redo', 16));
  root.append(
    h('h3', { title: 'Every edit, including ones you undid and replaced' }, 'History'),
    list,
    h('div', { class: 'panel-buttons' }, undo, redo),
  );

  const render = () => {
    clear(list);
    const doc = ed.doc;
    undo.disabled = !doc?.history.canUndo;
    redo.disabled = !doc?.history.canRedo;
    if (!doc) return;
    const flat = [];
    const walk = (node) => { flat.push(node); for (const child of node.children) walk(child); };
    walk(doc.history.tree());
    for (const node of flat) {
      list.append(h('div', {
        class: `history-row${node.current ? ' current' : ''}${node.future ? ' undone' : ''}${node.side ? ' side' : ''}`,
        role: 'treeitem',
        'aria-selected': String(node.current),
        style: { paddingLeft: `${8 + node.depth * 14}px` },
        title: node.side ? 'Another branch of edits' : node.name,
        onClick: () => doc.history.goTo(node.id),
      }, node.depth ? node.name : node.name));
    }
    list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  };
  ed.on('doc', render);
  ed.on('doc:history', render);
  render();
}

// ---------------------------------------------------------------------- colours

const PALETTE = ['#000000', '#404040', '#808080', '#c0c0c0', '#ffffff', '#7f0000', '#ff0000', '#ff7f00', '#ffd400', '#ffff00', '#7fff00', '#00c800',
  '#007f3f', '#00ffff', '#007fff', '#0000ff', '#3f007f', '#7f00ff', '#ff00ff', '#ff007f', '#7f3f00', '#ffb27f', '#ffd7b5', '#a0522d'];

export function buildColorsPanel(root, ed) {
  const css = (c) => `rgba(${c.r},${c.g},${c.b},${c.a ?? 1})`;
  const prim = h('button', { class: 'swatch primary', type: 'button', title: 'Primary colour (click to change)', 'aria-label': 'Primary colour', onClick: () => colorDialog(ed, 'primary') }, h('span', { class: 'fill' }));
  const sec = h('button', { class: 'swatch secondary', type: 'button', title: 'Secondary colour (click to change)', 'aria-label': 'Secondary colour', onClick: () => colorDialog(ed, 'secondary') }, h('span', { class: 'fill' }));
  const swap = h('button', { class: 'icon-btn swap', type: 'button', title: 'Swap colours (X)', 'aria-label': 'Swap colours', onClick: () => ed.swapColors() }, icon('swap', 14));
  const reset = h('button', { class: 'icon-btn reset', type: 'button', title: 'Reset to black and white', 'aria-label': 'Reset colours', onClick: () => ed.resetColors() }, icon('reset', 14));

  const palette = h('div', { class: 'palette' }, PALETTE.map((hex) => {
    const b = h('button', { class: 'pal', type: 'button', title: `${hex} (left: primary, right: secondary)`, 'aria-label': hex, style: { background: hex } });
    const c = { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a: 1 };
    b.addEventListener('click', () => { ed.setPrimary(c); ed.noteRecentColor(c); });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); ed.setSecondary(c); ed.noteRecentColor(c); });
    return b;
  }));

  const recentLabel = h('h3', { class: 'recent-label' }, 'Recent');
  const recent = h('div', { class: 'palette recent' });
  const renderRecent = () => {
    clear(recent);
    for (const c of ed.recentColors) {
      const hex = rgbToHex(c);
      const b = h('button', { class: 'pal', type: 'button', title: `${hex} (left: primary, right: secondary)`, 'aria-label': hex, style: { background: `rgba(${c.r},${c.g},${c.b},${c.a})` } });
      b.addEventListener('click', () => ed.setPrimary(c));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); ed.setSecondary(c); });
      recent.append(b);
    }
    recentLabel.hidden = recent.hidden = ed.recentColors.length === 0;
  };
  ed.on('recentColors', renderRecent);
  renderRecent();

  root.append(h('h3', null, 'Colors'), h('div', { class: 'swatches' }, sec, prim, swap, reset), palette, recentLabel, recent);
  const sync = () => {
    prim.firstChild.style.background = css(ed.primary);
    sec.firstChild.style.background = css(ed.secondary);
    prim.title = `Primary colour ${rgbToHex(ed.primary)}`;
    sec.title = `Secondary colour ${rgbToHex(ed.secondary)}`;
  };
  ed.on('colors', sync);
  sync();
}

// ---------------------------------------------------------------------- status bar

export function buildStatusbar(root, ed, view) {
  const hint = h('span', { class: 'st-hint' });
  const pos = h('span', { class: 'st-item', title: 'Pointer position' });
  const sel = h('span', { class: 'st-item', title: 'Selection size' });
  const size = h('span', { class: 'st-item', title: 'Image size' });
  const zoomOut = h('button', { class: 'icon-btn', type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onClick: () => view.zoomAt(1 / 1.25, view.width / 2, view.height / 2) }, '−');
  const zoomIn = h('button', { class: 'icon-btn', type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onClick: () => view.zoomAt(1.25, view.width / 2, view.height / 2) }, '+');
  const zoom = h('button', { class: 'st-zoom', type: 'button', title: 'Click for best fit', onClick: () => view.fit() });
  root.append(hint, h('span', { class: 'opt-spacer' }), pos, sel, size, zoomOut, zoom, zoomIn);

  const HINTS = {
    'rect-select': 'Drag to select. Ctrl adds, Alt subtracts, Shift makes a square.',
    'ellipse-select': 'Drag to select. Ctrl adds, Alt subtracts, Shift makes a circle.',
    lasso: 'Drag to draw a free-form selection.',
    wand: 'Click to select similar colours.',
    'move-pixels': 'Drag inside to move. Drag a corner or edge to scale, or scroll. Shift keeps proportions. Enter or right-click sets it down; Esc cancels.',
    'move-selection': 'Drag to move the selection outline only. Enter or right-click sets it down; Esc cancels.',
    zoom: 'Click to zoom in, right-click to zoom out, drag a box to zoom to it.',
    pan: 'Drag to pan. You can also hold Space with any tool.',
    bucket: 'Click to fill. Right-click fills with the secondary colour.',
    gradient: 'Drag from start to end. Right-drag reverses the colours.',
    brush: 'Drag to paint. Right button uses the secondary colour. [ and ] change size.',
    pencil: 'Drag to draw single hard pixels.',
    eraser: 'Drag to erase to transparency.',
    clone: 'Ctrl+click to choose a source, then drag to paint from it.',
    picker: 'Click to pick a colour. Right-click sets the secondary colour.',
    line: 'Drag to draw a line. Shift snaps to 15°.',
    rect: 'Drag to draw a rectangle. Shift makes a square.',
    roundrect: 'Drag to draw a rounded rectangle.',
    ellipse: 'Drag to draw an ellipse. Shift makes a circle.',
    text: 'Click where the text should start, type, then Ctrl+Enter.',
  };

  const update = () => {
    const doc = ed.doc;
    hint.textContent = HINTS[ed.tool.id] ?? '';
    size.textContent = doc ? `${doc.width} × ${doc.height}` : '';
    const b = doc?.selection && maskBounds(doc.selection);
    sel.textContent = b ? `Selection ${b.w} × ${b.h}` : '';
    zoom.textContent = doc ? `${Math.round(view.zoom * (view.zoom < 0.1 ? 1000 : 100)) / (view.zoom < 0.1 ? 10 : 1)}%` : '';
    zoomIn.disabled = zoomOut.disabled = zoom.disabled = !doc;
  };
  ed.on('cursor', (x, y) => { pos.textContent = x == null || !ed.doc ? '' : `${Math.floor(x)}, ${Math.floor(y)}`; });
  for (const ev of ['doc', 'tool', 'view', 'doc:selection', 'doc:size']) ed.on(ev, update);
  update();
}
