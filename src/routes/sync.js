// SiamEPOS Spa — cloud → local sync feed (read-only "pull" endpoints).
//
// A desktop install (Electron, offline-capable) polls these endpoints to
// mirror the cloud Postgres DB into its local encrypted SQLite DB so the
// till keeps working when the internet drops. Everything here is READ-ONLY:
// the till never pushes through this router (writes go through the normal
// /api routes when online, queued otherwise).
//
// SECURITY GATE
// -------------
// This feed deliberately exposes data the public API never does:
//   • therapists.pin — so the offline till can authenticate staff with no
//     cloud round-trip (the public /api/therapists omits the pin).
//   • clients + client_medical — the full medical questionnaire (a UK legal
//     requirement for massage). The local SQLite DB is encrypted at rest and
//     this feed is gated behind a shared secret, so carrying the full
//     medical record to the till is acceptable.
// Because of that, EVERY route in this router is gated by the SYNC_SECRET
// shared secret (sent in the `x-sync-secret` header). If SYNC_SECRET is
// unset on the cloud, or the header doesn't match, every request 401s and
// no data leaves the building. SYNC_SECRET must be set in the cloud Railway
// env (and matched in each desktop install's config) for sync to work.
//
// OS-agnostic: nothing here references a specific operating system — the
// desktop shell runs on both Mac and Windows.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool } = require('../db/dbAdapter');

// ---------------------------------------------------------------------------
// Gate middleware — applied to ALL routes below via router.use(gate).
// Reads the x-sync-secret header and compares it (constant-time) to
// process.env.SYNC_SECRET. If the env var is unset/empty the whole feed is
// considered disabled and every request 401s.
// ---------------------------------------------------------------------------
function gate(req, res, next) {
  const secret = process.env.SYNC_SECRET || '';
  if (!secret) {
    // Feature off: no secret configured on the cloud → nothing syncs.
    return res.status(401).json({ error: 'sync disabled or bad secret' });
  }
  const provided = req.get('x-sync-secret') || '';

  // Constant-time compare. timingSafeEqual throws if the buffers differ in
  // length, so guard the length first (and still do a dummy compare to keep
  // timing uniform). A plain === would also be acceptable per the spec.
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    return res.status(401).json({ error: 'sync disabled or bad secret' });
  }
  return next();
}
router.use(gate);

// ---------------------------------------------------------------------------
// GET /config
// Cloud-authoritative CONFIG tables the till needs to function offline.
// These are small, change rarely, and are pulled in full every time.
// NOTE: therapists includes the `pin` column on purpose — see the security
// note at the top of this file (offline staff auth).
// ---------------------------------------------------------------------------
router.get('/config', async (_req, res) => {
  try {
    const [
      treatmentCategories,
      treatments,
      therapists,
      therapistAvailability,
      therapistRotaOverrides,
      rooms,
      settings,
    ] = await Promise.all([
      pool.query(`SELECT * FROM treatment_categories ORDER BY sort_order, id`),
      pool.query(`SELECT * FROM treatments ORDER BY id`),
      // SELECT * intentionally includes therapists.pin for offline auth.
      pool.query(`SELECT * FROM therapists ORDER BY id`),
      pool.query(`SELECT * FROM therapist_availability ORDER BY therapist_id, day_of_week`),
      pool.query(`SELECT * FROM therapist_rota_overrides ORDER BY therapist_id, date`),
      pool.query(`SELECT * FROM rooms ORDER BY id`),
      pool.query(`SELECT key, value FROM settings ORDER BY key`),
    ]);

    res.json({
      treatment_categories:     treatmentCategories.rows,
      treatments:               treatments.rows,
      therapists:               therapists.rows,
      therapist_availability:   therapistAvailability.rows,
      therapist_rota_overrides: therapistRotaOverrides.rows,
      rooms:                    rooms.rows,
      settings:                 settings.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /clients[?since=<ISO>]
// The full client directory + medical questionnaires. Carries sensitive
// medical data — only reachable through the secret gate (see top of file).
// Optional ?since filters clients by created_at and medical rows by
// updated_at, so a delta pull only ships rows touched since the last sync.
// Omit ?since (or pass a bad value) to get everything.
// ---------------------------------------------------------------------------
router.get('/clients', async (req, res) => {
  try {
    const since = req.query.since;
    const hasSince = !!since && !Number.isNaN(Date.parse(since));

    let clients;
    let clientMedical;
    if (hasSince) {
      clients = await pool.query(
        `SELECT * FROM clients WHERE created_at >= $1 ORDER BY id`,
        [since],
      );
      clientMedical = await pool.query(
        `SELECT * FROM client_medical WHERE updated_at >= $1 ORDER BY id`,
        [since],
      );
    } else {
      clients = await pool.query(`SELECT * FROM clients ORDER BY id`);
      clientMedical = await pool.query(`SELECT * FROM client_medical ORDER BY id`);
    }

    res.json({
      clients:        clients.rows,
      client_medical: clientMedical.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /appointments[?from=<ISO>&to=<ISO>]
// Appointments whose starts_at falls in [from, to], plus the amendment
// audit-log rows for those appointments. Default window when params are
// omitted: now-7days .. now+30days (recent history + upcoming bookings).
// ---------------------------------------------------------------------------
router.get('/appointments', async (req, res) => {
  try {
    const now = Date.now();
    const from = (req.query.from && !Number.isNaN(Date.parse(req.query.from)))
      ? new Date(req.query.from).toISOString()
      : new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = (req.query.to && !Number.isNaN(Date.parse(req.query.to)))
      ? new Date(req.query.to).toISOString()
      : new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();

    const appointments = await pool.query(
      `SELECT * FROM appointments
        WHERE starts_at >= $1 AND starts_at <= $2
        ORDER BY starts_at`,
      [from, to],
    );

    // Amendments only for the appointments we're returning.
    const ids = appointments.rows.map((r) => r.id);
    let amendments = { rows: [] };
    if (ids.length > 0) {
      amendments = await pool.query(
        `SELECT * FROM appointment_amendments
          WHERE appointment_id = ANY($1::int[])
          ORDER BY id`,
        [ids],
      );
    }

    res.json({
      appointments:           appointments.rows,
      appointment_amendments: amendments.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /bills[?since=<ISO>&limit=500]
// Closed-bill history, paginated by a cursor on closed_at (mirrors the
// restaurant EPOS closed-orders cursor pattern). NULL closed_at sorts as
// the epoch so still-open bills (rare in this feed) lead the page. The
// caller pages forward by passing max_cursor back as ?since until
// has_more is false. bill_items are returned for the page's bills only.
// ---------------------------------------------------------------------------
router.get('/bills', async (req, res) => {
  try {
    const since = (req.query.since && !Number.isNaN(Date.parse(req.query.since)))
      ? new Date(req.query.since).toISOString()
      : '1970-01-01T00:00:00.000Z';
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 500;
    if (limit > 1000) limit = 1000; // hard ceiling so one call can't pull everything

    // Pull limit+1 to detect whether another page exists without a COUNT.
    const bills = await pool.query(
      `SELECT * FROM bills
        WHERE COALESCE(closed_at, '1970-01-01'::timestamptz) >= $1
        ORDER BY COALESCE(closed_at, '1970-01-01'::timestamptz) ASC, id ASC
        LIMIT $2`,
      [since, limit + 1],
    );

    const hasMore = bills.rows.length > limit;
    const page = hasMore ? bills.rows.slice(0, limit) : bills.rows;

    // Cursor for the next page = closed_at of the last row in this page.
    let maxCursor = null;
    if (page.length > 0) {
      const last = page[page.length - 1];
      maxCursor = last.closed_at || '1970-01-01T00:00:00.000Z';
    }

    // bill_items for the bills in this page only.
    const billIds = page.map((b) => b.id);
    let billItems = { rows: [] };
    if (billIds.length > 0) {
      billItems = await pool.query(
        `SELECT * FROM bill_items
          WHERE bill_id = ANY($1::int[])
          ORDER BY bill_id, id`,
        [billIds],
      );
    }

    res.json({
      bills:      page,
      bill_items: billItems.rows,
      max_cursor: maxCursor,
      has_more:   hasMore,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /vouchers
// All active gift vouchers plus their redemption history. The till needs
// these to redeem a voucher offline (check remaining balance / sessions).
// Redemptions are scoped to the active vouchers we return.
// ---------------------------------------------------------------------------
router.get('/vouchers', async (_req, res) => {
  try {
    const vouchers = await pool.query(
      `SELECT * FROM vouchers WHERE status = 'active' ORDER BY id`,
    );

    const voucherIds = vouchers.rows.map((v) => v.id);
    let redemptions = { rows: [] };
    if (voucherIds.length > 0) {
      redemptions = await pool.query(
        `SELECT * FROM voucher_redemptions
          WHERE voucher_id = ANY($1::int[])
          ORDER BY voucher_id, id`,
        [voucherIds],
      );
    }

    res.json({
      vouchers:            vouchers.rows,
      voucher_redemptions: redemptions.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
