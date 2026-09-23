// Modal dialogs. `modal()` is the primitive; the rest build on it.
import { clamp } from '../core/util.js';
import { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb } from '../core/color.js';
import { defaultParams } from '../core/adjustments.js';
import { BLEND_MODES } from '../core/blend.js';
import { FilterSession } from '../doc/ops.js';
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
  const session = new FilterSession(doc, layer, spec);
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

export function newImageDialog(ed) {
  const values = { width: 1280, height: 720, background: 'white' };
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
  };
  const fromHsv = (skip) => commit(hsvToRgb(hue, s, v), skip);
  const fromRgb = (rgb, skip) => { ({ h: hue, s, v } = rgbToHsv(rgb.r, rgb.g, rgb.b)); hueSlider.value = Math.round(hue); commit(rgb, skip); };

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

  modal({
    title: `${which === 'primary' ? 'Primary' : 'Secondary'} Color`, width: 320, body,
    buttons: [{ label: 'Cancel', cancel: true }, { label: 'OK', primary: true }],
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
