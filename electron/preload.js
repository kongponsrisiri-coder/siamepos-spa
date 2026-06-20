// Preload — the only bridge between the web app / setup screen and Electron's
// native side. Exposes a small, safe API on window.siamposSpa. contextIsolation
// is on, so the page can ONLY touch what we list here.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siamposSpa', {
  isElectron: true,
  platform: process.platform,

  // Printing (silent print of the current view).
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  printReceipt: (opts) => ipcRenderer.invoke('print-receipt', opts),

  // First-run setup wizard (setup.html).
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveSetup: (data) => ipcRenderer.invoke('save-setup', data),

  // Offline / server-down screen "Try again" button.
  retry: () => ipcRenderer.invoke('retry-load'),

  // Fired when a background auto-update finished downloading.
  onUpdateReady: (cb) => { ipcRenderer.on('siamepos-spa:update-ready', () => cb && cb()); },
});
