// SEPOS-SPA-LICENSE-001 Part B — device heartbeat (ops visibility).
//
// Installed desktop tills sit behind NAT, so ops can't poll them. Each till
// POSTs here on launch + on the license check-in cadence; the cloud records it
// in `devices`, and /api/health surfaces the list so ops sees which devices are
// installed, their version, and last-seen. Gated by the same SYNC_SECRET as the
// sync feed (the till already holds it).

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db/dbAdapter');

const router = express.Router();

function gate(req, res, next) {
  const secret = process.env.SYNC_SECRET || '';
  if (!secret) return res.status(401).json({ error: 'heartbeat disabled (no SYNC_SECRET)' });
  const a = Buffer.from(req.get('x-sync-secret') || '');
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'bad secret' });
  }
  next();
}

// POST /api/device/heartbeat  body: { device_id, spa_id?, app_version?, platform? }
router.post('/heartbeat', gate, async (req, res) => {
  const { device_id, spa_id, app_version, platform } = req.body || {};
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  try {
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO devices (device_id, spa_id, app_version, platform, last_seen)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (device_id) DO UPDATE SET
         spa_id      = EXCLUDED.spa_id,
         app_version = EXCLUDED.app_version,
         platform    = EXCLUDED.platform,
         last_seen   = EXCLUDED.last_seen`,
      [String(device_id), spa_id || null, app_version || null, platform || null, now],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[device] heartbeat', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
