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
        // SEPOS-SPA-BUGHUNT H5 — was created_at, which never re-ships edited
        // clients (created_at doesn't move on UPDATE). updated_at is bumped by a
        // trigger on every edit, so the delta now ships both new AND changed rows.
        `SELECT * FROM clients WHERE updated_at >= $1 ORDER BY id`,
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

    // Server-side delta cursor: the greatest updated_at across the rows we're
    // shipping (clients + client_medical), so the till advances its cursor to
    // real data instead of its own wall clock (which silently dropped rows).
    // When nothing changed, fall back to the request's prior `since` so the
    // cursor never moves backwards (and stays null on a full, since-less pull).
    let maxCursor = hasSince ? new Date(since).toISOString() : null;
    for (const row of [...clients.rows, ...clientMedical.rows]) {
      // clients are filtered by created_at, client_medical by updated_at — use
      // whichever the row has so the cursor advances for both streams (the
      // clients table has no updated_at column).
      const ts = row.updated_at != null ? row.updated_at : row.created_at;
      if (ts == null) continue;
      const iso = new Date(ts).toISOString();
      if (maxCursor == null || iso > maxCursor) maxCursor = iso;
    }

    res.json({
      clients:        clients.rows,
      client_medical: clientMedical.rows,
      max_cursor:     maxCursor,
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

// GET /deletions?since=<ISO> — GDPR erasure tombstones since the cursor, so a
// desktop till can wipe locally-held copies of records erased on the cloud (or
// on another till). Returns { deletions:[{entity,cloud_id,deleted_at}], max_cursor }.
router.get('/deletions', async (req, res) => {
  try {
    const since = req.query.since || '1970-01-01';
    const r = await pool.query(
      `SELECT entity, cloud_id, deleted_at FROM deleted_records
       WHERE deleted_at > $1 ORDER BY deleted_at ASC LIMIT 1000`,
      [since],
    );
    const max = r.rows.length ? r.rows[r.rows.length - 1].deleted_at : since;
    res.json({ deletions: r.rows, max_cursor: max });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===========================================================================
// PUSH — apply a batch of mutations queued by an offline desktop till.
// POST /api/sync/push   body: { ops: [ { op_key, action, data } ] }
//   → { results: [ { op_key, ok, cloud_id?, error? } ] }
//
// Each op is idempotent: op_key is recorded in sync_applied_ops, so a retried
// push (after a dropped connection) returns the original cloud_id instead of
// creating a duplicate booking/bill. The till sends data with foreign keys
// already remapped to CLOUD ids (it resolves them from its local cloud_id
// columns before pushing), so this handler just applies straight to the DB.
//
// Column safety: we only ever write columns that actually exist on the target
// table (read from the live catalog) and always parameterise values — `data`
// keys that aren't real columns are ignored.
// ===========================================================================

// Action → { table, kind }. kind: 'insert' (returns new id),
// 'update' (by data.id), or 'upsert_medical' (by data.client_id).
const PUSH_ACTIONS = {
  create_client:             { table: 'clients',         kind: 'insert' },
  update_client:             { table: 'clients',         kind: 'update' },
  save_medical:              { table: 'client_medical',  kind: 'upsert_medical' },
  create_appointment:        { table: 'appointments',    kind: 'insert' },
  update_appointment_status: { table: 'appointments',    kind: 'update' },
  create_bill:               { table: 'bills',           kind: 'insert' },
  add_bill_item:             { table: 'bill_items',      kind: 'insert' },
  pay_bill_cash:             { table: 'bills',           kind: 'update' },
  delete_client:             { table: 'clients',         kind: 'delete', entity: 'client' },
};

// Column list for a table, from the live catalog. Works on Postgres (cloud)
// and SQLite (a desktop install acting as receiver in tests).
const _pushColCache = {};
async function tableColumns(table) {
  if (_pushColCache[table]) return _pushColCache[table];
  let cols;
  if ((process.env.DB_MODE || '').toLowerCase() === 'local') {
    const r = await pool.query(`PRAGMA table_info(${table})`);
    cols = r.rows.map((c) => c.name);
  } else {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [table],
    );
    cols = r.rows.map((c) => c.column_name);
  }
  _pushColCache[table] = cols;
  return cols;
}

// Keep only data keys that are real, writable columns of the table.
async function writableData(table, data, { excludeId = true } = {}) {
  const cols = await tableColumns(table);
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (!cols.includes(k)) continue;
    if (excludeId && (k === 'id' || k === 'cloud_id')) continue;
    out[k] = v;
  }
  return out;
}

// `db` is the executor for all DATA writes — the per-op pooled client running
// inside a BEGIN/COMMIT transaction (see POST /push). It defaults to `pool` so
// the function still works for any direct (non-transactional) caller. Catalog
// reads (tableColumns/writableData) stay on `pool` — they're read-only metadata.
async function applyOp(action, data, db = pool) {
  const spec = PUSH_ACTIONS[action];
  if (!spec) throw new Error(`unknown push action: ${action}`);
  const { table, kind } = spec;

  if (kind === 'insert') {
    const fields = await writableData(table, data);
    const keys = Object.keys(fields);
    if (keys.length === 0) throw new Error(`${action}: no writable columns`);
    const ph = keys.map((_, i) => `$${i + 1}`).join(',');
    const r = await db.query(
      `INSERT INTO ${table} (${keys.join(',')}) VALUES (${ph}) RETURNING id`,
      keys.map((k) => fields[k]),
    );
    return r.rows[0].id;
  }

  if (kind === 'update') {
    const id = Number(data.id);
    if (!Number.isFinite(id)) throw new Error(`${action}: missing target id`);
    const fields = await writableData(table, data);
    const keys = Object.keys(fields);
    if (keys.length === 0) throw new Error(`${action}: no writable columns`);
    const sets = keys.map((k, i) => `${k}=$${i + 1}`).join(',');
    await db.query(
      `UPDATE ${table} SET ${sets} WHERE id=$${keys.length + 1}`,
      [...keys.map((k) => fields[k]), id],
    );
    return id;
  }

  // delete — erase the row (FK-cascades to children) and tombstone it so other
  // tills wipe their local copy too (GDPR erasure propagation).
  if (kind === 'delete') {
    const id = Number(data.id);
    if (!Number.isFinite(id)) throw new Error(`${action}: missing target id`);
    await db.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
    await db.query(`INSERT INTO deleted_records (entity, cloud_id) VALUES ($1, $2)`, [spec.entity || table, id]);
    return id;
  }

  // upsert_medical — client_medical keyed by client_id (1:1 with a client).
  if (kind === 'upsert_medical') {
    const clientId = Number(data.client_id);
    if (!Number.isFinite(clientId)) throw new Error('save_medical: missing client_id');
    const fields = await writableData(table, data);
    delete fields.client_id; // set explicitly below
    const keys = Object.keys(fields);
    let updated = { rowCount: 0, rows: [] };
    if (keys.length) {
      const upd = keys.map((k, i) => `${k}=$${i + 1}`).join(',');
      updated = await db.query(
        // RETURNING id so we hand back the client_medical row id — NOT the
        // client id. Returning clientId here corrupted the cloud_id mapping and
        // spawned duplicate medical rows on the next pull.
        `UPDATE ${table} SET ${upd} WHERE client_id=$${keys.length + 1} RETURNING id`,
        [...keys.map((k) => fields[k]), clientId],
      );
    }
    if (updated.rowCount) {
      return updated.rows[0].id;
    }
    // No existing row updated → insert a fresh medical row.
    const insKeys = ['client_id', ...keys];
    const ph = insKeys.map((_, i) => `$${i + 1}`).join(',');
    const r = await db.query(
      `INSERT INTO ${table} (${insKeys.join(',')}) VALUES (${ph}) RETURNING id`,
      [clientId, ...keys.map((k) => fields[k])],
    );
    return r.rows[0].id;
  }

  throw new Error(`unhandled push kind: ${kind}`);
}

router.post('/push', async (req, res) => {
  const ops = Array.isArray(req.body?.ops) ? req.body.ops : null;
  if (!ops) return res.status(400).json({ error: 'ops array required' });

  const results = [];
  for (const op of ops) {
    const { op_key, action, data } = op || {};
    if (!op_key || !action) {
      results.push({ op_key: op_key || null, ok: false, error: 'op_key and action required' });
      continue;
    }
    // Crash-atomic: run the data write AND its sync_applied_ops record on ONE
    // pooled client inside a single transaction, so they either both land or
    // neither does. Previously these were two separate pool.query() calls — a
    // crash in between let a retry re-apply the op and duplicate the booking/bill.
    const client = await pool.connect();
    let inTxn = false;
    try {
      // Idempotency: already applied? return the stored cloud_id (no txn needed).
      const seen = await client.query('SELECT cloud_id FROM sync_applied_ops WHERE op_key=$1', [op_key]);
      if (seen.rows[0]) {
        results.push({ op_key, ok: true, cloud_id: seen.rows[0].cloud_id, duplicate: true });
        continue;
      }
      await client.query('BEGIN');
      inTxn = true;
      const cloudId = await applyOp(action, data || {}, client);
      await client.query(
        `INSERT INTO sync_applied_ops (op_key, action, cloud_id) VALUES ($1, $2, $3)
         ON CONFLICT (op_key) DO NOTHING`,
        [op_key, action, cloudId ?? null],
      );
      await client.query('COMMIT');
      inTxn = false;
      results.push({ op_key, ok: true, cloud_id: cloudId });
    } catch (e) {
      if (inTxn) {
        try { await client.query('ROLLBACK'); } catch (_) { /* already torn down */ }
      }
      results.push({ op_key, ok: false, error: e.message });
    } finally {
      client.release();
    }
  }
  res.json({ results });
});

module.exports = router;
