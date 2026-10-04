// Modal dialogs. `modal()` is the primitive; the rest build on it.
import { clamp } from '../core/util.js';
import { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, powerSteps, stepValueAt, indexOfStep } from '../core/color.js';
import { defaultParams } from '../core/adjustments.js';
import { BLEND_MODES } from '../core/blend.js';
import { FilterSession } from '../doc/ops.js';
import { applyColorRange } from '../core/colorrange.js';
import { h } from './dom.js';

const stack = [];
export const isModalOpen = () => stack.length > 0;

/**
 * buttons: [{label, primary?, cancel?, keepOpen?, onClick?(api)}]
 * onClick may return false to keep the dialog open. Escape and the backdrop act like the cancel button.
 */
export function modal({ title, body, buttons = [], width = 380, onCancel }) {
  const root = document.getElementById('modal-root');
  const previous = document.activeElement;
  const backdrop = h('div', { class: 'modal-backdrop' });
  let closed = false;

  const api = {
    close() {
      if (closed) return;
      closed = true;
      stack.splice(stack.indexOf(api), 1);
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    },
    el: null,
  };
  const cancel = () => { api.close(); onCancel?.(); };
  const activate = (b) => {
    if (b.keepOpen) { b.onClick?.(api); return; }
    if (b.onClick?.(api) === false) return;
    api.close();
    if (b.cancel) onCancel?.();
  };
  const onKey = (e) => {
    if (stack[stack.length - 1] !== api) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === 'Enter' && !['TEXTAREA', 'BUTTON', 'SELECT'].includes(e.target.tagName)) {
      const p = buttons.find((b) => b.primary);
      if (p) { e.preventDefault(); e.stopPropagation(); activate(p); }
    }
  };

  const dlg = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: { width: `${width}px` } },
    h('div', { class: 'modal-title' }, title),
    h('div', { class: 'modal-body' }, body),
    buttons.length ? h('div', { class: 'modal-actions' }, buttons.map((b) => h('button', {
      class: `btn${b.primary ? ' primary' : ''}`, type: 'button', onClick: () => activate(b),
    }, b.label))) : null);
  api.el = dlg;
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) cancel(); });
  backdrop.append(dlg);
  root.append(backdrop);
  stack.push(api);
  document.addEventListener('keydown', onKey, true);
  (dlg.querySelector('input:not([type=range]), select, textarea') ?? dlg.querySelector('.btn.primary'))?.focus();
  return api;
}

// ---------------------------------------------------------------------- forms

let uid = 0;

/** Build labelled controls for a params spec; `values` is updated in place. */
export function buildFields(fields, values, onChange) {
  const grid = h('div', { class: 'fields' });
  for (const f of fields) {
    const id = `fld-${++uid}`;
    const set = (v) => { values[f.id] = v; onChange?.(f.id, v, values); };
    let control;
    switch (f.type) {
      case 'range': {
        const step = f.step ?? 1;
        const rng = h('input', { id, type: 'range', min: f.min, max: f.max, step, value: values[f.id] });
        const num = h('input', { type: 'number', class: 'num', min: f.min, max: f.max, step, value: values[f.id], 'aria-label': f.label });
        rng.addEventListener('input', () => { num.value = rng.value; set(parseFloat(rng.value)); });
        num.addEventListener('input', () => {
          const v = parseFloat(num.value);
          if (Number.isFinite(v)) { rng.value = v; set(clamp(v, f.min, f.max)); }
        });
        control = h('div', { class: 'range-row' }, rng, num);
        break;
      }
      case 'number': {
        control = h('input', { id, type: 'number', class: 'num', min: f.min, max: f.max, step: f.step ?? 1, value: values[f.id] });
        control.addEventListener('input', () => { const v = parseFloat(control.value); if (Number.isFinite(v)) set(v); });
        break;
      }
      case 'checkbox':
        control = h('input', { id, type: 'checkbox', checked: !!values[f.id] });
        control.addEventListener('change', () => set(control.checked));
        break;
      case 'color':
        control = h('input', { id, type: 'color', value: values[f.id] });
        control.addEventListener('input', () => set(control.value));
        break;
      case 'select':
        control = h('select', { id }, f.options.map(([v, label]) => h('option', { value: v, selected: v === values[f.id] }, label)));
        control.addEventListener('change', () => set(control.value));
        break;
      default:
        control = h('input', { id, type: 'text', value: values[f.id] ?? '' });
        control.addEventListener('input', () => set(control.value));
    }
    grid.append(h('label', { class: 'field-label', for: id }, f.label), control);
  }
  return grid;
}

/** Generic "fill in some fields" dialog → values, or null when cancelled. */
export function formDialog({ title, fields, values, okLabel = 'OK', width = 380, validate }) {
  return new Promise((resolve) => {
    modal({
      title, width, body: buildFields(fields, values),
      buttons: [
        { label: 'Cancel', cancel: true },
        { label: okLabel, primary: true, onClick: () => {
          const err = validate?.(values);
          if (err) { alert(err); return false; }
          resolve({ ...values });
        } },
      ],
      onCancel: () => resolve(null),
    });
  });
}

export function saveUnfinishedDialog({ name, kind, where, discardable = true }) {
  const values = { name };
  return new Promise((resolve) => {
    const body = h('div', null,
      h('p', { class: 'msg' }, 'The working copy lives only inside the program. It is deleted when you close, unless you save it out.'),
      h('p', { class: 'dim' }, where),
      buildFields([{ id: 'name', label: 'Save as', type: 'text' }], values),
      h('p', { class: 'dim' }, `Saved as a .${kind} file, which is a zip of the layers${kind === '3dlayered' ? ' and the model' : ''}.`),
    );
    const buttons = [{ label: 'Cancel', cancel: true }];
    if (discardable) buttons.push({ label: 'Discard', onClick: () => resolve({ action: 'discard' }) });
    buttons.push({
      label: 'Save', primary: true, onClick: () => {
        const n = String(values.name ?? '').trim();
        if (!n) { alert('Name the file first.'); return false; }
        resolve({ action: 'save', name: n });
      },
    });
    modal({ title: 'Save unfinished work as', width: 480, body, buttons, onCancel: () => resolve(null) });
  });
}

export function confirmDialog({ title, message, buttons }) {
  return new Promise((resolve) => {
    modal({
      title, width: 420, body: h('p', { class: 'msg' }, message),
      buttons: buttons.map((b, i) => ({ label: b.label, primary: b.primary, cancel: b.cancel, onClick: () => resolve(i) })),
      onCancel: () => resolve(-1),
    });
  });
}

export const infoDialog = (title, body, width = 460) =>
  new Promise((resolve) => modal({ title, body, width, buttons: [{ label: 'Close', primary: true, onClick: () => resolve() }], onCancel: resolve }));

// ---------------------------------------------------------------------- adjustments & effects

/** Live-preview dialog for an adjustment or effect. */
export function effectDialog(ed, spec) {
  const doc = ed.doc, layer = ed.editableLayer();
  if (!layer) return;
  const values = defaultParams(spec);
  const session = new FilterSession(doc, layer, spec, { ignoreSelection: ed.opts.wholeImage });
  let timer = 0;
  const preview = () => { clearTimeout(timer); timer = setTimeout(() => session.preview(values), 30); };
  const body = h('div', null);
  const build = () => { body.replaceChildren(buildFields(spec.params, values, preview)); };
  build();
  modal({
    title: spec.name, body, width: 420,
    buttons: [
      { label: 'Reset', keepOpen: true, onClick: () => { Object.assign(values, defaultParams(spec)); build(); preview(); } },
      { label: 'Cancel', cancel: true },
      { label: 'OK', primary: true, onClick: () => { clearTimeout(timer); session.preview(values); session.commit(); } },
    ],
    onCancel: () => { clearTimeout(timer); session.cancel(); },
  });
  session.preview(values);
}

// ---------------------------------------------------------------------- image dialogs

export function unwrapDialog({ hasUV }) {
  const values = { angle: 66, padding: 64, resolution: '1024', pxPerM: 0, useExisting: !!hasUV };
  const fields = [
    { id: 'angle', label: 'Cut where the surface bends more than (°)', type: 'number', min: 1, max: 180 },
    { id: 'padding', label: 'Pixel separation between areas or objects', type: 'number', min: 0, max: 512 },
    { id: 'resolution', label: 'Longest side', type: 'select', options: [['512', '512'], ['1024', '1024'], ['2048', '2048'], ['4096', '4096']] },
    { id: 'pxPerM', label: 'Pixels per metre (0 fits the atlas)', type: 'number', min: 0, max: 8192, step: 1 },
  ];
  if (hasUV) fields.unshift({ id: 'useExisting', label: 'Keep the UVs already in the file', type: 'checkbox' });
  return formDialog({
    title: 'Unwrap model', okLabel: 'Unwrap', width: 460, fields, values,
    validate(v) {
      if (!(+v.angle >= 1 && +v.angle <= 180)) return 'Angle must be between 1 and 180.';
      if (!(+v.padding >= 0 && +v.padding <= 512)) return 'Separation must be between 0 and 512 pixels.';
      if (!(+v.pxPerM >= 0 && +v.pxPerM <= 8192)) return 'Pixels per metre must be between 0 and 8192.';
      return null;
    },
  });
}

export function faceLimitDialog(groups, selected) {
  const names = [...new Set((groups || []).map((g) => g.name).filter(Boolean))];
  const picked = new Set(selected?.length ? selected : names);
  return new Promise((resolve) => {
    if (!names.length) { resolve([]); return; }
    const boxes = names.map((name) => {
      const input = h('input', { type: 'checkbox' });
      input.checked = picked.has(name);
      return { name, input, row: h('label', { class: 'check' }, input, ` ${name}`) };
    });
    modal({
      title: 'Limit to faces', width: 380,
      body: h('div', null,
        h('p', { class: 'msg' }, 'Draw this image only onto the ticked faces. The source picture is not modified.'),
        ...boxes.map((b) => b.row)),
      buttons: [
        { label: 'Cancel', cancel: true },
        { label: 'Apply', primary: true, onClick: () => resolve(boxes.filter((b) => b.input.checked).map((b) => b.name)) },
      ],
      onCancel: () => resolve(null),
    });
  });
}

export function newImageDialog(ed, defaults = {}) {
  const values = { width: 1280, height: 720, background: 'white', ...defaults };
  const presets = [['1280 × 720', 1280, 720], ['1920 × 1080', 1920, 1080], ['800 × 600', 800, 600], ['512 × 512', 512, 512], ['64 × 64', 64, 64]];
  return new Promise((resolve) => {
    const grid = buildFields([
      { id: 'width', label: 'Width (px)', type: 'number', min: 1, max: 16000 },
      { id: 'height', label: 'Height (px)', type: 'number', min: 1, max: 16000 },
      { id: 'background', label: 'Background', type: 'select', options: [['white', 'White'], ['transparent', 'Transparent'], ['primary', 'Primary colour'], ['secondary', 'Secondary colour']] },
    ], values);
    const setSize = (w, hh) => {
      values.width = w; values.height = hh;
      const [wi, hi] = grid.querySelectorAll('input[type=number]');
      wi.value = w; hi.value = hh;
    };
    const chips = h('div', { class: 'chips' }, presets.map(([label, w, hh]) => h('button', { class: 'chip', type: 'button', onClick: () => setSize(w, hh) }, label)));
    modal({
      title: 'New Image', width: 400, body: h('div', null, grid, chips),
      buttons: [
        { label: 'Cancel', cancel: true },
        { label: 'Create', primary: true, onClick: () => {
          const w = Math.round(values.width), hh = Math.round(values.height);
          if (!(w >= 1 && w <= 16000 && hh >= 1 && hh <= 16000)) { alert('Width and height must be between 1 and 16000 pixels.'); return false; }
          resolve({ width: w, height: hh, background: values.background });
        } },
      ],
      onCancel: () => resolve(null),
    });
  });
}

export function resizeDialog(doc) {
  const ratio = doc.width / doc.height;
  const v = { width: doc.width, height: doc.height, lock: true, mode: 'smooth' };
  return new Promise((resolve) => {
    const w = h('input', { type: 'number', class: 'num', min: 1, max: 32000, value: v.width, 'aria-label': 'Width' });
    const hh = h('input', { type: 'number', class: 'num', min: 1, max: 32000, value: v.height, 'aria-label': 'Height' });
    const pct = h('input', { type: 'number', class: 'num', min: 1, max: 1000, value: 100, 'aria-label': 'Percent' });
    const lock = h('input', { type: 'checkbox', checked: true });
    const mode = h('select', null, h('option', { value: 'smooth' }, 'Smooth (bilinear / area)'), h('option', { value: 'nearest' }, 'Nearest neighbour (hard pixels)'));
    w.addEventListener('input', () => {
      const n = parseInt(w.value, 10);
      if (!(n > 0)) return;
      v.width = n;
      if (lock.checked) { v.height = Math.max(1, Math.round(n / ratio)); hh.value = v.height; }
      pct.value = Math.round((n / doc.width) * 100);
    });
    hh.addEventListener('input', () => {
      const n = parseInt(hh.value, 10);
      if (!(n > 0)) return;
      v.height = n;
      if (lock.checked) { v.width = Math.max(1, Math.round(n * ratio)); w.value = v.width; }
      pct.value = Math.round((n / doc.height) * 100);
    });
    pct.addEventListener('input', () => {
      const p = parseFloat(pct.value);
      if (!(p > 0)) return;
      v.width = Math.max(1, Math.round((doc.width * p) / 100));
      v.height = Math.max(1, Math.round((doc.height * p) / 100));
      w.value = v.width; hh.value = v.height;
    });
    const body = h('div', { class: 'fields' },
      h('label', { class: 'field-label' }, 'Percent'), pct,
      h('label', { class: 'field-label' }, 'Width (px)'), w,
      h('label', { class: 'field-label' }, 'Height (px)'), hh,
      h('label', { class: 'field-label' }, 'Keep aspect ratio'), lock,
      h('label', { class: 'field-label' }, 'Resampling'), mode);
    modal({
      title: 'Resize Image', width: 400, body,
      buttons: [
        { label: 'Cancel', cancel: true },
        { label: 'OK', primary: true, onClick: () => {
          if (v.width * v.height > 200e6) { alert('That would be more than 200 megapixels.'); return false; }
          resolve({ width: v.width, height: v.height, mode: mode.value });
        } },
      ],
      onCancel: () => resolve(null),
    });
  });
}

export function canvasSizeDialog(doc) {
  const v = { width: doc.width, height: doc.height, ax: 0.5, ay: 0.5 };
  return new Promise((resolve) => {
    const cells = [];
    const anchors = h('div', { class: 'anchor-grid' });
    for (const ay of [0, 0.5, 1]) {
      for (const ax of [0, 0.5, 1]) {
        const b = h('button', { type: 'button', class: 'anchor-cell', 'aria-label': `Anchor ${ax},${ay}` });
        b.addEventListener('click', () => { v.ax = ax; v.ay = ay; cells.forEach((c) => c.el.classList.toggle('on', c.ax === v.ax && c.ay === v.ay)); });
        cells.push({ el: b, ax, ay });
        anchors.append(b);
      }
    }
    cells.forEach((c) => c.el.classList.toggle('on', c.ax === 0.5 && c.ay === 0.5));
    const fields = buildFields([
      { id: 'width', label: 'Width (px)', type: 'number', min: 1, max: 32000 },
      { id: 'height', label: 'Height (px)', type: 'number', min: 1, max: 32000 },
    ], v);
    modal({
      title: 'Canvas Size', width: 380,
      body: h('div', null, fields, h('div', { class: 'field-label anchor-label' }, 'Anchor'), anchors),
      buttons: [
        { label: 'Cancel', cancel: true },
        { label: 'OK', primary: true, onClick: () => {
          if (!(v.width >= 1 && v.height >= 1) || v.width * v.height > 200e6) { alert('Please enter a valid size.'); return false; }
          resolve({ ...v });
        } },
      ],
      onCancel: () => resolve(null),
    });
  });
}

// ---------------------------------------------------------------------- layer properties

export function layerPropsDialog(ed, layer) {
  const doc = ed.doc;
  const orig = { name: layer.name, visible: layer.visible, opacity: layer.opacity, blend: layer.blend };
  const v = { name: layer.name, visible: layer.visible, opacity: Math.round(layer.opacity * 100), blend: layer.blend };
  const live = (id, val) => {
    if (id === 'opacity') layer.opacity = val / 100;
    else if (id === 'name') return;
    else layer[id] = val;
    doc.refresh();
  };
  const revert = () => { Object.assign(layer, orig); doc.refresh(); };
  modal({
    title: 'Layer Properties', width: 400,
    body: buildFields([
      { id: 'name', label: 'Name', type: 'text' },
      { id: 'visible', label: 'Visible', type: 'checkbox' },
      { id: 'blend', label: 'Blend mode', type: 'select', options: BLEND_MODES },
      { id: 'opacity', label: 'Opacity (%)', type: 'range', min: 0, max: 100, step: 1 },
    ], v, live),
    buttons: [
      { label: 'Cancel', cancel: true },
      { label: 'OK', primary: true, onClick: () => {
        revert();
        doc.setLayerProps(layer, { name: v.name.trim() || orig.name, visible: v.visible, blend: v.blend, opacity: v.opacity / 100 });
      } },
    ],
    onCancel: revert,
  });
}

// ---------------------------------------------------------------------- colour picker

// ---------------------------------------------------------------------- palette (math-generated)

const CHANNEL_ORDER = ['r', 'g', 'b'];
let paletteFixed = 'b', paletteMode = 'whole'; // remembered across dialog opens, resets on reload

/**
 * A square grid of every combination of two channels (stepped per powerSteps) with the third
 * channel held at the current colour's value, plus a ring overlay around the current colour
 * marking one and two perceptual (log-scale) steps away, coloured with what's actually out there
 * at that distance rather than a plain outline — so you can eyeball a match against the grid.
 * getCurrent() reads the live colour; onPick(rgb) is called when the user clicks a cell.
 */
function buildPaletteTab(getCurrent, onPick) {
  const GRID = 240;
  const canvas = h('canvas', { class: 'palette-canvas', width: GRID, height: GRID });
  const fixedLabel = h('span', { class: 'mini-label' });

  const seg = (options, get, set) => {
    const btns = options.map(([v, label]) => {
      const b = h('button', { type: 'button', class: 'seg-btn' }, label);
      b.addEventListener('click', () => { set(v); render(); });
      return [v, b];
    });
    const sync = () => btns.forEach(([v, b]) => b.classList.toggle('on', get() === v));
    return { el: h('div', { class: 'seg palette-seg' }, btns.map(([, b]) => b)), sync };
  };
  const fixSeg = seg([['r', 'R'], ['g', 'G'], ['b', 'B']], () => paletteFixed, (v) => { paletteFixed = v; });
  const modeSeg = seg([['whole', 'Whole'], ['half', 'Half'], ['quarter', 'Quarter']], () => paletteMode, (v) => { paletteMode = v; });

  let xKey = 'r', yKey = 'g', xSteps = [], ySteps = [];
  const cellColor = (xi, yi) => {
    const c = { r: 0, g: 0, b: 0 };
    c[paletteFixed] = getCurrent()[paletteFixed];
    c[xKey] = xSteps[xi];
    c[yKey] = ySteps[yi];
    return c;
  };

  function render() {
    fixSeg.sync(); modeSeg.sync();
    [xKey, yKey] = CHANNEL_ORDER.filter((k) => k !== paletteFixed);
    const cur = getCurrent();
    fixedLabel.textContent = `${paletteFixed.toUpperCase()} fixed at ${Math.round(cur[paletteFixed])} — X: ${xKey.toUpperCase()}, Y: ${yKey.toUpperCase()}`;
    xSteps = powerSteps(255, paletteMode);
    ySteps = powerSteps(255, paletteMode);
    const nx = xSteps.length, ny = ySteps.length, cw = GRID / nx, ch = GRID / ny;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, GRID, GRID);
    for (let yi = 0; yi < ny; yi++) {
      for (let xi = 0; xi < nx; xi++) {
        const c = cellColor(xi, ny - 1 - yi); // row 0 (top) shows the highest value
        g.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
        g.fillRect(Math.floor(xi * cw), Math.floor(yi * ch), Math.ceil(cw) + 1, Math.ceil(ch) + 1);
      }
    }
    const cxIdx = indexOfStep(xSteps, cur[xKey]), cyIdx = indexOfStep(ySteps, cur[yKey]);
    const cx = (cxIdx + 0.5) * cw, cy = GRID - (cyIdx + 0.5) * ch;
    const ringRadii = paletteMode === 'whole' ? [1, 2] : [0.5, 1, 1.5, 2];
    for (const rad of ringRadii) {
      const arcSteps = 96;
      g.lineWidth = 2.5;
      for (let i = 0; i < arcSteps; i++) {
        const a0 = (i / arcSteps) * Math.PI * 2, a1 = ((i + 1) / arcSteps) * Math.PI * 2;
        const xi = clamp(cxIdx + Math.cos(a0) * rad, 0, nx - 1), yi = clamp(cyIdx + Math.sin(a0) * rad, 0, ny - 1);
        const c = { r: 0, g: 0, b: 0 };
        c[paletteFixed] = cur[paletteFixed];
        c[xKey] = stepValueAt(xSteps, xi);
        c[yKey] = stepValueAt(ySteps, yi);
        g.strokeStyle = `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
        g.beginPath();
        g.arc(cx, cy, rad * cw, a0, a1);
        g.stroke();
      }
    }
    g.lineWidth = 1.5; g.strokeStyle = '#fff';
    g.beginPath(); g.arc(cx, cy, 5, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 1; g.strokeStyle = '#000';
    g.beginPath(); g.arc(cx, cy, 5, 0, Math.PI * 2); g.stroke();
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = canvas.getBoundingClientRect();
    const xi = clamp(Math.floor(((e.clientX - r.left) / r.width) * xSteps.length), 0, xSteps.length - 1);
    const rowFromTop = clamp(Math.floor(((e.clientY - r.top) / r.height) * ySteps.length), 0, ySteps.length - 1);
    onPick(cellColor(xi, ySteps.length - 1 - rowFromTop));
    render();
  });

  render();
  const el = h('div', { class: 'palette-tab' },
    h('div', { class: 'palette-controls' },
      h('span', { class: 'mini-label' }, 'Fix'), fixSeg.el,
      h('span', { class: 'mini-label' }, 'Steps'), modeSeg.el),
    canvas, fixedLabel,
    h('p', { class: 'palette-hint dim' }, 'Click a cell to pick it. The rings mark one and two perceptual steps from the current colour, in the colours actually found there — match them against the grid.'));
  return { el, render };
}

export function colorDialog(ed, which) {
  const get = () => (which === 'primary' ? ed.primary : ed.secondary);
  const put = (c) => (which === 'primary' ? ed.setPrimary(c) : ed.setSecondary(c));
  const orig = { ...get() };
  let { h: hue, s, v } = rgbToHsv(orig.r, orig.g, orig.b);
  let alpha = orig.a ?? 1;

  const sv = h('canvas', { class: 'sv-canvas', width: 260, height: 180 });
  const hueSlider = h('input', { type: 'range', class: 'hue-slider', min: 0, max: 360, step: 1, value: Math.round(hue), 'aria-label': 'Hue' });
  const alphaSlider = h('input', { type: 'range', class: 'alpha-slider', min: 0, max: 100, step: 1, value: Math.round(alpha * 100), 'aria-label': 'Opacity' });
  const hex = h('input', { type: 'text', class: 'hex', maxLength: 7, value: rgbToHex(orig), 'aria-label': 'Hex colour' });
  const rgbInputs = ['r', 'g', 'b'].map((k) => h('input', { type: 'number', class: 'num', min: 0, max: 255, value: orig[k], 'aria-label': k.toUpperCase() }));
  const swatchOld = h('div', { class: 'swatch-half', style: { background: `rgba(${orig.r},${orig.g},${orig.b},${alpha})` } });
  const swatchNew = h('div', { class: 'swatch-half' });

  const drawSV = () => {
    const g = sv.getContext('2d'), { width: w, height: hh } = sv;
    g.fillStyle = `hsl(${hue},100%,50%)`;
    g.fillRect(0, 0, w, hh);
    let grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#fff'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, w, hh);
    grad = g.createLinearGradient(0, 0, 0, hh);
    grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, '#000');
    g.fillStyle = grad; g.fillRect(0, 0, w, hh);
    const x = s * w, y = (1 - v) * hh;
    g.lineWidth = 2; g.strokeStyle = '#000'; g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 1; g.strokeStyle = '#fff'; g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.stroke();
  };

  /** Push the current state to the editor and refresh every control except `skip`. */
  const commit = (rgb, skip) => {
    put({ ...rgb, a: alpha });
    if (skip !== 'hex') hex.value = rgbToHex(rgb);
    if (skip !== 'rgb') rgbInputs.forEach((el, i) => { el.value = [rgb.r, rgb.g, rgb.b][i]; });
    swatchNew.style.background = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
    alphaSlider.style.setProperty('--c', `${rgb.r},${rgb.g},${rgb.b}`);
    drawSV();
    palette.render();
  };
  const fromHsv = (skip) => commit(hsvToRgb(hue, s, v), skip);
  const fromRgb = (rgb, skip) => { ({ h: hue, s, v } = rgbToHsv(rgb.r, rgb.g, rgb.b)); hueSlider.value = Math.round(hue); commit(rgb, skip); };
  const palette = buildPaletteTab(get, (rgb) => { fromRgb(rgb); ed.noteRecentColor(rgb); });

  let dragging = false;
  const pick = (e) => {
    const r = sv.getBoundingClientRect();
    s = clamp((e.clientX - r.left) / r.width, 0, 1);
    v = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
    fromHsv();
  };
  sv.addEventListener('pointerdown', (e) => { sv.setPointerCapture(e.pointerId); dragging = true; pick(e); });
  sv.addEventListener('pointermove', (e) => { if (dragging) pick(e); });
  sv.addEventListener('pointerup', () => { dragging = false; });
  hueSlider.addEventListener('input', () => { hue = parseFloat(hueSlider.value); fromHsv(); });
  alphaSlider.addEventListener('input', () => { alpha = parseFloat(alphaSlider.value) / 100; fromHsv(); });
  hex.addEventListener('input', () => { const rgb = hexToRgb(hex.value); if (rgb) fromRgb(rgb, 'hex'); });
  rgbInputs.forEach((el) => el.addEventListener('input', () => {
    const [r, g, b] = rgbInputs.map((x) => clamp(parseInt(x.value, 10) || 0, 0, 255));
    fromRgb({ r, g, b }, 'rgb');
  }));

  const body = h('div', { class: 'color-dialog' },
    sv,
    h('label', { class: 'mini-label' }, 'Hue'), hueSlider,
    h('label', { class: 'mini-label' }, 'Opacity'), alphaSlider,
    h('div', { class: 'color-row' },
      h('div', { class: 'swatch-pair', title: 'Old / New' }, swatchOld, swatchNew),
      h('label', { class: 'mini-label' }, 'Hex'), hex,
      ...['R', 'G', 'B'].flatMap((l, i) => [h('label', { class: 'mini-label' }, l), rgbInputs[i]])));

  const slidersPane = h('div', null, body);
  const palettePane = h('div', { class: 'hidden-pane' }, palette.el);
  const tabSliders = h('button', { type: 'button', class: 'dlg-tab on' }, 'Sliders');
  const tabPalette = h('button', { type: 'button', class: 'dlg-tab' }, 'Palette');
  const selectTab = (name) => {
    const onSliders = name === 'sliders';
    tabSliders.classList.toggle('on', onSliders);
    tabPalette.classList.toggle('on', !onSliders);
    slidersPane.classList.toggle('hidden-pane', !onSliders);
    palettePane.classList.toggle('hidden-pane', onSliders);
    if (!onSliders) palette.render();
  };
  tabSliders.addEventListener('click', () => selectTab('sliders'));
  tabPalette.addEventListener('click', () => selectTab('palette'));

  modal({
    title: `${which === 'primary' ? 'Primary' : 'Secondary'} Color`, width: 320,
    body: h('div', null, h('div', { class: 'dlg-tabs' }, tabSliders, tabPalette), slidersPane, palettePane),
    buttons: [{ label: 'Cancel', cancel: true }, { label: 'OK', primary: true, onClick: () => ed.noteRecentColor(get()) }],
    onCancel: () => put(orig),
  });
  fromHsv();
}

// ---------------------------------------------------------------------- saving

export function qualityDialog(label, initial = 92) {
  const values = { quality: initial };
  return new Promise((resolve) => modal({
    title: `${label} quality`, width: 360,
    body: buildFields([{ id: 'quality', label: 'Quality', type: 'range', min: 1, max: 100, step: 1 }], values),
    buttons: [
      { label: 'Cancel', cancel: true },
      { label: 'Save', primary: true, onClick: () => resolve(values.quality / 100) },
    ],
    onCancel: () => resolve(null),
  }));
}

/** Browser only: choose a file name and format before downloading. */
export function webSaveDialog({ name, format, formats }) {
  const values = { name, format };
  return formDialog({
    title: 'Save As', values, okLabel: 'Save',
    fields: [
      { id: 'name', label: 'File name', type: 'text' },
      { id: 'format', label: 'Format', type: 'select', options: formats },
    ],
    validate: (v) => (v.name.trim() ? null : 'Please enter a file name.'),
  });
}

function ch8(c, key, fallback) {
  const v = c?.[key];
  if (v == null) return fallback;
  if (key === 'a') return v <= 1 ? Math.round(v * 255) : Math.round(v);
  return Math.round(v);
}

/** Live preview. A and B are the inclusive RGBA interval. Delete clears alpha; replace writes a third colour. */
export function colorRangeDialog(ed, seed = {}) {
  const layer = ed.editableLayer();
  if (!layer) return Promise.resolve(null);
  const A = seed.a ?? ed.primary, B = seed.b ?? ed.secondary;
  const values = {
    ar: ch8(A, 'r', 0), ag: ch8(A, 'g', 0), ab: ch8(A, 'b', 0), aa: ch8(A, 'a', 255),
    br: ch8(B, 'r', 255), bg: ch8(B, 'g', 255), bb: ch8(B, 'b', 255), ba: ch8(B, 'a', 255),
    mode: seed.mode ?? 'delete',
    rr: 0, rg: 0, rb: 0, ra: 0,
  };
  const ends = () => ({
    a: { r: values.ar, g: values.ag, b: values.ab, a: values.aa },
    b: { r: values.br, g: values.bg, b: values.bb, a: values.ba },
    replace: { r: values.rr, g: values.rg, b: values.rb, a: values.ra },
  });
  const spec = {
    name: 'Color Range',
    count: 0,
    apply(img) {
      const e = ends();
      const r = applyColorRange(img, e.a, e.b, { mode: values.mode, replace: e.replace });
      spec.count = r.count;
      return r.img;
    },
  };
  const session = new FilterSession(ed.doc, layer, spec, { ignoreSelection: ed.opts.wholeImage });
  let timer = 0;
  const preview = () => { clearTimeout(timer); timer = setTimeout(() => session.preview({}), 30); };
  const fields = [
    { id: 'ar', label: 'A red', type: 'number', min: 0, max: 255 },
    { id: 'ag', label: 'A green', type: 'number', min: 0, max: 255 },
    { id: 'ab', label: 'A blue', type: 'number', min: 0, max: 255 },
    { id: 'aa', label: 'A alpha', type: 'number', min: 0, max: 255 },
    { id: 'br', label: 'B red', type: 'number', min: 0, max: 255 },
    { id: 'bg', label: 'B green', type: 'number', min: 0, max: 255 },
    { id: 'bb', label: 'B blue', type: 'number', min: 0, max: 255 },
    { id: 'ba', label: 'B alpha', type: 'number', min: 0, max: 255 },
    { id: 'mode', label: 'Action', type: 'select', options: [['delete', 'Delete (clear alpha)'], ['replace', 'Replace']] },
    { id: 'rr', label: 'Replace red', type: 'number', min: 0, max: 255 },
    { id: 'rg', label: 'Replace green', type: 'number', min: 0, max: 255 },
    { id: 'rb', label: 'Replace blue', type: 'number', min: 0, max: 255 },
    { id: 'ra', label: 'Replace alpha', type: 'number', min: 0, max: 255 },
  ];
  return new Promise((resolve) => {
    const body = h('div', null);
    const note = h('p', { class: 'msg dim' }, 'Every channel is an inclusive interval from A to B. Swapped ends are fine. Primary and secondary are the starting A and B.');
    const rebuild = () => body.replaceChildren(note, buildFields(fields, values, preview));
    rebuild();
    modal({
      title: 'Color Range', width: 440, body,
      buttons: [
        { label: 'Primary / secondary', keepOpen: true, onClick: () => {
          const p = ed.primary, s = ed.secondary;
          Object.assign(values, {
            ar: ch8(p, 'r', 0), ag: ch8(p, 'g', 0), ab: ch8(p, 'b', 0), aa: ch8(p, 'a', 255),
            br: ch8(s, 'r', 0), bg: ch8(s, 'g', 0), bb: ch8(s, 'b', 0), ba: ch8(s, 'a', 255),
          });
          rebuild(); preview();
        } },
        { label: 'Cancel', cancel: true },
        { label: 'Apply', primary: true, onClick: () => {
          clearTimeout(timer);
          const ok = session.preview({}) && session.commit();
          resolve(ok ? { count: spec.count, mode: values.mode } : null);
        } },
      ],
      onCancel: () => { clearTimeout(timer); session.cancel(); resolve(null); },
    });
    preview();
  });
}

/** Pick one stored backup. rows: [{id, name, at, kind}]. → id or null. */
export function restoreBackupDialog(rows, formatWhen) {
  return new Promise((resolve) => {
    if (!rows.length) {
      modal({
        title: 'Restore Backup', width: 420,
        body: h('p', { class: 'msg' }, 'No backups yet. They appear when you save, or automatically while a document is open.'),
        buttons: [{ label: 'Close', primary: true, onClick: () => resolve(null) }],
        onCancel: () => resolve(null),
      });
      return;
    }
    let picked = rows[0].id;
    const list = h('div', { class: 'fields' }, rows.map((r) => {
      const input = h('input', { type: 'radio', name: 'bak', value: r.id, checked: r.id === picked });
      input.addEventListener('change', () => { picked = r.id; });
      return h('label', { class: 'field-label', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        input, `${r.name} — ${r.kind === 'auto' ? 'autosave' : 'save'} — ${formatWhen(r.at)}`);
    }));
    modal({
      title: 'Restore Backup', width: 480, body: list,
      buttons: [
        { label: 'Cancel', cancel: true },
        { label: 'Restore', primary: true, onClick: () => resolve(picked) },
      ],
      onCancel: () => resolve(null),
    });
  });
}
