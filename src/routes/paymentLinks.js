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
const { sendPaymentLinkEmail, sendSms, toGsm7 } = require('../services/emailService'); // SPA-PAYLINK-SEND-001

// SPA-PAYLINK-SEND-001 — compose the SMS so it fits ONE segment (160 GSM
// chars) whenever possible: the description is shortened first, then dropped;
// the link is never cut (a 2-segment text beats a dead link).
function composePayLinkSms({ spaName, amount, description, payUrl }) {
  const head = toGsm7(spaName) + ': please pay ' + amount;
  const tail = '. Pay here: ' + payUrl + ' (valid 24h)';
  const room = 160 - head.length - tail.length;
  let desc = description ? ' for ' + toGsm7(description) : '';
  if (desc.length > room) desc = room > 12 ? desc.slice(0, room).replace(/\s+\S*$/, '') : '';
  return head + desc + tail;
}

// SPA-PAYLINK-SEND-001 — 8-char code for the short public URL
// (${PUBLIC_API_URL}/pay/<code>) that fits in a single SMS segment. Stripe's
// own checkout URL is ~250 chars, which alone costs 2 segments.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function newShortCode() {
  for (let i = 0; i < 10; i++) {
    let c = '';
    for (let j = 0; j < 8; j++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    const { rows } = await pool.query('SELECT 1 FROM payment_links WHERE short_code = $1', [c]);
    if (!rows[0]) return c;
  }
  return null;
}
const shortUrl = (link) => (link.short_code && publicUrl()) ? `${publicUrl()}/pay/${link.short_code}` : link.url;
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
  const { amount, description, customer_email, customer_phone, appointment_id } = req.body || {};
  const s = stripe();
  if (!s) return res.status(503).json({ error: 'Stripe is not configured' });

  let pounds, desc, email = customer_email || null, phone = customer_phone || null, purpose = 'adhoc', apptId = null;

  try {
    if (appointment_id) {
      // ── Booking deposit link ──────────────────────────────────────────
      const a = await pool.query(
        `SELECT ap.id, ap.price_at_booking, ap.payment_status,
                t.name AS treatment_name, c.name AS client_name, c.email AS client_email, c.phone AS client_phone
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
      phone   = customer_phone || appt.client_phone || null;
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

    const code = await newShortCode();
    const { rows } = await pool.query(
      `INSERT INTO payment_links
         (purpose, amount, currency, description, status, stripe_session_id, url, customer_email, customer_phone, short_code, appointment_id, created_by, expires_at)
       VALUES ($1, $2, 'gbp', $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [purpose, pounds, desc, session.id, session.url, email, phone, code, apptId, req.staff?.id || null, expiresIso],
    );
    rows[0].short_url = shortUrl(rows[0]);

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
    for (const l of rows) l.short_url = shortUrl(l);
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

// SPA-PAYLINK-SEND-001 — POST /api/payment-links/:id/send
// body: { channel: 'email' | 'sms', to }
// Sends the (short) link to the customer. Best-effort delivery; the link
// itself is unaffected, so staff can always fall back to Copy link.
router.post('/:id/send', requireRole('admin', 'manager', 'reception'), async (req, res) => {
  const id = Number(req.params.id);
  const { channel, to } = req.body || {};
  if (!['email', 'sms'].includes(channel)) return res.status(400).json({ error: 'channel must be email or sms' });
  try {
    const { rows } = await pool.query('SELECT * FROM payment_links WHERE id = $1', [id]);
    const link = rows[0];
    if (!link) return res.status(404).json({ error: 'link not found' });
    if (link.status !== 'pending') return res.status(409).json({ error: `link is ${link.status}` });
    const payUrl = shortUrl(link);
    const spaName = process.env.SPA_NAME || 'SiamEPOS Spa';
    const amt = '£' + Number(link.amount).toFixed(2);
    let target;
    if (channel === 'email') {
      target = String(to || link.customer_email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) return res.status(400).json({ error: 'a valid email address is required' });
      const r = await sendPaymentLinkEmail({ to: target, amount: link.amount, description: link.description, payUrl, expiresAt: link.expires_at, spaName });
      if (r && r.skipped) return res.status(503).json({ error: 'email is not configured on this spa (BREVO_API_KEY)' });
    } else {
      target = String(to || link.customer_phone || '').trim();
      if (!target) return res.status(400).json({ error: 'a mobile number is required' });
      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return res.status(503).json({ error: 'SMS is not configured on this spa' });
      const text = composePayLinkSms({ spaName, amount: amt, description: link.description, payUrl });
      const ok = await sendSms(target, text, { noCap: true });
      if (!ok) return res.status(502).json({ error: 'SMS could not be sent — check the mobile number (UK 07… or +44…)' });
    }
    await pool.query(
      `UPDATE payment_links SET sent_via = $2, sent_to = $3, sent_at = now(),
         customer_email = CASE WHEN $2 = 'email' THEN $3 ELSE customer_email END,
         customer_phone = CASE WHEN $2 = 'sms'   THEN $3 ELSE customer_phone END
       WHERE id = $1`,
      [id, channel, target],
    );
    res.json({ ok: true, channel, sent_to: target });
  } catch (err) {
    console.error('[payment-links] send', err);
    res.status(500).json({ error: err.message || 'server error' });
  }
});

// SPA-PAYLINK-SEND-001 — public resolver for the short URL. Mounted by
// server.js at GET /pay/:code (no auth — the customer clicks it from an SMS).
async function resolveShortCode(req, res) {
  const code = String(req.params.code || '').toUpperCase();
  try {
    const { rows } = await pool.query('SELECT url, status, expires_at FROM payment_links WHERE short_code = $1', [code]);
    const link = rows[0];
    if (!link) return res.redirect(302, `${publicUrl()}/pay-thanks?status=cancelled`);
    if (link.status === 'paid') return res.redirect(302, `${publicUrl()}/pay-thanks?status=paid`);
    const expired = link.expires_at && new Date(link.expires_at).getTime() < Date.now();
    if (link.status !== 'pending' || expired || !link.url) return res.redirect(302, `${publicUrl()}/pay-thanks?status=cancelled`);
    return res.redirect(302, link.url);
  } catch (err) {
    console.error('[payment-links] short-code', err);
    return res.redirect(302, `${publicUrl()}/pay-thanks?status=cancelled`);
  }
}

module.exports = router;
module.exports.resolveShortCode = resolveShortCode;
module.exports.composePayLinkSms = composePayLinkSms;
