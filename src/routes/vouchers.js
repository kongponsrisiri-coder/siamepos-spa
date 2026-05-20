// Voucher routes — sell, look up, redeem, track spending
const express = require('express');
const { pool } = require('../db/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Generate a unique voucher code  e.g. SPA-A1B2C3D4
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'SPA-';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// GET /api/vouchers?q=&status=
router.get('/', async (req, res) => {
  const { q, status } = req.query;
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (v.code ILIKE $${params.length} OR v.purchased_by ILIKE $${params.length} OR v.purchased_for ILIKE $${params.length})`;
    }
    if (status) { params.push(status); where += ` AND v.status = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT v.*,
              c.name  AS client_name,
              th.name AS sold_by_name
       FROM vouchers v
       LEFT JOIN clients    c  ON c.id  = v.client_id
       LEFT JOIN therapists th ON th.id = v.sold_by
       ${where}
       ORDER BY v.purchased_at DESC
       LIMIT 200`,
      params,
    );
    res.json({ vouchers: rows });
  } catch (err) {
    console.error('[vouchers] list', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/vouchers/lookup?code=SPA-XXXXXXXX  — public-ish lookup for checkout
router.get('/lookup', async (req, res) => {
  const code = (req.query.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    const { rows } = await pool.query(
      `SELECT v.*, c.name AS client_name
       FROM vouchers v
       LEFT JOIN clients c ON c.id = v.client_id
       WHERE v.code = $1`,
      [code],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Voucher not found' });
    const v = rows[0];
    // Auto-expire check
    if (v.status === 'active' && v.expires_at && new Date(v.expires_at) < new Date()) {
      await pool.query("UPDATE vouchers SET status = 'expired' WHERE id = $1", [v.id]);
      v.status = 'expired';
    }
    res.json({ voucher: v });
  } catch (err) {
    console.error('[vouchers] lookup', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/vouchers/:id  — detail + redemption history
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const v = await pool.query(
      `SELECT v.*, c.name AS client_name, th.name AS sold_by_name
       FROM vouchers v
       LEFT JOIN clients    c  ON c.id  = v.client_id
       LEFT JOIN therapists th ON th.id = v.sold_by
       WHERE v.id = $1`,
      [id],
    );
    if (!v.rows[0]) return res.status(404).json({ error: 'not found' });
    const r = await pool.query(
      `SELECT vr.*, th.name AS redeemed_by_name
       FROM voucher_redemptions vr
       LEFT JOIN therapists th ON th.id = vr.redeemed_by
       WHERE vr.voucher_id = $1
       ORDER BY vr.redeemed_at DESC`,
      [id],
    );
    res.json({ voucher: v.rows[0], redemptions: r.rows });
  } catch (err) {
    console.error('[vouchers] get', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/vouchers  — sell a voucher
// body: { value, purchased_by, purchased_for, client_id?, expires_at?, notes?, sold_by? }
router.post('/', async (req, res) => {
  const { value, purchased_by, purchased_for, client_id, expires_at, notes, sold_by } = req.body || {};
  if (!value || Number(value) <= 0) return res.status(400).json({ error: 'value required' });
  try {
    // Ensure unique code
    let code;
    for (let i = 0; i < 10; i++) {
      code = generateCode();
      const exists = await pool.query('SELECT id FROM vouchers WHERE code = $1', [code]);
      if (!exists.rows[0]) break;
    }
    const { rows } = await pool.query(
      `INSERT INTO vouchers
         (code, initial_value, remaining_value, purchased_by, purchased_for,
          client_id, expires_at, notes, sold_by)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [code, Number(value), purchased_by || null, purchased_for || null,
       client_id || null, expires_at || null, notes || null,
       sold_by || req.staff?.id || null],
    );
    res.status(201).json({ voucher: rows[0] });
  } catch (err) {
    console.error('[vouchers] create', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/vouchers/:id  — update details (link client, notes, etc.)
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { purchased_by, purchased_for, client_id, expires_at, notes, status } = req.body || {};
  try {
    const allowed = ['active', 'cancelled'];
    const { rows } = await pool.query(
      `UPDATE vouchers SET
         purchased_by  = COALESCE($2, purchased_by),
         purchased_for = COALESCE($3, purchased_for),
         client_id     = COALESCE($4, client_id),
         expires_at    = COALESCE($5, expires_at),
         notes         = COALESCE($6, notes),
         status        = CASE WHEN $7 = ANY($8::text[]) THEN $7 ELSE status END
       WHERE id = $1 RETURNING *`,
      [id, purchased_by, purchased_for, client_id, expires_at, notes,
       status || null, allowed],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ voucher: rows[0] });
  } catch (err) {
    console.error('[vouchers] update', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/vouchers/:id/redeem
// body: { amount, bill_id?, notes? }
// Deducts amount from remaining_value, records who redeemed it.
router.post('/:id/redeem', async (req, res) => {
  const id = Number(req.params.id);
  const { amount, bill_id, notes } = req.body || {};
  const amtNum = Number(amount);
  if (!amtNum || amtNum <= 0) return res.status(400).json({ error: 'amount required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: vRows } = await client.query(
      'SELECT * FROM vouchers WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!vRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    const v = vRows[0];

    if (v.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Voucher is ${v.status}` });
    }
    if (v.expires_at && new Date(v.expires_at) < new Date()) {
      await client.query("UPDATE vouchers SET status = 'expired' WHERE id = $1", [id]);
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Voucher has expired' });
    }
    const deduct = Math.min(amtNum, Number(v.remaining_value));
    const newRemaining = +(Number(v.remaining_value) - deduct).toFixed(2);
    const newStatus = newRemaining <= 0 ? 'used' : 'active';

    await client.query(
      'UPDATE vouchers SET remaining_value = $2, status = $3 WHERE id = $1',
      [id, newRemaining, newStatus],
    );
    const { rows: rRows } = await client.query(
      `INSERT INTO voucher_redemptions
         (voucher_id, bill_id, amount_used, redeemed_by, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, bill_id || null, deduct, req.staff?.id || null, notes || null],
    );
    await client.query('COMMIT');

    res.json({ redemption: rRows[0], amount_used: deduct, remaining_value: newRemaining });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[vouchers] redeem', err);
    res.status(500).json({ error: 'server error' });
  } finally {
    client.release();
  }
});

// DELETE /api/vouchers/:id  — cancel (admin only)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows } = await pool.query(
      "UPDATE vouchers SET status = 'cancelled' WHERE id = $1 RETURNING *",
      [id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[vouchers] delete', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
