// SPA-TREATWELL-001 — shared Treatwell ingest engine.
//
// Takes a normalised booking (from treatwellEmail.parseTreatwellEmail or the AI
// fallback) and places / moves / cancels the appointment on the SiamSpa
// timetable, creating-or-linking the CRM client. Every email is recorded in
// `ingestion_log` (received → placed | duplicate | needs_review | error).
//
// Mirrors the proven logic in src/routes/treatwell.js (Sam's webhook) — client
// match (email→phone, top-up), treatment match (exact→fuzzy), dedup on the
// unique `treatwell_booking_id`, auto-assign via computeAvailability + conflict
// flag — and ADDS the reschedule/move path his webhook doesn't have. Kept as a
// separate module so it does NOT touch Sam's file; both dedup through the same
// `treatwell_booking_id` index, so they're safe to run side by side. (Later,
// with Sam's sign-off, his webhook can call this and the duplication goes away.)

const { pool } = require('../db/dbAdapter');
const { computeAvailability } = require('./availability');
const { sendOwnerNewBookingEmail } = require('./emailService');

const DB_MODE = process.env.DB_MODE || 'cloud';

// London wall-clock → an unambiguous tz-aware ISO string, independent of the
// server's TZ (Treatwell shows UK local time; the spa Railway may run in UTC).
function londonOffset(dateStr) {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const tz = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'short' })
    .formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value;
  return tz === 'BST' ? '+01:00' : '+00:00';
}
function toStartIso(parsed) {
  if (parsed.startIso) return parsed.startIso;   // already tz-aware (e.g. a webhook payload)
  if (!parsed.startLocal || !parsed.date) return null;
  return `${parsed.startLocal}${londonOffset(parsed.date)}`;
}

async function logIngestion(row) {
  try {
    await pool.query(
      `INSERT INTO ingestion_log
         (source, external_ref, action, status, confidence, parsed, raw, appointment_id, error)
       VALUES ('treatwell_email', $1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.ref || null, row.action || null, row.status, row.confidence || null,
       row.parsed ? JSON.stringify(row.parsed) : null, row.raw || null,
       row.appointmentId || null, row.error || null],
    );
  } catch (e) {
    console.error('[treatwellIngest] log write failed:', e.message);
  }
}

// Email-first, then phone. Top up missing fields without overwriting good data.
// Tag source='treatwell' on creation.
async function findOrCreateClient(db, parsed) {
  let cli = null;
  if (parsed.email) {
    const r = await db.query(
      `SELECT * FROM clients WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) LIMIT 1`, [parsed.email]);
    cli = r.rows[0] || null;
  }
  if (!cli && parsed.phone) {
    const r = await db.query(`SELECT * FROM clients WHERE phone = $1 LIMIT 1`, [parsed.phone]);
    cli = r.rows[0] || null;
  }
  if (cli) {
    await db.query(
      `UPDATE clients SET
         name  = COALESCE(NULLIF($2,''), name),
         phone = COALESCE(NULLIF($3,''), phone),
         email = COALESCE(NULLIF($4,''), email),
         gdpr_consent    = TRUE,
         gdpr_consent_at = COALESCE(gdpr_consent_at, now())
       WHERE id = $1`,
      [cli.id, parsed.name || '', parsed.phone || '', parsed.email || '']);
    return cli;
  }
  const ins = await db.query(
    `INSERT INTO clients (name, phone, email, source, gdpr_consent, gdpr_consent_at)
     VALUES ($1, $2, $3, 'treatwell', TRUE, now()) RETURNING *`,
    [parsed.name || 'Treatwell guest', parsed.phone || null, parsed.email || null]);
  return ins.rows[0];
}

// Exact name, then loose ILIKE. Returns { id, duration_minutes } | null.
async function matchTreatment(db, name) {
  if (!name) return null;
  const exact = await db.query(
    `SELECT id, duration_minutes FROM treatments WHERE active = TRUE AND LOWER(name) = LOWER($1) LIMIT 1`, [name]);
  if (exact.rows[0]) return exact.rows[0];
  const loose = await db.query(
    `SELECT id, duration_minutes FROM treatments WHERE active = TRUE AND name ILIKE $1 ORDER BY LENGTH(name) ASC LIMIT 1`,
    [`%${name}%`]);
  return loose.rows[0] || null;
}

async function autoAssign(treatmentId, startIso) {
  if (!treatmentId) return { therapistId: null, roomId: null, conflict: null };
  try {
    const slots = await computeAvailability({
      treatment_id: treatmentId, date: String(startIso).slice(0, 10), therapist_id: null });
    const slot = slots.find((s) => new Date(s.starts_at).getTime() === new Date(startIso).getTime());
    if (slot) return { therapistId: slot.therapists[0] || null, roomId: slot.rooms[0] || null, conflict: null };
    return { therapistId: null, roomId: null, conflict: '[CONFLICT — no free therapist at requested time; please reassign or contact customer]' };
  } catch (e) {
    console.warn('[treatwellIngest] auto-assign skipped:', e.message);
    return { therapistId: null, roomId: null, conflict: null };
  }
}

// ── CREATE ───────────────────────────────────────────────────────────────────
async function createBooking(parsed, raw, io) {
  const startIso = toStartIso(parsed);
  if (!startIso) {
    await logIngestion({ ...logBase(parsed, raw), status: 'needs_review', error: 'no parseable start time' });
    return { action: 'create', status: 'needs_review', reason: 'no start time' };
  }

  // Dedup first (outside any txn) — cheap + idempotent against re-delivery.
  const dup = await pool.query(`SELECT id FROM appointments WHERE treatwell_booking_id = $1 LIMIT 1`, [parsed.ref]);
  if (dup.rows[0]) {
    await logIngestion({ ...logBase(parsed, raw), status: 'duplicate', appointmentId: dup.rows[0].id });
    return { action: 'create', status: 'duplicate', appointment_id: dup.rows[0].id };
  }

  const treatment = await matchTreatment(pool, parsed.treatment);
  const treatmentId = treatment ? treatment.id : null;
  const durationMin = parsed.durationMin || (treatment && treatment.duration_minutes) || 60;
  const endIso = new Date(new Date(startIso).getTime() + durationMin * 60000).toISOString();
  const { therapistId, roomId, conflict } = await autoAssign(treatmentId, startIso);

  const notes = [
    conflict,
    treatmentId ? null : `[unmatched treatment: ${parsed.treatment || 'unknown'}]`,
    parsed.room ? `Treatwell room: ${parsed.room}` : null,
  ].filter(Boolean).join(' ') || null;

  let priceAtBooking = parsed.price != null ? Number(parsed.price) : null;
  if (priceAtBooking == null && treatmentId) {
    const pr = await pool.query('SELECT price FROM treatments WHERE id = $1', [treatmentId]);
    priceAtBooking = Number(pr.rows[0]?.price || 0);
  }
  const paymentType = parsed.prepaid ? 'full' : 'full';   // Treatwell marketplace bookings are prepaid

  const insertSql = `
    INSERT INTO appointments
      (client_id, treatment_id, therapist_id, room_id, starts_at, ends_at,
       status, source, notes, treatwell_booking_id, price_at_booking, treatwell_payment_type)
    VALUES ($1,$2,$3,$4,$5,$6,'booked','treatwell',$7,$8,$9,$10) RETURNING *`;

  let appt;
  if (DB_MODE === 'local') {
    const cli = await findOrCreateClient(pool, parsed);
    const r = await pool.query(insertSql,
      [cli.id, treatmentId, therapistId, roomId, startIso, endIso, notes, parsed.ref, priceAtBooking, paymentType]);
    appt = r.rows[0];
  } else {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const cli = await findOrCreateClient(db, parsed);
      // Serialise concurrent placement on the same therapist/room (READ COMMITTED
      // lets INSERT…WHERE NOT EXISTS double-book otherwise) — same as the engine.
      if (therapistId) await db.query('SELECT pg_advisory_xact_lock(1, $1)', [therapistId]);
      if (roomId)      await db.query('SELECT pg_advisory_xact_lock(2, $1)', [roomId]);
      const r = await db.query(insertSql,
        [cli.id, treatmentId, therapistId, roomId, startIso, endIso, notes, parsed.ref, priceAtBooking, paymentType]);
      await db.query('COMMIT');
      appt = r.rows[0];
    } catch (e) {
      await db.query('ROLLBACK'); throw e;
    } finally { db.release(); }
  }

  io?.emit('new_appointment', appt);

  // Owner notification (fire-and-forget) — parity with Sam's webhook so the
  // owner is alerted to Treatwell bookings arriving via email too.
  (async () => {
    try {
      const named = await pool.query(
        `SELECT c.*, th.name AS therapist_name, t.name AS treatment_name, t.duration_minutes, t.price
         FROM appointments a
         JOIN clients c       ON c.id  = a.client_id
         LEFT JOIN therapists th ON th.id = a.therapist_id
         LEFT JOIN treatments  t  ON t.id  = a.treatment_id
         WHERE a.id = $1`, [appt.id]);
      const row = named.rows[0];
      if (row) await sendOwnerNewBookingEmail({
        appointment: appt,
        client: row,
        treatment: row.treatment_name ? { name: row.treatment_name, duration_minutes: row.duration_minutes, price: row.price } : null,
        therapistName: row.therapist_name,
        source: 'treatwell',
      });
    } catch (e) { console.error('[treatwellIngest] owner notify failed:', e.message); }
  })();

  await logIngestion({ ...logBase(parsed, raw), status: 'placed', appointmentId: appt.id });
  return { action: 'create', status: 'placed', appointment_id: appt.id,
           treatment_matched: !!treatmentId, therapist_assigned: !!therapistId, conflict: !!conflict };
}

// ── RESCHEDULE (move) — the gap Sam's webhook doesn't cover ───────────────────
async function rescheduleBooking(parsed, raw, io) {
  const startIso = toStartIso(parsed);
  const found = await pool.query(
    `SELECT id, treatment_id FROM appointments WHERE treatwell_booking_id = $1 AND status NOT IN ('cancelled','no_show') ORDER BY id DESC LIMIT 1`,
    [parsed.ref]);
  const row = found.rows[0];
  if (!row || !startIso) {
    // We never ingested the original (or no new time) → leave for staff.
    await logIngestion({ ...logBase(parsed, raw), status: 'needs_review',
      error: !row ? 'reschedule for unknown booking ref' : 'no parseable new time' });
    return { action: 'reschedule', status: 'needs_review' };
  }
  let durationMin = parsed.durationMin;
  if (!durationMin && row.treatment_id) {
    const t = await pool.query('SELECT duration_minutes FROM treatments WHERE id = $1', [row.treatment_id]);
    durationMin = t.rows[0]?.duration_minutes;
  }
  durationMin = durationMin || 60;
  const endIso = new Date(new Date(startIso).getTime() + durationMin * 60000).toISOString();
  const upd = await pool.query(
    `UPDATE appointments SET starts_at = $2, ends_at = $3 WHERE id = $1 RETURNING *`,
    [row.id, startIso, endIso]);
  io?.emit('appointment_updated', upd.rows[0]);
  await logIngestion({ ...logBase(parsed, raw), status: 'placed', appointmentId: row.id });
  return { action: 'reschedule', status: 'moved', appointment_id: row.id };
}

// ── CANCEL ───────────────────────────────────────────────────────────────────
async function cancelBooking(parsed, raw, io) {
  const r = await pool.query(
    `UPDATE appointments SET status = 'cancelled' WHERE treatwell_booking_id = $1 AND status <> 'cancelled' RETURNING id`,
    [parsed.ref]);
  const id = r.rows[0]?.id || null;
  if (id) io?.emit('appointment_status', { id, status: 'cancelled' });
  await logIngestion({ ...logBase(parsed, raw), status: id ? 'placed' : 'needs_review',
    appointmentId: id, error: id ? null : 'cancel for unknown booking ref' });
  return { action: 'cancel', status: id ? 'cancelled' : 'needs_review', appointment_id: id };
}

function logBase(parsed, raw) {
  return { ref: parsed.ref, action: parsed.action, confidence: parsed.confidence, parsed, raw };
}

/**
 * Place / move / cancel a parsed Treatwell booking. `io` (optional) = socket.io
 * server for realtime push. Never throws to the caller for business outcomes —
 * everything lands in ingestion_log; only genuine DB errors bubble up.
 */
async function ingestBooking(parsed, raw, io) {
  if (!parsed || !parsed.ok || !parsed.ref) {
    await logIngestion({ ref: parsed?.ref, action: parsed?.action, status: 'needs_review',
      confidence: parsed?.confidence || 'none', parsed, raw, error: parsed?.reason || 'unparseable' });
    return { status: 'needs_review', reason: parsed?.reason || 'unparseable' };
  }
  try {
    if (parsed.action === 'cancel')     return await cancelBooking(parsed, raw, io);
    if (parsed.action === 'reschedule') return await rescheduleBooking(parsed, raw, io);
    return await createBooking(parsed, raw, io);
  } catch (e) {
    console.error('[treatwellIngest] error:', e);
    await logIngestion({ ...logBase(parsed, raw), status: 'error', error: e.message });
    return { status: 'error', error: e.message };
  }
}

module.exports = { ingestBooking, toStartIso, londonOffset };
