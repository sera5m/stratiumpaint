'use strict';
// The only bridge between the page and the OS. Everything here is a thin wrapper over an IPC call.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('stratumNative', {
  openFiles: () => ipcRenderer.invoke('dialog:open'),
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
});
