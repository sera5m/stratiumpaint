// The menu bar. Menus are lists of command ids; '-' is a separator and {label, items} a submenu.
import { ADJUSTMENTS } from '../core/adjustments.js';
import { EFFECTS, EFFECT_CATEGORIES } from '../core/effects.js';
import { h } from './dom.js';
import { icon } from './icons.js';

export const MENUS = [
  ['File', ['new', 'open', '-', 'save', 'saveAs', 'saveUnfinished', 'saveBackup', 'restoreBackup', '-', 'close', 'quit']],
  ['Edit', ['undo', 'redo', '-', 'cut', 'copy', 'paste', 'pasteNew', '-', 'erase', 'fill', 'colorRange', '-', 'selectAll', 'deselect', 'invertSel', '-', 'wholeImage']],
  ['View', ['zoomIn', 'zoomOut', 'zoomFit', 'zoomActual', '-', 'grid']],
  ['Image', ['crop', '-', 'resize', 'canvasSize', '-', 'flipH', 'flipV', '-', 'rotateCW', 'rotateCCW', 'rotate180', '-', 'removeBg', '-', 'flatten']],
  ['Model', ['openModel', 'demoModel', 'reunwrap', '-', 'addModelImage', 'newModelImage', 'modelRaise', 'modelLower', 'limitFaces', '-', 'layoutSplit', 'layout2d', 'layout3d', '-', 'uvLines', 'unmount']],
  ['Layers', ['layerAdd', 'layerDelete', 'layerDuplicate', 'layerMerge', '-', 'layerUp', 'layerDown', '-', 'layerProps']],
  ['Adjustments', ['wholeImage', '-', ...ADJUSTMENTS.map((s) => `adj:${s.id}`)]],
  ['Effects', ['wholeImage', '-', ...EFFECT_CATEGORIES.map((cat) => ({ label: cat, items: EFFECTS.filter((e) => e.category === cat).map((e) => `fx:${e.id}`) }))]],
  ['Help', ['shortcuts', 'about']],
];

const pretty = (s) => (s ?? '').split('|')[0];

/** Renders the bar into `root`. run(cmd) executes a command. */
export function buildMenubar(root, cmds, run) {
  let open = null; // { index, popup }

  const closeMenu = () => {
    if (!open) return;
    open.popup.remove();
    root.children[open.index]?.classList.remove('open');
    open = null;
  };

  const itemEl = (entry) => {
    if (entry === '-') return h('div', { class: 'menu-sep', role: 'separator' });
    if (typeof entry === 'object') {
      return h('div', { class: 'menu-item has-sub', role: 'menuitem', 'aria-haspopup': 'true' },
        h('span', { class: 'label' }, entry.label), icon('chevron', 12),
        h('div', { class: 'menu sub' }, entry.items.map(itemEl)));
    }
    const cmd = cmds.get(entry);
    if (!cmd) return null;
    const enabled = cmd.enabled ? !!cmd.enabled() : true;
    return h('button', {
      class: 'menu-item', type: 'button', role: 'menuitem', disabled: !enabled,
      onClick: () => { closeMenu(); run(cmd); },
    }, h('span', { class: 'check' }, cmd.checked?.() ? '✓' : ''), h('span', { class: 'label' }, cmd.label), h('span', { class: 'keys' }, pretty(cmd.shortcut)));
  };

  const openMenu = (index) => {
    closeMenu();
    const btn = root.children[index], r = btn.getBoundingClientRect();
    const popup = h('div', { class: 'menu', role: 'menu', style: { left: `${r.left}px`, top: `${r.bottom}px` } }, MENUS[index][1].map(itemEl));
    document.body.append(popup);
    btn.classList.add('open');
    open = { index, popup };
  };

  MENUS.forEach(([label], i) => {
    root.append(h('button', {
      class: 'menu-btn', type: 'button', 'aria-haspopup': 'true',
      onClick: () => (open?.index === i ? closeMenu() : openMenu(i)),
      onPointerenter: () => { if (open && open.index !== i) openMenu(i); },
    }, label));
  });

  document.addEventListener('pointerdown', (e) => {
    if (open && !open.popup.contains(e.target) && !root.contains(e.target)) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); }, true);
  window.addEventListener('blur', closeMenu);
  return { close: closeMenu };
}
