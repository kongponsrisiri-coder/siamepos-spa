// SPA-LINE-PAIR-001 — "Connect LINE" without anyone hunting for a user id.
//
// A LINE user id is not something a shop owner can look up: it is an internal
// id our bot only learns when they message it. So: the spa shows a short code,
// the owner sends that code to our LINE account, and the webhook stores the
// sender's id against the code. The spa polls for it and saves it.
//
// One LINE channel can only point at ONE webhook, so a single cloud acts as
// the broker for every spa (LINE_PAIR_BROKER, default the main spa cloud).
// Codes are short-lived and single-use, and carry nothing secret.
const crypto = require('crypto');
const { pool } = require('../db/dbAdapter');

const TTL_MIN = 15;
const BROKER = (process.env.LINE_PAIR_BROKER || 'https://spa-api.siamepos.co.uk').replace(/\/+$/, '');
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes: typed by a human into LINE

function isBroker() {
  const me = (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
  return !!me && me === BROKER;
}

async function newCode(spaName) {
  for (let i = 0; i < 10; i++) {
    let c = 'SPA-';
    for (let j = 0; j < 4; j++) c += CHARS[crypto.randomInt(CHARS.length)];
    try {
      await pool.query('INSERT INTO line_pairings (code, spa) VALUES ($1, $2)', [c, spaName || null]);
      return { code: c, expires_in_minutes: TTL_MIN };
    } catch (e) { /* collision — try again */ }
  }
  throw new Error('could not generate a pairing code');
}

// Called by the webhook when a message looks like a pairing code.
async function claim(code, userId) {
  const { rows } = await pool.query(
    `UPDATE line_pairings
        SET user_id = $2, paired_at = now()
      WHERE code = $1 AND user_id IS NULL
        AND created_at > now() - interval '${TTL_MIN} minutes'
      RETURNING code, spa`,
    [String(code).toUpperCase(), userId],
  );
  return rows[0] || null;
}

// Broker-side lookup: has this code been claimed yet?
async function lookup(code) {
  const { rows } = await pool.query(
    `SELECT user_id FROM line_pairings
      WHERE code = $1 AND created_at > now() - interval '${TTL_MIN} minutes'`,
    [String(code).toUpperCase()],
  );
  if (!rows[0]) return { status: 'unknown' };
  return rows[0].user_id ? { status: 'paired', user_id: rows[0].user_id } : { status: 'waiting' };
}

// Tenant-side: ask the broker (or ourselves, if we are the broker).
async function check(code) {
  if (isBroker()) return lookup(code);
  try {
    const res = await fetch(`${BROKER}/api/line/pair/${encodeURIComponent(code)}`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return { status: 'unknown' };
    return await res.json();
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

// Tenant-side: start a pairing. The code is minted on the BROKER, because that
// is where the LINE message will land.
async function start(spaName) {
  if (isBroker()) return newCode(spaName);
  try {
    const res = await fetch(`${BROKER}/api/line/pair/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spa: spaName || null }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`broker said ${res.status}`);
    return await res.json();
  } catch (e) {
    throw new Error(`Could not reach the pairing service: ${e.message}`);
  }
}

async function cleanup() {
  try {
    await pool.query(`DELETE FROM line_pairings WHERE created_at < now() - interval '1 day'`);
  } catch (e) { /* best effort */ }
}

module.exports = { newCode, claim, lookup, check, start, cleanup, isBroker, TTL_MIN, BROKER };
