// SPA-003 — Treatwell webhook receiver.
//
// Treatwell brings new customers via their marketplace; we accept their
// bookings into SiamSpa tagged `source='treatwell'` so the owner sees them
// alongside direct bookings, knows the commission is gone, and can target
// the same customers later with "book direct, save 10%" campaigns.
//
// Endpoint:
//   POST /api/treatwell/webhook
//   Header X-Treatwell-Secret: <env TREATWELL_WEBHOOK_SECRET>
//   Body (assumed — adjust field paths if Treatwell's real shape differs):
//     {
//       "booking_id": "TW-12345",
//       "status": "confirmed" | "cancelled",
//       "scheduled_for": "2026-06-01T14:30:00+01:00",
//       "customer": { "name": "...", "phone": "...", "email": "..." },
//       "service":  { "name": "...", "duration_minutes": 60, "price": 65 },
//       "notes":    "...",
//       "cancelled_at": "..."   // only on status='cancelled'
//     }
//
// On `confirmed` we upsert (find-or-create) the client by email/phone and
// INSERT an appointment with source='treatwell', treatwell_booking_id set.
// Re-deliveries are deduped by the unique partial index.
//
// On `cancelled` we look the booking up by treatwell_booking_id and mark
// it cancelled — the slot frees up automatically in availability.
//
// Treatment matching is by case-insensitive name (LIKE) — Treatwell shop
// owners typically mirror their treatment menu, but a fallback creates an
// `[unmatched]` flag in `notes` so staff can fix on import.

const express = require('express');
const { pool } = require('../db/database');
const { computeAvailability } = require('../services/availability');

const router = express.Router();

function expectedSecret() {
  return process.env.TREATWELL_WEBHOOK_SECRET || null;
}

function unauth(res, reason) {
  console.warn('[treatwell] webhook rejected:', reason);
  return res.status(401).json({ error: 'unauthorised' });
}

// POST /api/treatwell/webhook
router.post('/webhook', async (req, res) => {
  const secret = expectedSecret();
  if (!secret) return unauth(res, 'TREATWELL_WEBHOOK_SECRET not configured');
  const provided = req.get('x-treatwell-secret') || req.query.secret;
  if (provided !== secret) return unauth(res, 'bad secret');

  const b = req.body || {};
  const bookingId = b.booking_id || b.id || null;
  if (!bookingId) return res.status(400).json({ error: 'booking_id required' });

  const status = String(b.status || 'confirmed').toLowerCase();

  // ── Cancellation path ──────────────────────────────────────────────
  if (status === 'cancelled' || status === 'canceled' || b.cancelled_at) {
    try {
      const { rows } = await pool.query(
        `UPDATE appointments
         SET status = 'cancelled'
         WHERE treatwell_booking_id = $1
         RETURNING id`,
        [bookingId],
      );
      const found = !!rows[0];
      if (found) {
        req.app.get('io')?.emit('appointment_status', { id: rows[0].id, status: 'cancelled' });
      }
      return res.json({ ok: true, action: 'cancelled', matched: found });
    } catch (err) {
      console.error('[treatwell] cancel', err);
      return res.status(500).json({ error: 'server error' });
    }
  }

  // ── Confirmation path ──────────────────────────────────────────────
  const startsAt = b.scheduled_for || b.starts_at;
  const customer = b.customer || {};
  const service  = b.service  || {};
  if (!startsAt) return res.status(400).json({ error: 'scheduled_for required' });
  if (!customer.name && !customer.phone && !customer.email) {
    return res.status(400).json({ error: 'customer name/phone/email required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Dedup — if we've already imported this booking_id, no-op.
    const existing = await client.query(
      `SELECT id FROM appointments WHERE treatwell_booking_id = $1 LIMIT 1`,
      [bookingId],
    );
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, action: 'duplicate', appointment_id: existing.rows[0].id });
    }

    // Find / create the client. Email first, then phone.
    let cli = null;
    if (customer.email) {
      const r = await client.query(
        `SELECT * FROM clients WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) LIMIT 1`,
        [customer.email],
      );
      cli = r.rows[0] || null;
    }
    if (!cli && customer.phone) {
      const r = await client.query(
        `SELECT * FROM clients WHERE phone = $1 LIMIT 1`,
        [customer.phone],
      );
      cli = r.rows[0] || null;
    }
    if (cli) {
      // Top up any missing fields without overwriting good data.
      await client.query(
        `UPDATE clients SET
           name  = COALESCE(NULLIF($2,''), name),
           phone = COALESCE(NULLIF($3,''), phone),
           email = COALESCE(NULLIF($4,''), email),
           gdpr_consent    = TRUE,
           gdpr_consent_at = COALESCE(gdpr_consent_at, now())
         WHERE id = $1`,
        [cli.id, customer.name || '', customer.phone || '', customer.email || ''],
      );
    } else {
      const ins = await client.query(
        `INSERT INTO clients (name, phone, email, gdpr_consent, gdpr_consent_at)
         VALUES ($1, $2, $3, TRUE, now()) RETURNING *`,
        [customer.name || 'Treatwell guest', customer.phone || null, customer.email || null],
      );
      cli = ins.rows[0];
    }

    // Treatment match — case-insensitive name lookup. If no match, we
    // still book but tag the appointment notes so reception can fix it.
    let treatmentId = null;
    let durationMin = Number(service.duration_minutes) || 60;
    if (service.name) {
      const tr = await client.query(
        `SELECT id, duration_minutes FROM treatments
         WHERE active = TRUE AND LOWER(name) = LOWER($1)
         LIMIT 1`,
        [service.name],
      );
      if (tr.rows[0]) {
        treatmentId = tr.rows[0].id;
        durationMin = tr.rows[0].duration_minutes;
      } else {
        // Loose fallback — ILIKE substring.
        const tr2 = await client.query(
          `SELECT id, duration_minutes FROM treatments
           WHERE active = TRUE AND name ILIKE $1
           ORDER BY LENGTH(name) ASC
           LIMIT 1`,
          [`%${service.name}%`],
        );
        if (tr2.rows[0]) {
          treatmentId = tr2.rows[0].id;
          durationMin = tr2.rows[0].duration_minutes;
        }
      }
    }

    const endsAt = new Date(new Date(startsAt).getTime() + durationMin * 60_000);

    // Try to pre-assign a free therapist + room so the booking lands ready
    // to go. If the requested slot has no free therapist at all (rare —
    // Treatwell ought to have checked availability before pushing) we
    // still accept the booking but flag the conflict in notes so the
    // receptionist sees it and can offer the customer an alternative.
    let preTherapistId = null;
    let preRoomId      = null;
    let conflictFlag   = null;
    if (treatmentId) {
      try {
        const slots = await computeAvailability({
          treatment_id: treatmentId,
          date: String(startsAt).slice(0, 10),
          therapist_id: null,
        });
        const slot = slots.find((s) =>
          new Date(s.starts_at).getTime() === new Date(startsAt).getTime()
        );
        if (slot) {
          preTherapistId = slot.therapists[0] || null;
          preRoomId      = slot.rooms[0]      || null;
        } else {
          conflictFlag = '[CONFLICT — no free therapist at requested time; please reassign or contact customer]';
        }
      } catch (e) {
        // computeAvailability throws if treatment is inactive etc. — skip
        // auto-assign rather than fail the whole webhook.
        console.warn('[treatwell] auto-assign skipped:', e.message);
      }
    }

    const notes = [
      conflictFlag,
      treatmentId ? null : `[unmatched treatment: ${service.name || 'unknown'}]`,
      b.notes ? String(b.notes) : null,
    ].filter(Boolean).join(' ') || null;

    // Snapshot the treatment price at booking time. For un-matched
    // treatments (treatmentId is NULL) this stays NULL.
    let priceAtBooking = null;
    if (treatmentId) {
      const pr = await client.query('SELECT price FROM treatments WHERE id = $1', [treatmentId]);
      priceAtBooking = Number(pr.rows[0]?.price || 0);
    }

    // SPA-TREATWELL-COLOR — Treatwell payload may carry an explicit
    // prepay flag (b.payment_type or b.prepaid). When missing, default
    // to 'full' — a standard Treatwell marketplace booking means the
    // customer already paid Treatwell in full; the spa settles via
    // commission. Only mark 'partial' when the payload explicitly says
    // so (deposit booking) or the treatment name heuristic matches.
    // The operator can also flip this on the appointment Edit modal.
    let twPaymentType = null;
    const pt = String(b.payment_type || (b.prepaid ? 'full' : '')).toLowerCase();
    if (pt === 'full' || pt === 'prepaid' || pt === 'paid')      twPaymentType = 'full';
    else if (pt === 'partial' || pt === 'deposit')               twPaymentType = 'partial';
    else if (/tw\s*pre.?pa(id|y)/i.test(service?.name || ''))    twPaymentType = 'full';
    else                                                          twPaymentType = 'full';   // default: full prepay

    const ap = await client.query(
      `INSERT INTO appointments
         (client_id, treatment_id, therapist_id, room_id, starts_at, ends_at,
          status, source, notes, treatwell_booking_id, price_at_booking,
          treatwell_payment_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'booked', 'treatwell', $7, $8, $9, $10)
       RETURNING *`,
      [cli.id, treatmentId, preTherapistId, preRoomId, startsAt, endsAt, notes, bookingId, priceAtBooking, twPaymentType],
    );

    await client.query('COMMIT');

    req.app.get('io')?.emit('new_appointment', ap.rows[0]);

    return res.status(201).json({
      ok: true,
      action: 'created',
      appointment_id: ap.rows[0].id,
      client_id: cli.id,
      treatment_matched: !!treatmentId,
      therapist_assigned: !!preTherapistId,
      conflict: !!conflictFlag,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[treatwell] webhook', err);
    return res.status(500).json({ error: 'server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
