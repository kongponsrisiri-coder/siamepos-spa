// SiamEPOS Spa — Phase B sync engine.
//
// Runs INSIDE the desktop till's local server when DB_MODE=local. Every
// SYNC_PING_MS it:
//   1. pings the cloud /api/health,
//   2. if online, drains the offline push queue (syncOnce) — currently a
//      SAFE STUB (see applyToCloud + the B3 block below), then
//   3. pulls cloud → local (pullFromCloud) so the till mirrors the cloud DB.
//
// In cloud mode the whole engine is inert (isLocal === false → start() no-ops).
//
// ─── PULL is fully implemented. PUSH is a deliberate stub (Phase B3) ──────
// The cloud's WRITE endpoints (/api/appointments POST, /api/bills/:id/pay …)
// currently require a staff JWT. The auth model for an UNATTENDED desktop
// push (service token vs SYNC_SECRET-gated write feed) is being decided in
// B3, so we DO NOT invent an auth scheme here. applyToCloud() logs and THROWS
// for every action so the queue row stays 'pending' and nothing is lost —
// queued writes simply accumulate until B3 wires the real push. See the big
// TODO block on applyToCloud().
//
// CLOUD_API_URL env var controls the target. If unset, sync stays local
// permanently (queue grows but nothing pushes — safe default for tests).

const offlineQueue = require('./offlineQueue');
const { pool } = require('../db/dbAdapter');

const CLOUD_API_URL = process.env.CLOUD_API_URL || '';
// Default 5s — feels real-time for the till's appointment diary. Override per
// install via SYNC_PING_MS if Railway egress needs throttling.
const PING_INTERVAL_MS = parseInt(process.env.SYNC_PING_MS || '5000', 10);
const PING_TIMEOUT_MS = 3000;          // ping is a quick liveness check
const PULL_TIMEOUT_MS = 8000;          // data pulls can be larger

let status = 'local';                  // 'cloud' | 'local' | 'syncing' | 'initial-sync'
let intervalHandle = null;
let inProgress = false;
let initialSyncDone = false;
let lastQueueSize = 0;                  // refreshed every tick for getStatus()

// ───────────────────────────────────────────────────────────────────────────
// Small fetch helpers.
// ───────────────────────────────────────────────────────────────────────────
function syncHeaders() {
  // All /api/sync/* endpoints are gated by the x-sync-secret header.
  return process.env.SYNC_SECRET ? { 'x-sync-secret': process.env.SYNC_SECRET } : {};
}

async function getJSON(path, { timeout = PULL_TIMEOUT_MS, headers = {} } = {}) {
  const r = await fetch(CLOUD_API_URL + path, {
    headers,
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) {
    const e = new Error(`${path} → HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

// ───────────────────────────────────────────────────────────────────────────
// Generic upsert helper (cloud-authoritative config tables).
//
// pkCols: string PK ('id', 'key') OR array of columns for a composite PK
//         (e.g. ['date','therapist_id'] for therapist_turn_order).
// Drops null/undefined cloud values so they never clobber a non-null local
// default (e.g. therapists.pin which a partial cloud row might omit). Builds
// the column list per row from the intersection of the row's keys and the
// table's actual columns (so an extra cloud column never breaks the INSERT).
// ───────────────────────────────────────────────────────────────────────────
const _colCache = {};
async function getLocalColumns(table) {
  if (_colCache[table]) return _colCache[table];
  const r = await pool.query(`PRAGMA table_info(${table})`);
  const cols = r.rows.map((row) => row.name);
  _colCache[table] = cols;
  return cols;
}

async function upsertRows(table, pkCols, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const pks = Array.isArray(pkCols) ? pkCols : [pkCols];
  const localCols = await getLocalColumns(table);
  if (localCols.length === 0) return 0;

  let n = 0;
  for (const row of rows) {
    // Keep only columns that exist locally AND carry a real (non-null) value.
    const cols = Object.keys(row).filter(
      (c) => localCols.includes(c) && row[c] !== null && row[c] !== undefined
    );
    // Every PK column must be present for ON CONFLICT to target the row.
    if (!pks.every((pk) => cols.includes(pk))) continue;

    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const updateCols = cols.filter((c) => !pks.includes(c));
    if (updateCols.length === 0) continue; // nothing to update beyond the PK
    const updates = updateCols.map((c) => `${c}=excluded.${c}`).join(',');
    const conflictTarget = pks.join(',');

    const sql =
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders}) ` +
      `ON CONFLICT(${conflictTarget}) DO UPDATE SET ${updates}`;
    try {
      await pool.query(sql, cols.map((c) => row[c]));
      n++;
    } catch (err) {
      console.warn(`[sync] upsert ${table}#${pks.map((p) => row[p]).join('/')} failed:`, err.message);
    }
  }
  return n;
}

// ───────────────────────────────────────────────────────────────────────────
// cloud_id upsert for DATA tables (clients, appointments, bills, …).
//
// The cloud row's `id` maps to the local `cloud_id` column. We find the local
// row by cloud_id; UPDATE it (cloud-wins) or INSERT a new local row carrying
// the cloud_id. Rows whose cloud_id currently has a PENDING entry in
// sync_queue are SKIPPED — the till is authoritative for a record while its
// push is still in flight (mirrors the restaurant's pullActiveOrders guard).
//
// fkRemap: optional { localCol: (cloudRow) => localValue } to translate a
//          cloud foreign-key id into the matching local id (e.g. a bill_item's
//          bill_id → the local bill id). Returns null to SKIP the row when the
//          parent isn't local yet (it'll land on a later tick).
// ───────────────────────────────────────────────────────────────────────────
async function findLocalIdByCloudId(table, cloudId) {
  if (cloudId == null) return null;
  try {
    const r = await pool.query(`SELECT id FROM ${table} WHERE cloud_id = $1`, [cloudId]);
    return r.rows[0]?.id ?? null;
  } catch { return null; }
}

async function upsertByCloudId(table, rows, pendingCloudIds, fkRemap = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return { inserted: 0, updated: 0, skipped: 0 };
  const localCols = await getLocalColumns(table);
  let inserted = 0, updated = 0, skipped = 0;

  for (const row of rows) {
    const cloudId = row.id;
    if (cloudId == null) { skipped++; continue; }

    // Local-wins while a push for this record is queued.
    if (pendingCloudIds.has(Number(cloudId))) { skipped++; continue; }

    // Build the field map: known local columns, drop the cloud `id` (we use
    // our own local autoincrement id) and any null/undefined. Then translate
    // any FK columns and stamp cloud_id.
    const fields = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === 'id') continue;
      if (!localCols.includes(k)) continue;
      if (v === null || v === undefined) continue;
      fields[k] = v;
    }
    // FK remaps (may set a column to a translated local id, or signal a skip).
    // Distinguish a LEGIT null cloud FK (e.g. a walk-in appointment whose
    // client_id is genuinely null) from a parent that simply hasn't synced to
    // this till yet. Only the latter is a "parent missing" skip — a null cloud
    // FK leaves the column null and the row proceeds (otherwise walk-ins would
    // be skipped on every tick and never sync). The cloud FK lives under the
    // same column name on the cloud row (e.g. row.client_id / row.bill_id).
    let parentMissing = false;
    for (const [localCol, fn] of Object.entries(fkRemap)) {
      if (!localCols.includes(localCol)) continue;
      const cloudFk = row[localCol];
      if (cloudFk == null) continue; // legit null — leave column null, proceed
      const mapped = await fn(row);
      if (mapped == null) { parentMissing = true; break; } // parent not local yet
      fields[localCol] = mapped;
    }
    if (parentMissing) { skipped++; continue; }
    fields.cloud_id = cloudId;

    const localId = await findLocalIdByCloudId(table, cloudId);
    if (localId) {
      const setCols = Object.keys(fields).filter((c) => c !== 'cloud_id');
      if (setCols.length > 0) {
        const sets = setCols.map((c, i) => `${c} = $${i + 1}`).join(',');
        try {
          await pool.query(
            `UPDATE ${table} SET ${sets} WHERE id = $${setCols.length + 1}`,
            [...setCols.map((c) => fields[c]), localId]
          );
          updated++;
        } catch (err) {
          console.warn(`[sync] update ${table} cloud#${cloudId} failed:`, err.message);
        }
      }
    } else {
      const cols = Object.keys(fields);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
      try {
        await pool.query(
          `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`,
          cols.map((c) => fields[c])
        );
        inserted++;
      } catch (err) {
        console.warn(`[sync] insert ${table} cloud#${cloudId} failed:`, err.message);
      }
    }
  }
  return { inserted, updated, skipped };
}

// ───────────────────────────────────────────────────────────────────────────
// Pending-push guard. While a local mutation sits in sync_queue, the till is
// authoritative for that record. Collect the set of CLOUD ids the queue is
// about to touch so the pull skips them (avoids the "appears → snaps back"
// rollback flash). We read the cloud id from the payload where the push will
// have captured it; for not-yet-pushed local-only rows there's no cloud id to
// guard yet (they don't exist on the cloud, so the pull can't clobber them).
//
// Returns a Map: table-name → Set<cloudId>. Tables not present → empty set.
// ───────────────────────────────────────────────────────────────────────────
async function pendingCloudIdsByTable() {
  const map = {
    clients: new Set(),
    client_medical: new Set(),
    appointments: new Set(),
    bills: new Set(),
    bill_items: new Set(),
    vouchers: new Set(),
    voucher_redemptions: new Set(),
    appointment_amendments: new Set(),
  };
  try {
    const r = await pool.query(`SELECT op, payload FROM sync_queue WHERE status = 'pending'`);
    for (const row of r.rows) {
      let p;
      try { p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; }
      catch { continue; }
      if (!p || typeof p !== 'object') continue;
      // Generic: any payload field named <table>CloudId or cloudId tied to the
      // op's entity. We keep this loose because B3 will define the exact
      // payload contract; today nothing is pushed so this set is empty anyway.
      const add = (table, id) => {
        const n = Number(id);
        if (map[table] && Number.isFinite(n)) map[table].add(n);
      };
      if (p.appointmentCloudId) add('appointments', p.appointmentCloudId);
      if (p.billCloudId) add('bills', p.billCloudId);
      if (p.clientCloudId) add('clients', p.clientCloudId);
      if (p.medicalCloudId) add('client_medical', p.medicalCloudId);
      if (p.voucherCloudId) add('vouchers', p.voucherCloudId);
    }
  } catch (err) {
    console.warn('[sync] pendingCloudIdsByTable failed:', err.message);
  }
  return map;
}

// ───────────────────────────────────────────────────────────────────────────
// sync_state cursor helpers (pull high-water marks).
// ───────────────────────────────────────────────────────────────────────────
async function readSyncState(key) {
  try {
    const r = await pool.query('SELECT value FROM sync_state WHERE key = $1', [key]);
    return r.rows[0]?.value || null;
  } catch { return null; }
}
async function writeSyncState(key, value) {
  try {
    await pool.query(
      `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [key, value]
    );
  } catch (err) { console.warn('[sync] writeSyncState failed:', err.message); }
}

// ───────────────────────────────────────────────────────────────────────────
// PULL — fully implemented. Each endpoint is wrapped in its own try/catch so
// one failing feed never aborts the rest of the pull.
// ───────────────────────────────────────────────────────────────────────────

// /config → cloud-authoritative catalog tables, all keyed by their own PK.
async function pullConfig() {
  try {
    const data = await getJSON('/api/sync/config', { headers: syncHeaders() });
    let total = 0;
    total += await upsertRows('treatment_categories', 'id', data.treatment_categories || []);
    total += await upsertRows('treatments', 'id', data.treatments || []);
    // therapists carries `pin` (offline auth) — upsertRows keeps it because it
    // only drops null/undefined, and the cloud sends a real pin here.
    total += await upsertRows('therapists', 'id', data.therapists || []);
    total += await upsertRows('therapist_availability', 'id', data.therapist_availability || []);
    total += await upsertRows('therapist_rota_overrides', 'id', data.therapist_rota_overrides || []);
    total += await upsertRows('rooms', 'id', data.rooms || []);
    // settings: array of { key, value } rows, PK = key.
    total += await upsertRows('settings', 'key', data.settings || []);
    if (total > 0) console.log(`[sync] pull config: ${total} rows`);
  } catch (err) {
    console.warn('[sync] pull config failed:', err.message);
  }
}

// /clients → clients + client_medical, keyed by cloud_id. Delta by created_at
// /updated_at via the ?since cursor (persisted in sync_state).
async function pullClients(pending) {
  try {
    const since = await readSyncState('clients_since');
    const qs = since ? `?since=${encodeURIComponent(since)}` : '';
    const data = await getJSON('/api/sync/clients' + qs, { headers: syncHeaders() });

    const c = await upsertByCloudId('clients', data.clients || [], pending.clients);
    // client_medical.client_id is a cloud FK → translate to the local clients id.
    const m = await upsertByCloudId('client_medical', data.client_medical || [], pending.client_medical, {
      client_id: (row) => findLocalIdByCloudId('clients', row.client_id),
    });
    if (c.inserted || c.updated || m.inserted || m.updated) {
      console.log(`[sync] pull clients: ${c.inserted}+${c.updated} clients, ${m.inserted}+${m.updated} medical`);
    }
    // Advance the cursor to the SERVER's max updated_at (not the till's wall
    // clock). Using "now" silently dropped rows whose updated_at was older than
    // the till clock but newer than the last cursor. The server returns
    // max_cursor = greatest updated_at among the rows it just shipped (or the
    // prior `since` when nothing changed); persist exactly that — mirroring how
    // pullBills advances its cursor.
    if (data.max_cursor) {
      await writeSyncState('clients_since', String(data.max_cursor));
    }
  } catch (err) {
    console.warn('[sync] pull clients failed:', err.message);
  }
}

// /appointments → appointments + appointment_amendments in a date window.
async function pullAppointments(pending) {
  try {
    const data = await getJSON('/api/sync/appointments', { headers: syncHeaders() });
    const a = await upsertByCloudId('appointments', data.appointments || [], pending.appointments, {
      // client_id may be null (walk-in) — upsertByCloudId leaves a null cloud FK
      // untouched and only skips when a NON-null id has no local match yet.
      client_id: (row) => findLocalIdByCloudId('clients', row.client_id),
    });
    // amendments.appointment_id is a cloud FK → translate to the local appt id.
    const am = await upsertByCloudId('appointment_amendments', data.appointment_amendments || [], pending.appointment_amendments, {
      appointment_id: (row) => findLocalIdByCloudId('appointments', row.appointment_id),
    });
    if (a.inserted || a.updated || am.inserted || am.updated) {
      console.log(`[sync] pull appointments: ${a.inserted}+${a.updated} appts, ${am.inserted}+${am.updated} amendments`);
    }
  } catch (err) {
    console.warn('[sync] pull appointments failed:', err.message);
  }
}

// NOTE on appointment FK remap: client_id may legitimately be NULL on the
// cloud (walk-in with no client record). The remap above returns the cloud
// value (null) straight through in that case so upsertByCloudId's null-drop
// handles it — it does NOT treat a genuinely client-less appointment as a
// "parent missing" skip. (A non-null cloud client_id with no local match WILL
// skip, and resolve once the client lands on a later tick.)

// /bills → paginated by closed_at cursor; follows has_more. bills + bill_items.
async function pullBills(pending) {
  try {
    let since = (await readSyncState('bills_since')) || '1970-01-01T00:00:00.000Z';
    let totalBills = 0, totalItems = 0;
    for (let safety = 0; safety < 200; safety++) {
      const data = await getJSON(
        `/api/sync/bills?since=${encodeURIComponent(since)}&limit=500`,
        { headers: syncHeaders() }
      );
      const bills = data.bills || [];
      if (bills.length === 0) break;

      const b = await upsertByCloudId('bills', bills, pending.bills, {
        appointment_id: (row) => findLocalIdByCloudId('appointments', row.appointment_id),
      });
      const bi = await upsertByCloudId('bill_items', data.bill_items || [], pending.bill_items, {
        bill_id: (row) => findLocalIdByCloudId('bills', row.bill_id),
      });
      totalBills += b.inserted + b.updated;
      totalItems += bi.inserted + bi.updated;

      // Advance the cursor and persist it before deciding to continue.
      if (data.max_cursor) {
        since = data.max_cursor;
        await writeSyncState('bills_since', String(since));
      }
      if (!data.has_more) break;
    }
    if (totalBills || totalItems) {
      console.log(`[sync] pull bills: ${totalBills} bills, ${totalItems} items`);
    }
  } catch (err) {
    console.warn('[sync] pull bills failed:', err.message);
  }
}

// /vouchers → active vouchers + their redemptions, keyed by cloud_id.
async function pullVouchers(pending) {
  try {
    const data = await getJSON('/api/sync/vouchers', { headers: syncHeaders() });
    const v = await upsertByCloudId('vouchers', data.vouchers || [], pending.vouchers, {
      // client_id may be null (unassigned voucher) — a null cloud FK is left
      // null and proceeds; a non-null id with no local match skips till later.
      client_id: (row) => findLocalIdByCloudId('clients', row.client_id),
    });
    const vr = await upsertByCloudId('voucher_redemptions', data.voucher_redemptions || [], pending.voucher_redemptions, {
      voucher_id: (row) => findLocalIdByCloudId('vouchers', row.voucher_id),
      // bill_id may be null — left null and proceeds when so.
      bill_id:    (row) => findLocalIdByCloudId('bills', row.bill_id),
    });
    if (v.inserted || v.updated || vr.inserted || vr.updated) {
      console.log(`[sync] pull vouchers: ${v.inserted}+${v.updated} vouchers, ${vr.inserted}+${vr.updated} redemptions`);
    }
  } catch (err) {
    console.warn('[sync] pull vouchers failed:', err.message);
  }
}

async function pullFromCloud() {
  if (!offlineQueue.isLocal || !CLOUD_API_URL) return;

  // Config is unsecured-shaped but still gated by x-sync-secret. If SYNC_SECRET
  // is unset every /api/sync/* feed 401s — the individual try/catch blocks log
  // and skip, so the pull degrades gracefully to "nothing synced" rather than
  // crashing the tick.
  await pullConfig();

  // Snapshot the per-table pending-cloud-id guard once for this whole pull.
  const pending = await pendingCloudIdsByTable();

  // Parents before children so FK remaps resolve on the same tick where
  // possible (clients → medical/appointments/vouchers → bills → items/redemptions).
  await pullClients(pending);
  await pullAppointments(pending);
  await pullVouchers(pending);
  await pullBills(pending);

  // GDPR erasure: wipe local copies of anything erased on the cloud / another
  // till. Done AFTER the upserts so a tombstone always wins over a stale pull.
  await pullDeletions();
}

// Apply cloud erasure tombstones to the local DB. Deleting a client cascades
// to client_medical locally (FK ON DELETE CASCADE + PRAGMA foreign_keys=ON),
// so the sensitive medical record is wiped too.
async function pullDeletions() {
  try {
    const since = (await readSyncState('deletions_since')) || '1970-01-01';
    const data = await getJSON('/api/sync/deletions?since=' + encodeURIComponent(since), { headers: syncHeaders() });
    let n = 0;
    for (const d of (data.deletions || [])) {
      if (d.entity === 'client') {
        const r = await pool.query('DELETE FROM clients WHERE cloud_id = $1', [d.cloud_id]);
        n += r.rowCount || 0;
      }
    }
    if (data.max_cursor) await writeSyncState('deletions_since', data.max_cursor);
    if (n) console.log(`[sync] GDPR: erased ${n} locally-held record(s) per cloud tombstones`);
  } catch (err) {
    console.warn('[sync] pull deletions failed:', err.message);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// PING — quick liveness check against /api/health (3s abort).
// ───────────────────────────────────────────────────────────────────────────
async function ping() {
  if (!CLOUD_API_URL) return false;
  try {
    const r = await fetch(CLOUD_API_URL + '/api/health', {
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PUSH — STUB (Phase B3).
// ═══════════════════════════════════════════════════════════════════════════
// ┌──────────────────────────────────────────────────────────────────────────
// │ TODO (B3) — WIRE THE PUSH. Until then this is intentionally a no-op that
// │ THROWS so queued writes stay safely 'pending' (nothing is ever lost).
// │
// │ WHY IT'S STUBBED
// │   The cloud write endpoints the till would call to replay these
// │   mutations (POST /api/appointments, PUT /api/appointments/:id/status,
// │   POST /api/bills, POST /api/bills/:id/pay-cash, POST /api/bills/:id/items,
// │   POST /api/clients, PUT /api/clients/:id, PUT /api/clients/:id/medical)
// │   currently require a STAFF JWT. An unattended desktop till has no logged-in
// │   browser session to mint that token, and we must NOT invent an ad-hoc auth
// │   scheme that could become a forgeable backdoor.
// │
// │ THE B3 DECISION (one of):
// │   (a) Add SYNC_SECRET-gated WRITE endpoints under /api/sync/* (mirroring
// │       the restaurant's /api/sync/delete-order), reusing the same
// │       x-sync-secret header the pull feed already trusts; OR
// │   (b) Issue a long-lived SERVICE TOKEN per install (stored in the same
// │       config.json as sync_secret) that the cloud accepts on the normal
// │       write routes for the "till" pseudo-user.
// │
// │ THE PUSH PAYLOAD CONTRACT (so B3 knows exactly what's queued).
// │   Each case below names the actionType and the cloud call it will make.
// │   Payloads should carry the LOCAL row id plus a captured cloud id for
// │   parents (so replay is idempotent and FK-correct), e.g.
// │     create_appointment → { localAppointmentId, ...appointmentFields,
// │                            clientCloudId }            POST  /appointments
// │     update_appointment_status → { appointmentCloudId, status }
// │                                                       PUT   /appointments/:id/status
// │     create_bill        → { localBillId, appointmentCloudId, ...billFields }
// │                                                       POST  /bills
// │     add_bill_item      → { billCloudId, ...itemFields } POST /bills/:id/items
// │     pay_bill_cash      → { billCloudId, amount, tip, method }
// │                                                       POST  /bills/:id/pay-cash
// │     create_client      → { localClientId, ...clientFields }  POST /clients
// │     update_client      → { clientCloudId, ...clientFields }  PUT  /clients/:id
// │     save_medical       → { clientCloudId, ...medicalFields } PUT  /clients/:id/medical
// │   On success B3 must write the returned cloud id back into the local row's
// │   cloud_id column (like the restaurant's setOrderCloudId) so the pull then
// │   recognises the row by cloud_id instead of re-inserting a duplicate.
// └──────────────────────────────────────────────────────────────────────────
// Reverse of findLocalIdByCloudId: the cloud id this local row maps to (null
// if it hasn't been pushed yet).
async function findCloudIdByLocalId(table, localId) {
  if (localId == null) return null;
  try {
    const r = await pool.query(`SELECT cloud_id FROM ${table} WHERE id = $1`, [localId]);
    return r.rows[0]?.cloud_id ?? null;
  } catch { return null; }
}

async function postJSON(path, body) {
  const r = await fetch(CLOUD_API_URL + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...syncHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
  });
  if (!r.ok) {
    const e = new Error(`${path} → HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

// action → { table, insert, fks, medical }. `fks` maps a LOCAL foreign-key
// column to the parent table whose cloud_id we must substitute before pushing.
// Config FKs (treatment_id/therapist_id/room_id) are NOT remapped — config
// tables are keyed by their cloud id locally, so local id === cloud id.
const PUSH_MAP = {
  create_client:             { table: 'clients',        insert: true,  fks: {} },
  update_client:             { table: 'clients',        insert: false, fks: {} },
  save_medical:              { table: 'client_medical', insert: false, medical: true, fks: { client_id: 'clients' } },
  create_appointment:        { table: 'appointments',   insert: true,  fks: { client_id: 'clients' } },
  update_appointment_status: { table: 'appointments',   insert: false, fks: {} },
  create_bill:               { table: 'bills',          insert: true,  fks: { appointment_id: 'appointments' } },
  add_bill_item:             { table: 'bill_items',     insert: true,  fks: { bill_id: 'bills' } },
  pay_bill_cash:             { table: 'bills',          insert: false, fks: {} },
};

// A stable per-DEVICE id, generated once and persisted in sync_state. It's
// folded into every push op_key so two tills that share the same SPA_ID can
// never collide (e.g. both would otherwise emit "baan-siam:q1" for their first
// push and the cloud's idempotency would drop one). The operator types a plain
// SPA_ID; uniqueness is handled here under the hood.
let _deviceId = null;
async function getDeviceId() {
  if (_deviceId) return _deviceId;
  let id = await readSyncState('device_id');
  if (!id) {
    id = require('crypto').randomBytes(4).toString('hex');
    await writeSyncState('device_id', id);
  }
  _deviceId = id;
  return id;
}

// Globally-unique idempotency key for a queue entry: <spa>-<device>:q<rowId>.
async function makeOpKey(entry) {
  const spa = process.env.SPA_ID || 'spa';
  return `${spa}-${await getDeviceId()}:q${entry.id}`;
}

// Push one queued mutation to the cloud. Re-reads the current local row (freshest
// data + lets us remap FKs now that parents may have cloud ids), POSTs it to
// /api/sync/push, and writes the returned cloud id back into the local cloud_id
// column. Throws to keep the row queued on any failure (offline, parent not yet
// pushed, server error) — syncOnce stops the drain and retries next tick.
async function applyToCloud(entry) {
  const action = entry.action_type;

  // delete_client (GDPR erasure): the local row is already gone, so we can't
  // re-read it — send the captured cloud id straight to the cloud, which
  // deletes its copy and writes a tombstone for the other tills.
  if (action === 'delete_client') {
    const cloudId = entry.payload && entry.payload.cloud_id;
    if (cloudId == null) return; // never had a cloud copy — nothing to propagate
    const opKey = await makeOpKey(entry);
    const resp = await postJSON('/api/sync/push', { ops: [{ op_key: opKey, action, data: { id: cloudId } }] });
    const result = resp.results && resp.results[0];
    if (!result || !result.ok) throw new Error((result && result.error) || 'push rejected');
    return;
  }

  const spec = PUSH_MAP[action];
  if (!spec) throw new Error(`unknown push action: ${action}`);

  const localId = entry.payload && entry.payload.localId;
  if (localId == null) throw new Error(`${action}: payload.localId missing`);

  const rowRes = await pool.query(`SELECT * FROM ${spec.table} WHERE id = $1`, [localId]);
  const row = rowRes.rows[0];
  if (!row) throw new Error(`${action}: local ${spec.table}#${localId} no longer exists`);

  const data = { ...row };
  delete data.id;
  delete data.cloud_id;

  // Remap local foreign keys to their cloud ids.
  for (const [fkCol, parentTable] of Object.entries(spec.fks)) {
    const localFk = row[fkCol];
    if (localFk == null) { data[fkCol] = null; continue; }
    const parentCloud = await findCloudIdByLocalId(parentTable, localFk);
    if (parentCloud == null) {
      throw new Error(`${action}: parent ${parentTable}#${localFk} not on cloud yet — retry`);
    }
    data[fkCol] = parentCloud;
  }

  // Updates target the cloud row by id (the create op must have pushed first).
  if (!spec.insert && !spec.medical) {
    if (row.cloud_id == null) throw new Error(`${action}: local row has no cloud_id yet — retry`);
    data.id = row.cloud_id;
  }

  const opKey = await makeOpKey(entry);
  const resp = await postJSON('/api/sync/push', { ops: [{ op_key: opKey, action, data }] });
  const result = resp.results && resp.results[0];
  if (!result || !result.ok) throw new Error((result && result.error) || 'push rejected');

  // Capture the cloud id so future ops referencing this row remap correctly.
  if (result.cloud_id != null && (spec.insert || spec.medical)) {
    await pool.query(`UPDATE ${spec.table} SET cloud_id = $1 WHERE id = $2`, [result.cloud_id, localId]);
  }
}

// Drain the queue: for each pending row, attempt the cloud push; on success
// mark it synced. Today every applyToCloud throws (B3 stub), so syncOnce stops
// at the first row and leaves everything queued. We swallow the throw at the
// tick level so it never crashes the loop.
async function syncOnce() {
  const queue = await offlineQueue.pending();
  if (queue.length === 0) return;
  setStatus('syncing');
  for (const entry of queue) {
    try {
      await applyToCloud(entry);
      await offlineQueue.markSynced(entry.id);
    } catch (err) {
      // Expected while push is stubbed (B3). Stop draining; retry next tick.
      // Throttle the noise so we don't log the same wall every 5s forever.
      const now = Date.now();
      if (!_lastPushWarn || now - _lastPushWarn > 60_000) {
        console.warn(`[sync] queue drain halted at #${entry.id} (${entry.action_type}): ${err.message}`);
        _lastPushWarn = now;
      }
      return;
    }
  }
}
let _lastPushWarn = 0;

// ───────────────────────────────────────────────────────────────────────────
// Status helpers + tick loop.
// ───────────────────────────────────────────────────────────────────────────
function setStatus(next) {
  if (next === status) return;
  status = next;
}

async function isCatalogEmpty() {
  // "Local DB empty" probe — no therapists means a freshly-provisioned till.
  try {
    const r = await pool.query('SELECT COUNT(*) AS n FROM therapists');
    return Number(r.rows[0]?.n || 0) === 0;
  } catch { return true; }
}

async function tick() {
  if (!offlineQueue.isLocal) return;
  if (inProgress) return;
  inProgress = true;
  try {
    // First-launch full sync — flag the banner while the initial pull runs so
    // the operator sees activity instead of an empty diary.
    if (!initialSyncDone) {
      const online = await ping();
      if (online && (await isCatalogEmpty())) {
        setStatus('initial-sync');
        await pullFromCloud();
        initialSyncDone = true;
        const remaining = await offlineQueue.pendingCount();
        lastQueueSize = remaining;
        setStatus(remaining > 0 ? 'syncing' : 'cloud');
        return;
      }
      initialSyncDone = true;
      // fall through to the normal tick below
    }

    const online = await ping();
    if (!online) {
      setStatus('local');
      return;
    }

    // Online: drain the push queue (swallow the B3 stub-throw so it never
    // crashes the tick), then pull cloud → local.
    try {
      await syncOnce();
    } catch (err) {
      console.warn('[sync] syncOnce error (swallowed):', err.message);
    }
    await pullFromCloud();

    const remaining = await offlineQueue.pendingCount();
    lastQueueSize = remaining;
    setStatus(remaining > 0 ? 'syncing' : 'cloud');
  } finally {
    inProgress = false;
  }
}

function start() {
  if (!offlineQueue.isLocal) {
    console.log('[sync] cloud mode — sync engine not started');
    return;
  }
  if (!CLOUD_API_URL) {
    console.log('[sync] local mode but CLOUD_API_URL unset — staying offline');
    return;
  }
  console.log('[sync] local mode, target=', CLOUD_API_URL, 'interval=', PING_INTERVAL_MS, 'ms');
  // Kick off immediately so status reflects reality on boot.
  tick().catch((err) => console.error('[sync] initial tick failed:', err.message));
  intervalHandle = setInterval(() => {
    tick().catch((err) => console.error('[sync] tick failed:', err.message));
  }, PING_INTERVAL_MS);
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

// Synchronous status snapshot. `queueSize` is the count captured on the last
// tick (refreshed every SYNC_PING_MS). For an exact live number at any instant,
// callers can await offlineQueue.pendingCount() directly.
function getStatus() {
  return {
    mode: offlineQueue.isLocal ? 'local' : 'cloud',
    status,
    queueSize: lastQueueSize,
  };
}

// True only on a desktop till (DB_MODE=local) that is CURRENTLY offline.
// Always false in cloud mode — the cloud server is, by definition, online.
// Used to gate payment methods that require the internet (card via Stripe,
// gift-voucher redemption against a shared cloud balance). See SEPOS-SPA-PRO-001
// Phase B "Option A": cash works offline, card + voucher wait for reconnect.
function isOffline() {
  return offlineQueue.isLocal && status === 'local';
}

module.exports = {
  start,
  stop,
  syncOnce,
  pullFromCloud,
  getStatus,
  isOffline,
  // exported for targeted refreshes / tests
  ping,
  tick,
  upsertRows,
  // SEPOS-SPA-LICENSE-001 Part B — stable per-device id, reused by the heartbeat.
  getDeviceId,
};
