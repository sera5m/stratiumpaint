// Everything that differs between the Electron app and a plain browser tab.
// In Electron, electron/preload.cjs exposes window.stratumNative; without it we fall back to web APIs.
import { h } from './dom.js';

const native = typeof window !== 'undefined' ? window.stratumNative ?? null : null;

export const isNative = !!native;

/** → [{name, path, bytes}] */
export async function openFiles() {
  if (native) return native.openFiles();
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple: true, accept: 'image/*,.ora' });
    input.addEventListener('change', async () => {
      const out = [];
      for (const f of input.files) out.push({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) });
      resolve(out);
    });
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

export const readDroppedFiles = async (fileList) => {
  const out = [];
  for (const f of fileList) {
    if (/^image\//.test(f.type) || /\.(ora|png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name)) {
      out.push({ name: f.name, path: f.path || null, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
  }
  return out;
};

/** Native only: ask where to save. → path or null */
export const pickSavePath = (defaultName) => native.pickSavePath(defaultName);
export const writeFile = (path, bytes) => native.writeFile(path, bytes);

/** Browser fallback: hand the bytes to the download manager. */
export function download(name, bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function clipboardWriteImage(pngBytes) {
  if (native) return native.clipboardWriteImage(pngBytes);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([pngBytes], { type: 'image/png' }) })]);
}

/** → PNG bytes or null */
export async function clipboardReadImage() {
  if (native) return native.clipboardReadImage();
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) return new Uint8Array(await (await item.getType(type)).arrayBuffer());
  }
  return null;
}

export const quit = () => (native ? native.quit() : window.close());
export const onOpenFiles = (cb) => native?.onOpenFiles(cb);
export const onCloseRequest = (cb) => native?.onCloseRequest(cb);
export const confirmClose = () => native?.confirmClose();
export const initialFiles = () => (native ? native.initialFiles() : Promise.resolve([]));
