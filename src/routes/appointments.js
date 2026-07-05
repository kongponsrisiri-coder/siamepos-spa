const express = require('express');
const Stripe = require('stripe');
const { pool } = require('../db/dbAdapter');
const { computeAvailability, isTherapistWorking, buildAt, londonDateString } = require('../services/availability');
const { bookingToken, sendOwnerNewBookingEmail } = require('../services/emailService');
const { recomputeBillTotals, loadBillWithItems } = require('./bills');
const offlineQueue = require('../services/offlineQueue');

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: '2024-06-20' });
}

// Build the rich rota-conflict 409 body. Same alternatives shape as the
// time-conflict response so the modal can render one panel that
// branches on whether `conflicting` or `rota_conflict` is present.
async function buildRotaConflictResponse({ therapist_id, starts_at, ends_at, duration_minutes, working_window, exclude_id }) {
  const therapist = await pool.query(`SELECT name FROM therapists WHERE id = $1`, [therapist_id]);

  // Suggest alternative slots: same therapist later in their working window
  // today, then tomorrow if they're on shift.
  const altSlots = [];
  if (working_window) {
    const duration = duration_minutes || 60;
    let cursor = Math.max(new Date(starts_at).getTime(), working_window.start);
    // Pull the therapist's bookings within today to avoid suggesting busy slots.
    const date = String(starts_at).slice(0, 10);
    const dayAppts = await pool.query(
      `SELECT starts_at, ends_at FROM appointments
       WHERE therapist_id = $1
         AND starts_at::date = $2::date
         AND ($3::int IS NULL OR id != $3)
         AND status NOT IN ('cancelled','no_show')
       ORDER BY starts_at`,
      [therapist_id, date, exclude_id || null],
    );
    while (cursor + duration * 60_000 <= working_window.end && altSlots.length < 5) {
      const slotStart = new Date(cursor);
      const slotEnd   = new Date(cursor + duration * 60_000);
      const blocked   = dayAppts.rows.some((a) => {
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

  // Suggest alternative therapists free at the originally requested time —
  // only those whose rota covers the slot AND who aren't already booked.
  const candidatesRes = await pool.query(
    `SELECT th.id, th.name
     FROM therapists th
     WHERE th.active = TRUE
       AND th.role = 'therapist'
       AND th.id != $1
       AND NOT EXISTS (
         SELECT 1 FROM appointments a
         WHERE a.therapist_id = th.id
           AND ($4::int IS NULL OR a.id != $4)
           AND a.status NOT IN ('cancelled','no_show')
           AND NOT (a.ends_at <= $2 OR a.starts_at >= $3)
       )
     ORDER BY th.name`,
    [therapist_id || 0, starts_at, ends_at, exclude_id || null],
  );
  const altTherapists = [];
  for (const cand of candidatesRes.rows) {
    const check = await isTherapistWorking(cand.id, starts_at, ends_at);
    if (check.working) altTherapists.push(cand);
  }

  return {
    error: 'rota_conflict',
    rota_conflict: {
      therapist_id,
      therapist_name: therapist.rows[0]?.name || null,
      working_window: working_window
        ? { start: new Date(working_window.start).toISOString(),
            end:   new Date(working_window.end).toISOString() }
        : null, // null = off entirely on this day
    },
    alternative_slots: altSlots,
    alternative_therapists: altTherapists,
  };
}

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
              b.payment_method, b.payment_status AS bill_status, b.total AS bill_total,
              b.external_voucher_code
       FROM appointments a
       LEFT JOIN treatments t  ON t.id  = a.treatment_id
       LEFT JOIN clients    c  ON c.id  = a.client_id
       LEFT JOIN therapists th ON th.id = a.therapist_id
       LEFT JOIN rooms      r  ON r.id  = a.room_id
       LEFT JOIN bills b ON b.id = (
         SELECT id FROM bills WHERE appointment_id = a.id ORDER BY id DESC LIMIT 1
       )
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
  const { client_id, treatment_id, therapist_id, room_id, starts_at, notes, source, therapist_requested, treatwell_payment_type } = req.body || {};
  if (!treatment_id || !starts_at) {
    return res.status(400).json({ error: 'treatment_id + starts_at required' });
  }
  // Block past-date bookings unless explicitly allowed (admin "retro"
  // entries for historical records — gated by ?allow_past=1).
  const startsTs = new Date(starts_at).getTime();
  if (!isFinite(startsTs)) return res.status(400).json({ error: 'invalid starts_at' });
  const allowPast = req.query.allow_past === '1' || req.query.allow_past === 'true';
  if (startsTs < Date.now() && !allowPast) {
    return res.status(400).json({ error: 'cannot book in the past — pass ?allow_past=1 to record a historical booking' });
  }
  try {
    const tr = await pool.query('SELECT duration_minutes FROM treatments WHERE id = $1', [treatment_id]);
    if (!tr.rows[0]) return res.status(400).json({ error: 'treatment not found' });
    const ends_at = new Date(new Date(starts_at).getTime() + tr.rows[0].duration_minutes * 60_000);

    // Rota check — if a specific therapist is requested, they must be on
    // shift for the full duration. The timeline already blocks off-shift
    // clicks; this enforces the same rule on the booking form, which
    // otherwise lets the receptionist type any time + pick any therapist.
    if (therapist_id) {
      const rotaCheck = await isTherapistWorking(therapist_id, starts_at, ends_at.toISOString());
      if (!rotaCheck.working) {
        return res.status(409).json(await buildRotaConflictResponse({
          therapist_id, starts_at, ends_at: ends_at.toISOString(),
          duration_minutes: tr.rows[0].duration_minutes,
          working_window: rotaCheck.window,
          exclude_id: null,
        }));
      }
    }

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
      // Window bounds anchored to Europe/London (the spa's TZ) — Railway
      // runs UTC so server-local setHours() would slip by 1hr in BST.
      const altSlots = [];
      const searchFrom = new Date(conflicting.ends_at); // start looking after the blocking appt
      for (let dayOffset = 0; dayOffset <= 1 && altSlots.length < 5; dayOffset++) {
        const searchDateStr = londonDateString(new Date(searchFrom.getTime() + dayOffset * 86400000));
        const dayEnd = buildAt(searchDateStr, '21:00');

        // Fetch all bookings for this therapist on this search day
        const dayAppts = await pool.query(
          `SELECT starts_at, ends_at FROM appointments
           WHERE therapist_id = $1
             AND status NOT IN ('cancelled','no_show')
             AND starts_at::date = $2::date
           ORDER BY starts_at`,
          [therapist_id, searchDateStr],
        );

        let cursor = dayOffset === 0
          ? searchFrom.getTime()
          : buildAt(searchDateStr, '09:00').getTime();

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
      // First narrow by SQL: active, role='therapist', no booking conflict
      // at the requested slot. Then post-filter through isTherapistWorking
      // so we never suggest someone whose rota / override has them off.
      const candidatesRes = await pool.query(
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
      const altTherapists = [];
      for (const cand of candidatesRes.rows) {
        const check = await isTherapistWorking(cand.id, starts_at, ends_at.toISOString());
        if (check.working) altTherapists.push(cand);
      }

      return res.status(409).json({
        error: 'conflict',
        conflicting,
        alternative_slots: altSlots,
        alternative_therapists: altTherapists,
      });
    }

    // Snapshot the treatment price at booking time so subsequent price
    // edits don't retroactively change the bill.
    const priceRow = await pool.query('SELECT price FROM treatments WHERE id = $1', [treatment_id]);
    const priceAtBooking = Number(priceRow.rows[0]?.price || 0);

    // SPA-SOURCE-DROPDOWN — accept the receptionist's chosen source.
    // Treatwell payment type only stored when source='treatwell'.
    const validSource = ['phone', 'walkin', 'staff', 'online', 'treatwell'].includes(source)
      ? source : 'walkin';
    const validTwType = validSource === 'treatwell' && ['full', 'partial'].includes(treatwell_payment_type)
      ? treatwell_payment_type : null;

    // SEPOS-SPA-BUGHUNT #1 (v2) — race-safe insert. The WHERE NOT EXISTS re-check
    // is NOT enough under PostgreSQL READ COMMITTED: concurrent inserts each
    // evaluate it against their pre-commit snapshot, so several can win the same
    // slot (a 25-way stress test created 10). On PG we serialise per therapist +
    // room with transaction-scoped advisory locks, then re-check inside the lock so
    // only the first booking inserts. SQLite is single-writer, so the plain
    // statement is already atomic there. Swap (/swap) is a separate handler.
    const insertSql = `INSERT INTO appointments
         (client_id, treatment_id, therapist_id, room_id, starts_at, ends_at,
          status, source, notes, therapist_requested, price_at_booking, treatwell_payment_type)
       SELECT $1,$2,$3,$4,$5,$6,'booked',$7,$8,$9,$10,$11
       WHERE NOT EXISTS (
         SELECT 1 FROM appointments a
         WHERE a.status NOT IN ('cancelled','no_show')
           AND ( ($3::int IS NOT NULL AND a.therapist_id = $3)
              OR ($4::int IS NOT NULL AND a.room_id      = $4) )
           AND NOT (a.ends_at <= $5 OR a.starts_at >= $6)
       )
       RETURNING *`;
    const insertParams = [
      client_id || null, treatment_id, therapist_id || null, room_id || null,
      starts_at, ends_at, validSource, notes || null, !!therapist_requested,
      priceAtBooking, validTwType,
    ];
    let appt;
    if ((process.env.DB_MODE || '').toLowerCase() === 'local') {
      appt = (await pool.query(insertSql, insertParams)).rows[0];
    } else {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (therapist_id) await client.query('SELECT pg_advisory_xact_lock(1, $1)', [Number(therapist_id)]);
        if (room_id)      await client.query('SELECT pg_advisory_xact_lock(2, $1)', [Number(room_id)]);
        appt = (await client.query(insertSql, insertParams)).rows[0];
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        throw e;
      } finally {
        client.release();
      }
    }
    if (!appt) {
      return res.status(409).json({
        error: 'conflict',
        message: 'That slot was just booked by someone else — please pick another time or therapist.',
      });
    }
    await offlineQueue.enqueue('create_appointment', { localId: appt.id });
    req.app.get('io')?.emit('new_appointment', appt);

    // SPA-OWNER-NOTIFY — alert the spa owner of admin-created bookings
    // too (phone / walk-in / staff). Fetch the therapist + client
    // names alongside so the email reads well.
    (async () => {
      try {
        const named = await pool.query(
          `SELECT th.name AS therapist_name,
                  c.name  AS client_name, c.email AS client_email, c.phone AS client_phone,
                  t.name  AS treatment_name, t.duration_minutes, t.price
           FROM appointments a
           LEFT JOIN therapists th ON th.id = a.therapist_id
           LEFT JOIN clients    c  ON c.id  = a.client_id
           LEFT JOIN treatments t  ON t.id  = a.treatment_id
           WHERE a.id = $1`,
          [appt.id],
        );
        const n = named.rows[0] || {};
        await sendOwnerNewBookingEmail({
          appointment:   appt,
          client:        { name: n.client_name, email: n.client_email, phone: n.client_phone },
          treatment:     { name: n.treatment_name, duration_minutes: n.duration_minutes, price: n.price },
          therapistName: n.therapist_name,
          source:        validSource,
        });
      } catch (e) { console.error('[appointments] owner notify failed', e); }
    })();

    res.status(201).json({ appointment: appt });
  } catch (err) {
    console.error('[appointments] create', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/appointments/:id  — reschedule / reassign / edit any field
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { therapist_id, room_id, starts_at, notes, treatment_id, client_id, status, therapist_requested, treatwell_payment_type, source } = req.body || {};
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

    // SEPOS-SPA-BUGHUNT #1 — hoisted so the final UPDATE can re-use them for a
    // race-safe move guard (see below), not just the friendly upfront check.
    let checkTherapist = null, checkRoom = null, checkStart = null, checkEnd = null;
    if (needsConflictCheck) {
      // Fall back to the current row's values for fields not changed.
      const cur = await pool.query(
        `SELECT a.therapist_id, a.room_id, a.starts_at, a.ends_at, a.treatment_id, t.duration_minutes
         FROM appointments a LEFT JOIN treatments t ON t.id = a.treatment_id
         WHERE a.id = $1`, [id]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
      checkTherapist = therapist_id !== undefined ? therapist_id : cur.rows[0].therapist_id;
      checkRoom      = room_id      !== undefined ? room_id      : cur.rows[0].room_id;
      checkStart     = effectiveStart || cur.rows[0].starts_at;
      checkEnd       = newEnds || cur.rows[0].ends_at;

      // Rota check on edit too. Skip if no therapist is assigned (Treatwell
      // imports that haven't been allocated yet, or "Any available" edits).
      if (checkTherapist) {
        const startIso = checkStart instanceof Date ? checkStart.toISOString() : String(checkStart);
        const endIso   = checkEnd   instanceof Date ? checkEnd.toISOString()   : String(checkEnd);
        const rotaCheck = await isTherapistWorking(checkTherapist, startIso, endIso);
        if (!rotaCheck.working) {
          return res.status(409).json(await buildRotaConflictResponse({
            therapist_id: checkTherapist,
            starts_at: startIso,
            ends_at: endIso,
            duration_minutes: effectiveDuration || cur.rows[0].duration_minutes,
            working_window: rotaCheck.window,
            exclude_id: id,
          }));
        }
      }

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
          const searchDateStr = londonDateString(new Date(searchFrom.getTime() + dayOffset * 86400000));
          const dayEnd = buildAt(searchDateStr, '21:00');
          const dayAppts = await pool.query(
            `SELECT starts_at, ends_at FROM appointments
             WHERE therapist_id = $1
               AND id != $3
               AND status NOT IN ('cancelled','no_show')
               AND starts_at::date = $2::date
             ORDER BY starts_at`,
            [checkTherapist, searchDateStr, id],
          );
          let cursor = dayOffset === 0
            ? searchFrom.getTime()
            : buildAt(searchDateStr, '09:00').getTime();
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

        const candidatesRes = await pool.query(
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
        // Same rota filter as POST: drop anyone whose rota/override has
        // them off at the requested slot.
        const startIsoForRota = checkStart instanceof Date ? checkStart.toISOString() : String(checkStart);
        const endIsoForRota   = checkEnd   instanceof Date ? checkEnd.toISOString()   : String(checkEnd);
        const altTherapists = [];
        for (const cand of candidatesRes.rows) {
          const check = await isTherapistWorking(cand.id, startIsoForRota, endIsoForRota);
          if (check.working) altTherapists.push(cand);
        }

        return res.status(409).json({
          error: 'conflict',
          conflicting,
          alternative_slots: altSlots,
          alternative_therapists: altTherapists,
        });
      }
    }

    const allowed_statuses = ['booked', 'in_progress', 'completed', 'cancelled', 'no_show'];
    const safeStatus = allowed_statuses.includes(status) ? status : null;

    // If the treatment is being swapped, re-snapshot the price from the
    // new treatment. Pure status/notes edits leave price_at_booking alone.
    let newPriceAtBooking = null;
    if (treatment_id) {
      const pr = await pool.query('SELECT price FROM treatments WHERE id = $1', [treatment_id]);
      newPriceAtBooking = Number(pr.rows[0]?.price || 0);
    }

    // SPA-SOURCE-DROPDOWN — source + treatwell_payment_type are special:
    // they can be deliberately changed FROM one value TO another (or
    // cleared), so we don't use COALESCE for them. We compute the new
    // values from the current row + the request body, then write them
    // explicitly. Reading the current row also lets us auto-clear
    // tw_type when source changes away from 'treatwell'.
    const curRes = await pool.query(
      'SELECT source, treatwell_payment_type FROM appointments WHERE id = $1',
      [id],
    );
    if (!curRes.rows[0]) return res.status(404).json({ error: 'not found' });
    const curr = curRes.rows[0];
    const validSources = ['phone', 'walkin', 'staff', 'online', 'treatwell'];
    const newSource = (source !== undefined && validSources.includes(source))
      ? source
      : curr.source;
    let newTwType;
    if (newSource !== 'treatwell') {
      // Source changed away from Treatwell → clear the payment type.
      newTwType = null;
    } else if (treatwell_payment_type !== undefined) {
      newTwType = ['full', 'partial'].includes(treatwell_payment_type) ? treatwell_payment_type : null;
    } else {
      newTwType = curr.treatwell_payment_type;
    }

    // SEPOS-SPA-BUGHUNT #1 — race-safe move. When this edit actually moves the
    // booking (therapist/room/time changed), guard the UPDATE with an atomic
    // overlap re-check EXCLUDING this appointment, so two concurrent moves can't
    // both land on the same empty slot. Excluding self means moving within/around
    // its own slot is fine; landing on an OCCUPIED slot is blocked (use swap).
    // Pure status/notes edits skip the guard entirely.
    const moveGuard = needsConflictCheck ? `
       AND NOT EXISTS (
         SELECT 1 FROM appointments a
         WHERE a.id != $1 AND a.status NOT IN ('cancelled','no_show')
           AND ( ($14::int IS NOT NULL AND a.therapist_id = $14)
              OR ($15::int IS NOT NULL AND a.room_id      = $15) )
           AND NOT (a.ends_at <= $16 OR a.starts_at >= $17)
       )` : '';
    const moveParams = needsConflictCheck ? [checkTherapist ?? null, checkRoom ?? null, checkStart, checkEnd] : [];
    const moveSql = `UPDATE appointments SET
         therapist_id         = COALESCE($2, therapist_id),
         room_id              = COALESCE($3, room_id),
         starts_at            = COALESCE($4, starts_at),
         ends_at              = COALESCE($5, ends_at),
         treatment_id         = COALESCE($6, treatment_id),
         notes                = COALESCE($7, notes),
         client_id            = COALESCE($8, client_id),
         status               = COALESCE($9, status),
         therapist_requested  = COALESCE($10, therapist_requested),
         price_at_booking     = COALESCE($11, price_at_booking),
         source               = $12,
         treatwell_payment_type = $13
       WHERE id = $1${moveGuard} RETURNING *`;
    const moveAllParams = [id, therapist_id ?? null, room_id ?? null, starts_at ?? null, newEnds, treatment_id ?? null, notes ?? null, client_id ?? null, safeStatus, therapist_requested ?? null, newPriceAtBooking, newSource, newTwType, ...moveParams];
    // SEPOS-SPA-BUGHUNT #1 (v2) — a move into an empty slot has the same concurrency
    // race as create. When it's an actual move, serialise per therapist + room on PG
    // with advisory locks (SQLite is single-writer). Status/notes-only edits skip it.
    let rows;
    if (needsConflictCheck && (process.env.DB_MODE || '').toLowerCase() !== 'local') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (checkTherapist) await client.query('SELECT pg_advisory_xact_lock(1, $1)', [Number(checkTherapist)]);
        if (checkRoom)      await client.query('SELECT pg_advisory_xact_lock(2, $1)', [Number(checkRoom)]);
        ({ rows } = await client.query(moveSql, moveAllParams));
        await client.query('COMMIT');
      } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; } finally { client.release(); }
    } else {
      ({ rows } = await pool.query(moveSql, moveAllParams));
    }
    if (!rows[0]) {
      // The row exists (validated above) — so 0 rows on a move means the slot was
      // just taken in the race; otherwise it's genuinely gone.
      if (needsConflictCheck) {
        return res.status(409).json({ error: 'conflict', message: 'That slot was just taken — please pick another time or therapist.' });
      }
      return res.status(404).json({ error: 'not found' });
    }

    // SPA-BILL-SYNC — if the treatment was swapped AND there's already
    // an open (unpaid) bill for this appointment, update the bill's
    // subtotal too. Otherwise the receptionist sees the new treatment
    // on the booking but the till still charges the old price. Paid
    // bills are locked — they're already a closed transaction.
    if (newPriceAtBooking !== null) {
      // Keep the bill's treatment line item in sync with the swapped
      // treatment, then recompute totals from the line items (which now
      // include any retail / add-on lines the operator already added).
      const affected = await pool.query(
        `SELECT id FROM bills WHERE appointment_id = $1 AND payment_status NOT IN ('paid', 'refunded')`,
        [id],
      );
      for (const r of affected.rows) {
        await loadBillWithItems(r.id); // self-heals a missing treatment line
        await pool.query(
          `UPDATE bill_items bi
              SET unit_price = $2::numeric,
                  line_total = $2::numeric * bi.quantity,
                  name = COALESCE((SELECT name FROM treatments WHERE id = $3), bi.name)
            WHERE bi.bill_id = $1 AND bi.kind = 'treatment'`,
          [r.id, newPriceAtBooking, treatment_id],
        );
        await recomputeBillTotals(pool, r.id);
      }
    }

    req.app.get('io')?.emit('appointment_updated', rows[0]);
    res.json({ appointment: rows[0] });
  } catch (err) {
    console.error('[appointments] update', err);
    res.status(500).json({ error: 'server error' });
  }
});

// SPA-PAY-002 — Generate a Stripe payment-link for an appointment.
// Used when the receptionist takes a phone/WhatsApp booking and the
// customer wants to pay the deposit without going through the website
// widget. Returns the public manage-link URL; the customer-portal page
// auto-detects payment_status='deposit_pending' and shows a Pay Now UI.
//
// POST /api/appointments/:id/payment-link
// SPA-SWAP — swap the therapist (and room) between two appointments
// atomically. Saves the receptionist the dance of moving one to a
// temp slot first to clear the conflict guard.
//   body: { id_a, id_b }
// Both bookings keep their original starts_at and treatment; only
// therapist + room exchange. Validation: neither booking may be
// cancelled / completed / no_show; each new pairing must pass rota
// (therapist on shift at the OTHER booking's time) AND have no other
// conflicting booking once the swap takes effect.
router.post('/swap', async (req, res) => {
  const { id_a, id_b } = req.body || {};
  if (!id_a || !id_b) return res.status(400).json({ error: 'id_a + id_b required' });
  if (Number(id_a) === Number(id_b)) return res.status(400).json({ error: 'cannot swap an appointment with itself' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const both = await client.query(
      `SELECT id, therapist_id, room_id, starts_at, ends_at, status
       FROM appointments WHERE id = ANY($1::int[])
       FOR UPDATE`,
      [[Number(id_a), Number(id_b)]],
    );
    if (both.rows.length !== 2) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'one or both appointments not found' }); }
    const a = both.rows.find(r => r.id === Number(id_a));
    const b = both.rows.find(r => r.id === Number(id_b));
    for (const x of [a, b]) {
      if (['cancelled', 'no_show', 'completed'].includes(x.status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `cannot swap — appointment #${x.id} is ${x.status}` });
      }
    }
    // After swap: A gets B's therapist+room, B gets A's.
    const newA = { therapist_id: b.therapist_id, room_id: b.room_id };
    const newB = { therapist_id: a.therapist_id, room_id: a.room_id };

    // Rota check: each new therapist must be working at the OTHER's
    // time. PG returns starts_at/ends_at as JS Date objects; convert
    // to ISO strings so isTherapistWorking parses them correctly.
    for (const [appt, newPair] of [[a, newA], [b, newB]]) {
      if (newPair.therapist_id) {
        const startsIso = appt.starts_at instanceof Date ? appt.starts_at.toISOString() : String(appt.starts_at);
        const endsIso   = appt.ends_at   instanceof Date ? appt.ends_at.toISOString()   : String(appt.ends_at);
        const rc = await isTherapistWorking(newPair.therapist_id, startsIso, endsIso);
        if (!rc.working) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `Therapist not on shift at appointment #${appt.id}'s time`,
            rota_conflict: { therapist_id: newPair.therapist_id, working_window: rc.window },
          });
        }
      }
    }
    // Conflict check: any OTHER booking on the new therapist that overlaps
    // the OLD appointment's time? Exclude both swap participants.
    for (const [appt, newPair] of [[a, newA], [b, newB]]) {
      if (!newPair.therapist_id) continue;
      const clash = await client.query(
        `SELECT id FROM appointments
         WHERE therapist_id = $1
           AND id NOT IN ($2, $3)
           AND status NOT IN ('cancelled','no_show')
           AND NOT (ends_at <= $4 OR starts_at >= $5)
         LIMIT 1`,
        [newPair.therapist_id, a.id, b.id, appt.starts_at, appt.ends_at],
      );
      if (clash.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Therapist already has another booking at appointment #${appt.id}'s time (clash with #${clash.rows[0].id})` });
      }
    }
    // All clear — swap.
    await client.query(
      `UPDATE appointments SET therapist_id = $2, room_id = $3 WHERE id = $1`,
      [a.id, newA.therapist_id, newA.room_id],
    );
    await client.query(
      `UPDATE appointments SET therapist_id = $2, room_id = $3 WHERE id = $1`,
      [b.id, newB.therapist_id, newB.room_id],
    );
    await client.query('COMMIT');

    // Broadcast both updates so all tablets re-render.
    const refreshed = await pool.query(
      `SELECT * FROM appointments WHERE id = ANY($1::int[])`,
      [[a.id, b.id]],
    );
    const io = req.app.get('io');
    refreshed.rows.forEach(r => io?.emit('appointment_updated', r));

    res.json({ ok: true, appointments: refreshed.rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[appointments] swap', err);
    res.status(500).json({ error: 'server error' });
  } finally {
    client.release();
  }
});

router.post('/:id/payment-link', async (req, res) => {
  const id = Number(req.params.id);
  const s = stripeClient();
  if (!s) return res.status(503).json({ error: 'stripe not configured' });
  try {
    const apptRow = await pool.query(
      `SELECT a.id, a.deposit_amount, a.deposit_stripe_id, a.payment_status, a.client_id,
              t.price AS treatment_price, t.name AS treatment_name,
              c.email AS client_email, c.name AS client_name
       FROM appointments a
       LEFT JOIN treatments t ON t.id = a.treatment_id
       LEFT JOIN clients    c ON c.id = a.client_id
       WHERE a.id = $1`,
      [id],
    );
    const a = apptRow.rows[0];
    if (!a) return res.status(404).json({ error: 'appointment not found' });
    if (a.payment_status === 'deposit_paid' || a.payment_status === 'fully_paid') {
      return res.status(400).json({ error: `deposit already paid (payment_status=${a.payment_status})` });
    }

    // Resolve the deposit amount the same way the widget does. The
    // policy may have changed since the appointment was created.
    const policyRow = await pool.query(
      `SELECT key, value FROM settings WHERE key IN
         ('deposit_model','deposit_amount','deposit_percentage')`,
    );
    const policy = Object.fromEntries(policyRow.rows.map((r) => [r.key, r.value]));
    const model      = policy.deposit_model      || 'fixed_amount';
    const fixed      = Number(policy.deposit_amount || 25);
    const percentage = Number(policy.deposit_percentage || 25);
    const price      = Number(a.treatment_price || 0);
    let depositAmount = 0;
    if (model === 'full_prepay')      depositAmount = +price.toFixed(2);
    else if (model === 'percentage')  depositAmount = +((price * percentage) / 100).toFixed(2);
    else if (model === 'fixed_amount') depositAmount = +Math.min(fixed, price).toFixed(2);
    if (depositAmount <= 0) return res.status(400).json({ error: 'deposit policy is "none" — no link needed' });

    // Create a fresh PaymentIntent. Each call invalidates the previous
    // link — Stripe auto-expires unconfirmed intents.
    const intent = await s.paymentIntents.create({
      amount: Math.round(depositAmount * 100),
      currency: 'gbp',
      automatic_payment_methods: { enabled: true },
      receipt_email: a.client_email || undefined,
      metadata: {
        purpose: 'spa_deposit_link',
        appointment_id: String(a.id),
        treatment_name: String(a.treatment_name || ''),
      },
    });

    await pool.query(
      `UPDATE appointments
         SET deposit_amount = $2, deposit_stripe_id = $3, payment_status = 'deposit_pending'
       WHERE id = $1`,
      [id, depositAmount, intent.id],
    );

    const apiBase = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`;
    const url = `${apiBase}/my-booking.html?token=${encodeURIComponent(bookingToken(id))}`;

    res.json({
      url,
      deposit_amount: depositAmount,
      payment_status: 'deposit_pending',
      client_secret: intent.client_secret,
      intent_id: intent.id,
    });
  } catch (err) {
    console.error('[appointments] payment-link', err);
    res.status(500).json({ error: err.message || 'server error' });
  }
});

// POST /api/appointments/:id/deposit-manual
// Record a deposit taken by cash or card AT THE TILL (phone bookings
// where the customer reads their card to staff, walk-in deposits, etc.).
// body: { amount, method: 'cash'|'card' }
//
// Rejects if a Stripe deposit (deposit_stripe_id) already exists on the
// booking — those are managed via the Stripe webhook, not by staff.
// If a previous manual deposit is on the booking, this OVERWRITES it
// (operator amending). Use DELETE /:id/deposit-manual to clear.
router.post('/:id/deposit-manual', async (req, res) => {
  const id = Number(req.params.id);
  const { amount, method } = req.body || {};
  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (!['cash', 'card'].includes(method)) {
    return res.status(400).json({ error: 'method must be cash or card' });
  }
  try {
    const cur = await pool.query(
      `SELECT id, deposit_stripe_id, payment_status, status FROM appointments WHERE id = $1`,
      [id],
    );
    if (!cur.rows[0]) return res.status(404).json({ error: 'appointment not found' });
    const a = cur.rows[0];
    if (a.deposit_stripe_id) {
      return res.status(409).json({ error: 'online (Stripe) deposit already on this booking — manage via Stripe' });
    }
    if (a.payment_status === 'fully_paid') {
      return res.status(409).json({ error: 'bill is already closed — deposit cannot be amended' });
    }
    const { rows } = await pool.query(
      `UPDATE appointments
         SET deposit_amount   = $2,
             deposit_method   = $3,
             deposit_taken_at = now(),
             deposit_taken_by = $4,
             payment_status   = 'deposit_paid'
       WHERE id = $1 RETURNING *`,
      [id, +amt.toFixed(2), method, req.staff?.id || null],
    );
    req.app.get('io')?.emit('appointment_updated', rows[0]);
    res.json({ appointment: rows[0] });
  } catch (err) {
    console.error('[appointments] deposit-manual', err);
    res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/appointments/:id/deposit-manual — clear a manual deposit
// (operator mistake / refund-at-till). Refuses to touch online deposits.
router.delete('/:id/deposit-manual', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const cur = await pool.query(
      `SELECT deposit_stripe_id, payment_status FROM appointments WHERE id = $1`,
      [id],
    );
    if (!cur.rows[0]) return res.status(404).json({ error: 'appointment not found' });
    if (cur.rows[0].deposit_stripe_id) {
      return res.status(409).json({ error: 'cannot clear an online deposit from here' });
    }
    if (cur.rows[0].payment_status === 'fully_paid') {
      return res.status(409).json({ error: 'bill is already closed' });
    }
    const { rows } = await pool.query(
      `UPDATE appointments
         SET deposit_amount   = NULL,
             deposit_method   = NULL,
             deposit_taken_at = NULL,
             deposit_taken_by = NULL,
             payment_status   = 'none'
       WHERE id = $1 RETURNING *`,
      [id],
    );
    req.app.get('io')?.emit('appointment_updated', rows[0]);
    res.json({ appointment: rows[0] });
  } catch (err) {
    console.error('[appointments] deposit-manual delete', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/appointments/deposit-summary?date=YYYY-MM-DD
// SPA-DEPOSIT-DAILY — totals for the daily summary card on the
// Appointments screen. Counts deposits regardless of channel.
router.get('/deposit-summary', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int                                                          AS total_bookings,
         COUNT(*) FILTER (WHERE COALESCE(deposit_amount, 0) > 0)::int           AS with_deposit_count,
         COALESCE(SUM(deposit_amount) FILTER (WHERE deposit_amount > 0), 0)::numeric(10,2) AS total_deposit_collected,
         COALESCE(SUM(deposit_amount) FILTER (WHERE deposit_stripe_id IS NOT NULL),  0)::numeric(10,2) AS online_total,
         COALESCE(SUM(deposit_amount) FILTER (WHERE deposit_method = 'cash'),       0)::numeric(10,2) AS cash_total,
         COALESCE(SUM(deposit_amount) FILTER (WHERE deposit_method = 'card'),       0)::numeric(10,2) AS card_total,
         COUNT(*) FILTER (WHERE payment_status = 'deposit_pending')::int        AS pending_count
       FROM appointments
       WHERE starts_at::date = $1::date
         AND status NOT IN ('cancelled','no_show')`,
      [date],
    );
    res.json({ date, summary: rows[0] });
  } catch (err) {
    console.error('[appointments] deposit-summary', err);
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
    await offlineQueue.enqueue('update_appointment_status', { localId: id });
    req.app.get('io')?.emit('appointment_status', rows[0]);
    res.json({ appointment: rows[0] });
  } catch (err) {
    console.error('[appointments] status', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/appointments/:id/refund-deposit  body { reason? }
// SPA-BILL-ITEMS — staff-initiated refund of an online (Stripe) deposit,
// used by the Online Bookings admin tab's Refund button. Refunds the
// PaymentIntent via Stripe and marks payment_status='refunded'. The
// booking itself is left as-is (cancel is a separate action) so the
// operator can refund a deposit without cancelling, or cancel + refund.
router.post('/:id/refund-deposit', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const cur = await pool.query(
      `SELECT id, deposit_stripe_id, COALESCE(deposit_amount, 0) AS deposit_amount, payment_status
       FROM appointments WHERE id = $1`,
      [id],
    );
    if (!cur.rows[0]) return res.status(404).json({ error: 'appointment not found' });
    const a = cur.rows[0];
    if (!a.deposit_stripe_id) {
      return res.status(400).json({ error: 'no online deposit to refund on this booking' });
    }
    if (a.payment_status === 'refunded') {
      return res.status(409).json({ error: 'deposit already refunded' });
    }
    const s = stripeClient();
    if (!s) return res.status(503).json({ error: 'stripe not configured — refund via the Stripe dashboard' });
    try {
      await s.refunds.create({ payment_intent: a.deposit_stripe_id });
    } catch (e) {
      console.error('[appointments] refund-deposit stripe', e);
      return res.status(502).json({ error: `Stripe refund failed — ${e.message || 'try the Stripe dashboard'}` });
    }
    const { rows } = await pool.query(
      `UPDATE appointments SET payment_status = 'refunded' WHERE id = $1 RETURNING *`,
      [id],
    );
    req.app.get('io')?.emit('appointment_updated', rows[0]);
    res.json({ appointment: rows[0], refunded: Number(a.deposit_amount || 0) });
  } catch (err) {
    console.error('[appointments] refund-deposit', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
