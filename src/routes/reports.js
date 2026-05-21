const express = require('express');
const { pool } = require('../db/database');

const router = express.Router();

function today() {
  return new Date().toISOString().slice(0, 10);
}

// GET /api/reports/trading?date=YYYY-MM-DD  (default: today)
router.get('/trading', async (req, res) => {
  const date = req.query.date || today();
  try {
    const totals = await pool.query(
      `SELECT
         COALESCE(SUM(total), 0)::numeric  AS revenue,
         COALESCE(SUM(tip), 0)::numeric    AS tips,
         COUNT(*)::int                     AS bill_count
       FROM bills WHERE closed_at::date = $1::date`,
      [date],
    );
    const appts = await pool.query(
      `SELECT
         (COUNT(*) FILTER (WHERE status NOT IN ('cancelled','no_show')))::int AS appt_count,
         (COUNT(*) FILTER (WHERE status = 'no_show'))::int                    AS no_shows,
         (COUNT(*) FILTER (WHERE status = 'cancelled'))::int                  AS cancelled
       FROM appointments WHERE starts_at::date = $1::date`,
      [date],
    );
    const top = await pool.query(
      `SELECT t.id, t.name, COUNT(*)::int AS bookings, COALESCE(SUM(b.total),0)::numeric AS revenue
       FROM bills b
       JOIN appointments a ON a.id = b.appointment_id
       JOIN treatments   t ON t.id = a.treatment_id
       WHERE b.closed_at::date = $1::date
       GROUP BY t.id, t.name
       ORDER BY revenue DESC
       LIMIT 10`,
      [date],
    );
    const byMethod = await pool.query(
      `SELECT payment_method, COUNT(*)::int AS n, COALESCE(SUM(total),0)::numeric AS revenue
       FROM bills WHERE closed_at::date = $1::date
       GROUP BY payment_method`,
      [date],
    );
    // SPA-003 — source split: how many of today's appointments came from
    // Treatwell vs direct (walk-in / online widget / staff). Revenue side
    // joins bills so we can also see Treatwell vs direct income; Treatwell
    // revenue is what the spa would book on their books even though the
    // cash flow comes via Treatwell minus commission.
    const bySource = await pool.query(
      `SELECT
         COALESCE(a.source, 'unknown') AS source,
         COUNT(DISTINCT a.id)::int AS appointments,
         COUNT(b.id)::int          AS bills,
         COALESCE(SUM(b.total), 0)::numeric AS revenue
       FROM appointments a
       LEFT JOIN bills b
         ON b.appointment_id = a.id AND b.closed_at::date = $1::date
       WHERE a.starts_at::date = $1::date
         AND a.status NOT IN ('cancelled','no_show')
       GROUP BY COALESCE(a.source, 'unknown')
       ORDER BY appointments DESC`,
      [date],
    );
    // SPA-VOUCHER-004 — voucher sales taken today. Tracked separately
    // from bill revenue because vouchers are deferred revenue (money in,
    // service not yet delivered). The frontend renders this in its own
    // block alongside the bill totals so the owner can see both.
    const voucherSales = await pool.query(
      `SELECT
         COUNT(*)::int                                AS count,
         COALESCE(SUM(initial_value), 0)::numeric     AS total
       FROM vouchers
       WHERE purchased_at::date = $1::date`,
      [date],
    );
    const voucherSalesByMethod = await pool.query(
      `SELECT
         COALESCE(payment_method, 'unknown') AS payment_method,
         COUNT(*)::int                       AS n,
         COALESCE(SUM(initial_value), 0)::numeric AS revenue
       FROM vouchers
       WHERE purchased_at::date = $1::date
       GROUP BY COALESCE(payment_method, 'unknown')
       ORDER BY revenue DESC`,
      [date],
    );
    res.json({
      date,
      totals: totals.rows[0],
      appointments: appts.rows[0],
      top_treatments: top.rows,
      by_payment_method: byMethod.rows,
      by_source: bySource.rows,
      voucher_sales: {
        count:  voucherSales.rows[0].count,
        total:  voucherSales.rows[0].total,
        by_payment_method: voucherSalesByMethod.rows,
      },
    });
  } catch (err) {
    console.error('[reports] trading', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/reports/therapist?from=&to=
router.get('/therapist', async (req, res) => {
  const { from, to } = req.query;
  try {
    const params = [];
    let where = "WHERE b.closed_at IS NOT NULL";
    if (from) { params.push(from); where += ` AND b.closed_at::date >= $${params.length}::date`; }
    if (to)   { params.push(to);   where += ` AND b.closed_at::date <= $${params.length}::date`; }
    const { rows } = await pool.query(
      `SELECT th.id, th.name,
              COUNT(b.id)::int AS bills,
              COALESCE(SUM(b.subtotal),0)::numeric AS revenue,
              COALESCE(SUM(b.tip),0)::numeric      AS tips,
              COALESCE(SUM(b.total),0)::numeric    AS total
       FROM bills b
       JOIN appointments a ON a.id = b.appointment_id
       LEFT JOIN therapists th ON th.id = a.therapist_id
       ${where}
       GROUP BY th.id, th.name
       ORDER BY revenue DESC`,
      params,
    );
    res.json({ therapists: rows });
  } catch (err) {
    console.error('[reports] therapist', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/reports/z-report?date=
router.get('/z-report', async (req, res) => {
  const date = req.query.date || today();
  try {
    const totals = await pool.query(
      `SELECT
         COALESCE(SUM(subtotal),0)::numeric AS subtotal,
         COALESCE(SUM(tip),0)::numeric      AS tips,
         COALESCE(SUM(total),0)::numeric    AS total,
         COUNT(*)::int                      AS bills
       FROM bills WHERE closed_at::date = $1::date`,
      [date],
    );
    const byMethod = await pool.query(
      `SELECT payment_method, COUNT(*)::int AS n, COALESCE(SUM(total),0)::numeric AS revenue
       FROM bills WHERE closed_at::date = $1::date
       GROUP BY payment_method`,
      [date],
    );
    const closed = await pool.query(
      `SELECT value FROM settings WHERE key = 'last_z_closed_date'`,
    );
    res.json({
      date,
      totals: totals.rows[0],
      by_payment_method: byMethod.rows,
      last_closed_date: closed.rows[0]?.value || null,
    });
  } catch (err) {
    console.error('[reports] z-report', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/reports/z-report/close  body: { date? }
// Records that the day was Z-closed. Bills stay queryable; this just stamps.
router.post('/z-report/close', async (req, res) => {
  const date = req.body?.date || today();
  try {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('last_z_closed_date', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [date],
    );
    res.json({ ok: true, closed_date: date });
  } catch (err) {
    console.error('[reports] z-close', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
