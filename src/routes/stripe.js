// Stripe integration — full implementation lands in Step 9.
// For now this exposes the create-intent stub and the webhook handler that
// server.js mounts BEFORE express.json() with raw body parsing.

const express = require('express');
const { pool } = require('../db/database');

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
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      const billId = intent.metadata?.bill_id;
      if (billId) {
        await pool.query(
          `UPDATE bills SET payment_status = 'paid', payment_method = 'card', closed_at = now()
           WHERE id = $1`,
          [Number(billId)],
        );
        await pool.query(
          `UPDATE appointments SET status = 'completed'
           WHERE id = (SELECT appointment_id FROM bills WHERE id = $1)
             AND status NOT IN ('cancelled','no_show')`,
          [Number(billId)],
        );
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] webhook handler', err);
    res.status(500).json({ error: 'server error' });
  }
}

module.exports = { router, webhookHandler };
