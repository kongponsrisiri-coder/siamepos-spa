// SIAMPAY-002 (spa) — one place that decides HOW this tenant takes card
// payments online:
//
//   1. Own Stripe keys (STRIPE_SECRET_KEY set)  → today's behaviour, untouched.
//   2. SiamPay platform mode (no own key, PLATFORM_STRIPE_SECRET_KEY +
//      PLATFORM_STRIPE_PUBLISHABLE_KEY + SIAMPAY_ACCOUNT set) → DIRECT
//      charges on the client's connected account: every Stripe call carries
//      { stripeAccount } request options, money settles to the CLIENT
//      (merchant of record), and PaymentIntents/Checkout Sessions add a flat
//      application_fee_amount (default 10p) deducted from the client's
//      settlement. The customer always pays the quoted price — the fee is
//      never added on top (Korakot's rule, 21 Jul 2026). Never destination
//      charges / transfer_data — Nick's FCA/SEIS hard rule.
//   3. Neither configured → null (callers keep their existing 503 /
//      demo-mode fallbacks).
//
// Call-site conventions (stripe-node quirk that already bit the restaurant
// side): request options must be the LAST argument —
//   gw.s.paymentIntents.create(params, gw.opts)
//   gw.s.paymentIntents.retrieve(id, {}, gw.opts)   ← 3-arg, NOT 2-arg
//   gw.s.refunds.create(params, gw.opts)
// gw.opts is {} in own-keys mode, so the same call shape works for both.
//
// Webhooks: in SiamPay mode, events fire on the CONNECTED account and the
// tenant's own webhook endpoint will NOT receive them. Payment links /
// vouchers already reconcile by polling checkout.sessions.retrieve, and
// deposits verify synchronously at /book — so nothing hard-depends on the
// webhook. A platform-level connect webhook is a later increment.

const Stripe = require('stripe');

function gateway() {
  const own = process.env.STRIPE_SECRET_KEY;
  if (own) {
    return {
      mode: 'own',
      s: new Stripe(own, { apiVersion: '2024-06-20' }),
      opts: {},
      siampay: null,
      pk: process.env.STRIPE_PUBLISHABLE_KEY || null,
      account: null,
      feePence: 0,
    };
  }
  const key     = process.env.PLATFORM_STRIPE_SECRET_KEY;
  const pk      = process.env.PLATFORM_STRIPE_PUBLISHABLE_KEY;
  const account = process.env.SIAMPAY_ACCOUNT;
  if (!key || !pk || !account) return null;
  const feePence = Math.max(0, Math.min(100, Number(process.env.SIAMPAY_FEE_PENCE ?? 10) || 0));
  return {
    mode: 'siampay',
    s: new Stripe(key, { apiVersion: '2024-06-20' }),
    opts: { stripeAccount: account },
    siampay: { account, feePence },
    pk,
    account,
    feePence,
  };
}

// Spread into PaymentIntent create params: adds the flat SiamPay fee in
// platform mode, nothing in own-keys mode.
function piFee(gw) {
  return gw && gw.siampay && gw.feePence > 0 ? { application_fee_amount: gw.feePence } : {};
}

// Same for Checkout Session create params (fee rides inside payment_intent_data).
function sessionFee(gw) {
  return gw && gw.siampay && gw.feePence > 0
    ? { payment_intent_data: { application_fee_amount: gw.feePence } }
    : {};
}

module.exports = { gateway, piFee, sessionFee };
