// SiamEPOS Spa — Phase B offline mutation queue.
//
// When the desktop till runs in local mode (DB_MODE=local), route handlers
// call enqueue() AFTER the local SQLite write so syncService can push the
// mutation up to the cloud once the internet returns.
//
// In cloud mode every function is a no-op so production deploys are unaffected.
//
// ─────────────────────────────────────────────────────────────────────────
// IMPORTANT — the spa's sync_queue table is NOT shaped like the restaurant's.
// The restaurant uses { action_type, payload, synced (0/1), synced_at }.
// The spa's localDatabase.js created sync_queue with these columns instead:
//   id, entity, entity_id, op, payload, status (pending|done|error),
//   attempts, last_error, created_at, updated_at
// There is NO action_type / synced / synced_at column.
//
// So we map the restaurant's public interface onto the spa's columns:
//   • actionType (e.g. 'create_appointment')  → stored in the `op` column
//   • "pending"  → status = 'pending'
//   • markSynced → status = 'done', updated_at = CURRENT_TIMESTAMP
//   • `entity` is required (NOT NULL) so we always write a value — we derive a
//     coarse entity name from the actionType (appointment/bill/client/medical),
//     falling back to 'misc'. `entity_id` is optional and filled from the
//     payload's localId when present (purely informational for now).
// The exported method NAMES + return shapes match the restaurant template so
// syncService can be a near drop-in.
// ─────────────────────────────────────────────────────────────────────────

const { pool } = require('../db/dbAdapter');

const isLocal = (process.env.DB_MODE || 'cloud').toLowerCase() === 'local';

// Map an actionType to the coarse `entity` bucket the spa schema expects.
// Purely descriptive — the push logic switches on `action_type` (= op), not
// on entity. NOT NULL on the column means we must always supply something.
function entityFor(actionType) {
  const a = String(actionType || '');
  if (a.includes('medical')) return 'medical';
  if (a.includes('appointment')) return 'appointment';
  if (a.includes('bill')) return 'bill';
  if (a.includes('client')) return 'client';
  if (a.includes('voucher')) return 'voucher';
  return 'misc';
}

// Best-effort local row id from a payload, for the optional entity_id column.
function entityIdFor(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const v =
    payload.localId ??
    payload.localAppointmentId ??
    payload.localBillId ??
    payload.localClientId ??
    payload.id ??
    null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Enqueue a locally-originated mutation. Returns the new row id, or null in
// cloud mode (or on failure — logged, never thrown, so the caller's local
// write isn't rolled back by a queue hiccup).
async function enqueue(actionType, payload) {
  if (!isLocal) return null;
  try {
    const r = await pool.query(
      `INSERT INTO sync_queue (entity, entity_id, op, payload, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id`,
      [entityFor(actionType), entityIdFor(payload), actionType, JSON.stringify(payload)]
    );
    return r.rows[0]?.id ?? null;
  } catch (err) {
    console.error('[offlineQueue] enqueue failed:', actionType, err.message);
    return null;
  }
}

// All un-pushed rows, oldest first. We expose `action_type` (= the `op`
// column) + parsed `payload` so syncService reads exactly like the
// restaurant's queue entries.
async function pending() {
  if (!isLocal) return [];
  const r = await pool.query(
    `SELECT id, op AS action_type, payload, created_at
       FROM sync_queue
      WHERE status = 'pending'
      ORDER BY id ASC`
  );
  return r.rows.map((row) => ({
    id: row.id,
    action_type: row.action_type,
    payload: safeParse(row.payload),
    created_at: row.created_at,
  }));
}

function safeParse(p) {
  if (p == null) return null;
  if (typeof p !== 'string') return p;
  try { return JSON.parse(p); } catch { return null; }
}

async function pendingCount() {
  if (!isLocal) return 0;
  const r = await pool.query(
    `SELECT COUNT(*) AS n FROM sync_queue WHERE status = 'pending'`
  );
  return Number(r.rows[0]?.n || 0);
}

// Mark a queue row as successfully pushed.
async function markSynced(id) {
  if (!isLocal) return;
  await pool.query(
    `UPDATE sync_queue
        SET status = 'done', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [id]
  );
}

module.exports = { enqueue, pending, pendingCount, markSynced, isLocal };
