// SPA-LOYALTY-001 Layer 2 — APNs push for Apple Wallet pass updates.
//
// When a pass's content changes (loyalty visit earned, voucher redeemed) we:
//   1. bump wallet_passes.updated_at (drives passesUpdatedSince/Last-Modified)
//   2. send an EMPTY APNs notification to every device registered for that
//      serial — Wallet then calls our pass web service to re-fetch the pass.
//
// Auth: the pass-type certificate doubles as the APNs client certificate
// (Apple grants pass-type certs push capability for their own passes), so no
// separate APNs key is needed — same PASS_SIGNER_* envs as pass signing.
// Silent no-op when certs aren't configured (e.g. a local till, where pass
// updates are the CLOUD's job anyway).

const http2 = require('http2');
const { pool } = require('../db/dbAdapter');
const { getCerts, PASS_TYPE_ID, isConfigured } = require('./voucherWalletPass');

const APNS_HOST = 'https://api.push.apple.com';

// Push one empty notification per device token. Registrations whose token
// Apple reports dead (410 Unregistered / 400 BadDeviceToken) are pruned.
async function pushTokens(tokens) {
  if (!tokens.length || !isConfigured()) return { pushed: 0 };
  const certs = getCerts();
  const client = http2.connect(APNS_HOST, {
    cert: certs.signerCert,
    key: certs.signerKey,
    passphrase: certs.signerKeyPassphrase,
  });
  let pushed = 0;
  const dead = [];
  try {
    await Promise.all(tokens.map((token) => new Promise((resolve) => {
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        'apns-topic': PASS_TYPE_ID,
        'apns-push-type': 'alert',
        'apns-priority': '10',
      });
      let status = 0;
      req.setTimeout(10000, () => { req.close(); resolve(); });
      req.on('response', (headers) => { status = headers[':status']; });
      req.on('close', () => {
        if (status === 200) pushed++;
        else if (status === 410 || status === 400) dead.push(token);
        else if (status) console.warn('[walletPush] APNs', status, 'for token', token.slice(0, 8) + '…');
        resolve();
      });
      req.on('error', () => resolve());
      req.end('{}'); // Wallet pass pushes carry an empty payload
    })));
  } finally {
    client.close();
  }
  if (dead.length) {
    await pool.query(`DELETE FROM wallet_registrations WHERE push_token = ANY($1)`, [dead])
      .catch(() => {});
  }
  return { pushed, pruned: dead.length };
}

// Bump + push everything registered for a serial. Never throws.
async function notifySerial(serial) {
  try {
    await pool.query(`UPDATE wallet_passes SET updated_at = now() WHERE serial = $1`, [serial]);
    const regs = await pool.query(
      `SELECT DISTINCT push_token FROM wallet_registrations WHERE serial = $1`,
      [serial],
    );
    if (!regs.rows.length) return { pushed: 0 };
    return await pushTokens(regs.rows.map((r) => r.push_token));
  } catch (e) {
    console.error('[walletPush] notifySerial failed:', e.message);
    return { pushed: 0 };
  }
}

// A client's loyalty counters changed → refresh their loyalty card (if issued).
async function bumpLoyaltyPass(clientId) {
  try {
    const r = await pool.query(
      `SELECT serial FROM wallet_passes WHERE kind = 'loyalty' AND client_id = $1`,
      [clientId],
    );
    if (!r.rows[0]) return { pushed: 0 }; // customer never added the card
    return await notifySerial(r.rows[0].serial);
  } catch (e) {
    console.error('[walletPush] bumpLoyaltyPass failed:', e.message);
    return { pushed: 0 };
  }
}

// A voucher's balance/status changed → refresh its pass (serial = the code).
async function bumpVoucherPass(code) {
  try {
    if (!code) return { pushed: 0 };
    const r = await pool.query(
      `SELECT serial FROM wallet_passes WHERE kind = 'voucher' AND serial = $1`,
      [code],
    );
    if (!r.rows[0]) return { pushed: 0 };
    return await notifySerial(code);
  } catch (e) {
    console.error('[walletPush] bumpVoucherPass failed:', e.message);
    return { pushed: 0 };
  }
}

module.exports = { notifySerial, bumpLoyaltyPass, bumpVoucherPass };
