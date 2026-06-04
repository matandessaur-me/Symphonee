/**
 * preload.js - Exposes safe Electron APIs to the renderer via contextBridge.
 *
 * Runs in a privileged context (Node.js available) but is isolated from the
 * renderer's JS world. Only explicitly bridged APIs are accessible.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  clipboardRead:  ()     => ipcRenderer.invoke('clipboard-read'),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', text),
});
