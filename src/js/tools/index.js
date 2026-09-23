// Tool registry. Order here is the order in the toolbox.
import { selectionTools } from './select.js';
import { moveTools } from './move.js';
import { navTools } from './nav.js';
import { fillTools } from './fill.js';
import { brushTools } from './brush.js';
import { shapeTools } from './shapes.js';
import { textTool } from './text.js';

/** Fresh tool instances (each keeps its own drag state). */
export function createTools() {
  const [rectSel, ellSel, lasso, wand] = selectionTools();
  const [movePx, moveSel] = moveTools();
  const [zoom, pan, picker] = navTools();
  const [bucket, gradient] = fillTools();
  const [brush, pencil, eraser, clone] = brushTools();
  const [line, rect, roundrect, ellipse] = shapeTools();
  return [rectSel, ellSel, lasso, wand, movePx, moveSel, zoom, pan, bucket, gradient, brush, pencil, eraser, clone, picker, line, rect, roundrect, ellipse, textTool()];
}
