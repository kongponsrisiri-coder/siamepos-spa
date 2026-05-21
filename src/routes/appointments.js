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
              r.name AS room_name,
              b.payment_method, b.payment_status AS bill_status, b.total AS bill_total
       FROM appointments a
       LEFT JOIN treatments t  ON t.id  = a.treatment_id
       LEFT JOIN clients    c  ON c.id  = a.client_id
       LEFT JOIN therapists th ON th.id = a.therapist_id
       LEFT JOIN rooms      r  ON r.id  = a.room_id
       LEFT JOIN LATERAL (
         SELECT payment_method, payment_status, total FROM bills
         WHERE appointment_id = a.id ORDER BY id DESC LIMIT 1
       ) b ON TRUE
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
  const { client_id, treatment_id, therapist_id, room_id, starts_at, notes, source, therapist_requested } = req.body || {};
  if (!treatment_id || !starts_at) {
    return res.status(400).json({ error: 'treatment_id + starts_at required' });
  }
  try {
    const tr = await pool.query('SELECT duration_minutes FROM treatments WHERE id = $1', [treatment_id]);
    if (!tr.rows[0]) return res.status(400).json({ error: 'treatment not found' });
    const ends_at = new Date(new Date(starts_at).getTime() + tr.rows[0].duration_minutes * 60_000);

    // Conflict check: same therapist OR same room overlapping.
    const conflict = await pool.query(
      `SELECT a.id, a.starts_at, a.ends_at,
              c.name AS client_name, t.name AS treatment_name, th.name AS therapist_name
       FROM appointments a
       LEFT JOIN clients    c  ON c.id  = a.client_id
       LEFT JOIN treatments t  ON t.id  = a.treatment_id
       LEFT JOIN therapists th ON th.id = a.therapist_id
       WHERE a.status NOT IN ('cancelled','no_show')
         AND ( ($1::int IS NOT NULL AND a.therapist_id = $1)
            OR ($2::int IS NOT NULL AND a.room_id      = $2) )
         AND NOT (a.ends_at <= $3 OR a.starts_at >= $4)
       LIMIT 1`,
      [therapist_id || null, room_id || null, starts_at, ends_at],
    );
    if (conflict.rows[0]) {
      const conflicting = conflict.rows[0];
      const duration    = tr.rows[0].duration_minutes;

      // ── Alternative slots for same therapist (up to 5, same day then next day) ──
      const altSlots = [];
      const searchFrom = new Date(conflicting.ends_at); // start looking after the blocking appt
      for (let dayOffset = 0; dayOffset <= 1 && altSlots.length < 5; dayOffset++) {
        const dayEnd = new Date(searchFrom);
        dayEnd.setDate(dayEnd.getDate() + dayOffset);
        dayEnd.setHours(21, 0, 0, 0);

        // Fetch all bookings for this therapist on this search day
        const dayAppts = await pool.query(
          `SELECT starts_at, ends_at FROM appointments
           WHERE therapist_id = $1
             AND status NOT IN ('cancelled','no_show')
             AND starts_at::date = $2::date
           ORDER BY starts_at`,
          [therapist_id, searchFrom],
        );

        let cursor = dayOffset === 0
          ? searchFrom.getTime()
          : (() => { const d = new Date(searchFrom); d.setDate(d.getDate() + dayOffset); d.setHours(9, 0, 0, 0); return d.getTime(); })();

        while (cursor + duration * 60_000 <= dayEnd.getTime() && altSlots.length < 5) {
          const slotStart = new Date(cursor);
          const slotEnd   = new Date(cursor + duration * 60_000);
          const blocked   = dayAppts.rows.some(a => {
            const as = new Date(a.starts_at), ae = new Date(a.ends_at);
            return !(ae <= slotStart || as >= slotEnd);
          });
          if (!blocked) {
            altSlots.push({ starts_at: slotStart.toISOString() });
            cursor = slotEnd.getTime(); // jump past this slot
          } else {
            cursor += 15 * 60_000; // try next 15-min window
          }
        }
      }

      // ── Alternative therapists free at the requested time ──
      const altTherapists = await pool.query(
        `SELECT th.id, th.name
         FROM therapists th
         WHERE th.active = TRUE
           AND th.role = 'therapist'
           AND th.id != $1
           AND NOT EXISTS (
             SELECT 1 FROM appointments a
             WHERE a.therapist_id = th.id
               AND a.status NOT IN ('cancelled','no_show')
               AND NOT (a.ends_at <= $2 OR a.starts_at >= $3)
           )
         ORDER BY th.name`,
        [therapist_id || 0, starts_at, ends_at.toISOString()],
      );

      return res.status(409).json({
        error: 'conflict',
        conflicting,
        alternative_slots: altSlots,
        alternative_therapists: altTherapists.rows,
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO appointments
         (client_id, treatment_id, therapist_id, room_id, starts_at, ends_at, status, source, notes, therapist_requested)
       VALUES ($1,$2,$3,$4,$5,$6,'booked',$7,$8,$9) RETURNING *`,
      [client_id || null, treatment_id, therapist_id || null, room_id || null, starts_at, ends_at, source || 'walkin', notes || null, !!therapist_requested],
    );
    const appt = rows[0];
    req.app.get('io')?.emit('new_appointment', appt);
    res.status(201).json({ appointment: appt });
  } catch (err) {
    console.error('[appointments] create', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/appointments/:id  — reschedule / reassign / edit any field
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { therapist_id, room_id, starts_at, notes, treatment_id, client_id, status, therapist_requested } = req.body || {};
  try {
    // Recompute ends_at if starts_at or treatment changed.
    let newEnds = null;
    let effectiveStart = null;
    let effectiveDuration = null;
    if (starts_at || treatment_id) {
      const cur = await pool.query(
        `SELECT a.starts_at, a.treatment_id, t.duration_minutes
         FROM appointments a LEFT JOIN treatments t ON t.id = a.treatment_id
         WHERE a.id = $1`, [id]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
      effectiveStart = starts_at || cur.rows[0].starts_at;
      let dur = cur.rows[0].duration_minutes;
      if (treatment_id) {
        const t2 = await pool.query('SELECT duration_minutes FROM treatments WHERE id = $1', [treatment_id]);
        if (!t2.rows[0]) return res.status(400).json({ error: 'treatment not found' });
        dur = t2.rows[0].duration_minutes;
      }
      effectiveDuration = dur;
      newEnds = new Date(new Date(effectiveStart).getTime() + dur * 60_000);
    }

    // Conflict check on edit — only fires when the edit could land on a
    // busy slot (therapist or room reassigned, or time/treatment changed).
    // Symmetrical with POST so the modal's alternatives panel renders the
    // same way for create and edit. Exclude THIS appointment from the
    // search so editing its own notes / status doesn't trip the check.
    const needsConflictCheck =
      therapist_id !== undefined || room_id !== undefined ||
      starts_at    !== undefined || treatment_id !== undefined;

    if (needsConflictCheck) {
      // Fall back to the current row's values for fields not changed.
      const cur = await pool.query(
        `SELECT a.therapist_id, a.room_id, a.starts_at, a.ends_at, a.treatment_id, t.duration_minutes
         FROM appointments a LEFT JOIN treatments t ON t.id = a.treatment_id
         WHERE a.id = $1`, [id]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
      const checkTherapist = therapist_id !== undefined ? therapist_id : cur.rows[0].therapist_id;
      const checkRoom      = room_id      !== undefined ? room_id      : cur.rows[0].room_id;
      const checkStart     = effectiveStart || cur.rows[0].starts_at;
      const checkEnd       = newEnds || cur.rows[0].ends_at;

      const conflict = await pool.query(
        `SELECT a.id, a.starts_at, a.ends_at,
                c.name AS client_name, t.name AS treatment_name, th.name AS therapist_name
         FROM appointments a
         LEFT JOIN clients    c  ON c.id  = a.client_id
         LEFT JOIN treatments t  ON t.id  = a.treatment_id
         LEFT JOIN therapists th ON th.id = a.therapist_id
         WHERE a.id != $5
           AND a.status NOT IN ('cancelled','no_show')
           AND ( ($1::int IS NOT NULL AND a.therapist_id = $1)
              OR ($2::int IS NOT NULL AND a.room_id      = $2) )
           AND NOT (a.ends_at <= $3 OR a.starts_at >= $4)
         LIMIT 1`,
        [checkTherapist || null, checkRoom || null, checkStart, checkEnd, id],
      );

      if (conflict.rows[0]) {
        const conflicting = conflict.rows[0];
        const duration    = effectiveDuration || cur.rows[0].duration_minutes || 60;

        // Same alternative-slots / alternative-therapists logic as POST,
        // so the modal renders one consistent panel for create + edit.
        const altSlots = [];
        const searchFrom = new Date(conflicting.ends_at);
        for (let dayOffset = 0; dayOffset <= 1 && altSlots.length < 5; dayOffset++) {
          const dayEnd = new Date(searchFrom);
          dayEnd.setDate(dayEnd.getDate() + dayOffset);
          dayEnd.setHours(21, 0, 0, 0);
          const dayAppts = await pool.query(
            `SELECT starts_at, ends_at FROM appointments
             WHERE therapist_id = $1
               AND id != $3
               AND status NOT IN ('cancelled','no_show')
               AND starts_at::date = $2::date
             ORDER BY starts_at`,
            [checkTherapist, searchFrom, id],
          );
          let cursor = dayOffset === 0
            ? searchFrom.getTime()
            : (() => { const d = new Date(searchFrom); d.setDate(d.getDate() + dayOffset); d.setHours(9, 0, 0, 0); return d.getTime(); })();
          while (cursor + duration * 60_000 <= dayEnd.getTime() && altSlots.length < 5) {
            const slotStart = new Date(cursor);
            const slotEnd   = new Date(cursor + duration * 60_000);
            const blocked   = dayAppts.rows.some(a => {
              const as = new Date(a.starts_at), ae = new Date(a.ends_at);
              return !(ae <= slotStart || as >= slotEnd);
            });
            if (!blocked) {
              altSlots.push({ starts_at: slotStart.toISOString() });
              cursor = slotEnd.getTime();
            } else {
              cursor += 15 * 60_000;
            }
          }
        }

        const altTherapists = await pool.query(
          `SELECT th.id, th.name
           FROM therapists th
           WHERE th.active = TRUE
             AND th.role = 'therapist'
             AND th.id != $1
             AND NOT EXISTS (
               SELECT 1 FROM appointments a
               WHERE a.therapist_id = th.id
                 AND a.id != $4
                 AND a.status NOT IN ('cancelled','no_show')
                 AND NOT (a.ends_at <= $2 OR a.starts_at >= $3)
             )
           ORDER BY th.name`,
          [checkTherapist || 0, checkStart, checkEnd, id],
        );

        return res.status(409).json({
          error: 'conflict',
          conflicting,
          alternative_slots: altSlots,
          alternative_therapists: altTherapists.rows,
        });
      }
    }

    const allowed_statuses = ['booked', 'in_progress', 'completed', 'cancelled', 'no_show'];
    const safeStatus = allowed_statuses.includes(status) ? status : null;

    const { rows } = await pool.query(
      `UPDATE appointments SET
         therapist_id         = COALESCE($2, therapist_id),
         room_id              = COALESCE($3, room_id),
         starts_at            = COALESCE($4, starts_at),
         ends_at              = COALESCE($5, ends_at),
         treatment_id         = COALESCE($6, treatment_id),
         notes                = COALESCE($7, notes),
         client_id            = COALESCE($8, client_id),
         status               = COALESCE($9, status),
         therapist_requested  = COALESCE($10, therapist_requested)
       WHERE id = $1 RETURNING *`,
      [id, therapist_id ?? null, room_id ?? null, starts_at ?? null, newEnds, treatment_id ?? null, notes ?? null, client_id ?? null, safeStatus, therapist_requested ?? null],
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
