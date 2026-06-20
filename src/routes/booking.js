// SPA-PAY-001 — Customer self-service booking management.
//
// Public, no-auth endpoints driven by an HMAC-signed token sent in the
// confirmation email. The token encodes the appointment id; we verify
// the HMAC server-side before returning any data.
//
//   GET    /api/booking/by-token/:token   — load the booking + policy
//   PUT    /api/booking/by-token/:token   — reschedule to a new slot
//   DELETE /api/booking/by-token/:token   — cancel (with refund if in window)
//
// Refunds go via Stripe's refund API on the original PaymentIntent.
// Whether a refund is issued depends on cancel_window_hours in settings:
// inside the window the deposit is refunded; outside it's forfeit and
// the customer is told so on the portal.

const express = require('express');
const Stripe = require('stripe');
const { pool } = require('../db/dbAdapter');
const { computeAvailability, isTherapistWorking } = require('../services/availability');
const {
  parseBookingToken,
  sendBookingRescheduled,
  sendBookingCancelled,
} = require('../services/emailService');

const router = express.Router();

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: '2024-06-20' });
}

async function loadPolicy() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE key IN
       ('cancel_window_hours','cancel_policy_text','deposit_model','deposit_amount')`,
  );
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    cancel_window_hours: Number(s.cancel_window_hours || 24),
    cancel_policy_text:  s.cancel_policy_text  || '',
    deposit_model:       s.deposit_model       || 'fixed_amount',
    deposit_amount:      Number(s.deposit_amount || 25),
  };
}

// Centralised loader so GET/PUT/DELETE share one shape.
async function loadAppointment(id) {
  const { rows } = await pool.query(
    `SELECT a.*,
            t.name AS treatment_name, t.duration_minutes, t.price AS treatment_price,
            c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
            th.name AS therapist_name,
            r.name AS room_name
     FROM appointments a
     LEFT JOIN treatments t  ON t.id  = a.treatment_id
     LEFT JOIN clients    c  ON c.id  = a.client_id
     LEFT JOIN therapists th ON th.id = a.therapist_id
     LEFT JOIN rooms      r  ON r.id  = a.room_id
     WHERE a.id = $1`,
    [id],
  );
  return rows[0] || null;
}

// Tells the customer whether they can still amend free of charge.
function withinCancelWindow(starts_at, windowHours) {
  const start = new Date(starts_at).getTime();
  return (start - Date.now()) > windowHours * 3600 * 1000;
}

function tokenAppointmentId(req, res) {
  const id = parseBookingToken(req.params.token);
  if (!id) {
    res.status(401).json({ error: 'invalid or expired booking link' });
    return null;
  }
  return id;
}

// GET /api/booking/by-token/:token
router.get('/by-token/:token', async (req, res) => {
  const id = tokenAppointmentId(req, res);
  if (!id) return;
  try {
    const a = await loadAppointment(id);
    if (!a) return res.status(404).json({ error: 'booking not found' });
    const policy = await loadPolicy();
    const editable = withinCancelWindow(a.starts_at, policy.cancel_window_hours)
                  && !['cancelled', 'no_show', 'completed', 'in_progress'].includes(a.status);

    // SPA-PAY-002 — if the spa generated a payment-link for this
    // appointment, surface the Stripe client_secret + publishable key
    // so the portal can render the Pay Now UI with Stripe Elements.
    let payment = null;
    if (a.payment_status === 'deposit_pending' && a.deposit_stripe_id) {
      payment = {
        deposit_amount:  Number(a.deposit_amount || 0),
        publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
      };
      const s = stripeClient();
      if (s) {
        try {
          const intent = await s.paymentIntents.retrieve(a.deposit_stripe_id);
          payment.client_secret = intent.client_secret;
          payment.intent_status = intent.status;
        } catch (e) {
          console.error('[booking] retrieve intent', e);
        }
      }
    }

    res.json({
      booking: {
        id: a.id,
        status: a.status,
        starts_at: a.starts_at,
        ends_at: a.ends_at,
        treatment: { id: a.treatment_id, name: a.treatment_name, duration_minutes: a.duration_minutes, price: Number(a.treatment_price || 0) },
        therapist: a.therapist_id ? { id: a.therapist_id, name: a.therapist_name } : null,
        room: a.room_id ? { id: a.room_id, name: a.room_name } : null,
        client: { name: a.client_name, email: a.client_email, phone: a.client_phone },
        deposit_amount: Number(a.deposit_amount || 0),
        payment_status: a.payment_status || 'none',
        balance_due: +(Number(a.treatment_price || 0) - Number(a.deposit_amount || 0)).toFixed(2),
      },
      payment,
      policy: {
        cancel_window_hours: policy.cancel_window_hours,
        cancel_policy_text:  policy.cancel_policy_text,
        editable,
        deadline: new Date(new Date(a.starts_at).getTime() - policy.cancel_window_hours * 3600 * 1000).toISOString(),
      },
    });
  } catch (err) {
    console.error('[booking] get', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/booking/by-token/:token/confirm-payment
// Public — called by the customer portal after Stripe confirmCardPayment
// returns successfully. Verifies the PI is actually 'succeeded' against
// Stripe (so we don't trust the client) and flips payment_status to
// 'deposit_paid'. The Stripe webhook is the canonical signal in
// production; this endpoint is a complementary fast-path so the customer
// sees confirmation immediately without waiting for the webhook.
router.post('/by-token/:token/confirm-payment', async (req, res) => {
  const id = tokenAppointmentId(req, res);
  if (!id) return;
  try {
    const cur = await loadAppointment(id);
    if (!cur) return res.status(404).json({ error: 'booking not found' });
    if (!cur.deposit_stripe_id) return res.status(400).json({ error: 'no payment intent on this booking' });
    const s = stripeClient();
    if (!s) return res.status(503).json({ error: 'stripe not configured' });
    const intent = await s.paymentIntents.retrieve(cur.deposit_stripe_id);
    if (intent.status !== 'succeeded') {
      return res.status(402).json({ error: 'payment not yet succeeded', stripe_status: intent.status });
    }
    const depositAmount = +(intent.amount_received / 100).toFixed(2);
    await pool.query(
      `UPDATE appointments
         SET deposit_amount = $2, payment_status = 'deposit_paid'
       WHERE id = $1`,
      [id, depositAmount],
    );
    res.json({ ok: true, deposit_amount: depositAmount });
  } catch (err) {
    console.error('[booking] confirm-payment', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/booking/by-token/:token  body: { starts_at, therapist_id? }
// Reschedule: pick a new slot. Availability + rota are revalidated
// server-side so the customer can't move to a slot that doesn't fit.
router.put('/by-token/:token', async (req, res) => {
  const id = tokenAppointmentId(req, res);
  if (!id) return;
  const b = req.body || {};
  if (!b.starts_at) return res.status(400).json({ error: 'starts_at required' });

  const policy = await loadPolicy();
  const cur = await loadAppointment(id);
  if (!cur) return res.status(404).json({ error: 'booking not found' });
  if (!withinCancelWindow(cur.starts_at, policy.cancel_window_hours)) {
    return res.status(403).json({ error: 'past the change window — please contact the spa to amend' });
  }
  if (['cancelled', 'no_show', 'completed', 'in_progress'].includes(cur.status)) {
    return res.status(403).json({ error: `booking is ${cur.status} — cannot reschedule` });
  }

  // Run the same availability + rota checks the widget uses on first book.
  const duration = Number(cur.duration_minutes);
  const newEndsAt = new Date(new Date(b.starts_at).getTime() + duration * 60_000);
  const requestedTherapistId = b.therapist_id !== undefined
    ? (b.therapist_id ? Number(b.therapist_id) : null)
    : cur.therapist_id;

  if (requestedTherapistId) {
    const rotaCheck = await isTherapistWorking(requestedTherapistId, b.starts_at, newEndsAt.toISOString());
    if (!rotaCheck.working) return res.status(409).json({ error: 'chosen therapist not on shift at that time' });
  }

  // Pull free-slots for the day and confirm the chosen instant is one of them.
  const av = await computeAvailability({
    treatment_id: cur.treatment_id,
    date: String(b.starts_at).slice(0, 10),
    therapist_id: requestedTherapistId,
  });
  const slot = av.find((s) => new Date(s.starts_at).getTime() === new Date(b.starts_at).getTime());
  if (!slot) return res.status(409).json({ error: 'slot no longer available' });

  // Honour the requested therapist (rota+conflict already passed); otherwise let the
  // engine pick a free one.
  const newTherapistId = requestedTherapistId || slot.therapists[0];
  const newRoomId = slot.rooms[0];

  try {
    const oldStarts = cur.starts_at;
    const upd = await pool.query(
      `UPDATE appointments
         SET starts_at = $2, ends_at = $3, therapist_id = $4, room_id = $5
         WHERE id = $1 RETURNING *`,
      [id, b.starts_at, newEndsAt.toISOString(), newTherapistId, newRoomId],
    );
    await pool.query(
      `INSERT INTO appointment_amendments
         (appointment_id, kind, from_value, to_value, by_customer)
       VALUES ($1, 'rescheduled', $2, $3, TRUE)`,
      [id, String(oldStarts), b.starts_at],
    );

    req.app.get('io')?.emit('appointment_updated', upd.rows[0]);

    // Confirmation email (best-effort).
    if (cur.client_email) {
      sendBookingRescheduled({
        client:      { name: cur.client_name, email: cur.client_email },
        appointment: upd.rows[0],
        treatment:   { name: cur.treatment_name },
        oldStartsAt: oldStarts,
      }).catch((e) => console.error('[booking] reschedule email', e));
    }

    res.json({ booking: { id, starts_at: b.starts_at, ends_at: newEndsAt.toISOString(), therapist_id: newTherapistId } });
  } catch (err) {
    console.error('[booking] reschedule', err);
    res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/booking/by-token/:token
// Cancel. Inside the policy window → refund the deposit via Stripe.
// Outside → forfeit (no refund). Either way we mark the appointment
// cancelled and notify the customer.
router.delete('/by-token/:token', async (req, res) => {
  const id = tokenAppointmentId(req, res);
  if (!id) return;
  try {
    const cur = await loadAppointment(id);
    if (!cur) return res.status(404).json({ error: 'booking not found' });
    if (['cancelled', 'no_show', 'completed'].includes(cur.status)) {
      return res.status(409).json({ error: `booking is already ${cur.status}` });
    }
    const policy = await loadPolicy();
    const inWindow = withinCancelWindow(cur.starts_at, policy.cancel_window_hours);
    const depositAmount = Number(cur.deposit_amount || 0);

    let refundAmount = 0;
    let refundReason = null;
    let nextPaymentStatus = cur.payment_status || 'none';

    if (depositAmount > 0 && cur.deposit_stripe_id) {
      if (inWindow) {
        const s = stripeClient();
        if (!s) return res.status(503).json({ error: 'stripe not configured — cannot refund' });
        try {
          await s.refunds.create({ payment_intent: cur.deposit_stripe_id });
          refundAmount = depositAmount;
          nextPaymentStatus = 'refunded';
        } catch (err) {
          console.error('[booking] refund failed', err);
          return res.status(500).json({ error: 'refund failed — please contact the spa' });
        }
      } else {
        refundReason = `Cancellation is within ${policy.cancel_window_hours} hours of the appointment, so the £${depositAmount.toFixed(2)} deposit is non-refundable per our policy.`;
        nextPaymentStatus = 'forfeit';
      }
    }

    await pool.query(
      `UPDATE appointments SET status = 'cancelled', payment_status = $2 WHERE id = $1`,
      [id, nextPaymentStatus],
    );
    await pool.query(
      `INSERT INTO appointment_amendments
         (appointment_id, kind, from_value, to_value, by_customer, note)
       VALUES ($1, 'cancelled', $2, 'cancelled', TRUE, $3)`,
      [id, cur.status, refundAmount > 0 ? `refunded £${refundAmount.toFixed(2)}` : refundReason],
    );

    req.app.get('io')?.emit('appointment_status', { id, status: 'cancelled' });

    if (cur.client_email) {
      sendBookingCancelled({
        client:       { name: cur.client_name, email: cur.client_email },
        appointment:  { id, starts_at: cur.starts_at },
        treatment:    { name: cur.treatment_name },
        refundAmount, refundReason,
      }).catch((e) => console.error('[booking] cancel email', e));
    }

    res.json({ ok: true, refunded: refundAmount, payment_status: nextPaymentStatus });
  } catch (err) {
    console.error('[booking] cancel', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
