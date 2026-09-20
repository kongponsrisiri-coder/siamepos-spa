// SPA-DEVICE-PAIR-001 — routes for pairing a tablet to a spa.
//
// Two audiences:
//   · the TENANT route is admin-only — you must already be signed in to the
//     spa to invite a device to it. That is the whole security property.
//   · the BROKER routes are public by necessity: a tablet being set up has no
//     token and does not yet know which cloud it belongs to. They are safe
//     because a code is short-lived, single-use, and useless without someone
//     having generated it from inside the spa.
const express = require('express');
const { requireRole } = require('../middleware/auth');
const devicePair = require('../services/devicePair');

const router = express.Router();

// ── Tenant: "pair a new tablet" (Admin → Mobile App) ───────────────────────
router.post('/pair/start', requireRole('admin', 'manager'), async (_req, res) => {
  try {
    const r = await devicePair.start();
    res.json({ ...r, spa: process.env.SPA_NAME || '' });
  } catch (err) {
    console.error('[device-pair] start', err);
    res.status(500).json({ error: err.message || 'could not create a setup code' });
  }
});

// ── Broker: mint (called by another spa's cloud, not by a person) ──────────
const broker = express.Router();

broker.post('/start', async (req, res) => {
  if (!devicePair.isBroker()) return res.status(404).json({ error: 'not the pairing service' });
  const apiBase = String((req.body || {}).api_base || '').trim().replace(/\/+$/, '');
  // Only ever hand a tablet an https address — a code that resolved to http,
  // or to something that is not a URL, would point a till anywhere at all.
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(apiBase)) {
    return res.status(400).json({ error: 'api_base must be a plain https address' });
  }
  try {
    const r = await devicePair.mint(apiBase, String((req.body || {}).spa || '').slice(0, 120));
    res.json(r);
  } catch (err) {
    console.error('[device-pair] mint', err);
    res.status(500).json({ error: 'could not create a setup code' });
  }
});

// The tablet redeems its code here. Public: it has nothing to authenticate with.
broker.get('/:code', async (req, res) => {
  if (!devicePair.isBroker()) return res.status(404).json({ error: 'not the pairing service' });
  try {
    const row = await devicePair.redeem(req.params.code);
    if (!row) {
      return res.status(404).json({
        error: 'That setup code is not valid. It may have been used already, or it may have expired — ask the spa for a fresh one.',
      });
    }
    res.json({ api_base: row.api_base, spa: row.spa || '' });
  } catch (err) {
    console.error('[device-pair] redeem', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = { router, broker };
