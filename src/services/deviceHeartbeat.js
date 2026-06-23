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
const SQLITE_PATH = process.env.SQLITE_PATH; // present only on a desktop till
const SPA_ID = process.env.SPA_ID || null;
const APP_VERSION = process.env.APP_VERSION || null;

// 5-minute cadence matches the restaurant-epos heartbeat + the ops health poll,
// so last_seen stays fresh (the original ticket said reuse the 6h license timer,
// but Krit's canonical reference posts every 5 min — match that).
const INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

async function send() {
  if (!SQLITE_PATH || !CLOUD_API_URL) return;
  try {
    const device_id = await getDeviceId();
    await fetch(CLOUD_API_URL + '/api/device/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
