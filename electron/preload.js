// Preload — the only bridge between the web app and Electron's native side.
// Exposes a small, safe API on window.siamposSpa. contextIsolation is on,
// so the web page can ONLY touch what we list here.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siamposSpa', {
  isElectron: true,
  platform: process.platform,

  // Printing (Phase A — silent print of the current view).
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  printReceipt: (opts) => ipcRenderer.invoke('print-receipt', opts),

  // Offline screen "Try again" button calls this.
  retry: () => ipcRenderer.invoke('retry-load'),

  // Fired when a background auto-update has finished downloading and will
  // apply on next restart — the web app can show a gentle "update ready" toast.
  onUpdateReady: (cb) => {
    ipcRenderer.on('siamepos-spa:update-ready', () => cb && cb());
  },
});
