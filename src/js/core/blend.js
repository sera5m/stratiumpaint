// Layer blend modes. ids are the canvas globalCompositeOperation names.
export const BLEND_MODES = [
  ['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'],
  ['darken', 'Darken'], ['lighten', 'Lighten'], ['color-dodge', 'Color Dodge'], ['color-burn', 'Color Burn'],
  ['hard-light', 'Hard Light'], ['soft-light', 'Soft Light'], ['difference', 'Difference'], ['exclusion', 'Exclusion'],
  ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity'],
];

const KNOWN = new Set(BLEND_MODES.map(([id]) => id));

/** OpenRaster composite-op name for a blend id. */
export const toOraOp = (id) => (id === 'source-over' ? 'svg:src-over' : `svg:${id}`);

export function fromOraOp(op) {
  const id = String(op ?? '').replace(/^svg:/, '');
  if (id === 'src-over') return 'source-over';
  return KNOWN.has(id) ? id : 'source-over';
}
