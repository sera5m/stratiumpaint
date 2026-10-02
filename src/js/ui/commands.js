// Every user action lives here as a command: {id, label, shortcut?, enabled?(), run()}.
// Menus, keyboard shortcuts and buttons all go through this table.
import { ADJUSTMENTS } from '../core/adjustments.js';
import { EFFECTS } from '../core/effects.js';
import { Doc } from '../doc/document.js';
import { FORMATS, formatFromName, stripExt, openDocument, decodeImage, encodeDocument, imageToPng } from '../doc/io.js';
import { applyFilter, eraseSelection, fillSelection, extractSelection, pasteImage } from '../doc/ops.js';
import * as dlg from './dialogs.js';
import { putBackup, listBackups, formatWhen } from './backup.js';
import * as platform from './platform.js';
import { h } from './dom.js';

const base = (path) => path.split(/[\\/]/).pop();

export function createCommands({ ed, view }) {
  const cmds = new Map();
  const has = () => !!ed.doc;
  const hasSel = () => !!ed.doc?.selection;
  const add = (id, label, run, extra = {}) => cmds.set(id, { id, label, run, enabled: extra.enabled ?? has, ...extra });

  const guard = (fn) => async (...a) => {
    try { return await fn(...a); } catch (err) { console.error(err); ed.toast(err.message || String(err)); }
  };

  // ------------------------------------------------------------------ files

  async function openFilesInto(files) {
    for (const f of files) {
      const existing = f.path && ed.docs.find((d) => d.path === f.path);
      if (existing) { ed.activate(existing); continue; }
      try {
        const doc = await openDocument(f.bytes, f.name);
        doc.rename(f.name, f.path ?? null);
        doc.format = formatFromName(f.name);
        ed.addDoc(doc);
      } catch (err) {
        console.error(err);
        ed.toast(`Could not open ${f.name}: ${err.message}`);
      }
    }
  }

  const defaultFormat = (doc) => doc.format ?? (doc.layers.length > 1 ? 'ora' : 'png');

  /** → true when the file was written. */
  async function saveDoc(doc, forceDialog = false) {
    let { path, format } = doc;
    let name = stripExt(doc.name);
    const quickSave = platform.isNative && path && format && !forceDialog;

    if (!quickSave) {
      if (platform.isNative) {
        path = await platform.pickSavePath(`${name}.${FORMATS[defaultFormat(doc)].ext}`);
        if (!path) return false;
        format = formatFromName(path);
        if (!format) { path += '.png'; format = 'png'; }
      } else {
        const r = await dlg.webSaveDialog({
          name, format: defaultFormat(doc),
          formats: Object.entries(FORMATS).map(([k, f]) => [k, `${f.label} (.${f.ext})`]),
        });
        if (!r) return false;
        format = r.format;
        name = stripExt(r.name.trim());
      }
    }

    let quality = doc.quality ?? 0.92;
    if ((format === 'jpeg' || format === 'webp') && (!quickSave || doc.quality == null)) {
      const q = await dlg.qualityDialog(FORMATS[format].label, Math.round(quality * 100));
      if (q == null) return false;
      quality = q;
    }

    const bytes = await encodeDocument(doc, format, quality);
    if (platform.isNative && path) {
      try { await platform.backupExisting(path); } catch (err) { console.warn('Could not keep the previous file:', err); }
    }
    try {
      await putBackup({ docKey: doc.backupKey, name: doc.name, bytes, kind: 'save' });
    } catch (err) { console.warn('Could not store a backup copy:', err); }
    let fileName;
    if (platform.isNative) {
      await platform.writeFile(path, bytes);
      fileName = base(path);
    } else {
      fileName = `${name}.${FORMATS[format].ext}`;
      platform.download(fileName, bytes, FORMATS[format].mime);
    }

    doc.format = format;
    doc.quality = format === 'jpeg' || format === 'webp' ? quality : doc.quality;
    doc.rename(fileName, platform.isNative ? path : null);
    if (format === 'ora' || doc.layers.length === 1) doc.markSaved();
    else ed.toast(`Saved a flattened copy as ${fileName}. Layers are still open here; use .ora to keep them.`);
    return true;
  }

  async function closeDoc(doc = ed.doc) {
    if (!doc) return true;
    if (doc.modified) {
      ed.activate(doc);
      const r = await dlg.confirmDialog({
        title: 'Unsaved changes', message: `Save changes to "${doc.name}" before closing?`,
        buttons: [{ label: 'Save', primary: true }, { label: "Don't Save" }, { label: 'Cancel', cancel: true }],
      });
      if (r === 0) { if (!(await saveDoc(doc))) return false; } else if (r !== 1) return false;
    }
    ed.closeDoc(doc);
    return true;
  }

  async function closeAll() {
    for (const d of [...ed.docs]) if (!(await closeDoc(d))) return false;
    return true;
  }

  add('new', 'New…', guard(async () => {
    const r = await dlg.newImageDialog(ed);
    if (!r) return;
    const background = r.background === 'white' ? { r: 255, g: 255, b: 255, a: 1 }
      : r.background === 'primary' ? ed.primary : r.background === 'secondary' ? ed.secondary : null;
    ed.addDoc(new Doc(r.width, r.height, { name: 'Untitled', background }));
  }), { shortcut: 'Ctrl+N', enabled: () => true });

  add('open', 'Open…', guard(async () => openFilesInto(await platform.openFiles())), { shortcut: 'Ctrl+O', enabled: () => true });
  add('save', 'Save', guard(() => saveDoc(ed.doc)), { shortcut: 'Ctrl+S' });
  add('saveAs', 'Save As…', guard(() => saveDoc(ed.doc, true)), { shortcut: 'Ctrl+Shift+S' });
  add('saveBackup', 'Save Backup', guard(async () => {
    const doc = ed.doc;
    const bytes = await encodeDocument(doc, 'ora');
    await putBackup({ docKey: doc.backupKey, name: doc.name, bytes, kind: 'save' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${stripExt(doc.name)}.${stamp}.ora`;
    if (platform.isNative) {
      const where = await platform.writeBackup(doc.path, fileName, bytes);
      ed.toast(where ? `Backup written.` : 'Backup stored.');
    } else {
      platform.download(fileName, bytes, 'image/openraster');
      ed.toast('Backup downloaded, and kept in this browser.');
    }
  })), { shortcut: 'Ctrl+Alt+S' });
  add('restoreBackup', 'Restore Backup…', guard(async () => {
    const rows = await listBackups();
    const id = await dlg.restoreBackupDialog(rows, formatWhen);
    if (!id) return;
    const rec = rows.find((r) => r.id === id);
    if (!rec) return;
    const doc = await openDocument(rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes), rec.name);
    doc.rename(`${stripExt(rec.name)} restored`);
    ed.addDoc(doc);
    ed.toast('Restored a backup into a new image. The original file was not overwritten.');
  }), { enabled: () => true });
  add('close', 'Close', guard(() => closeDoc()), { shortcut: 'Ctrl+W' });
  add('quit', 'Quit', guard(async () => { if (await closeAll()) platform.quit(); }), { shortcut: 'Ctrl+Q', enabled: () => platform.isNative });

  // ------------------------------------------------------------------ edit

  add('undo', 'Undo', () => ed.doc.undo(), { shortcut: 'Ctrl+Z', enabled: () => ed.doc?.history.canUndo });
  add('redo', 'Redo', () => ed.doc.redo(), { shortcut: 'Ctrl+Y|Ctrl+Shift+Z', enabled: () => ed.doc?.history.canRedo });

  const copy = guard(async (cut) => {
    const layer = ed.editableLayer();
    if (!layer) return;
    const got = extractSelection(ed.doc, layer);
    if (!got) { ed.toast('Nothing to copy. Make a selection first, or Select All.'); return; }
    ed.clipboard = got.img;
    try { await platform.clipboardWriteImage(await imageToPng(got.img)); } catch (err) { console.warn('System clipboard unavailable:', err); }
    if (cut) eraseSelection(ed.doc, layer);
  });
  add('copy', 'Copy', () => copy(false), { shortcut: 'Ctrl+C' });
  add('cut', 'Cut', () => copy(true), { shortcut: 'Ctrl+X' });

  async function clipboardImage() {
    try {
      const png = await platform.clipboardReadImage();
      if (png) return await decodeImage(png);
    } catch (err) { console.warn('System clipboard unavailable:', err); }
    return ed.clipboard;
  }

  add('paste', 'Paste', guard(async () => {
    const img = await clipboardImage();
    if (!img) { ed.toast('The clipboard has no image.'); return; }
    const doc = ed.doc;
    if ((img.width > doc.width || img.height > doc.height)
      && confirm(`The pasted image (${img.width}×${img.height}) is larger than the canvas. Expand the canvas to fit it?`)) {
      doc.canvasSize(Math.max(doc.width, img.width), Math.max(doc.height, img.height), 0, 0);
    }
    const vis = view.visibleRect();
    pasteImage(doc, img, Math.max(0, vis?.x ?? 0), Math.max(0, vis?.y ?? 0));
    ed.setTool('move-pixels');
  }), { shortcut: 'Ctrl+V' });

  add('pasteNew', 'Paste Into New Image', guard(async () => {
    const img = await clipboardImage();
    if (!img) { ed.toast('The clipboard has no image.'); return; }
    const doc = new Doc(img.width, img.height, { name: 'Untitled' });
    doc.layers[0].replaceImage(img);
    ed.addDoc(doc);
  }), { shortcut: 'Ctrl+Alt+V', enabled: () => true });

  add('erase', 'Erase Selection', () => { const l = ed.editableLayer(); if (l && !eraseSelection(ed.doc, l, ed.opts.wholeImage)) ed.toast('The selection is empty.'); }, { shortcut: 'Delete' });
  add('fill', 'Fill Selection', () => { const l = ed.editableLayer(); if (l && !fillSelection(ed.doc, l, ed.primary, ed.opts.wholeImage)) ed.toast('The selection is empty.'); }, { shortcut: 'Backspace' });
  add('selectAll', 'Select All', () => ed.doc.selectAll(), { shortcut: 'Ctrl+A' });
  add('deselect', 'Deselect All', () => ed.doc.deselect(), { shortcut: 'Ctrl+D', enabled: hasSel });
  add('invertSel', 'Invert Selection', () => ed.doc.invertSelection(), { shortcut: 'Ctrl+I' });

  // ------------------------------------------------------------------ view

  add('zoomIn', 'Zoom In', () => view.zoomAt(1.25, view.width / 2, view.height / 2), { shortcut: 'Ctrl+=|Ctrl++' });
  add('zoomOut', 'Zoom Out', () => view.zoomAt(1 / 1.25, view.width / 2, view.height / 2), { shortcut: 'Ctrl+-' });
  add('zoomFit', 'Best Fit', () => view.fit(), { shortcut: 'Ctrl+B|Ctrl+0' });
  add('zoomActual', 'Actual Size (100%)', () => view.setZoom(1), { shortcut: 'Ctrl+Shift+A' });
  add('grid', 'Pixel Grid', () => ed.setOpt('grid', !ed.opts.grid), { checked: () => ed.opts.grid });

  // ------------------------------------------------------------------ image

  add('crop', 'Crop to Selection', () => { if (!ed.doc.cropToSelection()) ed.toast('Make a selection first.'); }, { shortcut: 'Ctrl+Shift+X', enabled: hasSel });
  add('resize', 'Resize Image…', guard(async () => {
    const r = await dlg.resizeDialog(ed.doc);
    if (r && (r.width !== ed.doc.width || r.height !== ed.doc.height)) ed.doc.resize(r.width, r.height, r.mode);
  }), { shortcut: 'Ctrl+R' });
  add('canvasSize', 'Canvas Size…', guard(async () => {
    const r = await dlg.canvasSizeDialog(ed.doc);
    if (r && (r.width !== ed.doc.width || r.height !== ed.doc.height)) ed.doc.canvasSize(r.width, r.height, r.ax, r.ay);
  }), { shortcut: 'Ctrl+Shift+R' });
  add('flipH', 'Flip Horizontal', () => ed.doc.flip(true));
  add('flipV', 'Flip Vertical', () => ed.doc.flip(false));
  add('rotateCW', 'Rotate 90° Clockwise', () => ed.doc.rotate(1));
  add('rotateCCW', 'Rotate 90° Counter-clockwise', () => ed.doc.rotate(3));
  add('rotate180', 'Rotate 180°', () => ed.doc.rotate(2));
  add('flatten', 'Flatten', () => ed.doc.flatten(), { shortcut: 'Ctrl+Shift+F', enabled: () => ed.doc?.layers.length > 1 });
  add('removeBg', 'Remove Background', () => {
    ed.toolById('bg-remove')?.down({}, ed);
  }, { shortcut: 'Ctrl+Shift+B' });
  add('colorRange', 'Color Range…', guard(async () => {
    const result = await dlg.colorRangeDialog(ed);
    if (result) ed.toast(result.mode === 'delete' ? `Deleted ${result.count} pixels.` : `Replaced ${result.count} pixels.`);
  })), { shortcut: 'Ctrl+Shift+C' });

  // ------------------------------------------------------------------ layers

  add('layerAdd', 'Add New Layer', () => ed.doc.addLayer(), { shortcut: 'Ctrl+Shift+N' });
  add('layerDelete', 'Delete Layer', () => { if (!ed.doc.deleteLayer()) ed.toast('An image needs at least one layer.'); }, { shortcut: 'Ctrl+Shift+Delete', enabled: () => ed.doc?.layers.length > 1 });
  add('layerDuplicate', 'Duplicate Layer', () => ed.doc.duplicateLayer(), { shortcut: 'Ctrl+Shift+D' });
  add('layerMerge', 'Merge Layer Down', () => ed.doc.mergeDown(), { shortcut: 'Ctrl+M', enabled: () => ed.doc?.active > 0 });
  add('layerUp', 'Move Layer Up', () => ed.doc.moveLayer(1), { enabled: () => ed.doc && ed.doc.active < ed.doc.layers.length - 1 });
  add('layerDown', 'Move Layer Down', () => ed.doc.moveLayer(-1), { enabled: () => ed.doc?.active > 0 });
  add('layerProps', 'Layer Properties…', () => dlg.layerPropsDialog(ed, ed.doc.layer), { shortcut: 'F4' });

  // ------------------------------------------------------------------ adjustments & effects

  const runSpec = (spec) => {
    const layer = ed.editableLayer();
    if (!layer) return;
    if (spec.params?.length) dlg.effectDialog(ed, spec);
    else if (!applyFilter(ed.doc, layer, spec, {}, ed.opts.wholeImage)) ed.toast('The selection is empty.');
  };
  for (const s of ADJUSTMENTS) add(`adj:${s.id}`, s.name + (s.params?.length ? '…' : ''), () => runSpec(s), { shortcut: s.shortcut });
  for (const s of EFFECTS) add(`fx:${s.id}`, s.name + (s.params?.length ? '…' : ''), () => runSpec(s), { shortcut: s.shortcut });
  add('wholeImage', 'Apply to Whole Image', () => ed.setOpt('wholeImage', !ed.opts.wholeImage), {
    shortcut: 'Ctrl+Shift+W', enabled: () => true, checked: () => ed.opts.wholeImage,
  });

  // ------------------------------------------------------------------ help

  add('shortcuts', 'Keyboard Shortcuts', () => dlg.infoDialog('Keyboard Shortcuts', shortcutsBody(cmds, ed), 560), { shortcut: 'F1', enabled: () => true });
  add('about', 'About Stratum', () => dlg.infoDialog('About Stratum', aboutBody(), 420), { enabled: () => true });

  return { cmds, openFilesInto, closeDoc, closeAll, saveDoc };
}

// ---------------------------------------------------------------------- help content

function shortcutsBody(cmds, ed) {
  const row = (a, b) => h('tr', null, h('td', null, a), h('td', { class: 'keys' }, b));
  const pretty = (s) => s.split('|')[0];
  const toolKeys = new Map();
  for (const t of ed.tools) toolKeys.set(t.key, [...(toolKeys.get(t.key) ?? []), t.name]);
  return h('div', { class: 'shortcuts' },
    h('h4', null, 'Tools (press again to cycle)'),
    h('table', null, [...toolKeys].map(([k, names]) => row(names.join(' / '), k))),
    h('h4', null, 'Selecting'),
    h('table', null,
      row('Add to selection', 'Ctrl + drag'), row('Subtract from selection', 'Alt + drag'),
      row('Intersect', 'Ctrl + Alt + drag'), row('Invert overlap (xor)', 'Right-drag'),
      row('Square / circle / 15° line', 'Shift + drag')),
    h('h4', null, 'Painting'),
    h('table', null,
      row('Use secondary colour', 'Right button'), row('Swap colours', 'X'), row('Brush size', '[  and  ]'),
      row('Clone Stamp: set source', 'Ctrl + click'), row('Cancel the current drag', 'Esc'),
      row('Text: line break', 'Shift+Enter'), row('Text: set it down', 'Enter, right-click, or Esc'),
      row('Move tools: set it down', 'Enter or right-click'), row('Move tools: cancel', 'Esc')),
    h('h4', null, 'Navigation'),
    h('table', null, row('Pan', 'Space + drag, middle-drag, or scroll'), row('Zoom', 'Ctrl + scroll')),
    h('h4', null, 'Commands'),
    h('table', null, [...cmds.values()].filter((c) => c.shortcut).map((c) => row(c.label.replace('…', ''), pretty(c.shortcut)))));
}

function aboutBody() {
  return h('div', { class: 'about' },
    h('p', null, 'Stratum is a layered raster image editor in the spirit of Paint.NET, built for Linux.'),
    h('p', null, 'Layers, selections, unlimited-ish undo history, adjustments, effects, OpenRaster (.ora) support.'),
    h('p', { class: 'dim' }, 'Runs on Electron; the editing core has no dependencies.'));
}
