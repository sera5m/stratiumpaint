// Everything that differs between the Electron app and a plain browser tab.
// In Electron, electron/preload.cjs exposes window.stratumNative; without it we fall back to web APIs.
import { h } from './dom.js';
import { safeSegment } from '../core/job.js';

const native = typeof window !== 'undefined' ? window.stratumNative ?? null : null;

export const isNative = !!native;

/** → [{name, path, bytes}] */
export async function openFiles() {
  if (native) return native.openFiles();
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple: true, accept: 'image/*,.ora,.2dlayered,.3dlayered' });
    input.addEventListener('change', async () => {
      const out = [];
      for (const f of input.files) out.push({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) });
      resolve(out);
    });
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/** → {name, text} or null. .obj, or JSON {positions, indices, uvs?}. */
export function openMeshFile() {
  if (native?.openMesh) return native.openMesh();
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: '.obj,.json,application/json,model/obj' });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

export const readDroppedFiles = async (fileList) => {
  const out = [];
  for (const f of fileList) {
    if (/^image\//.test(f.type) || /\.(ora|png|jpe?g|webp|gif|bmp|avif|2dlayered|3dlayered)$/i.test(f.name)) {
      out.push({ name: f.name, path: f.path || null, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
  }
  return out;
};

/** Write a working-copy zip at internal/<jobId>/<savepoint>/structure.<kind>. */
export async function scratchWrite(jobId, savepoint, kind, bytes) {
  const id = safeSegment(jobId);
  const point = safeSegment(savepoint);
  if (kind !== '2dlayered' && kind !== '3dlayered') throw new Error('Unknown job type.');
  if (native?.scratchWrite) return native.scratchWrite(id, point, kind, bytes);
  const folder = await opfsDir(['internal', id, point], true);
  const fh = await folder.getFileHandle(`structure.${kind}`, { create: true });
  const writable = await fh.createWritable();
  await writable.write(bytes);
  await writable.close();
  await pruneOpfs(id, 3);
  return `internal/${id}/${point}/structure.${kind}`;
}

/** Delete one job's internal tree. Missing is fine. */
export async function scratchDrop(jobId) {
  const id = safeSegment(jobId);
  if (native?.scratchDrop) return native.scratchDrop(id);
  try {
    const root = await navigator.storage.getDirectory();
    const internal = await root.getDirectoryHandle('internal');
    await internal.removeEntry(id, { recursive: true });
  } catch { /* already gone */ }
}

/** Save a job zip outside the internal tree. → path or filename, or null if cancelled. */
export async function exportLayered(name, bytes) {
  if (native?.exportLayered) return native.exportLayered(name, bytes);
  download(name, bytes, 'application/zip');
  return name;
}

async function opfsDir(parts, create) {
  let dir = await navigator.storage.getDirectory();
  for (const part of parts) dir = await dir.getDirectoryHandle(safeSegment(part), { create });
  return dir;
}

async function pruneOpfs(jobId, keep) {
  const parent = await opfsDir(['internal', jobId], true);
  const names = [];
  for await (const [name, handle] of parent.entries()) if (handle.kind === 'directory') names.push(name);
  names.sort();
  while (names.length > keep) await parent.removeEntry(names.shift(), { recursive: true });
}

/** Native only: ask where to save. → path or null */
export const pickSavePath = (defaultName) => native.pickSavePath(defaultName);
export const writeFile = (path, bytes) => native.writeFile(path, bytes);

/** Copy the current file aside before it is overwritten. No-op in the browser. → path or null */
export const backupExisting = (path) => (native?.backupExisting ? native.backupExisting(path) : Promise.resolve(null));

/** Write an extra copy (OpenRaster) into the backup folder. → path or null */
export const writeBackup = (hintPath, filename, bytes) =>
  (native?.writeBackup ? native.writeBackup(hintPath, filename, bytes) : Promise.resolve(null));

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
