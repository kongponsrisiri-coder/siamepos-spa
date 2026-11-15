const express = require('express');
const { pool } = require('../db/dbAdapter');
const { requireRole } = require('../middleware/auth');
const offlineQueue = require('../services/offlineQueue');
const { isOffline } = require('../services/syncService');
const clientMatch = require('../services/clientMatch'); // SPA-CLIENT-FUZZY-001
const clientMerge = require('../services/clientMerge'); // SPA-CLIENT-MERGE-002
const { denyAction } = require('../services/permissions');

const router = express.Router();

// SPA-CLIENT-FUZZY-001 — any client write here refreshes the search cache
// (bookings made elsewhere, e.g. Treatwell imports, catch up within a minute).
router.use((req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => clientMatch.invalidate());
  next();
});

// GET /api/clients?q=name_or_phone
// Returns the client list enriched with visit + spend stats so both the
// top-level Clients screen and the Admin → Clients CRM dashboard can
// render in one round-trip. Stats come from a LEFT JOIN against
// appointments (excluding cancelled / no-show) and bills (paid only) —
// any client with no appointments still appears with zeros, so newly
// created profiles aren't hidden.
// SPA-SEARCH-001 — type-ahead search.
// GET /api/clients/search?q=s  → up to 25 matches, no aggregates, ranked:
//   1 name/alias STARTS WITH q   2 any later WORD starts with q
//   3 phone digits / email start with q   4 contains q anywhere
// Case-insensitive throughout. Backs the Clients dropdown and the booking
// form, so one keystroke returns instantly; the heavier list query below
// still powers the full list with visits and spend.
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ clients: [] });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 50);
  try {
    const pre  = `${q.toLowerCase()}%`;
    const word = `% ${q.toLowerCase()}%`;
    const any  = `%${q.toLowerCase()}%`;
    const digits = q.replace(/[^0-9]/g, '');
    const { rows } = await pool.query(
      `SELECT id, name, alias, phone, email,
              CASE
                WHEN lower(name) LIKE $1 OR lower(COALESCE(alias,'')) LIKE $1 THEN 1
                WHEN lower(name) LIKE $2 OR lower(COALESCE(alias,'')) LIKE $2 THEN 2
                WHEN lower(COALESCE(email,'')) LIKE $1
                  OR ($4 <> '' AND replace(replace(COALESCE(phone,''),' ',''),'-','') LIKE $4 || '%') THEN 3
                ELSE 4
              END AS rank
         FROM clients
        WHERE lower(name) LIKE $3
           OR lower(COALESCE(alias,'')) LIKE $3
           OR lower(COALESCE(email,'')) LIKE $3
           OR ($4 <> '' AND replace(replace(COALESCE(phone,''),' ',''),'-','') LIKE '%' || $4 || '%')
        ORDER BY rank, name ASC
        LIMIT $5`,
      [pre, word, any, digits, limit],
    );
    // SPA-CLIENT-FUZZY-001 — top up with forgiving matches (typos, sound-alikes,
    // surname-first, accents, "07911…" vs "+44 7911…"). Exact hits stay first;
    // fuzzy-only rows carry approx:true so the till can label them
    // "Possible matches".
    let approximate = false;
    if (rows.length < limit) {
      const seen = new Set(rows.map((r) => r.id));
      const fuzzy = await clientMatch.fuzzySearch(q, { limit: limit - rows.length, excludeIds: seen });
      for (const f of fuzzy) rows.push({ id: f.id, name: f.name, alias: f.alias, phone: f.phone, email: f.email, rank: 5, approx: f.score < 1 });
      approximate = fuzzy.some((f) => f.score < 1);   // "Smith John" = same words, not a guess
    }
    res.json({ clients: rows, approximate });
  } catch (err) {
    console.error('[clients] search', err);
    res.status(500).json({ error: 'server error' });
  }
});

// SPA-CLIENT-FUZZY-001 — "This looks like [name]. Use existing profile?"
// GET /api/clients/likely-duplicates?name=&phone=&email=[&exclude=id]
// → existing clients with the same phone, same email, or a near-identical
// full name. The till asks before saving a new profile.
router.get('/likely-duplicates', async (req, res) => {
  try {
    const { name, phone, email, exclude } = req.query;
    const clients = await clientMatch.findLikelyDuplicates({ name, phone, email }, { excludeId: exclude || null });
    res.json({ clients });
  } catch (err) {
    console.error('[clients] likely-duplicates', err);
    res.status(500).json({ error: 'server error' });
  }
});

// ── SPA-CLIENT-MERGE-002 — duplicates review ─────────────────────────────
// GET /api/clients/possible-duplicates → pairs to review, best evidence first:
// pairs reception FLAGGED, then same phone / email / name. Pairs a manager
// marked "not duplicates" never come back.
router.get('/possible-duplicates', async (req, res) => {
  try {
    const flags = (await pool.query('SELECT client_a, client_b, status, note FROM client_duplicate_flags')).rows;
    const flagOf = new Map(flags.map((f) => [`${f.client_a}:${f.client_b}`, f]));
    const pairs = (await clientMatch.findDuplicatePairs())
      .filter((p) => (flagOf.get(`${p.a.id}:${p.b.id}`) || {}).status !== 'not_duplicate');
    const seen = new Set(pairs.map((p) => `${p.a.id}:${p.b.id}`));
    // Flagged pairs the matcher didn't spot (e.g. two quite different names).
    const extra = flags.filter((f) => f.status === 'flagged' && !seen.has(`${f.client_a}:${f.client_b}`));
    if (extra.length) {
      const ids = [...new Set(extra.flatMap((f) => [f.client_a, f.client_b]))];
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const rows = (await pool.query(`SELECT id, name, alias, phone, email FROM clients WHERE id IN (${ph})`, ids)).rows;
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const f of extra) {
        if (byId.get(f.client_a) && byId.get(f.client_b)) pairs.push({ a: byId.get(f.client_a), b: byId.get(f.client_b), reasons: [] });
      }
    }
    const out = pairs.map((p) => {
      const f = flagOf.get(`${p.a.id}:${p.b.id}`);
      return { ...p, flagged: !!(f && f.status === 'flagged'), note: f ? f.note : null };
    });
    out.sort((x, y) => Number(y.flagged) - Number(x.flagged));
    res.json({ pairs: out.slice(0, 200), total: out.length });
  } catch (err) {
    console.error('[clients] possible-duplicates', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/clients/duplicate-flags { client_a, client_b, note? } — any staff:
// "these two look like the same person" for a manager to review.
router.post('/duplicate-flags', async (req, res) => {
  const a = Number(req.body?.client_a), b = Number(req.body?.client_b);
  if (!a || !b || a === b) return res.status(400).json({ error: 'two different clients required' });
  const [lo, hi] = a < b ? [a, b] : [b, a];
  try {
    await pool.query(
      `INSERT INTO client_duplicate_flags (client_a, client_b, note, flagged_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_a, client_b) DO UPDATE SET status = 'flagged', note = COALESCE(EXCLUDED.note, client_duplicate_flags.note),
         flagged_by = EXCLUDED.flagged_by, resolved_by = NULL, resolved_at = NULL`,
      [lo, hi, (req.body?.note || '').toString().slice(0, 300) || null, req.staff?.id ?? null],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[clients] duplicate-flags', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/clients/duplicate-flags/not-duplicate { client_a, client_b } —
// manager/admin: they're different people; stop suggesting the pair.
router.post('/duplicate-flags/not-duplicate', async (req, res) => {
  if (await denyAction(req, res, 'merge_clients')) return;
  const a = Number(req.body?.client_a), b = Number(req.body?.client_b);
  if (!a || !b || a === b) return res.status(400).json({ error: 'two different clients required' });
  const [lo, hi] = a < b ? [a, b] : [b, a];
  try {
    await pool.query(
      `INSERT INTO client_duplicate_flags (client_a, client_b, status, resolved_by, resolved_at) VALUES ($1, $2, 'not_duplicate', $3, now())
       ON CONFLICT (client_a, client_b) DO UPDATE SET status = 'not_duplicate', resolved_by = EXCLUDED.resolved_by, resolved_at = now()`,
      [lo, hi, req.staff?.id ?? null],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[clients] not-duplicate', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/clients/:id/merge-preview?duplicate_id= — what a merge would do
// (counts, resulting contacts / consent / stamps). Read-only; manager/admin.
router.get('/:id/merge-preview', async (req, res) => {
  if (await denyAction(req, res, 'merge_clients')) return;
  try {
    const p = await clientMerge.previewMerge(pool, Number(req.params.id), Number(req.query.duplicate_id));
    if (!p) return res.status(404).json({ error: 'client not found' });
    res.json(p);
  } catch (err) {
    console.error('[clients] merge-preview', err);
    res.status(500).json({ error: 'server error' });
  }
});

router.get('/', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  try {
    const params = [];
    let where = '';
    if (q) {
      // SPA-SEARCH-001 — name, alias, email or phone digits; case-insensitive.
      params.push(`%${q.toLowerCase()}%`);
      params.push(q.replace(/[^0-9]/g, ''));
      where = `WHERE lower(c.name) LIKE $1
                  OR lower(COALESCE(c.alias,'')) LIKE $1
                  OR lower(COALESCE(c.email,'')) LIKE $1
                  OR ($2 <> '' AND replace(replace(COALESCE(c.phone,''),' ',''),'-','') LIKE '%' || $2 || '%')`;
    }
    // acquisition_source = the `source` of this client's earliest
    // non-cancelled appointment. Lets the operator see who first reached
    // them via Treatwell vs direct walk-in vs the online widget.
    const { rows } = await pool.query(
      `SELECT
         c.id,
         c.name,
         c.alias,
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
          gp_name, gp_surgery, gdpr_consent, gdpr_consent_at, marketing_consent, notes, alias)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9 THEN now() ELSE NULL END, $10, $11, $12)
       RETURNING *`,
      [
        b.name, b.phone || null, b.email || null, b.date_of_birth || null,
        b.emergency_contact_name || null, b.emergency_contact_phone || null,
        b.gp_name || null, b.gp_surgery || null,
        !!b.gdpr_consent, !!b.marketing_consent, b.notes || null, b.alias || null,
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
         notes                   = COALESCE($12, notes),
         alias                   = COALESCE($13, alias)
       WHERE id = $1 RETURNING *`,
      [
        id, b.name, b.phone, b.email, b.date_of_birth,
        b.emergency_contact_name, b.emergency_contact_phone,
        b.gp_name, b.gp_surgery,
        b.gdpr_consent, b.marketing_consent, b.notes, b.alias,
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

// SPA-CLIENT-MERGE-002 — merge a duplicate profile into the main one.
// POST /api/clients/:id/merge  { duplicate_id }   (:id = the profile KEPT)
// 'merge_clients' role action: managers + admins by default (Korakot, 15 Nov
// 2026), owner-adjustable in Staff → Roles — reception flags pairs
// instead (POST /api/clients/duplicate-flags). The rules live in
// services/clientMerge.js and are shared with the sync push, so the cloud and
// an offline till merge identically. On a till the merge applies locally at
// once and is queued for the cloud:
//   • the duplicate's own pending create/update ops are dropped (its row is
//     gone — replaying them would wedge the queue);
//   • duplicate already on the cloud → queue merge_client (cloud repeats the
//     merge and tombstones the duplicate so other tills re-point);
//   • main profile already on the cloud → queue update_client so the merged
//     contacts, consent and stamps reach it.
router.post('/:id/merge', async (req, res) => {
  if (await denyAction(req, res, 'merge_clients')) return;
  const keepId = Number(req.params.id);
  const dupId  = Number(req.body?.duplicate_id);
  if (!keepId || !dupId) return res.status(400).json({ error: 'duplicate_id required' });
  const client = await pool.connect();
  let inTxn = false;
  try {
    const dupMed = await client.query('SELECT id FROM client_medical WHERE client_id = $1', [dupId]);
    await client.query('BEGIN');
    inTxn = true;
    const r = await clientMerge.mergeClients(client, keepId, dupId, {
      staffId: req.staff?.id ?? null, staffName: req.staff?.name ?? null,
    });
    await client.query('COMMIT');
    inTxn = false;

    if (offlineQueue.isLocal) {
      await offlineQueue.cancelPending(['create_client', 'update_client'], dupId, 'merged into #' + keepId);
      if (r.medical === 'main_kept' && dupMed.rows[0]) {
        await offlineQueue.cancelPending(['save_medical'], dupMed.rows[0].id, 'merged — main profile form kept');
      }
      if (r.duplicate.cloud_id != null) {
        await offlineQueue.enqueue('merge_client', {
          localId: keepId, keepLocalId: keepId,
          dupCloudId: r.duplicate.cloud_id,
          clientCloudId: r.duplicate.cloud_id,     // pull guard: don't re-insert the duplicate meanwhile
          keepCloudId: r.keep_cloud_id,            // …or overwrite the merged main profile
          loyalty_visits: r.kept.loyalty_visits, loyalty_cycle: r.kept.loyalty_cycle,
        });
      }
      if (r.keep_cloud_id != null) await offlineQueue.enqueue('update_client', { localId: keepId });
    }
    console.log(`[client-merge] #${dupId} merged into #${keepId} by staff id=${req.staff?.id} — moved ${JSON.stringify(r.moved)}, medical ${r.medical}, audit #${r.merge_id}`);
    res.json({ ok: true, kept_id: keepId, merged_id: dupId, moved: r.moved, medical: r.medical, merge_id: r.merge_id, client: r.kept });
  } catch (err) {
    if (inTxn) { try { await client.query('ROLLBACK'); } catch { /* already rolled back */ } }
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[clients] merge', err);
    res.status(500).json({ error: 'server error' });
  } finally {
    client.release();
  }
});

// DELETE /api/clients/:id  — GDPR erasure (permanent). Admin only.
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
    // SPA-CLIENT-MERGE-002 — merge audit snapshots hold the merged-away
    // profile's contact details (same person): erasure wipes them too.
    try {
      await pool.query('DELETE FROM client_merges WHERE kept_id = $1 OR merged_id = $1', [id]);
      await pool.query('DELETE FROM client_duplicate_flags WHERE client_a = $1 OR client_b = $1', [id]);
    } catch (e) { console.warn('[gdpr-erase] merge audit wipe skipped:', e.message); }

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
