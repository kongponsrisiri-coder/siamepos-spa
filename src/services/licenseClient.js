'use strict';

// SEPOS-SPA-LICENSE-001 — desktop OFFLINE license lock (till side).
//
// Runs ONLY on the desktop till (local mode). Periodically checks in with the
// spa cloud's GET /api/license, verifies the SIGNED token with the bundled
// public key (licenseService), and caches `valid_until` + the highest timestamp
// ever seen (clock-rollback guard) to a small JSON file in userData. The order
// guard + the React lock screen read this cache via getLicenseState().
//
// Design guarantees:
//  • FAILS OPEN. Until the cloud is issuing SIGNED tokens (i.e. until
//    LICENSE_PRIVATE_KEY is deployed on the spa cloud), the till is NEVER
//    locked. So shipping this build cannot brick a paying till before
//    enforcement is deliberately switched on.
//  • A suspended spa stops getting fresh tokens, so its cached valid_until runs
//    out the GRACE window (default 14 days) and THEN locks — never instantly,
//    never mid-service for someone who's been paying.
//  • Genuine internet drops don't lock: the cached token stays valid until its
//    valid_until passes, regardless of connectivity.
//  • Clock-rollback: setting the PC clock back past the highest time we've seen
//    (beyond a day of tolerance) is treated as tampering → locked.

const fs = require('fs');
const path = require('path');
const licenseService = require('./licenseService');

const CLOUD_API_URL = process.env.CLOUD_API_URL;
const SQLITE_PATH = process.env.SQLITE_PATH;
// State lives next to the local DB in userData. No SQLITE_PATH → not a desktop
// till → this module is inert (getLicenseState always returns unlocked).
const STATE_PATH = SQLITE_PATH ? path.join(path.dirname(SQLITE_PATH), 'license-state.json') : null;

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // re-check every 6h (and on launch)
const CLOCK_TOLERANCE_MS = 24 * 60 * 60 * 1000; // tolerate 1 day of legit clock drift
const FETCH_TIMEOUT_MS = 10000;

let state = {
  valid_until: null, // ms epoch of the cached token's expiry; null = no signed token seen
  max_seen: 0,       // highest timestamp ever observed (clock-rollback guard)
  status: 'active',  // last known cloud status
  enforced: false,   // true once we've EVER verified a signed token (enforcement is on)
  last_check: 0,
};

function load() {
  if (!STATE_PATH) return;
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) };
  } catch { /* first run / unreadable — keep defaults */ }
}

function save() {
  if (!STATE_PATH) return;
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch (e) {
    console.warn('[license] state save failed:', e.message);
  }
}

// Pure lock decision from the cached state. { locked, reason, valid_until, status }.
function getLicenseState() {
  const now = Date.now();
  // Not a desktop till, or enforcement never activated → never lock (fail open).
  if (!STATE_PATH || !state.enforced || !state.valid_until) {
    return { locked: false, reason: 'not_enforced', valid_until: state.valid_until, status: state.status, enforced: state.enforced };
  }
  // Clock rolled back past the highest time we've seen → tampering.
  if (state.max_seen && now < state.max_seen - CLOCK_TOLERANCE_MS) {
    return { locked: true, reason: 'clock_rollback', valid_until: state.valid_until, status: state.status, enforced: true };
  }
  if (now > state.valid_until) {
    return { locked: true, reason: 'expired', valid_until: state.valid_until, status: state.status, enforced: true };
  }
  return { locked: false, reason: 'ok', valid_until: state.valid_until, status: state.status, enforced: true };
}

// One check-in with the cloud. Safe to call any time; swallows all errors
// (offline must never lock a till that has a still-valid cached token).
async function checkIn() {
  if (!STATE_PATH || !CLOUD_API_URL) return;
  const now = Date.now();
  try {
    const r = await fetch(CLOUD_API_URL + '/api/license', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    state.max_seen = Math.max(state.max_seen || 0, now);
    state.last_check = now;
    if (!r.ok) { save(); return; }
    const data = await r.json();

    if (data && data.token) {
      // Signed token — verify with the bundled public key.
      const payload = licenseService.verifyLicense(data.token);
      if (payload && payload.valid_until) {
        state.enforced = true;                 // enforcement is now active for this till
        state.valid_until = payload.valid_until;
        state.status = payload.status || 'active';
        save();
        return;
      }
      // Token present but failed verification (tamper / key mismatch) → do NOT
      // extend. Leave prior state (fail open if never enforced).
      save();
      return;
    }

    if (data && data.active === false) {
      // Cloud refuses to issue a token (suspended). Do NOT extend valid_until —
      // the cached token runs out its grace, then locks.
      state.status = data.status || 'suspended';
      save();
      return;
    }

    // Unsigned active (LICENSE_PRIVATE_KEY not deployed yet) → fail open.
    if (data) state.status = data.status || 'active';
    save();
  } catch (e) {
    // Offline / timeout / DNS — keep the cached state untouched (don't lock).
    state.last_check = now;
  }
}

let timer = null;
function start() {
  if (!STATE_PATH) return; // cloud / non-desktop → inert
  load();
  checkIn(); // on launch
  timer = setInterval(checkIn, CHECK_INTERVAL_MS);
  if (timer && timer.unref) timer.unref();
  console.log('[license] offline lock active — state at', STATE_PATH);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, checkIn, getLicenseState };
