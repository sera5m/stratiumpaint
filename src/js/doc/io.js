// Reading and writing image files. Browser-only (uses canvas for codecs).
import { decodeOra, encodeOra } from '../core/ora.js';
import { Doc } from './document.js';
import { Layer } from './layer.js';
import { createCanvas } from './raster.js';

export const FORMATS = {
  png: { mime: 'image/png', ext: 'png', label: 'PNG' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG' },
  webp: { mime: 'image/webp', ext: 'webp', label: 'WebP' },
  ora: { mime: 'image/openraster', ext: 'ora', label: 'OpenRaster (layers)' },
};

const BY_EXT = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', webp: 'webp', ora: 'ora' };

export function formatFromName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name ?? '');
  return (m && BY_EXT[m[1].toLowerCase()]) || null;
}

export const stripExt = (name) => name.replace(/\.[^./\\]+$/, '');

function bitmapToImage(bmp, w = bmp.width, h = bmp.height, x = 0, y = 0) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, x, y);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: id.data };
}

export async function decodeImage(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  try {
    return bitmapToImage(bmp);
  } finally {
    bmp.close?.();
  }
}

/** bytes of a PNG/JPEG/WebP/GIF/BMP or an .ora → a new Doc named `name`. */
export async function openDocument(bytes, name) {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip || formatFromName(name) === 'ora') {
    const ora = await decodeOra(bytes);
    const layers = [];
    for (const l of [...ora.layers].reverse()) {
      const bmp = await createImageBitmap(new Blob([l.png]));
      const layer = new Layer(ora.width, ora.height, l.name);
      layer.replaceImage(bitmapToImage(bmp, ora.width, ora.height, l.x, l.y));
      bmp.close?.();
      Object.assign(layer, { visible: l.visible, opacity: l.opacity, blend: l.blend });
      layers.push(layer);
    }
    if (!layers.length) throw new Error('This OpenRaster file contains no layers.');
    const doc = new Doc(ora.width, ora.height, { name });
    doc.setLayers(layers);
    return doc;
  }
  const img = await decodeImage(bytes);
  const doc = new Doc(img.width, img.height, { name });
  doc.layers[0].replaceImage(img);
  return doc;
}

const canvasToBytes = (canvas, mime, quality) =>
  new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error(`This browser could not encode ${mime}.`));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, mime, quality);
  });

export function imageToCanvas(img) {
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return c;
}

export const imageToPng = (img) => canvasToBytes(imageToCanvas(img), 'image/png');

export async function encodeDocument(doc, format, quality = 0.92) {
  const merged = doc.composite();
  if (format === 'ora') {
    const layers = [];
    for (const l of [...doc.layers].reverse()) {
      layers.push({
        name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, x: 0, y: 0,
        png: await canvasToBytes(l.canvas, 'image/png'),
      });
    }
    const k = Math.min(1, 256 / Math.max(doc.width, doc.height));
    const thumb = createCanvas(Math.round(doc.width * k), Math.round(doc.height * k));
    thumb.getContext('2d').drawImage(merged, 0, 0, thumb.width, thumb.height);
    return encodeOra({
      width: doc.width, height: doc.height, layers,
      mergedPng: await canvasToBytes(merged, 'image/png'),
      thumbPng: await canvasToBytes(thumb, 'image/png'),
    });
  }
  let canvas = merged;
  if (format === 'jpeg') { // JPEG has no alpha: flatten onto white
    canvas = createCanvas(doc.width, doc.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(merged, 0, 0);
  }
  return canvasToBytes(canvas, FORMATS[format].mime, quality);
}
