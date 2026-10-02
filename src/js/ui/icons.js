// Inline SVG icons (24x24, stroke based, inheriting the text colour).
const P = {
  'rect-select': '<rect x="4" y="5" width="16" height="14" stroke-dasharray="3 2.4"/>',
  'ellipse-select': '<ellipse cx="12" cy="12" rx="8.5" ry="6.5" stroke-dasharray="3 2.4"/>',
  lasso: '<path d="M6 11c-1-4 3-7 7-6.5s6.5 4 4.5 7.5-6 3-8.5 2" stroke-dasharray="3 2.4"/><path d="M9.5 14.5c-.5 2-1.5 3.5-3 5"/>',
  wand: '<path d="M4 20 15 9"/><path d="M16 3v3M16 12v3M10 6h3M19 6h3M20 3l-1.5 1.5M20 9l-1.5-1.5"/>',
  'move-pixels': '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  'move-selection': '<rect x="4" y="4" width="10" height="10" stroke-dasharray="2.5 2.2"/><path d="M12 12l8 8M20 14v6h-6"/>',
  zoom: '<circle cx="10" cy="10" r="6"/><path d="M15 15l6 6M10 7v6M7 10h6"/>',
  pan: '<path d="M8 13V6.5a1.5 1.5 0 013 0V12M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6.5a1.5 1.5 0 013 0V14c0 4-2 7-6 7-3 0-4.500-2-6.500-5l-1-2a1.500 1.500 0 012.500-1.500L8 14"/>',
  bucket: '<path d="M5 12l7-7 7 7-7 7z"/><path d="M5 12h14"/><path d="M20 15c1 1.500 1.500 2.300 1.500 3.200a1.500 1.500 0 01-3 0c0-.900.500-1.700 1.500-3.200z"/>',
  gradient: '<rect x="4" y="5" width="16" height="14" rx="1"/><path d="M8 5v14M12 5v14M16 5v14" opacity=".45"/>',
  brush: '<path d="M14 4l6 6-8.500 8.500c-1.500 1.500-3.500 1.500-6 1.500.500-2.500.500-4.500 2-6z"/><path d="M12 6l6 6"/>',
  pencil: '<path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M14 6l4 4"/>',
  eraser: '<path d="M4 15l8-9 8 6-6 8H8z"/><path d="M8 20h12M9 10l7 6"/>',
  clone: '<rect x="5" y="14" width="14" height="5" rx="1"/><path d="M9 14v-3.500a3 3 0 116 0V14"/><path d="M8 7l-2-2M16 7l2-2"/>',
  picker: '<path d="M15 4l5 5-3 1-1 1-8 8H5v-3l8-8 1-1z"/><path d="M13 7l4 4"/>',
  line: '<path d="M5 19L19 5"/>',
  rect: '<rect x="4" y="6" width="16" height="12"/>',
  roundrect: '<rect x="4" y="6" width="16" height="12" rx="4"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.500" ry="6"/>',
  text: '<path d="M5 7V4.500h14V7M12 4.500V19M9 19h6"/>',
  'bg-remove': '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2"/><circle cx="12" cy="12" r="4"/><path d="M5 5l3 3M19 5l-3 3"/>',
  'color-range': '<path d="M4 16c2-6 4-6 6 0s4 6 6 0 4-6 4 0"/><path d="M4 8h4M16 8h4"/>',

  eye: '<path d="M2 12s3.500-6.500 10-6.500S22 12 22 12s-3.500 6.500-10 6.500S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M3 3l18 18M10 6c.600-.100 1.300-.200 2-.200 6.500 0 10 6.200 10 6.200a17 17 0 01-3.300 4M6.500 7.500A17 17 0 002 12s3.500 6.500 10 6.500c1.500 0 2.800-.300 4-.800"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.500"/><path d="M16 8V5.500A1.500 1.500 0 0014.500 4h-9A1.500 1.500 0 004 5.500v9A1.500 1.500 0 005.500 16H8"/>',
  trash: '<path d="M4 7h16M9 7V4.500h6V7M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  merge: '<path d="M6 4v5a6 6 0 006 6 6 6 0 006-6V4M12 15v5M9 17l3 3 3-3"/>',
  props: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.600 5.600l2.100 2.100M16.300 16.300l2.100 2.100M5.600 18.400l2.100-2.100M16.300 7.700l2.100-2.100"/>',
  undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 12" transform="translate(0 -4)"/>',
  redo: '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 000 12" transform="translate(0 -4)"/>',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  reset: '<rect x="3" y="3" width="11" height="11"/><rect x="10" y="10" width="11" height="11" fill="currentColor" fill-opacity=".25"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
};

/** An <svg> element for the named icon. */
export function icon(name, size = 18) {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`;
  return wrap.firstChild;
}

export const hasIcon = (name) => name in P;
