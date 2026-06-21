// SiamEPOS Spa — Electron desktop shell (Phase B: offline-capable)
//
// Phase A was a thin wrapper that loaded the live cloud site. Phase B turns
// this into a real offline-capable till:
//   - It spawns the spa's OWN Express server as a child process in
//     DB_MODE=local, backed by an ENCRYPTED SQLite database (SQLCipher).
//   - The local server serves both the API and the bundled React client, so
//     everything runs on one localhost origin and keeps working with no
//     internet. A background sync engine mirrors cloud⇆local when online.
//   - The DB encryption key is generated once and stored in the OS keychain
//     via Electron safeStorage (medical questionnaire data is encrypted at
//     rest — UK GDPR).
//
// Escape hatch: set SPA_APP_URL to load a remote URL instead of spawning the
// local server (the old Phase A thin-wrapper behaviour, handy for staging).
//
// Native extras carried over from Phase A: silent receipt printing, silent
// background auto-update, single installed-app window.

const { app, BrowserWindow, Menu, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const IS_DEV = !!process.env.ELECTRON_DEV;
const REMOTE_OVERRIDE = process.env.SPA_APP_URL || ''; // non-empty → thin mode
const LOCAL_PORT = parseInt(process.env.SPA_LOCAL_PORT || '5050', 10);
const LOCAL_URL = `http://localhost:${LOCAL_PORT}`;

let mainWindow = null;
let serverProc = null;

// ── Paths (differ between dev `npm start` and a packaged install) ────
function resolvePaths() {
  if (app.isPackaged) {
    const res = process.resourcesPath;
    return {
      serverEntry: path.join(res, 'src', 'server.js'),
      clientDist: path.join(res, 'client-dist'),
    };
  }
  const root = path.join(__dirname, '..');
  return {
    serverEntry: path.join(root, 'src', 'server.js'),
    clientDist: path.join(root, 'client', 'dist'),
  };
}

// ── Config (userData/config.json) ───────────────────────────────────
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}
function writeConfig(cfg) {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}
function configComplete(cfg) {
  // Enough to run the till + sync. Without cloud_api_url/sync_secret the app
  // still runs locally, but can't sync — so we require them in the wizard.
  return !!(cfg && cfg.cloud_api_url && cfg.sync_secret && cfg.spa_id);
}

// ── DB encryption key (OS keychain via safeStorage) ─────────────────
// Stored as an encrypted blob on disk; the plaintext key only ever lives in
// memory + the child server's env. Falls back to a plaintext keyfile (with a
// loud warning) on platforms where safeStorage isn't available.
function getOrCreateDbKey() {
  const userData = app.getPath('userData');
  const encPath = path.join(userData, 'db-key.enc');
  const rawPath = path.join(userData, 'db-key.raw');

  if (safeStorage.isEncryptionAvailable()) {
    if (fs.existsSync(encPath)) {
      try {
        return safeStorage.decryptString(fs.readFileSync(encPath));
      } catch (e) {
        console.error('[key] failed to decrypt DB key — regenerating:', e.message);
      }
    }
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(encPath, safeStorage.encryptString(key));
    return key;
  }

  // Fallback: no OS keychain (e.g. some Linux setups). Keep working but warn.
  console.warn('[key] safeStorage unavailable — DB key stored UNENCRYPTED on disk.');
  if (fs.existsSync(rawPath)) return fs.readFileSync(rawPath, 'utf8');
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(rawPath, key, { mode: 0o600 });
  return key;
}

// ── Spawn the local server ──────────────────────────────────────────
function startLocalServer() {
  const { serverEntry, clientDist } = resolvePaths();
  const cfg = readConfig();

  // A stable JWT secret so staff tokens survive restarts (offline login).
  if (!cfg.jwt_secret) {
    cfg.jwt_secret = crypto.randomBytes(48).toString('hex');
    writeConfig(cfg);
  }

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DB_MODE: 'local',
    SQLITE_PATH: path.join(app.getPath('userData'), 'siamepos-spa.db'),
    SQLITE_ENCRYPTION_KEY: getOrCreateDbKey(),
    CLIENT_DIST_PATH: clientDist,
    PORT: String(LOCAL_PORT),
    JWT_SECRET: cfg.jwt_secret,
    CLOUD_API_URL: cfg.cloud_api_url || '',
    SYNC_SECRET: cfg.sync_secret || '',
    SPA_ID: cfg.spa_id || '',
    SPA_NAME: cfg.spa_name || 'SiamEPOS Spa',
    SPA_EMAIL: cfg.spa_email || 'info@siamepos.co.uk',
  };
  // Never let a leftover DATABASE_URL pull us back onto Postgres.
  delete env.DATABASE_URL;

  serverProc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProc.on('exit', (code) => console.log(`[server] exited (${code})`));
}

// Poll /api/health until the local server answers (or we give up).
function waitForServer(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const probe = () => {
      const req = http.get(`${LOCAL_URL}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => req.destroy());
    };
    const retry = () => (Date.now() > deadline ? resolve(false) : setTimeout(probe, 400));
    probe();
  });
}

// ── Window ──────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0D1B3E',
    show: false,
    title: 'SiamEPOS Spa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.on('did-fail-load', (_e, errorCode, _desc, validatedURL) => {
    if (errorCode === -3) return; // ABORTED on normal navigations
    if (validatedURL && validatedURL.startsWith(currentTarget())) {
      mainWindow.loadFile(path.join(__dirname, 'offline.html'));
    }
  });

  // Belt-and-braces for the startup race: if the window ever beats the local
  // server and lands on Express's "Cannot GET /" 404, reload once so it
  // recovers on its own instead of showing a dead page.
  let _recovered = false;
  mainWindow.webContents.on('did-finish-load', async () => {
    if (_recovered || !mainWindow) return;
    try {
      const body = await mainWindow.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
      if (/Cannot GET/i.test(body)) {
        _recovered = true;
        setTimeout(() => mainWindow && mainWindow.reload(), 900);
      }
    } catch {}
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(currentTarget())) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

// The URL the window is currently meant to be showing.
function currentTarget() {
  return REMOTE_OVERRIDE || LOCAL_URL;
}

// ── First-run setup wizard ──────────────────────────────────────────
function showSetup() {
  mainWindow.loadFile(path.join(__dirname, 'setup.html'));
}
ipcMain.handle('save-setup', async (_e, data) => {
  const cfg = { ...readConfig(), ...data };
  writeConfig(cfg);
  await bootLocal();
  return { ok: true };
});
ipcMain.handle('get-config', () => {
  const { spa_name, cloud_api_url, spa_id } = readConfig();
  return { spa_name, cloud_api_url, spa_id }; // never expose secrets to renderer
});

// Boot the local server then point the window at it.
async function bootLocal() {
  if (!serverProc) startLocalServer();
  const ok = await waitForServer();
  if (ok) mainWindow.loadURL(LOCAL_URL);
  else mainWindow.loadFile(path.join(__dirname, 'offline.html'));
}

// Entry decision: remote override → thin mode; missing config → wizard;
// otherwise → boot the local server.
async function boot() {
  if (REMOTE_OVERRIDE) {
    mainWindow.loadURL(REMOTE_OVERRIDE);
    return;
  }
  if (!configComplete(readConfig())) {
    showSetup();
    return;
  }
  await bootLocal();
}

ipcMain.handle('retry-load', () => boot());

// ── Printing (carried over from Phase A) ────────────────────────────
ipcMain.handle('list-printers', async () => {
  if (!mainWindow) return [];
  try { return await mainWindow.webContents.getPrintersAsync(); } catch { return []; }
});
ipcMain.handle('print-receipt', async (_e, opts = {}) => {
  if (!mainWindow) return { ok: false, error: 'no-window' };
  return new Promise((resolve) => {
    mainWindow.webContents.print(
      { silent: opts.silent !== false, printBackground: true, deviceName: opts.deviceName || undefined, margins: { marginType: 'none' } },
      (success, failureReason) => resolve({ ok: success, error: success ? null : failureReason })
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
        { label: 'Print Receipt', accelerator: 'CmdOrCtrl+P', click: () => mainWindow && mainWindow.webContents.print({ silent: false, printBackground: true }) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      // Without this Edit menu, Cmd/Ctrl+C/V/X don't work in text fields on
      // macOS — Electron wires the clipboard shortcuts through these roles.
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        ...(isMac
          ? [{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }]
          : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }]),
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.loadURL(currentTarget()) },
        { role: 'togglefullscreen' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        ...(IS_DEV ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Settings',
      submenu: [
        { label: 'Re-run Setup…', click: () => mainWindow && showSetup() },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About SiamEPOS Spa',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info', title: 'SiamEPOS Spa', message: 'SiamEPOS Spa',
            detail: `Version ${app.getVersion()}\nThai massage & spa management.\ninfo@siamepos.co.uk`,
          }),
        },
        { label: 'Visit SiamEPOS', click: () => shell.openExternal('https://siamepos.co.uk') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Auto-update (packaged builds only) ──────────────────────────────
function initAutoUpdate() {
  if (IS_DEV || !app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', () => mainWindow && mainWindow.webContents.send('siamepos-spa:update-ready'));
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

// ── Single-instance lock ────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    boot();
    initAutoUpdate();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

// Make sure the spawned server dies with the app.
function killServer() {
  if (serverProc && !serverProc.killed) { try { serverProc.kill(); } catch {} }
}
app.on('before-quit', killServer);
app.on('window-all-closed', () => { killServer(); if (process.platform !== 'darwin') app.quit(); });
