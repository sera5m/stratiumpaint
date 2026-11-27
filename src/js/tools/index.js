// Tool registry. Order here is the order in the toolbox.
import { selectionTools } from './select.js';
import { moveTools } from './move.js';
import { navTools } from './nav.js';
import { fillTools } from './fill.js';
import { brushTools } from './brush.js';
import { shapeTools } from './shapes.js';
import { pathTools } from './path.js';
import { textTool } from './text.js';
import { extraTools } from './extra.js';

/** Fresh tool instances (each keeps its own drag state). */
export function createTools() {
  const [rectSel, ellSel, lasso, wand] = selectionTools();
  const [movePx, moveSel] = moveTools();
  const [zoom, pan, picker] = navTools();
  const [bucket, gradient, polyFill] = fillTools();
  const [brush, pencil, eraser, clone] = brushTools();
  const shapes = shapeTools();
  const [path] = pathTools();
  return [rectSel, ellSel, lasso, wand, movePx, moveSel, zoom, pan, bucket, gradient, polyFill, brush, pencil, eraser, clone, picker, ...shapes, path, textTool(), ...extraTools()];
}
