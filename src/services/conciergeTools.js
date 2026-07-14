// SPA-WHATSAPP-AI-001 — SiamSpa "tools" for the WhatsApp AI booking concierge.
//
// These are plain service functions the orchestrator (Stage 2) calls directly,
// and which a thin secret-gated HTTP router (routes/concierge.js) also exposes
// so the same tools can be driven from a prototype (Make.com) or tested alone.
//
// THE GOVERNING RULE (from the ticket): the AI only ever acts through these.
//   • getTreatments / getSpaInfo / checkAvailability read REAL data.
//   • holdSlot creates a *pending* booking (status='held') + a Stripe checkout
//     link, and returns it. The booking is confirmed ONLY when Stripe reports
//     payment (the webhook promotes held → booked). No payment details ever
//     touch the chat.
//   • A hold auto-releases after HOLD_TTL minutes (releaseExpiredHolds sweeper),
//     freeing the slot.

const Stripe = require('stripe');
const { pool } = require('../db/dbAdapter');
const { computeAvailability } = require('./availability');

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: '2024-06-20' });
}

const publicUrl = () => (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
const HOLD_TTL_MIN = Math.max(5, Number(process.env.CONCIERGE_HOLD_TTL_MIN || 15));

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  e.code = 'BAD_REQUEST';
  return e;
}

// Deposit policy — identical shape/keys to the widget + payment-links, so a
// concierge hold charges exactly what a website or phone booking would.
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

// ── Tool 1: get_treatments ─────────────────────────────────────────
// Only treatments the spa allows to be booked online. Single-language names
// (the schema has no separate TH column); the AI converses bilingually itself.
async function getTreatments() {
  const { rows } = await pool.query(
    `SELECT id, name, duration_minutes, price, description
       FROM treatments
      WHERE active = TRUE AND online_bookable = TRUE
      ORDER BY name`,
  );
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    duration_min: Number(t.duration_minutes),
    price: Number(t.price),
    description: t.description || null,
  }));
}

// ── Tool 2: get_spa_info ───────────────────────────────────────────
async function getSpaInfo() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings
      WHERE key IN ('spa_name','spa_address','spa_phone','spa_email','opening_time','closing_time')`,
  );
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    name:    s.spa_name    || process.env.SPA_NAME    || 'SiamEPOS Spa',
    address: s.spa_address || process.env.SPA_ADDRESS || null,
    phone:   s.spa_phone   || null,
    email:   s.spa_email   || process.env.SPA_EMAIL   || null,
    opening_hours: (s.opening_time && s.closing_time)
      ? `${s.opening_time}–${s.closing_time} daily`
      : null,
  };
}

// ── Tool 3: check_availability ─────────────────────────────────────
// Returns ONLY real free slots. The AI may offer nothing that isn't here.
async function checkAvailability({ treatment_id, date, therapist_id } = {}) {
  if (!treatment_id || !date) throw badRequest('treatment_id and date (YYYY-MM-DD) are required');
  const slots = await computeAvailability({
    treatment_id: Number(treatment_id),
    date: String(date).slice(0, 10),
    therapist_id: therapist_id ? Number(therapist_id) : null,
  });
  return slots.map((s) => ({
    slot_datetime: s.starts_at,                       // ISO 8601
    therapist_id:  (s.therapists && s.therapists[0]) || null,
  }));
}

// Find-or-create a client from concierge-supplied contact details. Mirrors the
// public /book rule: for an existing match, only FILL BLANKS — never overwrite
// identity from an unauthenticated channel.
async function findOrCreateClient(client, { name, phone, email }) {
  const existing = email
    ? await client.query('SELECT * FROM clients WHERE email = $1 OR phone = $2 ORDER BY id LIMIT 1', [email, phone])
    : await client.query('SELECT * FROM clients WHERE phone = $1 ORDER BY id LIMIT 1', [phone]);
  if (existing.rows[0]) {
    const cli = existing.rows[0];
    await client.query(
      `UPDATE clients SET name = COALESCE(name,$2), phone = COALESCE(phone,$3), email = COALESCE(email,$4)
         WHERE id = $1`,
      [cli.id, name || null, phone || null, email || null],
    );
    return cli;
  }
  const ins = await client.query(
    `INSERT INTO clients (name, phone, email, gdpr_consent, gdpr_consent_at, marketing_consent, source)
     VALUES ($1,$2,$3,TRUE,now(),FALSE,'whatsapp') RETURNING *`,
    [name, phone, email || null],
  );
  return ins.rows[0];
}

// ── Tool 4: hold_slot ──────────────────────────────────────────────
// Creates a pending ('held') booking, locks the slot for HOLD_TTL minutes, and
// (when a deposit is due + Stripe is configured) returns a Stripe checkout URL.
// The booking becomes 'booked' only when the payment webhook fires. If no
// deposit is due (policy 'none') or Stripe isn't set up, the booking is
// confirmed immediately — there's nothing to pay to hold it.
//
// customer = { name, phone, email? }
async function holdSlot({ treatment_id, slot_datetime, customer, therapist_id, notes } = {}) {
  if (!treatment_id || !slot_datetime) throw badRequest('treatment_id and slot_datetime are required');
  if (!customer || !customer.name || !customer.phone) throw badRequest('customer name and phone are required');
  const startsAt = new Date(slot_datetime);
  if (isNaN(startsAt.getTime())) throw badRequest('invalid slot_datetime');
  if (startsAt.getTime() < Date.now()) throw badRequest('cannot hold a slot in the past');

  const isLocal = (process.env.DB_MODE || '').toLowerCase() === 'local';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tr = await client.query(
      'SELECT id, duration_minutes, name, price FROM treatments WHERE id = $1 AND active = TRUE AND online_bookable = TRUE',
      [Number(treatment_id)],
    );
    if (!tr.rows[0]) { await client.query('ROLLBACK'); throw badRequest('This treatment is not available for online booking'); }
    const ends_at = new Date(startsAt.getTime() + tr.rows[0].duration_minutes * 60_000);
    const priceAtBooking = Number(tr.rows[0].price || 0);

    const cli = await findOrCreateClient(client, customer);

    // Confirm the slot is genuinely free, and resolve a therapist + room.
    let therapistId = therapist_id ? Number(therapist_id) : null;
    const av = await computeAvailability({
      treatment_id: Number(treatment_id),
      date: String(slot_datetime).slice(0, 10),
      therapist_id: therapistId,
    });
    const slot = av.find((s) => new Date(s.starts_at).getTime() === startsAt.getTime());
    if (!slot) { await client.query('ROLLBACK'); const e = badRequest('That slot is no longer available'); e.status = 409; throw e; }
    if (!therapistId) therapistId = slot.therapists[0];
    const roomId = slot.rooms[0];

    // Race-safe insert (same advisory-lock keys as /book so the two paths
    // serialise against each other).
    if (!isLocal) {
      if (therapistId) await client.query('SELECT pg_advisory_xact_lock(1, $1)', [Number(therapistId)]);
      if (roomId)      await client.query('SELECT pg_advisory_xact_lock(2, $1)', [Number(roomId)]);
    }

    const holdExpiresAt = new Date(Date.now() + HOLD_TTL_MIN * 60_000);
    const ap = await client.query(
      `INSERT INTO appointments
         (client_id, treatment_id, therapist_id, room_id, starts_at, ends_at,
          status, source, notes, payment_status, price_at_booking, hold_expires_at)
       SELECT $1,$2,$3,$4,$5,$6,'held','whatsapp',$7,'none',$8,$9
       WHERE NOT EXISTS (
         SELECT 1 FROM appointments a
         WHERE a.status NOT IN ('cancelled','no_show')
           AND ( ($3::int IS NOT NULL AND a.therapist_id = $3)
              OR ($4::int IS NOT NULL AND a.room_id      = $4) )
           AND NOT (a.ends_at <= $5 OR a.starts_at >= $6)
       )
       RETURNING *`,
      [cli.id, Number(treatment_id), therapistId, roomId, startsAt.toISOString(), ends_at.toISOString(),
       notes || null, priceAtBooking, holdExpiresAt.toISOString()],
    );
    if (!ap.rows[0]) { await client.query('ROLLBACK'); const e = badRequest('That slot was just taken'); e.status = 409; throw e; }
    const appt = ap.rows[0];

    // Decide payment. Deposit due + Stripe configured → hosted checkout link.
    const policy  = await loadDepositPolicy();
    const deposit = computeDeposit(policy, priceAtBooking);
    const s = stripeClient();

    if (deposit > 0 && s) {
      // Stripe requires the session to live ≥30 min; our shorter hold is
      // enforced by the sweeper, which also expires this session on release.
      const expiresUnix = Math.floor(Date.now() / 1000) + 30 * 60;
      const session = await s.checkout.sessions.create({
        mode: 'payment',
        expires_at: expiresUnix,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'gbp',
            unit_amount: Math.round(deposit * 100),
            product_data: { name: `Deposit — ${tr.rows[0].name}` },
          },
        }],
        customer_email: customer.email || undefined,
        metadata: { purpose: 'deposit', appointment_id: String(appt.id) },
        success_url: `${publicUrl()}/pay-thanks?status=paid`,
        cancel_url:  `${publicUrl()}/pay-thanks?status=cancelled`,
      });
      await client.query(
        `INSERT INTO payment_links
           (purpose, amount, currency, description, status, stripe_session_id, url, customer_email, appointment_id, expires_at)
         VALUES ('deposit',$1,'gbp',$2,'pending',$3,$4,$5,$6,$7)`,
        [deposit, `Deposit — ${tr.rows[0].name}`, session.id, session.url, customer.email || null,
         appt.id, new Date(expiresUnix * 1000).toISOString()],
      );
      await client.query(
        "UPDATE appointments SET payment_status = 'deposit_pending', deposit_amount = $2 WHERE id = $1",
        [appt.id, deposit],
      );
      await client.query('COMMIT');
      return {
        booking_id: appt.id,
        status: 'held',
        confirmed: false,
        checkout_url: session.url,
        deposit_amount: deposit,
        hold_expires_at: holdExpiresAt.toISOString(),
      };
    }

    // No deposit due (or Stripe not configured) → nothing to pay, so the hold
    // is pointless: confirm the booking immediately.
    await client.query(
      "UPDATE appointments SET status = 'booked', hold_expires_at = NULL WHERE id = $1",
      [appt.id],
    );
    await client.query('COMMIT');
    return {
      booking_id: appt.id,
      status: 'booked',
      confirmed: true,
      checkout_url: null,
      deposit_amount: 0,
      hold_expires_at: null,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}

// ── Optional helper: get_booking_status ────────────────────────────
async function getBookingStatus(bookingId) {
  const { rows } = await pool.query(
    `SELECT ap.id, ap.status, ap.payment_status, ap.starts_at, ap.hold_expires_at,
            t.name AS treatment_name
       FROM appointments ap
       LEFT JOIN treatments t ON t.id = ap.treatment_id
      WHERE ap.id = $1`,
    [Number(bookingId)],
  );
  return rows[0] || null;
}

// ── Sweeper: release expired holds ─────────────────────────────────
// Cancels any 'held' booking past its hold_expires_at (freeing the slot in
// availability, which excludes 'cancelled'), and expires the Stripe session so
// a late payment can't confirm a slot we've already released.
async function releaseExpiredHolds() {
  const { rows } = await pool.query(
    `SELECT id FROM appointments WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at < now()`,
  );
  if (!rows.length) return { released: 0 };
  const s = stripeClient();
  let released = 0;
  for (const { id } of rows) {
    try {
      // Expire the still-pending checkout session(s) for this hold first.
      const links = await pool.query(
        "SELECT stripe_session_id FROM payment_links WHERE appointment_id = $1 AND status = 'pending'",
        [id],
      );
      if (s) {
        for (const l of links.rows) {
          if (l.stripe_session_id) { try { await s.checkout.sessions.expire(l.stripe_session_id); } catch (_) { /* may be paid/gone */ } }
        }
      }
      await pool.query(
        "UPDATE payment_links SET status = 'expired' WHERE appointment_id = $1 AND status = 'pending'",
        [id],
      );
      // Only cancel if STILL held (a payment arriving this instant may have
      // promoted it to 'booked' — never cancel a paid booking).
      const upd = await pool.query(
        `UPDATE appointments
           SET status = 'cancelled', payment_status = 'none', hold_expires_at = NULL
         WHERE id = $1 AND status = 'held'
         RETURNING id`,
        [id],
      );
      if (upd.rows[0]) released += 1;
    } catch (err) {
      console.error('[concierge] releaseExpiredHolds', id, err.message);
    }
  }
  if (released) console.log(`[concierge] released ${released} expired hold(s)`);
  return { released };
}

module.exports = {
  getTreatments,
  getSpaInfo,
  checkAvailability,
  holdSlot,
  getBookingStatus,
  releaseExpiredHolds,
  HOLD_TTL_MIN,
};
