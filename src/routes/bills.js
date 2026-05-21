const express = require('express');
const { pool } = require('../db/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// POST /api/bills  body: { appointment_id }
// Creates a pending bill from the appointment's treatment price.
router.post('/', async (req, res) => {
  const { appointment_id } = req.body || {};
  if (!appointment_id) return res.status(400).json({ error: 'appointment_id required' });
  try {
    const existing = await pool.query(
      'SELECT * FROM bills WHERE appointment_id = $1 LIMIT 1',
      [appointment_id],
    );
    if (existing.rows[0]) return res.json({ bill: existing.rows[0] });

    const ap = await pool.query(
      `SELECT a.id, t.price
       FROM appointments a LEFT JOIN treatments t ON t.id = a.treatment_id
       WHERE a.id = $1`,
      [appointment_id],
    );
    if (!ap.rows[0]) return res.status(404).json({ error: 'appointment not found' });
    const subtotal = ap.rows[0].price || 0;

    const { rows } = await pool.query(
      `INSERT INTO bills (appointment_id, subtotal, tip, total)
       VALUES ($1, $2, 0, $2) RETURNING *`,
      [appointment_id, subtotal],
    );
    res.status(201).json({ bill: rows[0] });
  } catch (err) {
    console.error('[bills] create', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/bills/:id/tip  body: { tip }
router.put('/:id/tip', async (req, res) => {
  const id = Number(req.params.id);
  const { tip } = req.body || {};
  const tipNum = Number(tip);
  if (Number.isNaN(tipNum) || tipNum < 0) return res.status(400).json({ error: 'invalid tip' });
  try {
    const { rows } = await pool.query(
      `UPDATE bills SET tip = $2, total = subtotal + $2
       WHERE id = $1 RETURNING *`,
      [id, tipNum],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ bill: rows[0] });
  } catch (err) {
    console.error('[bills] tip', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/bills/:id/pay
//   body: { method, split_payments? }
//
//   method 'split' takes an additional body field split_payments — an
//   array of { method: 'cash'|'card'|'voucher', amount } whose amounts
//   must sum to the bill total (±£0.01 for float jitter). The breakdown
//   is stored on the bill row so reports can attribute the underlying
//   cash/card portions correctly instead of lumping into "split".
//
// 'treatwell' means the booking was paid through the Treatwell marketplace —
// the customer's card was charged by Treatwell, who'll settle (minus
// commission) on their statement. We mark the bill paid so it closes
// cleanly, but Reports → "by source" lets the owner see Treatwell vs
// direct revenue so they don't double-count cash flow.
router.post('/:id/pay', async (req, res) => {
  const id = Number(req.params.id);
  const { method, split_payments } = req.body || {};
  if (!['cash', 'card', 'split', 'voucher', 'treatwell'].includes(method)) {
    return res.status(400).json({ error: 'invalid method' });
  }
  let splitJson = null;
  if (method === 'split') {
    if (!Array.isArray(split_payments) || split_payments.length === 0) {
      return res.status(400).json({ error: 'split_payments required when method=split' });
    }
    const ALLOWED = ['cash', 'card', 'voucher'];
    const clean = [];
    for (const p of split_payments) {
      const m = String(p.method || '').toLowerCase();
      const a = Number(p.amount);
      if (!ALLOWED.includes(m)) return res.status(400).json({ error: `split_payments: bad method "${p.method}"` });
      if (!isFinite(a) || a <= 0)  return res.status(400).json({ error: `split_payments: amount must be > 0` });
      clean.push({ method: m, amount: +a.toFixed(2) });
    }
    // Validate sum against the bill total
    const totalRes = await pool.query('SELECT total FROM bills WHERE id = $1', [id]);
    if (!totalRes.rows[0]) return res.status(404).json({ error: 'not found' });
    const billTotal = Number(totalRes.rows[0].total);
    const sum = +clean.reduce((s, p) => s + p.amount, 0).toFixed(2);
    if (Math.abs(sum - billTotal) > 0.01) {
      return res.status(400).json({ error: `split_payments sum £${sum.toFixed(2)} does not match bill total £${billTotal.toFixed(2)}` });
    }
    splitJson = JSON.stringify(clean);
  }
  try {
    const { rows } = await pool.query(
      `UPDATE bills SET
         payment_method = $2,
         split_payments = $3::jsonb,
         payment_status = 'paid',
         closed_at      = now()
       WHERE id = $1 RETURNING *`,
      [id, method, splitJson],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    // Mark the appointment completed as a side-effect of taking payment.
    await pool.query(
      `UPDATE appointments SET status = 'completed'
       WHERE id = $1 AND status NOT IN ('cancelled','no_show')`,
      [rows[0].appointment_id],
    );
    res.json({ bill: rows[0] });
  } catch (err) {
    console.error('[bills] pay', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/bills?from=&to=
router.get('/', async (req, res) => {
  const { from, to } = req.query;
  try {
    const params = [];
    let where = "WHERE b.closed_at IS NOT NULL";
    if (from) { params.push(from); where += ` AND b.closed_at::date >= $${params.length}::date`; }
    if (to)   { params.push(to);   where += ` AND b.closed_at::date <= $${params.length}::date`; }
    const { rows } = await pool.query(
      `SELECT b.*, a.starts_at, t.name AS treatment_name, c.name AS client_name
       FROM bills b
       LEFT JOIN appointments a ON a.id = b.appointment_id
       LEFT JOIN treatments   t ON t.id = a.treatment_id
       LEFT JOIN clients      c ON c.id = a.client_id
       ${where}
       ORDER BY b.closed_at DESC
       LIMIT 500`,
      params,
    );
    res.json({ bills: rows });
  } catch (err) {
    console.error('[bills] list', err);
    res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/bills/:id  — admin/manager only, resets appointment to booked
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM bills WHERE id = $1', [id]);
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Bill not found' }); }
    const bill = rows[0];
    // Reset the linked appointment back to 'booked' so it can be re-processed
    if (bill.appointment_id) {
      await client.query(
        `UPDATE appointments SET status = 'booked' WHERE id = $1`,
        [bill.appointment_id],
      );
    }
    await client.query('DELETE FROM bills WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[bills] delete', err);
    res.status(500).json({ error: 'server error' });
  } finally { client.release(); }
});

module.exports = router;
