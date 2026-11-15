// SPA-CLIENT-MERGE-002 — merge one duplicate client profile into the main one.
//
// One routine for every path, so the rules can't drift:
//   • cloud admin  (POST /api/clients/:id/merge, cloud mode)
//   • offline till (same route in DB_MODE=local; the till then queues the merge)
//   • sync push    (the till's queued merge replayed on the cloud)
// The caller owns the transaction (BEGIN/COMMIT on `db`). SQL stays inside what
// the SQLite adapter translates (no = ANY, booleans computed in JS).
//
// Rules (MP/Nick ticket, 15 Nov 2026):
//   • everything moves: appointments (→ bills, history), vouchers & session
//     packages, loyalty events + stamps, Wallet passes, the medical form.
//   • contact details: main profile's win; a DIFFERENT phone/email from the
//     duplicate is kept in alt_phone / alt_email (overflow → notes).
//   • marketing consent is NEVER switched on by a merge: on only if BOTH
//     profiles had it, and an unsubscribe on either profile sticks.
//   • GDPR record-keeping consent (to hold the medical form) carries over if
//     either profile had it — the form moving with it was given under it.
//   • audit row in client_merges; merge tombstone (cloud) so tills re-point.
'use strict';

const CHILD_TABLES = ['appointments', 'vouchers', 'loyalty_events', 'wallet_passes'];
const isLocal = () => (process.env.DB_MODE || 'cloud').toLowerCase() === 'local';

const digits = (s) => {
  let d = String(s || '').replace(/\D/g, '');
  if (d.startsWith('44')) d = `0${d.slice(2)}`;
  return d;
};
const lc = (s) => String(s || '').trim().toLowerCase();
const truthy = (v) => v === true || v === 1 || v === '1' || v === 't' || v === 'true';
const ts = (v) => (v ? new Date(v).getTime() : null);
const earliest = (a, b) => {
  if (!a) return b || null;
  if (!b) return a;
  return ts(a) <= ts(b) ? a : b;
};

// Fields shown in the preview / kept in the audit. Never medical answers.
const PUBLIC_FIELDS = ['id', 'name', 'alias', 'phone', 'alt_phone', 'email', 'alt_email', 'date_of_birth',
  'emergency_contact_name', 'emergency_contact_phone', 'gp_name', 'gp_surgery', 'notes',
  'gdpr_consent', 'gdpr_consent_at', 'marketing_consent', 'unsubscribed_at',
  'loyalty_visits', 'loyalty_cycle', 'source', 'created_at'];
const pick = (row) => Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, row[k] ?? null]));

// What the main profile will look like after the merge (pure — used by the
// preview AND the merge, so what staff confirm is exactly what happens).
function mergedFields(keep, dup, { loyaltyOverride = null } = {}) {
  const out = {};
  const extra = [];

  // Phone / email: main wins; a different one from the duplicate goes to alt_*.
  const pairs = [['phone', 'alt_phone', digits], ['email', 'alt_email', lc]];
  for (const [main, alt, normalise] of pairs) {
    let primary = keep[main] || null;
    let second = keep[alt] || null;
    for (const cand of [dup[main], dup[alt]]) {
      if (!cand) continue;
      const n = normalise(cand);
      if ([primary, second].some((v) => v && normalise(v) === n)) continue;
      if (!primary) primary = cand;
      else if (!second) second = cand;
      else extra.push(`${main} ${cand}`);
    }
    out[main] = primary;
    out[alt] = second;
  }

  // Blank-fill the rest from the duplicate.
  for (const k of ['date_of_birth', 'emergency_contact_name', 'emergency_contact_phone', 'gp_name', 'gp_surgery']) {
    out[k] = keep[k] || dup[k] || null;
  }
  out.alias = keep.alias || dup.alias || null;
  if (keep.alias && dup.alias && lc(keep.alias) !== lc(dup.alias)) extra.push(`nickname "${dup.alias}"`);
  if (lc(dup.name) !== lc(keep.name)) extra.push(`name "${dup.name}"`);

  // Notes: keep both, labelled.
  const stamp = new Date().toISOString().slice(0, 10);
  const parts = [keep.notes || null];
  if (dup.notes || extra.length) {
    parts.push(`— Merged from "${dup.name}" on ${stamp}${extra.length ? ` (also: ${extra.join(', ')})` : ''}${dup.notes ? `: ${dup.notes}` : ''}`);
  }
  out.notes = parts.filter(Boolean).join('\n') || null;

  // Consent.
  out.unsubscribed_at = earliest(keep.unsubscribed_at, dup.unsubscribed_at);
  out.marketing_consent = truthy(keep.marketing_consent) && truthy(dup.marketing_consent) && !out.unsubscribed_at;
  out.gdpr_consent = truthy(keep.gdpr_consent) || truthy(dup.gdpr_consent);
  out.gdpr_consent_at = out.gdpr_consent ? earliest(keep.gdpr_consent_at, dup.gdpr_consent_at) : null;

  // Loyalty stamps: add the duplicate's to the main card, on the later cycle.
  if (loyaltyOverride) {
    out.loyalty_visits = Number(loyaltyOverride.visits) || 0;
    out.loyalty_cycle = Number(loyaltyOverride.cycle) || 0;
  } else {
    out.loyalty_visits = (Number(keep.loyalty_visits) || 0) + (Number(dup.loyalty_visits) || 0);
    out.loyalty_cycle = Math.max(Number(keep.loyalty_cycle) || 0, Number(dup.loyalty_cycle) || 0);
  }

  // "Client since" = whichever profile is older.
  out.created_at = earliest(keep.created_at, dup.created_at);
  return out;
}

async function loadPair(db, keepId, dupId) {
  const r = await db.query('SELECT * FROM clients WHERE id IN ($1, $2)', [keepId, dupId]);
  const keep = r.rows.find((x) => Number(x.id) === Number(keepId));
  const dup = r.rows.find((x) => Number(x.id) === Number(dupId));
  return { keep, dup };
}

async function childCounts(db, clientId) {
  const out = {};
  for (const t of CHILD_TABLES) {
    const r = await db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE client_id = $1`, [clientId]);
    out[t] = Number(r.rows[0].n) || 0;
  }
  const m = await db.query('SELECT COUNT(*) AS n FROM client_medical WHERE client_id = $1', [clientId]);
  out.medical_form = Number(m.rows[0].n) > 0;
  return out;
}

/** Everything the confirm screen shows. Read-only. */
async function previewMerge(db, keepId, dupId) {
  const { keep, dup } = await loadPair(db, keepId, dupId);
  if (!keep || !dup) return null;
  const keepCounts = await childCounts(db, keep.id);
  const dupCounts = await childCounts(db, dup.id);
  const result = mergedFields(keep, dup);
  return {
    keep: { ...pick(keep), counts: keepCounts },
    duplicate: { ...pick(dup), counts: dupCounts },
    result: { ...pick({ ...keep, ...result }), name: keep.name },
    medical: keepCounts.medical_form ? (dupCounts.medical_form ? 'main_kept' : 'main') : (dupCounts.medical_form ? 'moved' : 'none'),
  };
}

/**
 * Merge `dupId` into `keepId` inside the caller's transaction.
 * Returns { kept, moved, merge_id } or throws { status, message }.
 */
async function mergeClients(db, keepId, dupId, { staffId = null, staffName = null, source = null, loyaltyOverride = null } = {}) {
  keepId = Number(keepId); dupId = Number(dupId);
  if (!keepId || !dupId) throw Object.assign(new Error('two client ids required'), { status: 400 });
  if (keepId === dupId) throw Object.assign(new Error('cannot merge a client into itself'), { status: 400 });
  const { keep, dup } = await loadPair(db, keepId, dupId);
  if (!keep || !dup) throw Object.assign(new Error('client not found'), { status: 404 });

  const f = mergedFields(keep, dup, { loyaltyOverride });
  const cols = Object.keys(f);
  await db.query(
    `UPDATE clients SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [keepId, ...cols.map((c) => f[c])],
  );

  // Re-point every child record; remember which rows moved (for audit / undo).
  const moved = {};
  for (const t of CHILD_TABLES) {
    const ids = (await db.query(`SELECT id FROM ${t} WHERE client_id = $1`, [dupId])).rows.map((r) => r.id);
    if (ids.length) await db.query(`UPDATE ${t} SET client_id = $1 WHERE client_id = $2`, [keepId, dupId]);
    moved[t] = ids;
  }
  // Medical form is one per client: move it only if the main has none.
  const keptMed = await db.query('SELECT id FROM client_medical WHERE client_id = $1', [keepId]);
  const dupMed = await db.query('SELECT id FROM client_medical WHERE client_id = $1', [dupId]);
  let medical = 'none';
  if (dupMed.rows.length && !keptMed.rows.length) {
    await db.query('UPDATE client_medical SET client_id = $1 WHERE client_id = $2', [keepId, dupId]);
    medical = 'moved';
  } else if (dupMed.rows.length) {
    await db.query('DELETE FROM client_medical WHERE client_id = $1', [dupId]);
    medical = 'main_kept';
  }

  // Flags that involved the duplicate are settled by this merge.
  await db.query('DELETE FROM client_duplicate_flags WHERE client_a = $1 OR client_b = $1', [dupId]);
  await db.query('DELETE FROM clients WHERE id = $1', [dupId]);

  const snapshot = {
    duplicate: pick(dup),                                 // contact + consent as it was
    main_before: pick(keep),
    moved: { ...moved, medical },
  };
  const audit = await db.query(
    `INSERT INTO client_merges (kept_id, merged_id, merged_name, snapshot, staff_id, staff_name, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [keepId, dupId, dup.name, JSON.stringify(snapshot), staffId, staffName, source || (isLocal() ? 'till' : 'cloud')],
  );
  // Cloud: tombstone so every till drops the duplicate and re-points its rows.
  if (!isLocal()) {
    await db.query(
      `INSERT INTO deleted_records (entity, cloud_id, merged_into) VALUES ('client', $1, $2)`,
      [dupId, keepId],
    );
  }
  const kept = (await db.query('SELECT * FROM clients WHERE id = $1', [keepId])).rows[0];
  return {
    kept, merge_id: audit.rows[0].id, medical,
    moved: Object.fromEntries(Object.entries(moved).map(([t, ids]) => [t, ids.length])),
    duplicate: { id: dup.id, cloud_id: dup.cloud_id ?? null, name: dup.name },
    keep_cloud_id: keep.cloud_id ?? null,
    dup_had_medical: dupMed.rows.length > 0,
  };
}

module.exports = { mergeClients, previewMerge, mergedFields, CHILD_TABLES };
