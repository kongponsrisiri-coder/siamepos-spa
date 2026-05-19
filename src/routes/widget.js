// Public booking widget endpoints — NO auth required.
// Mounted at /api/widget/* and excluded from the requireAuth middleware.

const express = require('express');
const { pool } = require('../db/database');
const { computeAvailability } = require('../services/availability');
const { sendBookingConfirmation } = require('../services/emailService');

const router = express.Router();

// GET /api/widget/treatments — public list (active only)
router.get('/treatments', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.duration_minutes, t.price, t.description,
             c.id AS category_id, c.name AS category_name, c.sort_order
      FROM treatments t
      LEFT JOIN treatment_categories c ON c.id = t.category_id
      WHERE t.active = TRUE
      ORDER BY c.sort_order NULLS LAST, c.name NULLS LAST, t.name
    `);
    res.json({ treatments: rows });
  } catch (err) {
    console.error('[widget] treatments', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/widget/therapists — public list (active only).
// Returns the bare minimum the customer needs to pick a therapist.
router.get('/therapists', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, specialisms
       FROM therapists
       WHERE active = TRUE
       ORDER BY name`,
    );
    res.json({ therapists: rows });
  } catch (err) {
    console.error('[widget] therapists', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/widget/availability?treatment_id=&date=YYYY-MM-DD&therapist_id=(optional)
router.get('/availability', async (req, res) => {
  const { treatment_id, date, therapist_id } = req.query;
  if (!treatment_id || !date) {
    return res.status(400).json({ error: 'treatment_id + date required' });
  }
  try {
    const slots = await computeAvailability({
      treatment_id: Number(treatment_id),
      date,
      therapist_id: therapist_id ? Number(therapist_id) : null,
    });
    // Public output is leaner: don't expose internal therapist/room IDs.
    res.json({ slots: slots.map((s) => ({ starts_at: s.starts_at, ends_at: s.ends_at })) });
  } catch (err) {
    console.error('[widget] availability', err);
    res.status(400).json({ error: err.message || 'server error' });
  }
});

// POST /api/widget/book
// body: { treatment_id, starts_at, therapist_id?, name, phone, email?, gdpr_consent, marketing_consent?, notes? }
router.post('/book', async (req, res) => {
  const b = req.body || {};
  const required = ['treatment_id', 'starts_at', 'name', 'phone'];
  for (const k of required) if (!b[k]) return res.status(400).json({ error: `${k} required` });
  if (!b.gdpr_consent) return res.status(400).json({ error: 'gdpr_consent required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Treatment duration.
    const tr = await client.query(
      'SELECT id, duration_minutes, name FROM treatments WHERE id = $1 AND active = TRUE',
      [b.treatment_id],
    );
    if (!tr.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'treatment not found' }); }
    const ends_at = new Date(new Date(b.starts_at).getTime() + tr.rows[0].duration_minutes * 60_000);

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
      await client.query(
        `UPDATE clients SET
           name = COALESCE($2, name),
           phone = COALESCE($3, phone),
           email = COALESCE($4, email),
           gdpr_consent = TRUE,
           gdpr_consent_at = COALESCE(gdpr_consent_at, now()),
           marketing_consent = clients.marketing_consent OR $5
         WHERE id = $1`,
        [cli.id, b.name, b.phone, b.email || null, !!b.marketing_consent],
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
         (client_id, treatment_id, therapist_id, room_id, starts_at, ends_at, status, source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,'booked','online',$7)
       RETURNING *`,
      [cli.id, b.treatment_id, therapist_id, room_id, b.starts_at, ends_at, b.notes || null],
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

    // Fire-and-forget side effects after commit so the booking isn't lost
    // if the email service is down.
    const policy = (await pool.query(
      `SELECT value FROM settings WHERE key = 'cancellation_policy_text'`,
    )).rows[0]?.value;
    req.app.get('io')?.emit('new_appointment', ap.rows[0]);
    if (cli.email) {
      sendBookingConfirmation({
        client: cli,
        appointment: ap.rows[0],
        treatment: tr.rows[0],
        cancellationPolicy: policy,
      }).catch((e) => console.error('[widget] email send failed', e));
    }

    res.status(201).json({
      appointment: {
        id: ap.rows[0].id,
        starts_at: ap.rows[0].starts_at,
        ends_at: ap.rows[0].ends_at,
        therapist_name: named.rows[0]?.therapist_name || null,
        room_name: named.rows[0]?.room_name || null,
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

module.exports = router;
