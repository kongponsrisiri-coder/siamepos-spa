// Public booking widget endpoints — NO auth required.
// Mounted at /api/widget/* and excluded from the requireAuth middleware.

const express = require('express');
const Stripe = require('stripe');
const { pool } = require('../db/dbAdapter');
const { computeAvailability, getTherapistWorkingWindow, londonDateString } = require('../services/availability');
const { sendBookingConfirmation, sendVoucherGiftEmail, sendOwnerNewBookingEmail } = require('../services/emailService');

const router = express.Router();

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: '2024-06-20' });
}

// Load the spa's deposit + cancellation policy from settings, with sensible
// defaults if the operator hasn't set anything yet.
async function loadDepositPolicy() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE key IN
       ('deposit_model','deposit_amount','deposit_percentage','cancel_window_hours','cancel_policy_text')`,
  );
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    deposit_model:        s.deposit_model        || 'fixed_amount',     // 'none' | 'fixed_amount' | 'percentage' | 'full_prepay'
    deposit_amount:       Number(s.deposit_amount || 25),
    deposit_percentage:   Number(s.deposit_percentage || 25),
    cancel_window_hours:  Number(s.cancel_window_hours || 24),
    cancel_policy_text:   s.cancel_policy_text   || '',
  };
}

// Given a treatment price and policy, compute the deposit £ amount.
function computeDeposit(policy, treatmentPrice) {
  const price = Number(treatmentPrice || 0);
  if (policy.deposit_model === 'none')        return 0;
  if (policy.deposit_model === 'full_prepay') return +price.toFixed(2);
  if (policy.deposit_model === 'percentage')  return +((price * policy.deposit_percentage) / 100).toFixed(2);
  return +Math.min(policy.deposit_amount, price).toFixed(2); // fixed_amount (default)
}

// GET /api/widget/treatments — public list. Only treatments that are
// BOTH active=TRUE (not hidden) AND online_bookable=TRUE (operator
// opted to show them online). The admin booking flow keeps the full
// list — this filter applies to the public widget only.
router.get('/treatments', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.duration_minutes, t.price, t.description,
             c.id AS category_id, c.name AS category_name, c.sort_order
      FROM treatments t
      LEFT JOIN treatment_categories c ON c.id = t.category_id
      WHERE t.active = TRUE AND t.online_bookable = TRUE
      ORDER BY c.sort_order NULLS LAST, c.name NULLS LAST, t.name
    `);
    res.json({ treatments: rows });
  } catch (err) {
    console.error('[widget] treatments', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/widget/therapists — public list (active only).
//   ?date=YYYY-MM-DD — restrict to therapists ACTUALLY ON SHIFT that
//                      date (weekly_rota + per-date overrides). Used by
//                      the booking widget so the customer can only pick
//                      from people who are working on their chosen day.
// Filters to role='therapist' so the public widget never shows admin /
// manager / reception staff as bookable practitioners.
router.get('/therapists', async (req, res) => {
  const { date } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, specialisms, photo_url
       FROM therapists
       WHERE active = TRUE AND role = 'therapist'
       ORDER BY name`,
    );
    if (!date) return res.json({ therapists: rows });

    // Filter by working window on the given date.
    const working = [];
    for (const t of rows) {
      const win = await getTherapistWorkingWindow(t.id, date);
      if (win) {
        const sh = new Date(win.start).toISOString();
        const eh = new Date(win.end).toISOString();
        working.push({ ...t, work_start: sh, work_end: eh });
      }
    }
    res.json({ therapists: working });
  } catch (err) {
    console.error('[widget] therapists', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/widget/availability?treatment_id=&date=YYYY-MM-DD&therapist_id=(optional)
//
// Public widget — strips out slots that have already started so the
// customer can't book a time that's in the past. Admin's equivalent
// endpoint (/api/appointments/availability) keeps the full list since
// receptionists sometimes need to record a walk-in whose treatment
// actually started a few minutes ago.
router.get('/availability', async (req, res) => {
  const { treatment_id, date, therapist_id } = req.query;
  if (!treatment_id || !date) {
    return res.status(400).json({ error: 'treatment_id + date required' });
  }
  try {
    // online_bookable guard — don't compute/expose slots for a treatment the
    // operator has marked in-store-only (also blocked at /book + /payment-intent).
    const tr = await pool.query(
      'SELECT id FROM treatments WHERE id = $1 AND active = TRUE AND online_bookable = TRUE',
      [Number(treatment_id)],
    );
    if (!tr.rows[0]) return res.status(400).json({ error: 'This treatment isn’t available for online booking' });
    const slots = await computeAvailability({
      treatment_id: Number(treatment_id),
      date,
      therapist_id: therapist_id ? Number(therapist_id) : null,
    });
    // SPA-NO-PAST — drop slots whose start time is in the past.
    // A small lead-time buffer prevents "book a slot starting in 2
    // minutes" — the spa needs time to prepare a room. 30 min default.
    const leadTimeMinMs = 30 * 60 * 1000;
    const earliest = Date.now() + leadTimeMinMs;
    const filtered = slots.filter((s) => new Date(s.starts_at).getTime() >= earliest);
    // Public output is leaner: don't expose internal therapist/room IDs.
    res.json({ slots: filtered.map((s) => ({ starts_at: s.starts_at, ends_at: s.ends_at })) });
  } catch (err) {
    console.error('[widget] availability', err);
    res.status(400).json({ error: err.message || 'server error' });
  }
});

// GET /api/widget/stripe-config
// Public — returns the publishable key + deposit policy so the widget
// can show "Pay £25 deposit" and load Stripe Elements.
router.get('/stripe-config', async (_req, res) => {
  try {
    const policy = await loadDepositPolicy();
    res.json({
      publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
      configured:      !!(process.env.STRIPE_PUBLISHABLE_KEY && process.env.STRIPE_SECRET_KEY),
      policy,
    });
  } catch (err) {
    console.error('[widget] stripe-config', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/widget/payment-intent
// body: { treatment_id, starts_at, email? }
// Creates a Stripe PaymentIntent for the deposit on a quoted booking.
// The appointment is NOT created here — only after the payment confirms
// the widget calls POST /book with the payment_intent_id. So an
// abandoned payment never leaves a phantom appointment.
router.post('/payment-intent', async (req, res) => {
  const b = req.body || {};
  if (!b.treatment_id || !b.starts_at) {
    return res.status(400).json({ error: 'treatment_id + starts_at required' });
  }
  const s = stripeClient();
  if (!s) return res.status(503).json({ error: 'stripe not configured' });
  try {
    // online_bookable guard — an in-store-only treatment is hidden from the
    // public list, but must ALSO be un-bookable here (stops a stale deep-link
    // or hand-typed id from taking a deposit for it).
    const tr = await pool.query(
      'SELECT id, name, price FROM treatments WHERE id = $1 AND active = TRUE AND online_bookable = TRUE',
      [b.treatment_id],
    );
    if (!tr.rows[0]) return res.status(400).json({ error: 'This treatment isn’t available for online booking' });
    const policy = await loadDepositPolicy();
    const deposit = computeDeposit(policy, tr.rows[0].price);
    if (deposit <= 0) {
      // Policy says no deposit — the widget should call /book directly.
      return res.json({ deposit_amount: 0, skip_payment: true });
    }
    const intent = await s.paymentIntents.create({
      amount: Math.round(deposit * 100),
      currency: 'gbp',
      automatic_payment_methods: { enabled: true },
      receipt_email: b.email || undefined,
      metadata: {
        purpose: 'spa_deposit',
        treatment_id: String(b.treatment_id),
        treatment_name: String(tr.rows[0].name || ''),
        starts_at: String(b.starts_at),
      },
    });
    res.json({
      client_secret:  intent.client_secret,
      intent_id:      intent.id,
      deposit_amount: deposit,
      total_amount:   Number(tr.rows[0].price),
    });
  } catch (err) {
    console.error('[widget] payment-intent', err);
    res.status(500).json({ error: err.message || 'server error' });
  }
});

// POST /api/widget/book
// body: { treatment_id, starts_at, therapist_id?, name, phone, email?,
//         gdpr_consent, marketing_consent?, notes?, payment_intent_id? }
// payment_intent_id is required when the deposit policy says one is due.
// We verify with Stripe that the PI is in 'succeeded' state before
// creating the appointment — guarantees no appointment without payment.
router.post('/book', async (req, res) => {
  const b = req.body || {};
  const required = ['treatment_id', 'starts_at', 'name', 'phone'];
  for (const k of required) if (!b[k]) return res.status(400).json({ error: `${k} required` });
  if (!b.gdpr_consent) return res.status(400).json({ error: 'gdpr_consent required' });

  // ── No past-date bookings ─────────────────────────────────────────
  // Compare in Europe/London since the spa runs UK hours. We allow
  // bookings later TODAY (e.g. customer books a same-day slot) but
  // reject anything before now. Both client (widget min=today) and
  // server enforce, defence in depth.
  const startsAt = new Date(b.starts_at);
  if (isNaN(startsAt.getTime())) {
    return res.status(400).json({ error: 'invalid starts_at' });
  }
  if (startsAt.getTime() < Date.now()) {
    return res.status(400).json({ error: 'cannot book in the past' });
  }

  // ── Verify deposit payment up-front if policy requires one ────────
  // We do this BEFORE opening the DB transaction so a failed payment
  // can't leave a partial appointment row anywhere.
  //
  // Graceful degradation: if the spa hasn't yet configured Stripe
  // (STRIPE_SECRET_KEY missing on the server) we silently skip the
  // deposit check — the widget already skips its own payment step in
  // the same case (client checks /stripe-config configured=false), so
  // without this guard the two sides disagree and every online booking
  // bounces with "payment_intent_id required (deposit due)".
  // The spa loses the no-show safety net for online bookings until
  // they configure Stripe, but bookings still flow.
  const policy = await loadDepositPolicy();
  let depositAmount = 0;
  let depositStripeId = null;
  const s = stripeClient();
  if (policy.deposit_model !== 'none' && s) {
    const tr0 = await pool.query('SELECT price FROM treatments WHERE id = $1', [b.treatment_id]);
    depositAmount = computeDeposit(policy, tr0.rows[0]?.price);
    if (depositAmount > 0) {
      if (!b.payment_intent_id) return res.status(400).json({ error: 'payment_intent_id required (deposit due)' });
      let intent;
      try { intent = await s.paymentIntents.retrieve(b.payment_intent_id); }
      catch (err) { return res.status(400).json({ error: 'invalid payment_intent_id' }); }
      if (intent.status !== 'succeeded') {
        return res.status(402).json({ error: 'deposit payment not completed', stripe_status: intent.status });
      }
      // Defend against amount tampering — Stripe is the source of truth.
      depositAmount = +(intent.amount_received / 100).toFixed(2);
      depositStripeId = intent.id;
    }
  }
  if (policy.deposit_model !== 'none' && !s) {
    console.warn('[widget] /book: deposit policy set but Stripe not configured — booking through without deposit');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Treatment duration + snapshot the current price so this booking
    // locks in the quoted amount even if the treatment's price is
    // edited later.
    const tr = await client.query(
      'SELECT id, duration_minutes, name, price FROM treatments WHERE id = $1 AND active = TRUE AND online_bookable = TRUE',
      [b.treatment_id],
    );
    if (!tr.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This treatment isn’t available for online booking' }); }
    const ends_at = new Date(new Date(b.starts_at).getTime() + tr.rows[0].duration_minutes * 60_000);
    const priceAtBooking = Number(tr.rows[0].price || 0);

    // Find or create client. Match by email if given, otherwise by phone.
    let cli;
    const existing = b.email
      ? await client.query(
          `SELECT * FROM clients WHERE email = $1 OR phone = $2 ORDER BY id LIMIT 1`,
          [b.email, b.phone],
        )
      : await client.query(
          `SELECT * FROM clients WHERE phone = $1 ORDER BY id LIMIT 1`,
          [b.phone],
        );
    if (existing.rows[0]) {
      cli = existing.rows[0];
      // SEPOS-SPA-BUGHUNT M4 — this is an UNAUTHENTICATED public endpoint that
      // matches an existing client by email OR phone. Previously it OVERWROTE the
      // matched client's name/phone/email with the submitter's values and
      // force-set gdpr_consent — so anyone who knew a victim's email could tamper
      // with their profile and false-stamp consent. Now we only FILL BLANKS
      // (COALESCE existing-first) and never alter identity or consent flags on an
      // existing record from the public widget; staff edit those in the back office.
      await client.query(
        `UPDATE clients SET
           name  = COALESCE(name,  $2),
           phone = COALESCE(phone, $3),
           email = COALESCE(email, $4)
         WHERE id = $1`,
        [cli.id, b.name || null, b.phone || null, b.email || null],
      );
    } else {
      const ins = await client.query(
        `INSERT INTO clients (name, phone, email, gdpr_consent, gdpr_consent_at, marketing_consent)
         VALUES ($1, $2, $3, TRUE, now(), $4)
         RETURNING *`,
        [b.name, b.phone, b.email || null, !!b.marketing_consent],
      );
      cli = ins.rows[0];
    }

    // Pick a free therapist + room. If a therapist was requested, honour it
    // (computeAvailability will only return slots where that therapist is free).
    let therapist_id = b.therapist_id ? Number(b.therapist_id) : null;
    const av = await computeAvailability({
      treatment_id: b.treatment_id,
      date: String(b.starts_at).slice(0, 10),
      therapist_id,
    });
    const slot = av.find((s) => new Date(s.starts_at).getTime() === new Date(b.starts_at).getTime());
    if (!slot) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'slot no longer available' }); }
    if (!therapist_id) therapist_id = slot.therapists[0];
    const room_id = slot.rooms[0];

    const ap = await client.query(
      `INSERT INTO appointments
         (client_id, treatment_id, therapist_id, room_id, starts_at, ends_at,
          status, source, notes,
          deposit_amount, deposit_stripe_id, payment_status,
          price_at_booking)
       VALUES ($1,$2,$3,$4,$5,$6,'booked','online',$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        cli.id, b.treatment_id, therapist_id, room_id, b.starts_at, ends_at, b.notes || null,
        depositAmount > 0 ? depositAmount : null,
        depositStripeId,
        depositAmount > 0 ? 'deposit_paid' : 'none',
        priceAtBooking,
      ],
    );

    // Look up the names the widget renders on the confirmation card.
    const named = await client.query(
      `SELECT th.name AS therapist_name, r.name AS room_name
       FROM therapists th
       LEFT JOIN rooms r ON r.id = $2
       WHERE th.id = $1`,
      [therapist_id, room_id],
    );

    await client.query('COMMIT');

    // Fire-and-forget side effects after commit.
    req.app.get('io')?.emit('new_appointment', ap.rows[0]);
    if (cli.email) {
      sendBookingConfirmation({
        client:        cli,
        appointment:   ap.rows[0],
        treatment:     tr.rows[0],
        therapistName: named.rows[0]?.therapist_name,
        roomName:      named.rows[0]?.room_name,
        depositAmount,
        totalAmount:   Number(tr.rows[0].price),
        cancellationPolicy: policy.cancel_policy_text,
      }).catch((e) => console.error('[widget] email send failed', e));
    }
    // SPA-OWNER-NOTIFY — alert the spa owner of every new booking.
    sendOwnerNewBookingEmail({
      appointment:   ap.rows[0],
      client:        cli,
      treatment:     tr.rows[0],
      therapistName: named.rows[0]?.therapist_name,
      source:        'online',
    }).catch((e) => console.error('[widget] owner notify failed', e));

    res.status(201).json({
      appointment: {
        id: ap.rows[0].id,
        starts_at: ap.rows[0].starts_at,
        ends_at: ap.rows[0].ends_at,
        therapist_name: named.rows[0]?.therapist_name || null,
        room_name: named.rows[0]?.room_name || null,
        deposit_amount: depositAmount,
        total_amount: Number(tr.rows[0].price),
        balance_due: +(Number(tr.rows[0].price) - depositAmount).toFixed(2),
      },
      client: { id: cli.id, name: cli.name },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[widget] book', err);
    res.status(500).json({ error: 'server error' });
  } finally {
    client.release();
  }
});

// POST /api/widget/vouchers
// Public endpoint — called by the Baan Siam website voucher widget.
// Creates a voucher record for online purchases (payment_method always 'card').
// body: { value, purchased_by, purchased_for, recipient_email, message?,
//          treatment_id?, treatment_name? }
// SPA-SEC-001 — hard ceiling on an online voucher so a tampered request
// can't mint an absurd balance even on a Stripe-less demo install.
const MAX_ONLINE_VOUCHER = 1000;

router.post('/vouchers', async (req, res) => {
  const { value, purchased_by, purchased_for, recipient_email, message, treatment_id, payment_intent_id } = req.body || {};
  if (!value || Number(value) <= 0) return res.status(400).json({ error: 'value required' });
  if (Number(value) > MAX_ONLINE_VOUCHER) {
    return res.status(400).json({ error: `online vouchers are capped at £${MAX_ONLINE_VOUCHER}` });
  }

  // SPA-SEC-001 — a voucher is 100% pre-paid value redeemable at the till,
  // so unlike a booking deposit it MUST be backed by a real payment when the
  // spa has Stripe configured. Mirror /book's deposit verification: require a
  // succeeded PaymentIntent and take the voucher value from Stripe's
  // amount_received (never the client-sent value). When Stripe is NOT
  // configured (demo / pre-go-live) we fall back to the client value so the
  // mock-pay demo widget still works — exactly the same trade-off as /book.
  let voucherValue = Number(value);
  const sv = stripeClient();
  if (sv) {
    if (!payment_intent_id) {
      return res.status(400).json({ error: 'payment_intent_id required — voucher must be paid for' });
    }
    let intent;
    try { intent = await sv.paymentIntents.retrieve(payment_intent_id); }
    catch (err) { return res.status(400).json({ error: 'invalid payment_intent_id' }); }
    if (intent.status !== 'succeeded') {
      return res.status(402).json({ error: 'voucher payment not completed', stripe_status: intent.status });
    }
    // Reject a PaymentIntent that's already been used for another voucher.
    const used = await pool.query('SELECT id FROM vouchers WHERE stripe_payment_intent_id = $1', [intent.id]);
    if (used.rows[0]) return res.status(409).json({ error: 'this payment has already been used for a voucher' });
    voucherValue = +(intent.amount_received / 100).toFixed(2);
    if (voucherValue <= 0) return res.status(402).json({ error: 'voucher payment captured £0' });
  }
  const stripeIntentId = sv ? payment_intent_id : null;

  // Generate unique code (SPA-XXXXXXXX)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  for (let i = 0; i < 10; i++) {
    let c = 'SPA-';
    for (let j = 0; j < 8; j++) c += chars[Math.floor(Math.random() * chars.length)];
    const exists = await pool.query('SELECT id FROM vouchers WHERE code = $1', [c]);
    if (!exists.rows[0]) { code = c; break; }
  }
  if (!code) return res.status(500).json({ error: 'Could not generate unique code' });

  // Expiry = 1 year from today
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 1);
  const expiresAt = expires.toISOString().slice(0, 10);

  try {
    const { rows } = await pool.query(
      `INSERT INTO vouchers
         (code, initial_value, remaining_value, purchased_by, purchased_for,
          recipient_email, payment_method, notes, expires_at, treatment_id,
          stripe_payment_intent_id)
       VALUES ($1,$2,$2,$3,$4,$5,'card',$6,$7,$8,$9) RETURNING *`,
      [
        code,
        voucherValue,
        purchased_by  || null,
        purchased_for || null,
        recipient_email || null,
        message       || null,
        expiresAt,
        treatment_id  ? Number(treatment_id) : null,
        stripeIntentId,
      ],
    );
    const voucher = rows[0];

    // Fire-and-forget gift email
    if (voucher.recipient_email) {
      const tName = treatment_id
        ? (await pool.query('SELECT name FROM treatments WHERE id = $1', [Number(treatment_id)])).rows[0]?.name
        : null;
      sendVoucherGiftEmail({ voucher, treatment_name: tName })
        .then(async (r) => {
          if (r && r.ok) {
            await pool.query('UPDATE vouchers SET email_sent_at = now() WHERE id = $1', [voucher.id]);
          }
        })
        .catch((e) => console.error('[widget/vouchers] email failed', e));
    }

    res.status(201).json({ voucher });
  } catch (err) {
    console.error('[widget/vouchers] create', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
