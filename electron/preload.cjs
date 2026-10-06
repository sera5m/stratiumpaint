'use strict';
// The only bridge between the page and the OS. Everything here is a thin wrapper over an IPC call.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('stratumNative', {
  openFiles: () => ipcRenderer.invoke('dialog:open'),
  openMesh: () => ipcRenderer.invoke('dialog:open-mesh'),
  scratchWrite: (jobId, savepoint, kind, bytes) => ipcRenderer.invoke('scratch:write', jobId, savepoint, kind, bytes),
  scratchDrop: (jobId) => ipcRenderer.invoke('scratch:drop', jobId),
  exportLayered: (name, bytes) => ipcRenderer.invoke('job:export', name, bytes),
  pickSavePath: (defaultName) => ipcRenderer.invoke('dialog:save', defaultName),
  writeFile: (filePath, bytes) => ipcRenderer.invoke('file:write', filePath, bytes),
  backupExisting: (filePath) => ipcRenderer.invoke('file:backup-existing', filePath),
  writeBackup: (hintPath, filename, bytes) => ipcRenderer.invoke('file:write-backup', hintPath, filename, bytes),
  clipboardWriteImage: (bytes) => ipcRenderer.invoke('clipboard:write-image', bytes),
  clipboardReadImage: () => ipcRenderer.invoke('clipboard:read-image'),
  initialFiles: () => ipcRenderer.invoke('app:initial-files'),
  onOpenFiles: on('app:open-files'),
  onCloseRequest: on('app:request-close'),
  confirmClose: () => ipcRenderer.invoke('app:confirm-close'),
  quit: () => ipcRenderer.invoke('app:quit'),
  accentColor: () => ipcRenderer.invoke('app:accent'),
  onAccentColor: on('app:accent'),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  applyUpdate: (mode) => ipcRenderer.invoke('app:apply-update', mode),
  onScriptExec: (cb) => ipcRenderer.on('script:exec', (_e, payload) => cb(payload)),
  scriptResult: (id, result) => ipcRenderer.send('script:result', id, result),
  scriptReady: () => ipcRenderer.send('script:ready'),
  ollamaGenerate: (payload) => ipcRenderer.invoke('ollama:generate', payload),
  onOllamaProgress: (cb) => {
    ipcRenderer.removeAllListeners('ollama:progress');
    if (typeof cb === 'function') ipcRenderer.on('ollama:progress', (_e, data) => cb(data));
  },
  offOllamaProgress: () => ipcRenderer.removeAllListeners('ollama:progress'),
});
