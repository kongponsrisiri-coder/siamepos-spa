'use strict';

// SEPOS-SPA-LICENSE-001 Part B — desktop heartbeat sender (till side).
//
// Runs ONLY on the desktop till (local mode). POSTs this device's id + version +
// platform to the spa cloud on launch and every 6h (same "phone home" cadence as
// the license check-in). Best-effort: swallows all errors — a failed heartbeat
// must never affect the till. Reuses syncService's stable per-device id so the
// ops device_id matches the one folded into sync op-keys.

const { getDeviceId } = require('./syncService');

const CLOUD_API_URL = process.env.CLOUD_API_URL;
const SYNC_SECRET = process.env.SYNC_SECRET;
const SQLITE_PATH = process.env.SQLITE_PATH; // present only on a desktop till
const SPA_ID = process.env.SPA_ID || null;
const APP_VERSION = process.env.APP_VERSION || null;

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

async function send() {
  if (!SQLITE_PATH || !CLOUD_API_URL || !SYNC_SECRET) return;
  try {
    const device_id = await getDeviceId();
    await fetch(CLOUD_API_URL + '/api/device/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-secret': SYNC_SECRET },
      body: JSON.stringify({ device_id, spa_id: SPA_ID, app_version: APP_VERSION, platform: process.platform }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) { /* offline / cloud down — try again next tick */ }
}

let timer = null;
function start() {
  if (!SQLITE_PATH) return; // cloud / non-desktop → inert
  send(); // on launch
  timer = setInterval(send, INTERVAL_MS);
  if (timer && timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, send };
