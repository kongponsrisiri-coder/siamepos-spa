const express = require('express');
const { pool } = require('../db/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

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
router.put('/', requireRole('admin', 'manager'), async (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value == null ? null : String(value)],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[settings] put', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
