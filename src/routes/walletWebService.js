// SPA-LOYALTY-001 Layer 2 — Apple Wallet pass web service + pass downloads.
// Mounted PUBLIC at /api/wallet (Apple's servers and customers' phones call
// it); every route authenticates with the per-pass token in wallet_passes
// ("Authorization: ApplePass <token>" from Apple, ?t= on download links).
//
// Apple's REST contract (webServiceURL = <PUBLIC_API_URL>/api/wallet):
//   POST   /v1/devices/:deviceId/registrations/:passTypeId/:serial  register
//   DELETE /v1/devices/:deviceId/registrations/:passTypeId/:serial  unregister
//   GET    /v1/devices/:deviceId/registrations/:passTypeId          what changed
//   GET    /v1/passes/:passTypeId/:serial                           latest .pkpass
//   POST   /v1/log                                                  device logs
//
// Download links (from emails):
//   GET /api/wallet/loyalty/:serial.pkpass?t=<auth_token>
//
// Serves BOTH pass kinds: 'loyalty' (built from live loyalty state) and
// 'voucher' (built from the voucher row — balance updates ride along free).

const express = require('express');
const { pool } = require('../db/dbAdapter');
const { PASS_TYPE_ID, buildVoucherPass } = require('../services/voucherWalletPass');
const loyaltyWalletPass = require('../services/loyaltyWalletPass');
const loyaltyService = require('../services/loyaltyService');

const router = express.Router();

function apiBase() {
  return (process.env.PUBLIC_API_URL || 'https://spa-api.siamepos.co.uk').replace(/\/$/, '');
}

async function passBySerial(serial) {
  const r = await pool.query(`SELECT * FROM wallet_passes WHERE serial = $1`, [serial]);
  return r.rows[0] || null;
}

// Apple sends "Authorization: ApplePass <token>"; download links send ?t=.
function providedToken(req) {
  const h = req.get('authorization') || '';
  if (h.startsWith('ApplePass ')) return h.slice('ApplePass '.length).trim();
  return (req.query && (req.query.t || req.query.token)) || null;
}

// Constant-time-ish compare (both sides are our own random hex).
function tokenOk(pass, req) {
  const t = providedToken(req);
  return !!t && !!pass && t === pass.auth_token;
}

// Build the current .pkpass buffer for a wallet_passes row.
async function buildForPass(pass) {
  if (pass.kind === 'loyalty') {
    const c = await pool.query(`SELECT * FROM clients WHERE id = $1`, [pass.client_id]);
    if (!c.rows[0]) return null;
    const status = await loyaltyService.getStatus(pass.client_id);
    return loyaltyWalletPass.buildLoyaltyPass({
      client: c.rows[0],
      status: status || { visits: 0, tiers: [], available_rewards: [], redeemed_tiers: [] },
      serial: pass.serial,
      authToken: pass.auth_token,
    });
  }
  // kind = 'voucher' — serial is the voucher code.
  const v = await pool.query(
    `SELECT v.*, t.name AS treatment_name
     FROM vouchers v LEFT JOIN treatments t ON t.id = v.treatment_id
     WHERE v.code = $1`,
    [pass.serial],
  );
  if (!v.rows[0]) return null;
  return buildVoucherPass(v.rows[0], {
    webServiceURL: `${apiBase()}/api/wallet`,
    authenticationToken: pass.auth_token,
  });
}

function sendPkpass(res, buf, updatedAt) {
  res.set('content-type', 'application/vnd.apple.pkpass');
  if (updatedAt) res.set('last-modified', new Date(updatedAt).toUTCString());
  res.send(buf);
}

// ── Customer download links (from the loyalty email) ────────────────────────
router.get('/loyalty/:serial.pkpass', async (req, res) => {
  try {
    const pass = await passBySerial(req.params.serial);
    if (!pass || pass.kind !== 'loyalty' || !tokenOk(pass, req)) {
      return res.status(401).json({ error: 'unauthorised' });
    }
    const buf = await buildForPass(pass);
    if (!buf) return res.status(404).json({ error: 'not found' });
    sendPkpass(res, buf, pass.updated_at);
  } catch (err) {
    if (err.code === 'PASS_NOT_CONFIGURED') return res.status(503).json({ error: 'wallet passes not configured' });
    console.error('[wallet] loyalty download', err);
    res.status(500).json({ error: 'server error' });
  }
});

// ── Apple pass web service ──────────────────────────────────────────────────
// Register a device for pass updates. Body: { pushToken }.
router.post('/v1/devices/:deviceId/registrations/:passTypeId/:serial', async (req, res) => {
  try {
    if (req.params.passTypeId !== PASS_TYPE_ID) return res.status(404).end();
    const pass = await passBySerial(req.params.serial);
    if (!pass) return res.status(404).end();
    if (!tokenOk(pass, req)) return res.status(401).end();
    const pushToken = req.body && req.body.pushToken;
    if (!pushToken) return res.status(400).end();
    const existing = await pool.query(
      `SELECT id, push_token FROM wallet_registrations WHERE device_library_id = $1 AND serial = $2`,
      [req.params.deviceId, req.params.serial],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].push_token !== pushToken) {
        await pool.query(`UPDATE wallet_registrations SET push_token = $2 WHERE id = $1`,
          [existing.rows[0].id, pushToken]);
      }
      return res.status(200).end(); // already registered
    }
    await pool.query(
      `INSERT INTO wallet_registrations (device_library_id, push_token, serial) VALUES ($1, $2, $3)`,
      [req.params.deviceId, pushToken, req.params.serial],
    );
    res.status(201).end();
  } catch (err) {
    console.error('[wallet] register', err);
    res.status(500).end();
  }
});

// Unregister a device (pass removed from Wallet).
router.delete('/v1/devices/:deviceId/registrations/:passTypeId/:serial', async (req, res) => {
  try {
    if (req.params.passTypeId !== PASS_TYPE_ID) return res.status(404).end();
    const pass = await passBySerial(req.params.serial);
    if (!pass) return res.status(404).end();
    if (!tokenOk(pass, req)) return res.status(401).end();
    await pool.query(
      `DELETE FROM wallet_registrations WHERE device_library_id = $1 AND serial = $2`,
      [req.params.deviceId, req.params.serial],
    );
    res.status(200).end();
  } catch (err) {
    console.error('[wallet] unregister', err);
    res.status(500).end();
  }
});

// Which of this device's passes changed since the tag? (No per-pass auth —
// Apple's spec: returns serials only, the pass fetch itself is authenticated.)
router.get('/v1/devices/:deviceId/registrations/:passTypeId', async (req, res) => {
  try {
    if (req.params.passTypeId !== PASS_TYPE_ID) return res.status(404).end();
    const since = req.query.passesUpdatedSince ? new Date(Number(req.query.passesUpdatedSince) * 1000) : null;
    const r = await pool.query(
      `SELECT wp.serial, wp.updated_at
       FROM wallet_registrations wr
       JOIN wallet_passes wp ON wp.serial = wr.serial
       WHERE wr.device_library_id = $1`,
      [req.params.deviceId],
    );
    if (!r.rows.length) return res.status(404).end();
    const changed = r.rows.filter((row) =>
      !since || Number.isNaN(since.getTime()) || new Date(row.updated_at) > since);
    if (!changed.length) return res.status(204).end();
    const lastUpdated = Math.max(...changed.map((row) => Math.floor(new Date(row.updated_at).getTime() / 1000)));
    res.json({
      serialNumbers: changed.map((row) => row.serial),
      lastUpdated: String(lastUpdated),
    });
  } catch (err) {
    console.error('[wallet] registrations', err);
    res.status(500).end();
  }
});

// Latest version of a pass (Wallet re-fetches after a push).
router.get('/v1/passes/:passTypeId/:serial', async (req, res) => {
  try {
    if (req.params.passTypeId !== PASS_TYPE_ID) return res.status(404).end();
    const pass = await passBySerial(req.params.serial);
    if (!pass) return res.status(404).end();
    if (!tokenOk(pass, req)) return res.status(401).end();
    const buf = await buildForPass(pass);
    if (!buf) return res.status(404).end();
    sendPkpass(res, buf, pass.updated_at);
  } catch (err) {
    if (err.code === 'PASS_NOT_CONFIGURED') return res.status(503).end();
    console.error('[wallet] pass fetch', err);
    res.status(500).end();
  }
});

// Device-side error logs — Apple posts these when something's wrong with the
// pass or our service. Surfacing them in the server log is the whole point.
router.post('/v1/log', (req, res) => {
  const logs = (req.body && req.body.logs) || [];
  for (const line of logs) console.warn('[wallet] device log:', line);
  res.status(200).end();
});

module.exports = router;
