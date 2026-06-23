// Payment links (SEPOS-SPA-PAYLINK-001, Phase 1) — staff-generated one-off
// Stripe Checkout links for an ad-hoc custom amount. Staff create a link in the
// admin, copy it / show the QR, and the customer pays remotely (card-not-present).
//
// Status reconciliation is belt-and-braces:
//   - the checkout.session.completed webhook marks it paid on the cloud, AND
//   - GET /api/payment-links refreshes any still-'pending' link straight from
//     Stripe, so the till (which doesn't receive the webhook) stays accurate too.

const express = require('express');
const Stripe = require('stripe');
const { pool } = require('../db/dbAdapter');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

function stripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: '2024-06-20' });
}

const publicUrl = () => (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');

// Hard ceiling — mirrors the £1000 cap on online voucher purchases.
const MAX_AMOUNT = 1000;

// POST /api/payment-links  body: { amount, description?, customer_email? }
router.post('/', requireRole('admin', 'manager', 'reception'), async (req, res) => {
  const { amount, description, customer_email } = req.body || {};
  const pounds = Number(amount);
  if (!pounds || pounds <= 0)    return res.status(400).json({ error: 'A positive amount is required' });
  if (pounds > MAX_AMOUNT)       return res.status(400).json({ error: `Amount cannot exceed £${MAX_AMOUNT}` });
  const s = stripe();
  if (!s) return res.status(503).json({ error: 'Stripe is not configured' });

  try {
    // Stripe Checkout sessions expire 30 min – 24 h out; use ~23 h.
    const expiresUnix = Math.floor(Date.now() / 1000) + 23 * 60 * 60;
    const expiresIso = new Date(expiresUnix * 1000).toISOString();
    const session = await s.checkout.sessions.create({
      mode: 'payment',
      expires_at: expiresUnix,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'gbp',
          unit_amount: Math.round(pounds * 100),
          product_data: { name: (description && String(description).slice(0, 250)) || 'SiamEPOS Spa payment' },
        },
      }],
      customer_email: customer_email || undefined,
      metadata: { purpose: 'payment_link' },
      success_url: `${publicUrl()}/pay-thanks?status=paid`,
      cancel_url:  `${publicUrl()}/pay-thanks?status=cancelled`,
    });

    const { rows } = await pool.query(
      `INSERT INTO payment_links
         (purpose, amount, currency, description, status, stripe_session_id, url, customer_email, created_by, expires_at)
       VALUES ('adhoc', $1, 'gbp', $2, 'pending', $3, $4, $5, $6, $7)
       RETURNING *`,
      [pounds, description || null, session.id, session.url, customer_email || null, req.staff?.id || null, expiresIso],
    );
    res.status(201).json({ link: rows[0] });
  } catch (err) {
    console.error('[payment-links] create', err);
    res.status(500).json({ error: err.message || 'server error' });
  }
});

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
          const sess = await s.checkout.sessions.retrieve(link.stripe_session_id);
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
      try { await s.checkout.sessions.expire(link.stripe_session_id); } catch (e) { /* may already be gone */ }
    }
    await pool.query("UPDATE payment_links SET status = 'cancelled' WHERE id = $1 AND status = 'pending'", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[payment-links] cancel', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
