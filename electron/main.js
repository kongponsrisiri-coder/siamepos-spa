// SiamEPOS Spa — Electron desktop shell (Phase A)
//
// This is a THIN desktop wrapper around the live cloud web app.
//   - It loads https://spa.siamepos.co.uk in a real browser window
//     (so UI updates ship instantly — no app rebuild needed).
//   - Cloud (Railway Postgres) stays the single source of truth.
//   - Offline DATA support (local SQLite + sync) is Phase B; for now
//     we show a friendly "can't reach the internet" screen and retry.
//
// Native extras the browser can't do, added here:
//   - Silent receipt printing to a chosen system printer.
//   - Silent background auto-update via GitHub Releases.
//   - A proper installed-app window (kiosk-style, no address bar).

const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────
// The live web app. Override with SPA_APP_URL for staging/dev.
const APP_URL = process.env.SPA_APP_URL || 'https://spa.siamepos.co.uk';
const IS_DEV = !!process.env.ELECTRON_DEV;

let mainWindow = null;

// ── Single-instance lock ────────────────────────────────────────────
// A till should only ever run one copy. Second launch focuses the first.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ── Window ──────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0D1B3E', // spa brand navy — no white flash on load
    show: false,
    title: 'SiamEPOS Spa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Show only once the page has painted — avoids a blank flash.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  loadApp();

  // If the live site can't be reached, show the bundled offline screen.
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL) => {
    // -3 (ABORTED) fires on normal in-app navigations; ignore it.
    if (errorCode === -3) return;
    // Only swap to the offline page for top-level navigation failures.
    if (validatedURL && validatedURL.startsWith(APP_URL)) {
      mainWindow.loadFile(path.join(__dirname, 'offline.html'));
    }
  });

  // External links (e.g. a help page, Stripe) open in the real browser,
  // not inside the till window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

function loadApp() {
  mainWindow.loadURL(APP_URL);
}

// Called by the offline screen's "Try again" button (via preload).
ipcMain.handle('retry-load', () => {
  if (mainWindow) loadApp();
});

// ── Printing ────────────────────────────────────────────────────────
// Phase A: print whatever's on screen (e.g. a receipt view) silently to
// the default — or a named — printer. Real ESC/POS thermal formatting is
// a follow-on once we pick the spa's printer hardware (Phase A.2).
ipcMain.handle('list-printers', async () => {
  if (!mainWindow) return [];
  try {
    return await mainWindow.webContents.getPrintersAsync();
  } catch {
    return [];
  }
});

ipcMain.handle('print-receipt', async (_e, opts = {}) => {
  if (!mainWindow) return { ok: false, error: 'no-window' };
  return new Promise((resolve) => {
    mainWindow.webContents.print(
      {
        silent: opts.silent !== false, // default to silent for a till
        printBackground: true,
        deviceName: opts.deviceName || undefined,
        margins: { marginType: 'none' },
      },
      (success, failureReason) => {
        resolve({ ok: success, error: success ? null : failureReason });
      }
    );
  });
});

// ── Application menu ────────────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Print Receipt',
          accelerator: 'CmdOrCtrl+P',
          click: () => mainWindow && mainWindow.webContents.print({ silent: false, printBackground: true }),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow && mainWindow.loadURL(APP_URL),
        },
        { role: 'togglefullscreen' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(IS_DEV ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About SiamEPOS Spa',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'SiamEPOS Spa',
              message: 'SiamEPOS Spa',
              detail: `Version ${app.getVersion()}\nThai massage & spa management.\ninfo@siamepos.co.uk`,
            });
          },
        },
        {
          label: 'Visit SiamEPOS',
          click: () => shell.openExternal('https://siamepos.co.uk'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Auto-update ─────────────────────────────────────────────────────
// Silent background download from GitHub Releases; applies on next quit.
// Only runs in a packaged build (no-op under `npm start`).
function initAutoUpdate() {
  if (IS_DEV || !app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return; // dependency not present — skip silently
  }
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', () => {
    if (mainWindow) {
      mainWindow.webContents.send('siamepos-spa:update-ready');
    }
  });
  autoUpdater.checkForUpdatesAndNotify().catch(() => {/* offline — ignore */});
}

// ── Lifecycle ───────────────────────────────────────────────────────
app.whenReady().then(() => {
  buildMenu();
  createWindow();
  initAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
