const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db/dbAdapter');
const { requireAuth, requireRole } = require('../middleware/auth');
const offlineQueue = require('../services/offlineQueue');

const router = express.Router();

const SYNC_SECRET = process.env.SYNC_SECRET || '';

// Constant-time compare of the x-sync-secret header (identical to routes/sync.js).
function secretOk(req) {
  const provided = req.get('x-sync-secret') || '';
  if (!SYNC_SECRET || !provided) return false;
  const a = Buffer.from(provided), b = Buffer.from(SYNC_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// SPA-BRAND-001 — settings can be written by an admin/manager (web / JWT) OR
// with the shared sync secret. The sync-secret path is what lets a desktop till
// push its own settings change up to the cloud master — same trust model as the
// SYNC_SECRET-gated pull feed, and how the restaurant EPOS does it.
function settingsAuth(req, res, next) {
  if (secretOk(req)) return next();
  return requireRole('admin', 'manager')(req, res, next);
}

// GET /api/settings — returns all settings as { key: value }.
// Kept behind requireAuth (was the mount-level guard before it moved here so
// the PUT sync-secret path could bypass it). The pre-login login screen reads
// branding from the public /api/widget/branding endpoint, not this one.
router.get('/', requireAuth, async (_req, res) => {
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
    // SPA-SETTINGS-SYNC — on a desktop till (DB_MODE=local) queue a push to the
    // cloud master so the change syncs and isn't reverted by the cloud-wins
    // pull. syncService.drainSettings() pushes it and pullConfig guards the
    // pull against the pending key (mirrors the restaurant EPOS's
    // update_kv_settings). No-op in cloud mode.
    await offlineQueue.enqueue('update_setting', { key, value: stored });
    res.json({ ok: true });
  } catch (err) {
    console.error('[settings] put', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
