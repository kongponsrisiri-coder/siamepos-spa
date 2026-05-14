const express = require('express');
const { pool } = require('../db/database');

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

// POST /api/bills/:id/pay  body: { method: 'cash'|'card'|'split' }
router.post('/:id/pay', async (req, res) => {
  const id = Number(req.params.id);
  const { method } = req.body || {};
  if (!['cash', 'card', 'split'].includes(method)) {
    return res.status(400).json({ error: 'invalid method' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE bills SET
         payment_method = $2,
         payment_status = 'paid',
         closed_at      = now()
       WHERE id = $1 RETURNING *`,
      [id, method],
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

module.exports = router;
