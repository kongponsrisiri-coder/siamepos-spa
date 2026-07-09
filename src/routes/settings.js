const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db/dbAdapter');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

const DB_MODE       = (process.env.DB_MODE || 'cloud').toLowerCase();
const CLOUD_API_URL = process.env.CLOUD_API_URL || '';
const SYNC_SECRET   = process.env.SYNC_SECRET || '';

// Constant-time compare of the x-sync-secret header (mirrors routes/sync.js).
function secretOk(req) {
  const provided = req.get('x-sync-secret') || '';
  if (!SYNC_SECRET || !provided) return false;
  const a = Buffer.from(provided), b = Buffer.from(SYNC_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// SPA-BRAND-001 — settings can be written by an admin/manager (web / JWT) OR
// with the shared sync secret. The sync-secret path is what lets a desktop till
// (local DB) push its own settings change up to the cloud master — same trust
// model as the SYNC_SECRET-gated pull feed, and how the restaurant EPOS does it.
function settingsAuth(req, res, next) {
  if (secretOk(req)) return next();
  return requireRole('admin', 'manager')(req, res, next);
}

// SPA-BRAND-001 — the desktop till runs a LOCAL DB (DB_MODE=local) whose settings
// the cloud-wins pull would otherwise overwrite. So when a till saves a setting,
// propagate it to the cloud master immediately (best-effort, fire-and-forget) so
// it sticks everywhere. No-op on the cloud server itself (DB_MODE=cloud), which
// prevents any loop.
function pushSettingToCloud(key, value) {
  if (DB_MODE !== 'local' || !CLOUD_API_URL || !SYNC_SECRET) return;
  fetch(CLOUD_API_URL.replace(/\/+$/, '') + '/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-sync-secret': SYNC_SECRET },
    body: JSON.stringify({ key, value }),
  }).then((r) => { if (!r.ok) console.warn('[settings] cloud push', key, '→', r.status); })
    .catch((e) => console.warn('[settings] cloud push failed:', key, e.message));
}

// GET /api/settings — returns all settings as { key: value }
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM settings');
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    res.json({ settings });
  } catch (err) {
    console.error('[settings] get', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/settings  body: { key, value }
router.put('/', settingsAuth, async (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  const stored = value == null ? null : String(value);
  try {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, stored],
    );
    pushSettingToCloud(key, stored); // local till → cloud master (no-op on the cloud)
    res.json({ ok: true });
  } catch (err) {
    console.error('[settings] put', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
