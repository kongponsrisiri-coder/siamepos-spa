const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/database');
const { signStaffToken } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login  body: { pin: '1234' }
// PINs are stored as bcrypt hashes — we compare against every active staff
// row. For a spa with <50 staff this is plenty fast.
router.post('/login', async (req, res) => {
  const { pin } = req.body || {};
  if (!pin || typeof pin !== 'string') {
    return res.status(400).json({ error: 'pin required' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, name, pin, role FROM therapists WHERE active = TRUE',
    );
    const match = rows.find((r) => bcrypt.compareSync(pin, r.pin));
    if (!match) return res.status(401).json({ error: 'invalid pin' });
    const staff = { id: match.id, name: match.name, role: match.role };
    return res.json({ staff, token: signStaffToken(staff) });
  } catch (err) {
    console.error('[auth/login] error', err);
    return res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
