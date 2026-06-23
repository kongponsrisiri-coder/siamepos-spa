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

  // ── App & Updates (admin Settings card) ──────────────────────────
  getAppVersion:   () => ipcRenderer.invoke('app-version'),
  getUpdateStatus: () => ipcRenderer.invoke('update-status'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  quitAndInstall:  () => ipcRenderer.invoke('quit-and-install'),

  // Subscribe to a live update event. `event` is one of:
  //   checking | available | none | progress | error | ready
  // Returns an unsubscribe fn so the React card can clean up on unmount
  // (avoids stacking listeners each time the Settings tab re-mounts).
  onUpdate: (event, cb) => {
    const channel = `siamepos-spa:update-${event}`;
    const handler = (_e, payload) => cb && cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
