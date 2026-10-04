// Every user action lives here as a command: {id, label, shortcut?, enabled?(), run()}.
// Menus, keyboard shortcuts and buttons all go through this table.
import { ADJUSTMENTS } from '../core/adjustments.js';
import { EFFECTS } from '../core/effects.js';
import { Doc } from '../doc/document.js';
import { FORMATS, formatFromName, stripExt, openDocument, decodeImage, encodeDocument, imageToPng } from '../doc/io.js';
import { applyFilter, eraseSelection, fillSelection, extractSelection, pasteImage } from '../doc/ops.js';
import { parseMeshBytes, demoMesh, unwrapMesh } from '../core/mesh.js';
import { jobExt } from '../core/job.js';
import { dropScratch, freezeScratch, jobBytes, jobFolder, openJob, scratchWhere } from './scratch.js';
import { beginSession, joinSession, leaveSession } from './session.js';
import { defaultPlace, dropProjection, reproject } from './place.js';
import { faceBounds } from '../core/project.js';
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
    try { return await fn(...a); } catch (err) {
      console.error(err);
      const msg = String(err?.message || err).replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/, '');
      ed.toast(msg);
    }
  };

  // ------------------------------------------------------------------ files

  async function openFilesInto(files, { ontoModel = false } = {}) {
    for (const f of files) {
      if (/\.([23]dlayered)$/i.test(f.name) && f.bytes) {
        const doc = await openJob(f.bytes, f.name);
        if (doc.mount) { ed.layout = 'split'; ed.emit('layout'); }
        ed.addDoc(doc);
        continue;
      }
      if (/\.(obj|json|stl|fbx|glb|gltf)$/i.test(f.name) && f.bytes) {
        await openMeshBytes(f.name, f.bytes);
        continue;
      }
      const existing = f.path && ed.docs.find((d) => d.path === f.path);
      if (existing) { ed.activate(existing); continue; }
      try {
        const doc = await openDocument(f.bytes, f.name);
        doc.rename(f.name, f.path ?? null);
        doc.format = formatFromName(f.name);
        if (ontoModel && ed.doc?.mount) addOntoModel(doc);
        else ed.addDoc(doc);
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
    freezeScratch(doc);
    if (doc.modified) {
      ed.activate(doc);
      let packed;
      try { packed = await jobBytes(doc); }
      catch (err) { ed.toast(err.message || String(err)); doc._scratchFrozen = false; return false; }
      try {
        await platform.scratchWrite(jobFolder(doc), packed.savepoint, packed.kind, packed.bytes);
        doc.scratchPoint = packed.savepoint;
        doc.scratchKind = packed.kind;
      } catch (err) { console.warn('Could not update the working copy:', err); }
      const choice = await dlg.saveUnfinishedDialog({
        name: stripExt(doc.name), kind: packed.kind, where: scratchWhere(doc),
      });
      if (!choice) { doc._scratchFrozen = false; return false; }
      if (choice.action === 'save') {
        const saved = await platform.exportLayered(`${stripExt(choice.name)}.${packed.kind}`, packed.bytes);
        if (!saved) { doc._scratchFrozen = false; return false; }
        doc.markSaved();
      }
    }
    try { await dropScratch(doc); } catch (err) { console.warn('Could not remove the working copy:', err); }
    dropProjection(doc);
    leaveSession(doc);
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
  add('saveUnfinished', 'Save Unfinished Work As…', guard(async () => {
    const doc = ed.doc;
    const choice = await dlg.saveUnfinishedDialog({
      name: stripExt(doc.name), kind: jobExt(doc), where: scratchWhere(doc), discardable: false,
    });
    if (choice?.action !== 'save') return;
    const packed = await jobBytes(doc);
    const saved = await platform.exportLayered(`${stripExt(choice.name)}.${packed.kind}`, packed.bytes);
    if (!saved) return;
    try {
      await platform.scratchWrite(jobFolder(doc), packed.savepoint, packed.kind, packed.bytes);
      doc.scratchPoint = packed.savepoint;
    } catch (err) { console.warn(err); }
    doc.markSaved();
    ed.toast('Saved. The copy inside the program is still removed when you close.');
  }), { shortcut: 'Ctrl+Shift+U' });
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
  }), { shortcut: 'Ctrl+Alt+S' });
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
  }), { shortcut: 'Ctrl+Shift+C' });

  // ------------------------------------------------------------------ model

  function mountAtlas(atlas, name) {
    const doc = new Doc(atlas.width, atlas.height, { name, background: { r: 196, g: 198, b: 204, a: 1 } });
    beginSession(doc, atlas);
    ed.layout = 'split';
    ed.addDoc(doc);
    ed.emit('layout');
    const detail = atlas.keptUVs
      ? (atlas.separated > 1
        ? `Split ${atlas.separated} objects onto their own parts of the texture, so paint on one stays off the others. Atlas ${atlas.width}×${atlas.height}.`
        : `Kept the UVs already in the file. Atlas ${atlas.width}×${atlas.height}.`)
      : `Unwrapped ${atlas.charts} chart${atlas.charts === 1 ? '' : 's'} into ${atlas.width}×${atlas.height}.`;
    const extra = atlas.projected ? ` ${atlas.projected} chart${atlas.projected === 1 ? '' : 's'} were projected instead of solved.` : '';
    ed.toast(`${detail}${extra} Paint the image, or paint on the model.`);
  }

  async function openMeshBytes(name, bytes, { ask = true } = {}) {
    const mesh = await parseMeshBytes(name, bytes);
    const opts = ask ? await dlg.unwrapDialog({ hasUV: mesh.hasUV }) : { angle: 66, padding: 4, resolution: 1024, pxPerM: 0, useExisting: false };
    if (!opts) return;
    mountAtlas(unwrapMesh(mesh, opts), stripExt(name));
  }

  add('openModel', 'Open Model…', guard(async () => {
    const f = await platform.openMeshFile();
    if (!f) return;
    const bytes = f.bytes || new TextEncoder().encode(f.text || '');
    await openMeshBytes(f.name, bytes);
  }), { enabled: () => true });

  add('demoModel', 'Unwrap Demo', guard(() => {
    mountAtlas(unwrapMesh(demoMesh(), { angle: 66, padding: 4, resolution: 1024, pxPerM: 0 }), 'Demo mine');
  }), { enabled: () => true });

  add('reunwrap', 'Unwrap Again…', guard(async () => {
    const mesh = ed.doc?.mount?.mesh;
    if (!mesh) return;
    const opts = await dlg.unwrapDialog({ hasUV: mesh.hasUV });
    if (!opts) return;
    mountAtlas(unwrapMesh(mesh, opts), stripExt(ed.doc.name));
  }), { enabled: () => !!ed.doc?.mount?.mesh });

  function addOntoModel(doc) {
    const host = ed.doc;
    if (!host?.mount) { ed.addDoc(doc); return; }
    const session = host.session || beginSession(host, host.mount);
    joinSession(session, doc, defaultPlace(doc, session.mount));
    const previous = session.members[session.members.length - 2];
    const at = ed.docs.indexOf(previous);
    if (at >= 0) ed.docs.splice(at + 1, 0, doc);
    else ed.docs.push(doc);
    ed.activate(doc);
    ed.layout = ed.layout || 'split';
    ed.emit('docs');
    ed.emit('layout');
    reproject(doc, ed);
    ed.toast(`${doc.name} is on the model. Move it onto the faces you want. The picture itself is not changed.`);
  }

  add('addModelImage', 'Add Image to Model…', guard(async () => {
    await openFilesInto(await platform.openFiles(), { ontoModel: true });
  }), { enabled: () => !!ed.doc?.mount });

  add('newModelImage', 'New Image on Model…', guard(async () => {
    const mount = ed.doc.mount;
    const r = await dlg.newImageDialog(ed, { width: mount.width, height: mount.height, background: 'transparent' });
    if (!r) return;
    const background = r.background === 'white' ? { r: 255, g: 255, b: 255, a: 1 }
      : r.background === 'primary' ? ed.primary : r.background === 'secondary' ? ed.secondary : null;
    const n = (ed.doc.session?.members.length ?? 1) + 1;
    addOntoModel(new Doc(r.width, r.height, { name: `Image ${n}`, background }));
  }), { enabled: () => !!ed.doc?.mount });

  function moveOnModel(dir) {
    const session = ed.doc?.session;
    if (!session) return;
    const i = session.members.indexOf(ed.doc);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= session.members.length) return;
    const order = session.members;
    [order[i], order[j]] = [order[j], order[i]];
    ed.doc.emit('render');
    ed.emit('docs');
  }
  add('modelRaise', 'Raise Image on Model', () => moveOnModel(1), {
    enabled: () => !!ed.doc?.session && ed.doc.session.members.at(-1) !== ed.doc,
  });
  add('modelLower', 'Lower Image on Model', () => moveOnModel(-1), {
    enabled: () => !!ed.doc?.session && ed.doc.session.members[0] !== ed.doc,
  });
  add('limitFaces', 'Limit to Faces…', guard(async () => {
    const doc = ed.doc;
    if (!doc?.session || doc.atlas) { ed.toast('Open the image you want to limit.'); return; }
    const names = await dlg.faceLimitDialog(doc.mount?.groups ?? [], doc.faces);
    if (!names) return;
    const all = [...new Set((doc.mount?.groups ?? []).map((g) => g.name))];
    doc.faces = names.length === all.length ? null : names;
    if (doc.faces) {
      const bounds = faceBounds(doc.mount.uvs, doc.mount.groups, doc.faces);
      if (bounds) doc.place = bounds;
    }
    reproject(doc, ed);
    ed.toast(doc.faces ? `${doc.name} is drawn on ${doc.faces.join(', ')} only.` : `${doc.name} is drawn on every face it covers.`);
  }), { enabled: () => !!ed.doc?.session && !ed.doc.atlas });

  const setLayout = (mode) => { ed.layout = mode; ed.emit('layout'); };
  add('layoutSplit', 'Split View', () => setLayout('split'), { enabled: () => !!ed.doc?.mount, checked: () => ed.layout === 'split' });
  add('layout2d', 'Texture Only', () => setLayout('2d'), { enabled: () => !!ed.doc?.mount, checked: () => ed.layout === '2d' });
  add('layout3d', 'Model Only', () => setLayout('3d'), { enabled: () => !!ed.doc?.mount, checked: () => ed.layout === '3d' });
  add('uvLines', 'UV Lines', () => {
    const m = ed.doc?.mount;
    if (!m) return;
    m.showWires = m.showWires === false;
    ed.requestOverlay();
  }, { enabled: () => !!ed.doc?.mount, checked: () => !!ed.doc?.mount && ed.doc.mount.showWires !== false });
  add('unmount', 'Unmount Model', () => {
    const session = ed.doc?.session;
    if (session) for (const d of [...session.members]) leaveSession(d);
    else if (ed.doc) delete ed.doc.mount;
    ed.emit('layout');
    ed.requestOverlay();
  }, { enabled: () => !!ed.doc?.mount });

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
  add('checkUpdate', 'Check for Updates…', guard(async (auto) => {
    if (!platform.isNative) {
      if (!auto) ed.toast('Refresh the page. Updates install themselves only in the desktop app.');
      return;
    }
    if (!auto) ed.toast('Checking for updates…');
    let info;
    try { info = await platform.checkUpdate(); }
    catch (err) { if (!auto) throw err; return; }
    if (!info || info.mode === 'offline') {
      if (!auto) ed.toast('Could not reach the update server.');
      return;
    }
    if (!info.behind) {
      if (!auto) ed.toast(`Stratum ${info.version} is up to date.`);
      return;
    }
    const newer = info.remoteVersion && info.remoteVersion !== info.version
      ? `Stratum ${info.remoteVersion} is available (you have ${info.version}).`
      : `${info.behind} new commit${info.behind === 1 ? '' : 's'}.${info.note ? ` Latest: ${info.note}.` : ''}`;
    const r = await dlg.confirmDialog({
      title: 'Update Stratum',
      message: `${newer} It will be installed in your home folder if this copy cannot write to its own folder, then Stratum restarts.`,
      buttons: [{ label: 'Update', primary: true }, { label: 'Not now', cancel: true }],
    });
    if (r !== 0) return;
    ed.toast('Updating. Stratum will restart when the build finishes.');
    await platform.applyUpdate(info.mode);
  }), { enabled: () => true });

  return { cmds, openFilesInto, closeDoc, closeAll, saveDoc, openMeshBytes };
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
    h('p', null, 'Model → Open Model reads OBJ, JSON, STL, FBX and GLB. STL and FBX have no UVs, so Stratum unwraps the triangles it finds. A GLB keeps the UVs it already has, and objects that shared one texture are split apart so paint on one does not show on the others. The cube on the model snaps the view. Help → Check for Updates keeps the desktop app current.'),
    h('p', { class: 'dim' }, 'Runs on Electron; the editing core has no dependencies.'));
}
