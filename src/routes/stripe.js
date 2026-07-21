// Stripe integration — full implementation lands in Step 9.
// For now this exposes the create-intent stub and the webhook handler that
// server.js mounts BEFORE express.json() with raw body parsing.

const express = require('express');
const { pool } = require('../db/dbAdapter');
const conciergeOrchestrator = require('../services/conciergeOrchestrator'); // SPA-WHATSAPP-AI-001

const router = express.Router();
const Stripe = require('stripe');

// SIAMPAY-002 — own keys OR SiamPay platform mode (see services/stripeGateway).
// NOTE: the WEBHOOK below stays own-keys-only on purpose — in SiamPay mode
// events fire on the connected account and this endpoint won't receive them;
// payment links reconcile by polling and deposits verify synchronously.
const { gateway, piFee } = require('../services/stripeGateway');
function stripe() {
  return gateway();
}

// GET /api/stripe/config — returns the publishable key for the frontend.
router.get('/config', (_req, res) => {
  const gw = gateway();
  res.json({
    publishable_key: gw ? gw.pk : null,
    configured: !!(gw && gw.pk),
    stripe_account: gw && gw.siampay ? gw.account : undefined, // SIAMPAY-002
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
    const intent = await s.s.paymentIntents.create({
      amount,
      currency: 'gbp',
      automatic_payment_methods: { enabled: true },
      ...piFee(s), // SIAMPAY-002
      metadata: { bill_id: String(bill.id), appointment_id: String(bill.appointment_id) },
    }, s.opts);
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
    event = s.s.webhooks.constructEvent(req.body, sig, secret);
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
        // A booking deposit link → mark the appointment paid. If it was a
        // concierge HOLD (status='held'), payment is what CONFIRMS it, so
        // promote held → booked in the same statement (SPA-WHATSAPP-AI-001).
        const link = rows[0];
        if (link && link.appointment_id) {
          const upd = await pool.query(
            `UPDATE appointments
               SET payment_status = 'deposit_paid',
                   deposit_amount = $2,
                   deposit_stripe_id = $3,
                   status = CASE WHEN status = 'held' THEN 'booked' ELSE status END,
                   hold_expires_at = NULL
             WHERE id = $1 AND status NOT IN ('cancelled','no_show')
             RETURNING id, status`,
            [link.appointment_id, link.amount, session.payment_intent || null],
          );
          // Notify the timeline, and — for a WhatsApp booking that just got
          // paid — send the customer their confirmation on WhatsApp.
          if (upd.rows[0]) {
            req.app?.get('io')?.emit('appointment_confirmed', upd.rows[0]);
            if (upd.rows[0].status === 'booked') {
              conciergeOrchestrator.sendBookingConfirmationWhatsApp(link.appointment_id)
                .catch((e) => console.error('[stripe] whatsapp confirm', e.message));
            }
          }
        }
      }
    }

    // A concierge checkout session that EXPIRED without payment → release the
    // hold so the slot frees up (mirrors the sweeper, driven by Stripe's event).
    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      if (session.id) {
        const { rows } = await pool.query(
          `UPDATE payment_links SET status = 'expired'
             WHERE stripe_session_id = $1 AND status = 'pending'
           RETURNING appointment_id`,
          [session.id],
        );
        const link = rows[0];
        if (link && link.appointment_id) {
          await pool.query(
            `UPDATE appointments SET status = 'cancelled', payment_status = 'none', hold_expires_at = NULL
               WHERE id = $1 AND status = 'held'`,
            [link.appointment_id],
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
