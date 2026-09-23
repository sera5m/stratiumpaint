// OpenRaster (.ora): the layered format shared by Krita, GIMP, MyPaint and Pinta.
// This module only deals with the zip + stack.xml; PNG encoding lives in doc/io.js.
import { zipStore, unzip } from './zip.js';
import { toOraOp, fromOraOp } from './blend.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * layers: top-most first, each {name, visible, opacity, blend, x?, y?, png: Uint8Array}
 * → Uint8Array of the .ora file.
 */
export function encodeOra({ width, height, layers, mergedPng, thumbPng }) {
  const enc = new TextEncoder();
  const stack = layers.map((l, i) =>
    `    <layer name="${esc(l.name)}" src="data/layer${layers.length - i}.png" x="${l.x ?? 0}" y="${l.y ?? 0}" ` +
    `opacity="${(+l.opacity).toFixed(4)}" visibility="${l.visible ? 'visible' : 'hidden'}" composite-op="${toOraOp(l.blend)}"/>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<image version="0.0.3" w="${width}" h="${height}">\n  <stack>\n${stack}\n  </stack>\n</image>\n`;
  const files = [
    { name: 'mimetype', data: enc.encode('image/openraster') },
    { name: 'stack.xml', data: enc.encode(xml) },
    ...layers.map((l, i) => ({ name: `data/layer${layers.length - i}.png`, data: l.png })),
  ];
  if (mergedPng) files.push({ name: 'mergedimage.png', data: mergedPng });
  if (thumbPng) files.push({ name: 'Thumbnails/thumbnail.png', data: thumbPng });
  return zipStore(files);
}

function attrs(s) {
  const out = {};
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = unesc(m[2] ?? m[3]);
  return out;
}

/** → {width, height, layers: top-most first [{name, visible, opacity, blend, x, y, png}]} */
export async function decodeOra(bytes) {
  const files = await unzip(bytes);
  const xmlBytes = files.get('stack.xml');
  if (!xmlBytes) throw new Error('Not an OpenRaster file (stack.xml missing)');
  const xml = new TextDecoder().decode(xmlBytes);
  const root = /<image\b([^>]*)>/.exec(xml);
  if (!root) throw new Error('Malformed stack.xml');
  const a = attrs(root[1]);
  const layers = [];
  for (const m of xml.matchAll(/<layer\b([^>]*?)\/?>/g)) {
    const l = attrs(m[1]);
    const png = files.get(l.src);
    if (!png) continue;
    layers.push({
      name: l.name || 'Layer', visible: (l.visibility ?? 'visible') !== 'hidden',
      opacity: l.opacity === undefined ? 1 : Math.min(1, Math.max(0, parseFloat(l.opacity))),
      blend: fromOraOp(l['composite-op']), x: parseInt(l.x ?? '0', 10) || 0, y: parseInt(l.y ?? '0', 10) || 0, png,
    });
  }
  return { width: parseInt(a.w, 10), height: parseInt(a.h, 10), layers, mergedPng: files.get('mergedimage.png') ?? null };
}
