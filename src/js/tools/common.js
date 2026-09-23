// Small helpers shared by the tools.
import { rectIntersect } from '../core/util.js';

/** Colour for the mouse button used: left = primary, right = secondary. */
export const colorFor = (ed, e) => (e.button === 2 ? ed.secondary : ed.primary);

export const withOpacity = (c, pct) => ({ ...c, a: (c.a ?? 1) * (pct / 100) });

export const layerRect = (layer) => ({ x: 0, y: 0, w: layer.width, h: layer.height });

export const clipToLayer = (r, layer) => rectIntersect(r, layerRect(layer));

export const rgbaCss = (c, k = 1) => `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${(c.a ?? 1) * k})`;

/** Draw the "marching ants" style dashed outline the tools use for rubber-banding. */
export function dashedStroke(ctx, drawPath) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255,255,255,.95)';
  ctx.beginPath(); drawPath(); ctx.stroke();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(0,0,0,.95)';
  ctx.beginPath(); drawPath(); ctx.stroke();
  ctx.restore();
}
