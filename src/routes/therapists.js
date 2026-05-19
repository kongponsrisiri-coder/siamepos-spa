const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/therapists  — active staff (no PIN hash returned)
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, role, specialisms, active FROM therapists WHERE active = TRUE ORDER BY name',
    );
    res.json({ therapists: rows });
  } catch (err) {
    console.error('[therapists] list', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/therapists  body: { name, pin, role, specialisms? }
router.post('/', requireRole('admin', 'manager'), async (req, res) => {
  const { name, pin, role, specialisms } = req.body || {};
  if (!name || !pin) return res.status(400).json({ error: 'name + pin required' });
  try {
    const hash = bcrypt.hashSync(String(pin), 10);
    const { rows } = await pool.query(
      `INSERT INTO therapists (name, pin, role, specialisms) VALUES ($1, $2, $3, $4)
       RETURNING id, name, role, specialisms, active`,
      [name, hash, role || 'therapist', specialisms || null],
    );
    res.status(201).json({ therapist: rows[0] });
  } catch (err) {
    console.error('[therapists] create', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/therapists/:id  body: { name?, pin?, role?, specialisms?, active? }
router.put('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const id = Number(req.params.id);
  const { name, pin, role, specialisms, active } = req.body || {};
  const pinHash = pin ? bcrypt.hashSync(String(pin), 10) : null;
  try {
    const { rows } = await pool.query(
      `UPDATE therapists SET
         name        = COALESCE($2, name),
         pin         = COALESCE($3, pin),
         role        = COALESCE($4, role),
         specialisms = COALESCE($5, specialisms),
         active      = COALESCE($6, active)
       WHERE id = $1
       RETURNING id, name, role, specialisms, active`,
      [id, name, pinHash, role, specialisms, active],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ therapist: rows[0] });
  } catch (err) {
    console.error('[therapists] update', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/therapists/:id/availability
router.get('/:id/availability', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows } = await pool.query(
      `SELECT id, day_of_week, start_time, end_time
       FROM therapist_availability
       WHERE therapist_id = $1
       ORDER BY day_of_week, start_time`,
      [id],
    );
    res.json({ availability: rows });
  } catch (err) {
    console.error('[therapists] availability get', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/therapists/:id/availability
// body: { slots: [{ day_of_week, start_time, end_time }, ...] }  (replaces all)
router.put('/:id/availability', requireRole('admin', 'manager'), async (req, res) => {
  const id = Number(req.params.id);
  const slots = Array.isArray(req.body?.slots) ? req.body.slots : null;
  if (!slots) return res.status(400).json({ error: 'slots[] required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM therapist_availability WHERE therapist_id = $1', [id]);
    for (const s of slots) {
      await client.query(
        `INSERT INTO therapist_availability (therapist_id, day_of_week, start_time, end_time)
         VALUES ($1, $2, $3, $4)`,
        [id, s.day_of_week, s.start_time, s.end_time],
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: slots.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[therapists] availability put', err);
    res.status(500).json({ error: 'server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
