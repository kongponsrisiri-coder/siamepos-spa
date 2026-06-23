// SEPOS-SPA-LICENSE-001 — license endpoints + the desktop order guard.
//
//   GET  /api/license          (cloud) — issues a signed "paid-up" token based
//                                         on this spa's license_status setting.
//   GET  /api/license-state    (local) — the till's cached lock state (UI poll).
//   POST /api/license-recheck  (local) — force a check-in, return fresh state.
//
// Single-tenant per deployment: each spa is its own cloud, so "is this spa paid
// up?" is a single `settings.license_status` value ('active' | 'suspended').
// Flip it to 'suspended' to lock that spa's tills after the grace window.

const express = require('express');
const { pool } = require('../db/dbAdapter');
const licenseService = require('./../services/licenseService');
const licenseClient = require('./../services/licenseClient');

const router = express.Router();
const IS_LOCAL = (process.env.DB_MODE || '').toLowerCase() === 'local';

// GET /api/license — the cloud's signed "paid-up pass".
router.get('/license', async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'license_status'");
    const status = (rows[0] && rows[0].value) || 'active';
    if (status === 'suspended' || status === 'cancelled') {
      return res.json({ active: false, status });
    }
    const now = Date.now();
    const payload = {
      status,
      issued_at: now,
      valid_until: now + licenseService.GRACE_DAYS * 24 * 60 * 60 * 1000,
    };
    const token = licenseService.signLicense(payload);
    // No signing key yet → fail open (unsigned active), so enforcement can be
    // rolled out before LICENSE_PRIVATE_KEY is deployed.
    if (!token) return res.json({ active: true, status, unsigned: true, valid_until: payload.valid_until });
    res.json({ active: true, status, token, valid_until: payload.valid_until });
  } catch (err) {
    // Fail open — a glitch must never lock a paying spa out.
    res.json({ active: true, status: 'active', error: err.message });
  }
});

// GET /api/license-state — the local till's cached lock decision (UI polls this).
router.get('/license-state', (_req, res) => {
  try { res.json(licenseClient.getLicenseState()); }
  catch { res.json({ locked: false, reason: 'error' }); }
});

// POST /api/license-recheck — force a cloud check-in (the "I've paid" button).
router.post('/license-recheck', async (_req, res) => {
  try { await licenseClient.checkIn(); res.json(licenseClient.getLicenseState()); }
  catch { res.json({ locked: false, reason: 'error' }); }
});

// Order guard — applied to the money/booking write routes. Only enforces on the
// desktop till (local mode); the cloud is never gated here. Fails OPEN: any
// glitch, or enforcement not yet active, lets the request through.
function requireValidLicense(req, res, next) {
  try {
    if (!IS_LOCAL) return next();
    const st = licenseClient.getLicenseState();
    if (st && st.locked) {
      return res.status(403).json({
        error: 'license_locked',
        reason: st.reason,
        message: 'SiamEPOS Spa subscription has lapsed. Please contact SiamEPOS to reactivate this till.',
      });
    }
  } catch (e) {
    // Any glitch → allow (a paying till must never be locked by a bug here).
  }
  next();
}

module.exports = { router, requireValidLicense };
