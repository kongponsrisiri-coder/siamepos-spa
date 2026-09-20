// SPA-DEVICE-PAIR-001 — a tablet may only attach to a spa it was invited to.
//
// One APK serves every shop, and it is published on a public download link, so
// the first-run screen used to list the clients by name and let ANYONE who had
// the app tap "Highbury Thai Massage" and land on that shop's till. A PIN still
// stood in the way, but the list also told a stranger who our clients are, and
// "anyone can reach the front door of a client's till" is not a thing to leave
// standing.
//
// So the list is gone. A tablet now needs a SETUP CODE, and a setup code can
// only be produced by someone already signed in as an admin on that spa.
//
// Same broker shape as the LINE pairing (services/linePair.js): a tablet has no
// idea which cloud it belongs to yet, so one known cloud holds code -> address.
// The code carries nothing secret, is single-use, and dies after 15 minutes.
const crypto = require('crypto');
const { pool } = require('../db/dbAdapter');

const TTL_MIN = 15;
const BROKER = (process.env.DEVICE_PAIR_BROKER || 'https://spa-api.siamepos.co.uk').replace(/\/+$/, '');
// No look-alikes: this gets read off one screen and typed into another.
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function me() { return (process.env.PUBLIC_API_URL || '').replace(/\/+$/, ''); }
function isBroker() { return !!me() && me() === BROKER; }

// Broker side — mint a code for a spa's address.
async function mint(apiBase, spaName) {
  for (let i = 0; i < 10; i++) {
    let c = '';
    for (let j = 0; j < 6; j++) c += CHARS[crypto.randomInt(CHARS.length)];
    try {
      await pool.query(
        'INSERT INTO device_pairings (code, api_base, spa) VALUES ($1, $2, $3)',
        [c, apiBase, spaName || null],
      );
      return { code: c, expires_in_minutes: TTL_MIN };
    } catch (e) { /* collision — try again */ }
  }
  throw new Error('could not generate a setup code');
}

// Broker side — redeem. Single use: the UPDATE only matches an unclaimed row,
// so a code shoulder-surfed after the fact is already spent.
async function redeem(code) {
  const { rows } = await pool.query(
    `UPDATE device_pairings
        SET claimed_at = now()
      WHERE code = $1 AND claimed_at IS NULL
        AND created_at > now() - interval '${TTL_MIN} minutes'
      RETURNING api_base, spa`,
    [String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')],
  );
  return rows[0] || null;
}

// Tenant side — ask the broker for a code covering THIS spa (or mint it
// ourselves when we are the broker).
async function start() {
  const apiBase = me();
  if (!apiBase) throw new Error('PUBLIC_API_URL is not set on this spa, so a tablet would have no address to be given');
  const spaName = process.env.SPA_NAME || '';
  if (isBroker()) return await mint(apiBase, spaName);

  const res = await fetch(`${BROKER}/device-pair/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_base: apiBase, spa: spaName }),
  });
  if (!res.ok) throw new Error(`the pairing service answered ${res.status}`);
  return await res.json();
}

module.exports = { mint, redeem, start, isBroker, BROKER, TTL_MIN };
