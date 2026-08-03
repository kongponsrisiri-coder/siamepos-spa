const express = require('express');
const { pool } = require('../db/dbAdapter');
const { requireRole } = require('../middleware/auth');
const offlineQueue = require('../services/offlineQueue');
const { isOffline } = require('../services/syncService');

const router = express.Router();

// GET /api/clients?q=name_or_phone
// Returns the client list enriched with visit + spend stats so both the
// top-level Clients screen and the Admin → Clients CRM dashboard can
// render in one round-trip. Stats come from a LEFT JOIN against
// appointments (excluding cancelled / no-show) and bills (paid only) —
// any client with no appointments still appears with zeros, so newly
// created profiles aren't hidden.
router.get('/', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  try {
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`);
      where = `WHERE c.name ILIKE $1 OR c.phone ILIKE $1 OR c.email ILIKE $1`;
    }
    // acquisition_source = the `source` of this client's earliest
    // non-cancelled appointment. Lets the operator see who first reached
    // them via Treatwell vs direct walk-in vs the online widget.
    const { rows } = await pool.query(
      `SELECT
         c.id,
         c.name,
         c.phone,
         c.email,
         c.date_of_birth,
         c.marketing_consent,
         c.unsubscribed_at,
         c.gdpr_consent,
         c.created_at,
         COUNT(a.id) FILTER (WHERE a.status NOT IN ('cancelled','no_show')) AS total_visits,
         MIN(a.starts_at) FILTER (WHERE a.status NOT IN ('cancelled','no_show')) AS first_visit,
         MAX(a.starts_at) FILTER (WHERE a.status NOT IN ('cancelled','no_show')) AS last_visit,
         COALESCE(SUM(b.total) FILTER (WHERE b.payment_status = 'paid'), 0) AS total_spend,
         (
           SELECT a2.source FROM appointments a2
           WHERE a2.client_id = c.id AND a2.status NOT IN ('cancelled','no_show')
           ORDER BY a2.starts_at ASC NULLS LAST LIMIT 1
         ) AS acquisition_source
       FROM clients c
       LEFT JOIN appointments a ON a.client_id = c.id
       LEFT JOIN bills        b ON b.appointment_id = a.id
       ${where}
       GROUP BY c.id
       ORDER BY MAX(a.starts_at) DESC NULLS LAST, c.name ASC
       LIMIT 500`,
      params,
    );
    // Cast Postgres numerics / counts to plain JS numbers for the client.
    const clients = rows.map((r) => ({
      ...r,
      total_visits: Number(r.total_visits || 0),
      total_spend:  Number(r.total_spend  || 0),
    }));
    res.json({ clients });
  } catch (err) {
    console.error('[clients] list', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/clients/:id  — profile + medical + appointment history
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const c = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'not found' });
    const m = await pool.query('SELECT * FROM client_medical WHERE client_id = $1 ORDER BY updated_at DESC LIMIT 1', [id]);
    const a = await pool.query(
      `SELECT a.*, t.name AS treatment_name, th.name AS therapist_name,
              b.payment_method, b.total AS bill_total
       FROM appointments a
       LEFT JOIN treatments t  ON t.id  = a.treatment_id
       LEFT JOIN therapists th ON th.id = a.therapist_id
       LEFT JOIN bills b ON b.id = (
         SELECT id FROM bills WHERE appointment_id = a.id ORDER BY id DESC LIMIT 1
       )
       WHERE a.client_id = $1
       ORDER BY a.starts_at DESC LIMIT 50`,
      [id],
    );
    res.json({ client: c.rows[0], medical: m.rows[0] || null, appointments: a.rows });
  } catch (err) {
    console.error('[clients] get', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/clients
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO clients
         (name, phone, email, date_of_birth, emergency_contact_name, emergency_contact_phone,
          gp_name, gp_surgery, gdpr_consent, gdpr_consent_at, marketing_consent, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9 THEN now() ELSE NULL END, $10, $11)
       RETURNING *`,
      [
        b.name, b.phone || null, b.email || null, b.date_of_birth || null,
        b.emergency_contact_name || null, b.emergency_contact_phone || null,
        b.gp_name || null, b.gp_surgery || null,
        !!b.gdpr_consent, !!b.marketing_consent, b.notes || null,
      ],
    );
    await offlineQueue.enqueue('create_client', { localId: rows[0].id });
    res.status(201).json({ client: rows[0] });
  } catch (err) {
    console.error('[clients] create', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/clients/:id
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE clients SET
         name                    = COALESCE($2, name),
         phone                   = COALESCE($3, phone),
         email                   = COALESCE($4, email),
         date_of_birth           = COALESCE($5, date_of_birth),
         emergency_contact_name  = COALESCE($6, emergency_contact_name),
         emergency_contact_phone = COALESCE($7, emergency_contact_phone),
         gp_name                 = COALESCE($8, gp_name),
         gp_surgery              = COALESCE($9, gp_surgery),
         gdpr_consent            = COALESCE($10, gdpr_consent),
         gdpr_consent_at         = CASE WHEN $10 = TRUE AND gdpr_consent IS DISTINCT FROM TRUE THEN now()
                                        ELSE gdpr_consent_at END,
         marketing_consent       = COALESCE($11, marketing_consent),
         notes                   = COALESCE($12, notes)
       WHERE id = $1 RETURNING *`,
      [
        id, b.name, b.phone, b.email, b.date_of_birth,
        b.emergency_contact_name, b.emergency_contact_phone,
        b.gp_name, b.gp_surgery,
        b.gdpr_consent, b.marketing_consent, b.notes,
      ],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    await offlineQueue.enqueue('update_client', { localId: id });
    res.json({ client: rows[0] });
  } catch (err) {
    console.error('[clients] update', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/clients/:id/medical
router.get('/:id/medical', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM client_medical WHERE client_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [id],
    );
    res.json({ medical: rows[0] || null });
  } catch (err) {
    console.error('[clients] medical get', err);
    res.status(500).json({ error: 'server error' });
  }
});

// SEPOS-SPA-BUGHUNT C1 — the medical write used to hard-code 18 columns, so the
// expanded intake fields (autoimmune_disorder, blood_clots, neuropathy,
// pregnancy_months, reason_for_massage, pressure_preference, …) the form sends
// were SILENTLY DROPPED — a clinical-safety + GDPR record bug. We now write every
// writable column the table actually has (cross-DB catalog lookup, like sync.js),
// so the column list can never drift from the schema again.
const MEDICAL_NONWRITABLE = new Set(['id', 'client_id', 'signed_at', 'updated_at', 'created_at', 'cloud_id']);
let _medicalColsCache = null;
async function medicalWritableColumns() {
  if (_medicalColsCache) return _medicalColsCache;
  let cols;
  if ((process.env.DB_MODE || '').toLowerCase() === 'local') {
    const r = await pool.query(`PRAGMA table_info(client_medical)`);
    cols = r.rows.map((c) => c.name);
  } else {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      ['client_medical'],
    );
    cols = r.rows.map((c) => c.column_name);
  }
  // digital_signature is handled separately (drives signed_at); exclude metadata.
  _medicalColsCache = cols.filter((c) => !MEDICAL_NONWRITABLE.has(c) && c !== 'digital_signature');
  return _medicalColsCache;
}

// PUT /api/clients/:id/medical  — upsert (one active record per client)
router.put('/:id/medical', async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  // SEPOS-SPA-BUGHUNT L2 — the check-then-write upsert used to run the existence
  // SELECT and the UPDATE/INSERT as two separate queries with no transaction, so
  // two concurrent saves for the same client could both miss the existing row and
  // each INSERT, leaving duplicate medical records. We now run the read + write in
  // one transaction on a single pooled connection, taking a row lock
  // (SELECT … FOR UPDATE) so concurrent saves serialise instead of racing.
  const client = await pool.connect();
  try {
    const writable = await medicalWritableColumns();
    // Persist only keys the caller actually sent with a real value. Omitting a
    // NOT NULL column lets its schema DEFAULT apply on INSERT (and leaves the
    // existing value untouched on UPDATE), so we never hit a NOT NULL violation
    // by writing an explicit NULL. The form sends every field (false / '' for
    // empties), so in practice the whole questionnaire is now saved.
    const keys = writable.filter((c) => b[c] !== undefined && b[c] !== null);
    const hasSig = b.digital_signature !== undefined && b.digital_signature !== null && b.digital_signature !== '';

    await client.query('BEGIN');
    const exists = await client.query('SELECT id FROM client_medical WHERE client_id = $1 LIMIT 1 FOR UPDATE', [id]);

    if (exists.rows[0]) {
      const setParts = keys.map((c, i) => `${c} = $${i + 2}`);
      const params = [id, ...keys.map((k) => b[k])];
      if (hasSig) { setParts.push(`digital_signature = $${params.length + 1}`, 'signed_at = now()'); params.push(b.digital_signature); }
      setParts.push('updated_at = now()');
      const { rows } = await client.query(
        `UPDATE client_medical SET ${setParts.join(', ')} WHERE client_id = $1 RETURNING *`,
        params,
      );
      await client.query('COMMIT');
      await offlineQueue.enqueue('save_medical', { localId: rows[0].id });
      return res.json({ medical: rows[0] });
    }

    const insertCols = ['client_id', ...keys];
    const params = [id, ...keys.map((k) => b[k])];
    if (hasSig) { insertCols.push('digital_signature'); params.push(b.digital_signature); }
    const ph = insertCols.map((_, i) => `$${i + 1}`);
    const signedCol = hasSig ? ', signed_at' : '';
    const signedVal = hasSig ? ', now()' : '';
    const { rows } = await client.query(
      `INSERT INTO client_medical (${insertCols.join(', ')}${signedCol})
       VALUES (${ph.join(', ')}${signedVal}) RETURNING *`,
      params,
    );
    await client.query('COMMIT');
    await offlineQueue.enqueue('save_medical', { localId: rows[0].id });
    res.status(201).json({ medical: rows[0] });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    console.error('[clients] medical put', err);
    res.status(500).json({ error: 'server error' });
  } finally {
    client.release();
  }
});

// DELETE /api/clients/:id  — GDPR erasure (permanent). Admin only.
// Logs to console for audit; in production we'd write to an audit table.
// POST /api/clients/:id/merge  { duplicate_id }
// SPA-CLIENT-MERGE (Highbury request) — receptionist typos create duplicate
// client records, splitting one person's history/spend across rows. Merge
// moves EVERYTHING from the duplicate onto the kept client, fills the kept
// record's blank contact fields from the duplicate, then deletes the duplicate
// with a sync tombstone (same pattern as GDPR delete) so tills drop it too.
// Reception-level on purpose: they're the ones who spot dupes day-to-day, and
// merge preserves history (unlike delete, which stays admin-only).
router.post('/:id/merge', requireRole('admin', 'manager', 'reception'), async (req, res) => {
  const keepId = Number(req.params.id);
  const dupId  = Number(req.body?.duplicate_id);
  if (!keepId || !dupId) return res.status(400).json({ error: 'duplicate_id required' });
  if (keepId === dupId)  return res.status(400).json({ error: 'cannot merge a client into itself' });
  // Cloud-only: on a local till the reassigns would need per-row cloud_id
  // translation through the sync queue. Highbury runs the cloud admin; keep
  // the till path honest rather than half-synced.
  if (offlineQueue.isLocal) {
    return res.status(501).json({ error: 'Merging clients is done in the cloud admin (your online dashboard), not on the till.' });
  }
  const client = await pool.connect();
  try {
    const both = await client.query('SELECT * FROM clients WHERE id = ANY($1)', [[keepId, dupId]]);
    const keep = both.rows.find((r) => r.id === keepId);
    const dup  = both.rows.find((r) => r.id === dupId);
    if (!keep || !dup) { client.release(); return res.status(404).json({ error: 'client not found' }); }

    await client.query('BEGIN');
    // Fill the kept record's blanks from the duplicate (never overwrite what
    // the kept record already has). Consent: the person consented under either
    // identity → OR the flags; but an unsubscribe on either record sticks.
    await client.query(
      `UPDATE clients SET
         phone         = COALESCE(NULLIF(phone, ''), $2),
         email         = COALESCE(NULLIF(email, ''), $3),
         date_of_birth = COALESCE(date_of_birth, $4),
         gdpr_consent      = (gdpr_consent OR $5),
         marketing_consent = (marketing_consent OR $6),
         unsubscribed_at   = COALESCE(unsubscribed_at, $7)
       WHERE id = $1`,
      [keepId, dup.phone || null, dup.email || null, dup.date_of_birth || null,
       !!dup.gdpr_consent, !!dup.marketing_consent, dup.unsubscribed_at || null],
    );
    // Reassign every record that points at the duplicate.
    const moved = {};
    for (const [table, col] of [
      ['appointments', 'client_id'], ['vouchers', 'client_id'],
      ['loyalty_events', 'client_id'], ['wallet_passes', 'client_id'],
    ]) {
      const r = await client.query(`UPDATE ${table} SET ${col} = $1 WHERE ${col} = $2`, [keepId, dupId]);
      moved[table] = r.rowCount || 0;
    }
    // client_medical is UNIQUE per client: move the duplicate's form over only
    // if the kept client has none; otherwise the kept client's form wins.
    const keptMed = await client.query('SELECT id FROM client_medical WHERE client_id = $1', [keepId]);
    if (keptMed.rows.length) {
      await client.query('DELETE FROM client_medical WHERE client_id = $1', [dupId]);
    } else {
      const r = await client.query('UPDATE client_medical SET client_id = $1 WHERE client_id = $2', [keepId, dupId]);
      moved.client_medical = r.rowCount || 0;
    }
    // Delete the duplicate + tombstone so every till's next pull drops it.
    await client.query('DELETE FROM clients WHERE id = $1', [dupId]);
    await client.query('INSERT INTO deleted_records (entity, cloud_id) VALUES ($1, $2)', ['client', dupId]);
    await client.query('COMMIT');
    console.log(`[client-merge] #${dupId} ("${dup.name}") merged into #${keepId} ("${keep.name}") by staff id=${req.staff.id} — moved ${JSON.stringify(moved)}`);
    res.json({ ok: true, kept_id: keepId, merged_id: dupId, moved });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    console.error('[clients] merge', err);
    res.status(500).json({ error: 'server error' });
  } finally {
    client.release();
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    // SEPOS-SPA-BUGHUNT C1 — select only the base columns that exist in BOTH the
    // cloud Postgres and local SQLite schemas. `cloud_id` exists ONLY on local
    // SQLite, so selecting it unconditionally 500'd every erasure on the cloud
    // (the GDPR-critical path) and no deletion/tombstone ever happened. We now
    // fetch cloud_id separately INSIDE the local-only branch below.
    const c = await pool.query('SELECT id, name, email, phone FROM clients WHERE id = $1', [id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'not found' });

    // On a desktop till, erasure must reach the cloud (and thence every other
    // till) to be a true GDPR deletion. Block it offline so we never leave a
    // copy elsewhere that we can't confirm was wiped. This gate must run BEFORE
    // the G2/G3 scrubs below — otherwise a refused (offline) erasure would have
    // already destroyed the notes + transcript while the client itself remains.
    if (offlineQueue.isLocal && isOffline()) {
      return res.status(503).json({
        error: 'offline', offline: true,
        message: 'Erasing a client needs an internet connection so the deletion reaches the cloud and all devices. Please try again when back online.',
      });
    }

    // SEPOS-SPA-AUDIT G3 — scrub free-text appointment notes (may hold health
    // notes) BEFORE the delete: the appointments FK is ON DELETE SET NULL, so
    // afterwards the rows survive de-identified but the notes would linger.
    try { await pool.query('UPDATE appointments SET notes = NULL WHERE client_id = $1', [id]); }
    catch (e) { console.warn('[gdpr-erase] notes scrub failed:', e.message); }
    // SEPOS-SPA-AUDIT G2 — erasure must also wipe the WhatsApp concierge
    // transcript (keyed by phone, no FK cascade to clients); it can hold
    // health-adjacent disclosures. Guarded so a missing table (older till
    // schema) never breaks the GDPR-critical delete path.
    if (c.rows[0].phone) {
      try { await pool.query('DELETE FROM concierge_conversations WHERE phone = $1', [c.rows[0].phone]); }
      catch (e) { console.warn('[gdpr-erase] concierge transcript wipe skipped:', e.message); }
    }

    if (offlineQueue.isLocal) {
      // cloud_id exists only on the local SQLite schema — fetch it here, on the
      // local path, so the cloud path never references a missing column.
      const cl = await pool.query('SELECT cloud_id FROM clients WHERE id = $1', [id]);
      const cloudId = cl.rows[0] ? cl.rows[0].cloud_id : null;
      await pool.query('DELETE FROM clients WHERE id = $1', [id]); // cascades to client_medical
      // Push the erasure up; the cloud deletes its copy + writes a tombstone so
      // other tills wipe their local copy on their next pull.
      if (cloudId != null) await offlineQueue.enqueue('delete_client', { cloud_id: cloudId });
    } else {
      // Cloud: delete + record a tombstone so every offline till erases too.
      await pool.query('DELETE FROM clients WHERE id = $1', [id]); // cascades to client_medical
      await pool.query('INSERT INTO deleted_records (entity, cloud_id) VALUES ($1, $2)', ['client', id]);
    }

    // SEPOS-SPA-AUDIT G3 — audit line logs IDs only; don't copy the erased
    // name/email into log storage (that's a persistent copy of the PII we
    // just erased). The client id + staff id are enough for an audit trail.
    console.warn(
      `[gdpr-erase] client id=${id} deleted by staff id=${req.staff.id} at ${new Date().toISOString()}`,
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[clients] delete', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
