// Payment links (SEPOS-SPA-PAYLINK-001) — staff-generated Stripe Checkout links.
//
//   • Ad-hoc:  POST { amount, description?, customer_email? }
//   • Booking: POST { appointment_id }  → deposit link for a phone booking; the
//              amount is computed from the spa's deposit policy and, on payment,
//              the appointment is marked deposit_paid.
//
// Status reconciliation is belt-and-braces: the checkout.session.completed
// webhook marks it paid on the cloud, AND GET /api/payment-links refreshes any
// still-'pending' link straight from Stripe (so the till stays accurate too).

const express = require('express');
const Stripe = require('stripe');
const { pool } = require('../db/dbAdapter');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// SIAMPAY-002 — own keys OR SiamPay platform mode (see services/stripeGateway).
const { gateway, sessionFee } = require('../services/stripeGateway');
function stripe() {
  return gateway();
}

const publicUrl = () => (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
const MAX_AMOUNT = 1000; // mirrors the £1000 cap on online voucher purchases

// Deposit policy — same shape/keys the widget uses, so phone bookings charge
// exactly what website bookings do.
async function loadDepositPolicy() {
  const { rows } = await pool.query(
    "SELECT key, value FROM settings WHERE key IN ('deposit_model','deposit_amount','deposit_percentage')",
  );
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    deposit_model:      s.deposit_model || 'fixed_amount',
    deposit_amount:     Number(s.deposit_amount || 25),
    deposit_percentage: Number(s.deposit_percentage || 25),
  };
}
function computeDeposit(policy, price) {
  const p = Number(price || 0);
  if (policy.deposit_model === 'none')        return 0;
  if (policy.deposit_model === 'full_prepay') return +p.toFixed(2);
  if (policy.deposit_model === 'percentage')  return +((p * policy.deposit_percentage) / 100).toFixed(2);
  return +Math.min(policy.deposit_amount, p).toFixed(2);
}

// POST /api/payment-links
//   ad-hoc : { amount, description?, customer_email? }
//   booking: { appointment_id }   (amount derived from deposit policy)
router.post('/', requireRole('admin', 'manager', 'reception'), async (req, res) => {
  const { amount, description, customer_email, appointment_id } = req.body || {};
  const s = stripe();
  if (!s) return res.status(503).json({ error: 'Stripe is not configured' });

  let pounds, desc, email = customer_email || null, purpose = 'adhoc', apptId = null;

  try {
    if (appointment_id) {
      // ── Booking deposit link ──────────────────────────────────────────
      const a = await pool.query(
        `SELECT ap.id, ap.price_at_booking, ap.payment_status,
                t.name AS treatment_name, c.name AS client_name, c.email AS client_email
         FROM appointments ap
         LEFT JOIN treatments t ON t.id = ap.treatment_id
         LEFT JOIN clients    c ON c.id = ap.client_id
         WHERE ap.id = $1`,
        [Number(appointment_id)],
      );
      const appt = a.rows[0];
      if (!appt) return res.status(404).json({ error: 'appointment not found' });
      if (['deposit_paid', 'fully_paid'].includes(appt.payment_status)) {
        return res.status(409).json({ error: 'deposit already paid for this booking' });
      }
      const policy = await loadDepositPolicy();
      pounds = computeDeposit(policy, appt.price_at_booking);
      if (pounds <= 0) return res.status(400).json({ error: 'Deposit policy is "none" — no payment is due' });
      desc    = description || `Deposit — ${appt.treatment_name || 'treatment'}${appt.client_name ? ' for ' + appt.client_name : ''}`;
      email   = customer_email || appt.client_email || null;
      purpose = 'deposit';
      apptId  = appt.id;
    } else {
      // ── Ad-hoc amount ─────────────────────────────────────────────────
      pounds = Number(amount);
      if (!pounds || pounds <= 0) return res.status(400).json({ error: 'A positive amount is required' });
      if (pounds > MAX_AMOUNT)    return res.status(400).json({ error: `Amount cannot exceed £${MAX_AMOUNT}` });
      desc = description || null;
    }

    const expiresUnix = Math.floor(Date.now() / 1000) + 23 * 60 * 60; // Stripe caps at 24h
    const expiresIso  = new Date(expiresUnix * 1000).toISOString();
    const session = await s.s.checkout.sessions.create({
      mode: 'payment',
      ...sessionFee(s), // SIAMPAY-002
      expires_at: expiresUnix,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'gbp',
          unit_amount: Math.round(pounds * 100),
          product_data: { name: (desc && String(desc).slice(0, 250)) || 'SiamEPOS Spa payment' },
        },
      }],
      customer_email: email || undefined,
      metadata: { purpose, appointment_id: apptId ? String(apptId) : '' },
      success_url: `${publicUrl()}/pay-thanks?status=paid`,
      cancel_url:  `${publicUrl()}/pay-thanks?status=cancelled`,
    }, s.opts);

    const { rows } = await pool.query(
      `INSERT INTO payment_links
         (purpose, amount, currency, description, status, stripe_session_id, url, customer_email, appointment_id, created_by, expires_at)
       VALUES ($1, $2, 'gbp', $3, 'pending', $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [purpose, pounds, desc, session.id, session.url, email, apptId, req.staff?.id || null, expiresIso],
    );

    // Surface the pending deposit on the booking so staff see it on the
    // appointment screen straight away.
    if (apptId) {
      await pool.query(
        `UPDATE appointments SET payment_status = 'deposit_pending', deposit_amount = $2
         WHERE id = $1 AND payment_status NOT IN ('deposit_paid','fully_paid')`,
        [apptId, pounds],
      );
    }

    res.status(201).json({ link: rows[0] });
  } catch (err) {
    console.error('[payment-links] create', err);
    res.status(500).json({ error: err.message || 'server error' });
  }
});

// Mark a booking's appointment paid when its deposit link completes. Shared by
// the webhook and the on-demand refresh below.
async function markAppointmentPaid(appointmentId, amount, paymentIntentId) {
  if (!appointmentId) return;
  await pool.query(
    `UPDATE appointments
       SET payment_status = 'deposit_paid', deposit_amount = $2, deposit_stripe_id = $3
     WHERE id = $1 AND status NOT IN ('cancelled','no_show')`,
    [appointmentId, amount, paymentIntentId || null],
  );
}

// GET /api/payment-links — 50 most recent, refreshing pending links from Stripe.
router.get('/', requireRole('admin', 'manager', 'reception'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM payment_links ORDER BY created_at DESC LIMIT 50',
    );
    const s = stripe();
    if (s) {
      for (const link of rows) {
        if (link.status !== 'pending' || !link.stripe_session_id) continue;
        try {
          const sess = await s.s.checkout.sessions.retrieve(link.stripe_session_id, {}, s.opts);
          let next = null;
          if (sess.payment_status === 'paid' || sess.status === 'complete') next = 'paid';
          else if (sess.status === 'expired') next = 'expired';
          if (next && next !== link.status) {
            const paidAt = next === 'paid' ? new Date().toISOString() : null;
            await pool.query(
              'UPDATE payment_links SET status = $2, paid_at = COALESCE($3, paid_at) WHERE id = $1',
              [link.id, next, paidAt],
            );
            link.status = next;
            if (paidAt) link.paid_at = paidAt;
            if (next === 'paid' && link.appointment_id) {
              await markAppointmentPaid(link.appointment_id, link.amount, sess.payment_intent);
            }
          }
        } catch (e) { /* leave as pending if Stripe lookup fails */ }
      }
    }
    res.json({ links: rows });
  } catch (err) {
    console.error('[payment-links] list', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/payment-links/:id/cancel — expire the Stripe session + mark cancelled.
router.post('/:id/cancel', requireRole('admin', 'manager', 'reception'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows } = await pool.query('SELECT * FROM payment_links WHERE id = $1', [id]);
    const link = rows[0];
    if (!link) return res.status(404).json({ error: 'not found' });
    if (link.status !== 'pending') return res.status(409).json({ error: `Link is already ${link.status}` });
    const s = stripe();
    if (s && link.stripe_session_id) {
      try { await s.s.checkout.sessions.expire(link.stripe_session_id, {}, s.opts); } catch (e) { /* may already be gone */ }
    }
    await pool.query("UPDATE payment_links SET status = 'cancelled' WHERE id = $1 AND status = 'pending'", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[payment-links] cancel', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
