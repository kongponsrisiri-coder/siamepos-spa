const express = require('express');
const { pool } = require('../db/dbAdapter');
const { requireRole } = require('../middleware/auth');
const offlineQueue = require('../services/offlineQueue');

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

// PUT /api/clients/:id/medical  — upsert (one active record per client)
router.put('/:id/medical', async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const cols = [
    'pregnancy','heart_condition','blood_pressure','diabetes','epilepsy','cancer','dvt',
    'recent_surgery','bone_fracture','skin_condition','varicose_veins','osteoporosis','lymphoedema',
    'medications','allergies','areas_to_avoid','skin_conditions_detail','digital_signature',
  ];
  // BUG-SPA-001 fix — the schema marks the boolean columns NOT NULL DEFAULT FALSE
  // and blood_pressure NOT NULL DEFAULT 'none'. Passing an explicit NULL bypasses
  // the DEFAULT and hits the NOT NULL constraint, so when the medical record is
  // being INSERTed (no prior row) we COALESCE the placeholder to the same value
  // the schema would have used. Anything not listed here is nullable TEXT.
  const insertDefaults = {
    pregnancy: 'FALSE', heart_condition: 'FALSE', blood_pressure: "'none'",
    diabetes: 'FALSE', epilepsy: 'FALSE', cancer: 'FALSE', dvt: 'FALSE',
    recent_surgery: 'FALSE', bone_fracture: 'FALSE', skin_condition: 'FALSE',
    varicose_veins: 'FALSE', osteoporosis: 'FALSE', lymphoedema: 'FALSE',
  };
  const values = cols.map((k) => b[k] ?? null);
  try {
    const exists = await pool.query('SELECT id FROM client_medical WHERE client_id = $1 LIMIT 1', [id]);
    if (exists.rows[0]) {
      const setClause = cols.map((c, i) => `${c} = COALESCE($${i + 2}, ${c})`).join(', ');
      const signedClause = b.digital_signature ? ', signed_at = now()' : '';
      const { rows } = await pool.query(
        `UPDATE client_medical SET ${setClause}, updated_at = now() ${signedClause}
         WHERE client_id = $1 RETURNING *`,
        [id, ...values],
      );
      await offlineQueue.enqueue('save_medical', { localId: rows[0].id });
      return res.json({ medical: rows[0] });
    }
    const placeholders = cols.map((c, i) => {
      const ph = `$${i + 2}`;
      return insertDefaults[c] ? `COALESCE(${ph}, ${insertDefaults[c]})` : ph;
    }).join(', ');
    const { rows } = await pool.query(
      `INSERT INTO client_medical (client_id, ${cols.join(', ')}, signed_at)
       VALUES ($1, ${placeholders}, CASE WHEN $${cols.length + 2}::text IS NOT NULL THEN now() ELSE NULL END)
       RETURNING *`,
      [id, ...values, b.digital_signature || null],
    );
    await offlineQueue.enqueue('save_medical', { localId: rows[0].id });
    res.status(201).json({ medical: rows[0] });
  } catch (err) {
    console.error('[clients] medical put', err);
    res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/clients/:id  — GDPR erasure (permanent). Admin only.
// Logs to console for audit; in production we'd write to an audit table.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const c = await pool.query('SELECT id, name, email FROM clients WHERE id = $1', [id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'not found' });
    await pool.query('DELETE FROM clients WHERE id = $1', [id]);
    console.warn(
      `[gdpr-erase] client id=${id} name="${c.rows[0].name}" email="${c.rows[0].email || ''}" deleted by staff id=${req.staff.id} (${req.staff.name}) at ${new Date().toISOString()}`,
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[clients] delete', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
