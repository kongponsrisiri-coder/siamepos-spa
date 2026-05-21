const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/database');
const { requireRole, requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/therapists  — active staff (no PIN hash returned)
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, role, specialisms, photo_url, active FROM therapists WHERE active = TRUE ORDER BY name',
    );
    res.json({ therapists: rows });
  } catch (err) {
    console.error('[therapists] list', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/therapists  body: { name, pin, role, specialisms?, photo_url? }
router.post('/', requireRole('admin', 'manager'), async (req, res) => {
  const { name, pin, role, specialisms, photo_url } = req.body || {};
  if (!name || !pin) return res.status(400).json({ error: 'name + pin required' });
  try {
    const hash = bcrypt.hashSync(String(pin), 10);
    const { rows } = await pool.query(
      `INSERT INTO therapists (name, pin, role, specialisms, photo_url) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, role, specialisms, photo_url, active`,
      [name, hash, role || 'therapist', specialisms || null, photo_url || null],
    );
    res.status(201).json({ therapist: rows[0] });
  } catch (err) {
    console.error('[therapists] create', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/therapists/:id  body: { name?, pin?, role?, specialisms?, photo_url?, active? }
router.put('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const id = Number(req.params.id);
  const { name, pin, role, specialisms, photo_url, active } = req.body || {};
  const pinHash = pin ? bcrypt.hashSync(String(pin), 10) : null;
  try {
    const { rows } = await pool.query(
      `UPDATE therapists SET
         name        = COALESCE($2, name),
         pin         = COALESCE($3, pin),
         role        = COALESCE($4, role),
         specialisms = COALESCE($5, specialisms),
         photo_url   = COALESCE($6, photo_url),
         active      = COALESCE($7, active)
       WHERE id = $1
       RETURNING id, name, role, specialisms, photo_url, active`,
      [id, name, pinHash, role, specialisms, photo_url, active],
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
    req.app.get('io')?.emit('rota_updated', { therapist_id: id, kind: 'weekly' });
    res.json({ ok: true, count: slots.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[therapists] availability put', err);
    res.status(500).json({ error: 'server error' });
  } finally {
    client.release();
  }
});

// ── SPA-ROTA-001 — bulk rota overview ─────────────────────────────────────
// GET /api/therapists/rota?month=YYYY-MM
// Returns { therapists, weekly_rota, overrides } for the given month.
// Used by RotaSection (admin) + AppointmentScreen (any staff) to know who's working.
router.get('/rota', requireAuth, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM
    const monthStart = `${month}-01`;
    const d = new Date(monthStart);
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);

    const [therapistsRes, rotaRes, overridesRes] = await Promise.all([
      pool.query('SELECT id, name, role, specialisms FROM therapists WHERE active = TRUE ORDER BY name'),
      pool.query(
        `SELECT therapist_id, day_of_week, start_time, end_time
         FROM therapist_availability ORDER BY therapist_id, day_of_week`,
      ),
      pool.query(
        `SELECT id, therapist_id, date::text AS date, is_working, start_time, end_time, note
         FROM therapist_rota_overrides
         WHERE date BETWEEN $1 AND $2
         ORDER BY date, therapist_id`,
        [monthStart, monthEnd],
      ),
    ]);

    res.json({
      therapists:  therapistsRes.rows,
      weekly_rota: rotaRes.rows,
      overrides:   overridesRes.rows,
    });
  } catch (err) {
    console.error('[therapists] rota GET', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/therapists/:id/overrides?month=YYYY-MM
router.get('/:id/overrides', requireRole('admin', 'manager'), async (req, res) => {
  const id    = Number(req.params.id);
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const monthStart = `${month}-01`;
  const d = new Date(monthStart);
  const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
  try {
    const { rows } = await pool.query(
      `SELECT id, date::text AS date, is_working, start_time, end_time, note
       FROM therapist_rota_overrides
       WHERE therapist_id = $1 AND date BETWEEN $2 AND $3
       ORDER BY date`,
      [id, monthStart, monthEnd],
    );
    res.json({ overrides: rows });
  } catch (err) {
    console.error('[therapists] overrides GET', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/therapists/:id/overrides
// body: { date, is_working, start_time?, end_time?, note? }
router.put('/:id/overrides', requireRole('admin', 'manager'), async (req, res) => {
  const id = Number(req.params.id);
  const { date, is_working, start_time, end_time, note } = req.body || {};
  if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO therapist_rota_overrides
         (therapist_id, date, is_working, start_time, end_time, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (therapist_id, date) DO UPDATE SET
         is_working = EXCLUDED.is_working,
         start_time = EXCLUDED.start_time,
         end_time   = EXCLUDED.end_time,
         note       = EXCLUDED.note
       RETURNING id, date::text AS date, is_working, start_time, end_time, note`,
      [id, date, is_working ?? false, start_time || null, end_time || null, note || null],
    );
    req.app.get('io')?.emit('rota_updated', { therapist_id: id, date, kind: 'override' });
    res.json({ override: rows[0] });
  } catch (err) {
    console.error('[therapists] overrides PUT', err);
    res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/therapists/:id/overrides/:date  — restore weekly rota for that date
router.delete('/:id/overrides/:date', requireRole('admin', 'manager'), async (req, res) => {
  const id   = Number(req.params.id);
  const date = req.params.date;
  try {
    await pool.query(
      'DELETE FROM therapist_rota_overrides WHERE therapist_id = $1 AND date = $2',
      [id, date],
    );
    req.app.get('io')?.emit('rota_updated', { therapist_id: id, date, kind: 'override_deleted' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[therapists] overrides DELETE', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
