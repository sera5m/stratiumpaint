// Wires everything together: editor, viewport, panels, keyboard, drag & drop, native hooks.
import { Editor } from './editor.js';
import { View } from './view.js';
import { createCommands } from './commands.js';
import { buildMenubar } from './menus.js';
import { buildToolbox, buildOptionsBar, buildTabs, buildLayersPanel, buildHistoryPanel, buildColorsPanel, buildStatusbar } from './panels.js';
import { isModalOpen } from './dialogs.js';
import * as platform from './platform.js';
import { encodeDocument } from '../doc/io.js';
import { putBackup } from './backup.js';
import { MeshView } from './meshview.js';
import { NodeView } from './nodeview.js';
import { watchScratch, dropScratch } from './scratch.js';
import { watchPlacement } from './place.js';
import { $, h } from './dom.js';
import { executeLine } from '../nodes/script.js';

const TEXT_INPUTS = new Set(['text', 'number', 'search', 'url', 'email', 'password', 'tel']);

const isTyping = (t) => t && (
  t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable ||
  (t.tagName === 'INPUT' && TEXT_INPUTS.has(t.type)));

/** "Ctrl+Shift+N" style name for a key event. */
function comboOf(e) {
  let k = e.key === ' ' ? 'Space' : e.key;
  const letter = k.length === 1 && /[a-z]/i.test(k);
  if (k.length === 1) k = k.toUpperCase();
  const shift = e.shiftKey && (letter || k.length > 1); // symbols already carry their shift
  return `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${shift ? 'Shift+' : ''}${e.altKey ? 'Alt+' : ''}${k}`;
}

export function start() {
  platform.watchAccent();
  const ed = new Editor();
  const stage = $('#pane-2d');
  const view = new View(ed, stage);
  ed.view = view;
  ed.meshView = new MeshView(ed, $('#pane-3d'));
  ed.nodeView = new NodeView(ed, $('#pane-nodes'));

  const { cmds, openFilesInto, closeDoc, closeAll, openMeshBytes } = createCommands({ ed, view });

  const split = $('#split');
  const pane3 = $('#pane-3d');
  const applyLayout = () => {
    const mode = ed.doc?.mount ? ed.layout : '2d';
    split.classList.remove('layout-2d', 'layout-3d', 'layout-split');
    split.classList.add(`layout-${mode}`);
    pane3.hidden = mode === '2d';
  };
  ed.on('doc', applyLayout);
  ed.on('docs', applyLayout);
  ed.on('layout', applyLayout);
  const paneNodes = $('#pane-nodes');
  const applySurface = () => {
    const nodes = ed.surfaceMode === 'nodes';
    paneNodes.hidden = !nodes;
    $('#main').classList.toggle('mode-nodes', nodes);
    if (nodes) ed.nodeView.show();
  };
  ed.on('surface', applySurface);
  applySurface();

  const run = async (cmd) => {
    if (cmd.enabled && !cmd.enabled()) return;
    ed.commitPending(); // e.g. finish an open text box before Select All, Undo, an adjustment, ...
    try { await cmd.run(); } catch (err) { console.error(err); ed.toast(err.message || String(err)); }
  };

  buildMenubar($('#menubar'), cmds, run);
  buildToolbox($('#toolbox'), ed);
  buildOptionsBar($('#optionsbar'), ed);
  buildTabs($('#tabs'), ed, closeDoc);
  buildLayersPanel($('#panel-layers'), ed, cmds);
  buildHistoryPanel($('#panel-history'), ed);
  buildColorsPanel($('#panel-colors'), ed);
  buildStatusbar($('#statusbar'), ed, view);

  // ---------------------------------------------------------------- keyboard
  const shortcuts = new Map();
  for (const c of cmds.values()) for (const combo of (c.shortcut ?? '').split('|').filter(Boolean)) shortcuts.set(combo, c);

  window.addEventListener('keydown', (e) => {
    if (isModalOpen() || isTyping(e.target)) return;
    if (ed.surfaceMode === 'nodes' && ed.nodeView.handleKey(e, 'down')) { e.preventDefault(); return; }
    const combo = comboOf(e);

    if (combo === 'Space') { e.preventDefault(); view.setSpace(true); return; }
    const cmd = shortcuts.get(combo);
    if (cmd) { e.preventDefault(); run(cmd); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'Escape') { ed.cancelTool(); return; }
    if (e.key === 'Enter') { e.preventDefault(); ed.commitTool(); return; }
    if (e.key === '[') { ed.nudgeSize(e.shiftKey ? -10 : -1); return; }
    if (e.key === ']') { ed.nudgeSize(e.shiftKey ? 10 : 1); return; }
    if (e.key === '{') { ed.nudgeSize(-10); return; }
    if (e.key === '}') { ed.nudgeSize(10); return; }
    if (combo === 'X') { ed.swapColors(); return; }
    if (e.key.length === 1 && ed.cycleTool(e.key.toUpperCase())) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (ed.surfaceMode === 'nodes' && ed.nodeView.handleKey(e, 'up')) return;
    if (e.key === ' ') view.setSpace(false);
  });
  window.addEventListener('blur', () => view.setSpace(false));

  // On Linux, middle-click conventionally pastes the X11 "primary" selection (whatever text was
  // last highlighted anywhere on the desktop) into focused editable elements. Our own Paste command
  // never goes through this native event (it uses the clipboard bridge), so it's safe to always
  // swallow it outside real text inputs — this keeps a middle-click on the canvas from dumping
  // stray text in, while still allowing normal pasting into the text tool box or a dialog field.
  window.addEventListener('paste', (e) => { if (!isTyping(e.target)) e.preventDefault(); }, true);

  // ---------------------------------------------------------------- toasts
  const toasts = $('#toasts');
  ed.on('toast', (msg) => {
    const t = h('div', { class: 'toast', role: 'status' }, msg);
    toasts.append(t);
    while (toasts.children.length > 3) toasts.firstChild.remove();
    setTimeout(() => t.remove(), 4500);
  });

  // ---------------------------------------------------------------- window title, empty state
  const empty = $('#empty-state');
  const syncChrome = () => {
    const d = ed.doc;
    empty.hidden = !!d;
    document.title = d ? `${d.modified ? '• ' : ''}${d.name} — Stratum` : 'Stratum';
  };
  for (const ev of ['doc', 'docs', 'doc:meta']) ed.on(ev, syncChrome);
  syncChrome();

  // ---------------------------------------------------------------- drag & drop
  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    const meshes = [], images = [];
    for (const f of e.dataTransfer.files) (/\.(obj|json|stl|fbx|glb|gltf)$/i.test(f.name) ? meshes : images).push(f);
    for (const f of meshes) {
      try { await openMeshBytes(f.name, new Uint8Array(await f.arrayBuffer())); }
      catch (err) { console.error(err); ed.toast(err.message || String(err)); }
    }
    if (images.length) {
      const ontoModel = !!e.target.closest?.('#pane-3d') && !!ed.doc?.mount;
      openFilesInto(await platform.readDroppedFiles(images), { ontoModel });
    }
  });

  // ---------------------------------------------------------------- errors nobody caught
  window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); ed.toast(`Something went wrong: ${e.reason?.message ?? e.reason}`); });
  window.addEventListener('error', (e) => { if (e.message) ed.toast(`Something went wrong: ${e.message}`); });

  // ---------------------------------------------------------------- native shell hooks
  platform.onOpenFiles((files) => openFilesInto(files));
  platform.onCloseRequest(async () => { if (await closeAll()) platform.confirmClose(); });
  if (!platform.isNative) {
    window.addEventListener('beforeunload', (e) => { if (ed.docs.some((d) => d.modified)) { e.preventDefault(); e.returnValue = ''; } });
    window.addEventListener('pagehide', () => { for (const d of ed.docs) dropScratch(d); });
  }
  platform.initialFiles().then((files) => { if (files.length) openFilesInto(files); });

  platform.onScriptExec?.((payload) => {
    let source = 'script pipe';
    try {
      const msg = JSON.parse(payload.line);
      if (msg && msg.source) source = String(msg.source).slice(0, 80);
    } catch { /* executeLine reports a bad line */ }
    ed.emit('script-in', { source });
    const result = executeLine(ed, payload.line);
    platform.scriptResult?.(payload.id, result);
  });
  platform.scriptReady?.();

  watchScratch(ed);
  watchPlacement(ed);

  // Desktop only: ask once per launch when a newer version is sitting on GitHub.
  if (platform.isNative) setTimeout(() => cmds.get('checkUpdate').run(true), 1500);

  // Quiet recovery copies while a document has unsaved work. File → Restore Backup reads them.
  const AUTOSAVE_MS = 60_000;
  setInterval(() => {
    for (const doc of ed.docs) {
      if (!doc.modified) continue;
      encodeDocument(doc, 'ora')
        .then((bytes) => putBackup({ docKey: doc.backupKey, name: doc.name, bytes, kind: 'auto' }))
        .catch((err) => console.warn('Autosave failed:', err));
    }
  }, AUTOSAVE_MS);

  return { ed, view, cmds };
}
