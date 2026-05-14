const express = require('express');
const { pool } = require('../db/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM rooms WHERE active = TRUE ORDER BY name',
    );
    res.json({ rooms: rows });
  } catch (err) {
    console.error('[rooms] list', err);
    res.status(500).json({ error: 'server error' });
  }
});

router.post('/', requireRole('admin', 'manager'), async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO rooms (name) VALUES ($1) RETURNING *',
      [name],
    );
    res.status(201).json({ room: rows[0] });
  } catch (err) {
    console.error('[rooms] create', err);
    res.status(500).json({ error: 'server error' });
  }
});

router.put('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const id = Number(req.params.id);
  const { name, active } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE rooms SET
         name   = COALESCE($2, name),
         active = COALESCE($3, active)
       WHERE id = $1 RETURNING *`,
      [id, name, active],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ room: rows[0] });
  } catch (err) {
    console.error('[rooms] update', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
