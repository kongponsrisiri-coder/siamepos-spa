const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/dbAdapter');
const { requireRole, requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/therapists                — active BOOKABLE therapists (role='therapist').
//   Used by booking pickers + rota, so non-therapist staff (reception/manager)
//   must NOT appear here.
// GET /api/therapists?include=staff   — the non-therapist till staff for the
//   admin Staff tab: reception, managers AND admins (active + inactive so you
//   can re-enable a returning member, and so the seeded default Admin stays
//   editable — that's the only place to change its PIN 1234).
// PIN hash is never returned in either case.
router.get('/', async (req, res) => {
  try {
    const staffOnly = req.query.include === 'staff';
    const { rows } = await pool.query(
      staffOnly
        ? "SELECT id, name, role, active FROM therapists WHERE role <> 'therapist' ORDER BY active DESC, name"
        : "SELECT id, name, role, specialisms, photo_url, active FROM therapists WHERE active = TRUE AND role = 'therapist' ORDER BY name",
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

// SPA-TURN-ORDER — set the column order for a given date. MUST BE
// DEFINED BEFORE the `/:id` route below, otherwise Express matches
// `PUT /turn-order` against `PUT /:id` with id='turn-order' and 500s.
//   body: { date: 'YYYY-MM-DD', order: [therapist_id, …] }
router.put('/turn-order', requireRole('admin', 'manager', 'reception'), async (req, res) => {
  const { date, order } = req.body || {};
  if (!date)                  return res.status(400).json({ error: 'date required' });
  if (!Array.isArray(order))  return res.status(400).json({ error: 'order array required' });
  // Run on a single pooled client so BEGIN/COMMIT/ROLLBACK are a real
  // transaction. Issuing them via pool.query() lets each statement land on a
  // different connection (no atomicity) and can release a connection with an
  // open transaction that poisons unrelated later requests.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM therapist_turn_order WHERE date = $1', [date]);
    for (let i = 0; i < order.length; i++) {
      const tid = Number(order[i]);
      if (!Number.isInteger(tid) || tid <= 0) continue;
      await client.query(
        `INSERT INTO therapist_turn_order (date, therapist_id, position, set_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (date, therapist_id) DO UPDATE SET position = EXCLUDED.position, set_by = EXCLUDED.set_by, set_at = now()`,
        [date, tid, i + 1, req.staff?.id || null],
      );
    }
    await client.query('COMMIT');
    req.app.get('io')?.emit('turn_order_updated', { date, order });
    res.json({ ok: true, date, order });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[therapists] turn-order PUT', err);
    res.status(500).json({ error: 'server error' });
  } finally {
    client.release();
  }
});

// DELETE /api/therapists/turn-order?date=YYYY-MM-DD — clear the order
router.delete('/turn-order', requireRole('admin', 'manager', 'reception'), async (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    await pool.query('DELETE FROM therapist_turn_order WHERE date = $1', [date]);
    req.app.get('io')?.emit('turn_order_updated', { date, order: [] });
    res.json({ ok: true, date });
  } catch (err) {
    console.error('[therapists] turn-order DELETE', err);
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
    // Pure-string month-end math so the result is independent of the
    // server's wall-clock TZ. `new Date(year, month, 0)` + toISOString()
    // would only work on a UTC server.
    const monthStart = `${month}-01`;
    const [yyyy, mm] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
    const monthEnd = `${month}-${String(lastDay).padStart(2, '0')}`;

    const [therapistsRes, rotaRes, overridesRes, turnOrderRes] = await Promise.all([
      pool.query("SELECT id, name, role, specialisms FROM therapists WHERE active = TRUE AND role = 'therapist' ORDER BY name"),
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
      // SPA-TURN-ORDER — per-day column order set by the receptionist.
      pool.query(
        `SELECT date::text AS date, therapist_id, position
         FROM therapist_turn_order
         WHERE date BETWEEN $1 AND $2
         ORDER BY date, position`,
        [monthStart, monthEnd],
      ),
    ]);

    res.json({
      therapists:  therapistsRes.rows,
      weekly_rota: rotaRes.rows,
      overrides:   overridesRes.rows,
      turn_order:  turnOrderRes.rows,
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
