const express = require('express');
const { pool } = require('../db/database');
const { computeAvailability } = require('../services/availability');

const router = express.Router();

// GET /api/appointments?date=YYYY-MM-DD  OR  ?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/', async (req, res) => {
  try {
    const { date, from, to, therapist_id } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (date) {
      params.push(date);
      where += ` AND a.starts_at::date = $${params.length}::date`;
    } else if (from && to) {
      params.push(from); params.push(to);
      where += ` AND a.starts_at::date BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
    }
    if (therapist_id) {
      params.push(Number(therapist_id));
      where += ` AND a.therapist_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT a.*,
              t.name AS treatment_name, t.duration_minutes,
              c.name AS client_name, c.phone AS client_phone,
              th.name AS therapist_name,
              r.name AS room_name
       FROM appointments a
       LEFT JOIN treatments t  ON t.id  = a.treatment_id
       LEFT JOIN clients    c  ON c.id  = a.client_id
       LEFT JOIN therapists th ON th.id = a.therapist_id
       LEFT JOIN rooms      r  ON r.id  = a.room_id
       ${where}
       ORDER BY a.starts_at ASC`,
      params,
    );
    res.json({ appointments: rows });
  } catch (err) {
    console.error('[appointments] list', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/appointments/availability?treatment_id=&date=YYYY-MM-DD&therapist_id=(optional)
router.get('/availability', async (req, res) => {
  try {
    const { treatment_id, date, therapist_id } = req.query;
    if (!treatment_id || !date) {
      return res.status(400).json({ error: 'treatment_id + date required' });
    }
    const slots = await computeAvailability({
      treatment_id: Number(treatment_id),
      date,
      therapist_id: therapist_id ? Number(therapist_id) : null,
    });
    res.json({ slots });
  } catch (err) {
    console.error('[appointments] availability', err);
    res.status(500).json({ error: err.message || 'server error' });
  }
});

// POST /api/appointments
// body: { client_id, treatment_id, therapist_id?, room_id?, starts_at, notes?, source? }
router.post('/', async (req, res) => {
  const { client_id, treatment_id, therapist_id, room_id, starts_at, notes, source } = req.body || {};
  if (!treatment_id || !starts_at) {
    return res.status(400).json({ error: 'treatment_id + starts_at required' });
  }
  try {
    const tr = await pool.query('SELECT duration_minutes FROM treatments WHERE id = $1', [treatment_id]);
    if (!tr.rows[0]) return res.status(400).json({ error: 'treatment not found' });
    const ends_at = new Date(new Date(starts_at).getTime() + tr.rows[0].duration_minutes * 60_000);

    // Conflict check: same therapist OR same room overlapping.
    const conflict = await pool.query(
      `SELECT id FROM appointments
       WHERE status NOT IN ('cancelled','no_show')
         AND ( ($1::int IS NOT NULL AND therapist_id = $1)
            OR ($2::int IS NOT NULL AND room_id      = $2) )
         AND NOT (ends_at <= $3 OR starts_at >= $4)
       LIMIT 1`,
      [therapist_id || null, room_id || null, starts_at, ends_at],
    );
    if (conflict.rows[0]) return res.status(409).json({ error: 'time slot conflicts with another appointment' });

    const { rows } = await pool.query(
      `INSERT INTO appointments
         (client_id, treatment_id, therapist_id, room_id, starts_at, ends_at, status, source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,'booked',$7,$8) RETURNING *`,
      [client_id || null, treatment_id, therapist_id || null, room_id || null, starts_at, ends_at, source || 'walkin', notes || null],
    );
    const appt = rows[0];
    req.app.get('io')?.emit('new_appointment', appt);
    res.status(201).json({ appointment: appt });
  } catch (err) {
    console.error('[appointments] create', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/appointments/:id  — reschedule / reassign
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { therapist_id, room_id, starts_at, notes, treatment_id } = req.body || {};
  try {
    // Recompute ends_at if starts_at or treatment changed.
    let newEnds = null;
    if (starts_at || treatment_id) {
      const cur = await pool.query(
        `SELECT a.starts_at, a.treatment_id, t.duration_minutes
         FROM appointments a LEFT JOIN treatments t ON t.id = a.treatment_id
         WHERE a.id = $1`, [id]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
      const useStart = starts_at || cur.rows[0].starts_at;
      let dur = cur.rows[0].duration_minutes;
      if (treatment_id) {
        const t2 = await pool.query('SELECT duration_minutes FROM treatments WHERE id = $1', [treatment_id]);
        if (!t2.rows[0]) return res.status(400).json({ error: 'treatment not found' });
        dur = t2.rows[0].duration_minutes;
      }
      newEnds = new Date(new Date(useStart).getTime() + dur * 60_000);
    }

    const { rows } = await pool.query(
      `UPDATE appointments SET
         therapist_id = COALESCE($2, therapist_id),
         room_id      = COALESCE($3, room_id),
         starts_at    = COALESCE($4, starts_at),
         ends_at      = COALESCE($5, ends_at),
         treatment_id = COALESCE($6, treatment_id),
         notes        = COALESCE($7, notes)
       WHERE id = $1 RETURNING *`,
      [id, therapist_id, room_id, starts_at, newEnds, treatment_id, notes],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    req.app.get('io')?.emit('appointment_updated', rows[0]);
    res.json({ appointment: rows[0] });
  } catch (err) {
    console.error('[appointments] update', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/appointments/:id/status  body: { status: 'in_progress'|'completed'|'cancelled'|'no_show' }
router.put('/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  const allowed = ['booked', 'in_progress', 'completed', 'cancelled', 'no_show'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE appointments SET status = $2 WHERE id = $1 RETURNING *`,
      [id, status],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    req.app.get('io')?.emit('appointment_status', rows[0]);
    res.json({ appointment: rows[0] });
  } catch (err) {
    console.error('[appointments] status', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
