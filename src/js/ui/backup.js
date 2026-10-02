// Recovery copies. The browser build keeps them in IndexedDB. The Electron build
// also copies the previous file aside before an overwrite (see electron/main.cjs).

const DB = 'stratum';
const STORE = 'backups';
const CAP = 12;
const hasIDB = typeof indexedDB !== 'undefined';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('backup aborted'));
  });
}

export async function listBackups() {
  if (!hasIDB) return [];
  const d = await openDb();
  const tx = d.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).getAll();
  const rows = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
  return rows.sort((a, b) => b.at - a.at);
}

async function dropIds(ids) {
  if (!ids.length) return;
  const d = await openDb();
  const tx = d.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const id of ids) store.delete(id);
  await txDone(tx);
}

/** Remember an encoded document. Autosaves overwrite one slot per document; manual saves accumulate. */
export async function putBackup({ docKey, name, bytes, kind = 'save' }) {
  if (!hasIDB) return null;
  const at = Date.now();
  const id = kind === 'auto' ? `auto:${docKey}` : `${docKey}:${at}`;
  const rec = { id, docKey, name, at, kind, bytes };
  const d = await openDb();
  const tx = d.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(rec);
  await txDone(tx);
  const all = await listBackups();
  const overflow = all.slice(CAP);
  await dropIds(overflow.map((r) => r.id));
  return rec;
}

export async function deleteBackup(id) {
  await dropIds([id]);
}

export function formatWhen(at) {
  try { return new Date(at).toLocaleString(); } catch { return String(at); }
}
