// SEPOS-SPA-LICENSE-001 Part B — device heartbeat (ops visibility).
//
// Installed desktop tills sit behind NAT, so ops can't poll them. Each till
// POSTs here on launch + every 5 min; the cloud records it in `devices`, and
// /api/health surfaces the list so ops sees which devices are installed, their
// version, and last-seen. UNGATED to match restaurant-epos 1:1 — the body is
// non-sensitive (no medical/PII), device_id is the upsert key, and ops reads the
// data back through /api/health, never this endpoint.

const express = require('express');
const { pool } = require('../db/dbAdapter');

const router = express.Router();

// POST /api/device/heartbeat  body: { device_id, spa_id?, app_version?, platform? }
router.post('/heartbeat', async (req, res) => {
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
