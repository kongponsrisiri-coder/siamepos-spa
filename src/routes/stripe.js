// Stripe integration — full implementation lands in Step 9.
// For now this exposes the create-intent stub and the webhook handler that
// server.js mounts BEFORE express.json() with raw body parsing.

const express = require('express');
const { pool } = require('../db/dbAdapter');

const router = express.Router();
const Stripe = require('stripe');

function stripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: '2024-06-20' });
}

// GET /api/stripe/config — returns the publishable key for the frontend.
router.get('/config', (_req, res) => {
  res.json({
    publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
    configured: !!(process.env.STRIPE_PUBLISHABLE_KEY && process.env.STRIPE_SECRET_KEY),
  });
});

// POST /api/stripe/create-intent  body: { bill_id }
router.post('/create-intent', async (req, res) => {
  const { bill_id } = req.body || {};
  if (!bill_id) return res.status(400).json({ error: 'bill_id required' });
  const s = stripe();
  if (!s) return res.status(503).json({ error: 'stripe not configured' });
  try {
    const { rows } = await pool.query('SELECT * FROM bills WHERE id = $1', [bill_id]);
    const bill = rows[0];
    if (!bill) return res.status(404).json({ error: 'bill not found' });
    const amount = Math.round(Number(bill.total) * 100);
    const intent = await s.paymentIntents.create({
      amount,
      currency: 'gbp',
      automatic_payment_methods: { enabled: true },
      metadata: { bill_id: String(bill.id), appointment_id: String(bill.appointment_id) },
    });
    await pool.query(
      'UPDATE bills SET stripe_payment_intent_id = $2 WHERE id = $1',
      [bill.id, intent.id],
    );
    res.json({ client_secret: intent.client_secret, intent_id: intent.id });
  } catch (err) {
    console.error('[stripe] create-intent', err);
    res.status(500).json({ error: err.message || 'server error' });
  }
});

// Webhook handler — mounted in server.js with express.raw() so req.body is a Buffer.
async function webhookHandler(req, res) {
  const s = stripe();
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s || !secret) return res.status(503).json({ error: 'stripe not configured' });
  let event;
  try {
    event = s.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[stripe] webhook signature failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    // Payment links (SEPOS-SPA-PAYLINK-001) — mark the link paid when its
    // Checkout session completes.
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.id) {
        const { rows } = await pool.query(
          `UPDATE payment_links SET status = 'paid', paid_at = now()
           WHERE stripe_session_id = $1 AND status <> 'paid'
           RETURNING appointment_id, amount`,
          [session.id],
        );
        // A booking deposit link → mark the held appointment paid too.
        const link = rows[0];
        if (link && link.appointment_id) {
          await pool.query(
            `UPDATE appointments
               SET payment_status = 'deposit_paid', deposit_amount = $2, deposit_stripe_id = $3
             WHERE id = $1 AND status NOT IN ('cancelled','no_show')`,
            [link.appointment_id, link.amount, session.payment_intent || null],
          );
        }
      }
    }
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      const billId = intent.metadata?.bill_id;
      if (billId) {
        // SEPOS-SPA-BUGHUNT #3 — verify the amount + be idempotent before marking
        // a bill paid. Previously this flipped payment_status='paid' from the
        // metadata alone, with no amount check (a wrong/partial intent could close
        // a bill) and no idempotency (a duplicate webhook re-ran the side effects).
        const { rows } = await pool.query(
          'SELECT id, total, payment_status, appointment_id FROM bills WHERE id = $1',
          [Number(billId)],
        );
        const bill = rows[0];
        if (!bill) {
          console.warn(`[stripe] payment_intent.succeeded for unknown bill ${billId}`);
        } else if (bill.payment_status === 'paid') {
          // Already settled (duplicate/retried webhook) — no-op.
        } else {
          const expectedPence = Math.round(Number(bill.total) * 100);
          const receivedPence = Number(intent.amount_received || 0);
          if (Math.abs(receivedPence - expectedPence) > 1) {
            // Amount doesn't match the bill total — do NOT close it. Log loudly
            // so it's reconciled manually rather than silently mis-marked paid.
            console.error(`[stripe] amount mismatch bill=${billId}: received ${receivedPence}p, expected ${expectedPence}p — NOT marking paid`);
          } else {
            await pool.query(
              `UPDATE bills SET payment_status = 'paid', payment_method = 'card', closed_at = now()
               WHERE id = $1 AND payment_status != 'paid'`,
              [Number(billId)],
            );
            await pool.query(
              `UPDATE appointments SET status = 'completed'
               WHERE id = $1 AND status NOT IN ('cancelled','no_show')`,
              [Number(bill.appointment_id)],
            );
          }
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] webhook handler', err);
    res.status(500).json({ error: 'server error' });
  }
}

module.exports = { router, webhookHandler };
