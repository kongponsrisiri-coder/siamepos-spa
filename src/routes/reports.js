const express = require('express');
const { pool } = require('../db/dbAdapter');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Today's date in Europe/London — NOT UTC. Reports default to "today's"
// trading; on Railway (UTC server) `new Date().toISOString().slice(0,10)`
// rolls over to tomorrow at 00:00 UTC = 01:00 BST, so a London operator
// at 00:30 BST would land on yesterday's report. Using Intl with the
// spa's timezone keeps the rollover at midnight local.
function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()); // 'en-CA' yields YYYY-MM-DD
}

// Shared spa identity loader — used by every report endpoint so the
// CSV / print / on-screen header all carry the business name. Settings
// table wins; env-var fallbacks; ultimate fallback to "SiamEPOS Spa".
async function loadIdentity() {
  const ident = await pool.query(
    `SELECT key, value FROM settings WHERE key IN
       ('spa_name','spa_email','spa_address','spa_phone')`,
  );
  const map = Object.fromEntries(ident.rows.map((r) => [r.key, r.value]));
  return {
    spa_name:    map.spa_name    || process.env.SPA_NAME    || 'SiamEPOS Spa',
    spa_email:   map.spa_email   || process.env.SPA_EMAIL   || null,
    spa_address: map.spa_address || process.env.SPA_ADDRESS || null,
    spa_phone:   map.spa_phone   || null,
  };
}

// GET /api/reports/trading?date=YYYY-MM-DD  (default: today)
// Payment-method breakdown that splits each 'split' bill into its component
// methods (e.g. £30 cash + £20 card → cash & card lines, not a "split" line).
// Portable: split bills are expanded in JS rather than with Postgres-only
// `LATERAL jsonb_array_elements`, so it runs on both PG (cloud) and SQLite
// (offline till). `baseWhere` filters the bill set (date/range + refunded) and
// must NOT mention payment_method — this helper adds it. Returns { rows }.
async function billsByMethod(baseWhere, params) {
  const nonSplit = await pool.query(
    `SELECT payment_method, total AS amount FROM bills
     WHERE ${baseWhere} AND payment_method <> 'split'`,
    params,
  );
  const splitBills = await pool.query(
    `SELECT split_payments FROM bills
     WHERE ${baseWhere} AND payment_method = 'split'`,
    params,
  );
  const agg = {};
  const add = (method, amount) => {
    const m = method == null ? '' : String(method);
    if (!m) return;
    if (!agg[m]) agg[m] = { payment_method: m, n: 0, revenue: 0 };
    agg[m].n += 1;
    agg[m].revenue += Number(amount) || 0;
  };
  for (const r of nonSplit.rows) add(r.payment_method, r.amount);
  for (const r of splitBills.rows) {
    let arr = r.split_payments; // JSONB→object on PG, TEXT→string on SQLite
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
    if (Array.isArray(arr)) for (const p of arr) add(p && p.method, p && p.amount);
  }
  const rows = Object.values(agg).sort((a, b) => b.revenue - a.revenue);
  return { rows };
}

// SPA-REVENUE-CLARITY — split a day's/range's payments into two clear groups so
// the "by payment method" view is easy to understand and reconciles to revenue:
//   • money_taken  — real money in today (= Revenue): till cash/card/Treatwell +
//                    voucher SALES folded into the method they were bought with +
//                    online prepayments.
//   • already_paid — bills covered by money that came in EARLIER, so not counted
//                    again today: voucher redemptions, 'external' (already paid),
//                    and the online-deposit portion at bill close.
const MONEY_IN_METHODS = new Set(['cash', 'card', 'treatwell']);
const ALREADY_PAID_METHODS = new Set(['voucher', 'external', 'deposit']);
function buildPaymentBreakdown(byMethodRows, voucherSalesRows, prepay) {
  const agg = {};
  const ensure = (m) => (agg[m] || (agg[m] = { payment_method: m, n: 0, revenue: 0, voucher_portion: 0 }));
  for (const r of byMethodRows) {
    if (MONEY_IN_METHODS.has(r.payment_method)) {
      const a = ensure(r.payment_method); a.n += Number(r.n || 0); a.revenue += Number(r.revenue || 0);
    }
  }
  for (const r of (voucherSalesRows || [])) {                 // voucher sale → its buy method
    const a = ensure(r.payment_method || 'card');
    a.n += Number(r.n || 0); a.revenue += Number(r.revenue || 0); a.voucher_portion += Number(r.revenue || 0);
  }
  if (prepay && Number(prepay.total) > 0) {                   // online prepayments
    const a = ensure('online'); a.n += Number(prepay.count || 0); a.revenue += Number(prepay.total || 0);
  }
  const money_taken = Object.values(agg)
    .map((r) => ({ ...r, revenue: +r.revenue.toFixed(2), voucher_portion: +r.voucher_portion.toFixed(2) }))
    .sort((a, b) => b.revenue - a.revenue);
  const already_paid = byMethodRows
    .filter((r) => ALREADY_PAID_METHODS.has(r.payment_method))
    .map((r) => ({ payment_method: r.payment_method, n: Number(r.n || 0), amount: +Number(r.revenue || 0).toFixed(2) }))
    .sort((a, b) => b.amount - a.amount);
  const revenue = +money_taken.reduce((s, r) => s + r.revenue, 0).toFixed(2);
  return { money_taken, already_paid, revenue };
}

router.get('/trading', async (req, res) => {
  const date = req.query.date || today();
  try {
    const totals = await pool.query(
      `SELECT
         COALESCE(SUM(total), 0)::numeric  AS revenue,
         COALESCE(SUM(tip), 0)::numeric    AS tips,
         COUNT(*)::int                     AS bill_count
       FROM bills WHERE closed_at::date = $1::date AND payment_status <> 'refunded'`,
      [date],
    );
    const appts = await pool.query(
      `SELECT
         (COUNT(*) FILTER (WHERE status NOT IN ('cancelled','no_show','held')))::int AS appt_count,
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
       WHERE b.closed_at::date = $1::date AND b.payment_status <> 'refunded'
       GROUP BY t.id, t.name
       ORDER BY revenue DESC
       LIMIT 10`,
      [date],
    );
    // SPA-BILL-ITEMS — revenue split by line-item kind (treatment vs retail
    // vs add-on) so the owner sees how much of the day's takings came from
    // products / upgrades rather than treatments.
    const byKind = await pool.query(
      `SELECT bi.kind,
              COUNT(*)::int                          AS lines,
              COALESCE(SUM(bi.line_total), 0)::numeric AS revenue
       FROM bill_items bi
       JOIN bills b ON b.id = bi.bill_id
       WHERE b.closed_at::date = $1::date AND b.payment_status <> 'refunded'
       GROUP BY bi.kind
       ORDER BY revenue DESC`,
      [date],
    );
    // Split-aware payment-method aggregation: a bill paid by 'split'
    // contributes its split_payments[] entries to their underlying
    // methods (e.g. £30 cash + £20 card), so the owner sees real
    // cash/card totals instead of a generic "split" line.
    const byMethod = await billsByMethod(
      "closed_at::date = $1::date AND payment_status <> 'refunded'",
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
         ON b.appointment_id = a.id AND b.closed_at::date = $1::date AND b.payment_status <> 'refunded'
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
    // SPA-PAY-001 — online deposits collected today (separate from
    // bill revenue: money landed in the spa's Stripe account when the
    // customer booked online, regardless of whether they've arrived).
    const onlineDeposits = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE payment_status = 'deposit_paid')::int  AS count_pending,
         COUNT(*) FILTER (WHERE payment_status = 'fully_paid')::int    AS count_consumed,
         COUNT(*) FILTER (WHERE payment_status = 'refunded')::int      AS count_refunded,
         COUNT(*) FILTER (WHERE payment_status = 'forfeit')::int       AS count_forfeit,
         COALESCE(SUM(deposit_amount) FILTER (WHERE payment_status IN ('deposit_paid','fully_paid','forfeit')), 0)::numeric AS total_taken,
         COALESCE(SUM(deposit_amount) FILTER (WHERE payment_status = 'refunded'), 0)::numeric AS total_refunded
       FROM appointments
       WHERE source = 'online' AND created_at::date = $1::date`,
      [date],
    );

    // Cash-basis revenue + the clear two-group payment breakdown.
    const od = onlineDeposits.rows[0];
    const prepayCount = Number(od.count_pending) + Number(od.count_consumed) + Number(od.count_forfeit);
    const pb = buildPaymentBreakdown(byMethod.rows, voucherSalesByMethod.rows, { total: Number(od.total_taken || 0), count: prepayCount });
    const billMoneyIn = byMethod.rows.filter((r) => MONEY_IN_METHODS.has(r.payment_method)).reduce((s, r) => s + Number(r.revenue || 0), 0);

    res.json({
      date,
      identity: await loadIdentity(),
      totals: { ...totals.rows[0], revenue: pb.revenue },
      revenue_breakdown: { till: +billMoneyIn.toFixed(2), voucher_sales: Number(voucherSales.rows[0].total || 0), prepayments: Number(od.total_taken || 0) },
      payment_breakdown: { money_taken: pb.money_taken, already_paid: pb.already_paid },
      appointments: appts.rows[0],
      top_treatments: top.rows,
      by_kind: byKind.rows,
      by_payment_method: pb.money_taken,   // kept for back-compat; = money_taken
      by_source: bySource.rows,
      voucher_sales: {
        count:  voucherSales.rows[0].count,
        total:  voucherSales.rows[0].total,
        by_payment_method: voucherSalesByMethod.rows,
      },
      online_deposits: od,
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
    // Therapist totals + hours worked + customer-requested hours.
    // `therapist_requested = TRUE` means the customer asked for that
    // specific therapist when booking (vs being auto-assigned), which
    // is a useful loyalty/popularity metric for spa owners.
    const { rows: therapists } = await pool.query(
      `SELECT th.id, th.name,
              COUNT(b.id)::int                                          AS bills,
              COALESCE(SUM(b.subtotal),0)::numeric                      AS revenue,
              COALESCE(SUM(b.tip),0)::numeric                           AS tips,
              COALESCE(SUM(b.total),0)::numeric                         AS total,
              COALESCE(SUM(t.duration_minutes), 0)::int                 AS minutes_worked,
              COALESCE(SUM(t.duration_minutes) FILTER (WHERE a.therapist_requested), 0)::int AS minutes_requested,
              COUNT(b.id) FILTER (WHERE a.therapist_requested)::int     AS requested_bookings
       FROM bills b
       JOIN appointments a   ON a.id = b.appointment_id
       LEFT JOIN therapists th ON th.id = a.therapist_id
       LEFT JOIN treatments t  ON t.id = a.treatment_id
       ${where}
       GROUP BY th.id, th.name
       ORDER BY revenue DESC`,
      params,
    );

    // Payment-method breakdown for the same range — split-aware (one
    // 'split' bill contributes to multiple methods via split_payments).
    const { rows: byMethod } = await billsByMethod(
      `closed_at IS NOT NULL
         AND ($1::date IS NULL OR closed_at::date >= $1::date)
         AND ($2::date IS NULL OR closed_at::date <= $2::date)`,
      [from || null, to || null],
    );
    // Voucher sales + online prepayments over the range, for the clear breakdown.
    const vSales = await pool.query(
      `SELECT COALESCE(payment_method, 'card') AS payment_method, COUNT(*)::int AS n,
              COALESCE(SUM(initial_value), 0)::numeric AS revenue
       FROM vouchers
       WHERE ($1::date IS NULL OR purchased_at::date >= $1::date)
         AND ($2::date IS NULL OR purchased_at::date <= $2::date)
       GROUP BY COALESCE(payment_method, 'card')`,
      [from || null, to || null],
    );
    const dep = await pool.query(
      `SELECT (COUNT(*) FILTER (WHERE payment_status IN ('deposit_paid','fully_paid','forfeit')))::int AS count,
              COALESCE(SUM(deposit_amount) FILTER (WHERE payment_status IN ('deposit_paid','fully_paid','forfeit')), 0)::numeric AS total
       FROM appointments
       WHERE source = 'online'
         AND ($1::date IS NULL OR created_at::date >= $1::date)
         AND ($2::date IS NULL OR created_at::date <= $2::date)`,
      [from || null, to || null],
    );
    const pb = buildPaymentBreakdown(byMethod, vSales.rows, { total: Number(dep.rows[0].total || 0), count: Number(dep.rows[0].count || 0) });

    res.json({
      identity: await loadIdentity(),
      therapists,
      by_payment_method: pb.money_taken,   // back-compat; = money_taken
      payment_breakdown: { money_taken: pb.money_taken, already_paid: pb.already_paid },
      revenue: pb.revenue,
    });
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
       FROM bills WHERE closed_at::date = $1::date AND payment_status <> 'refunded'`,
      [date],
    );
    // SPA-BILL-ITEMS — revenue split by line-item kind (treatment / retail /
    // add-on) for the end-of-day Z report, mirroring the trading report.
    const byKind = await pool.query(
      `SELECT bi.kind,
              COUNT(*)::int                           AS lines,
              COALESCE(SUM(bi.line_total), 0)::numeric AS gross
       FROM bill_items bi
       JOIN bills b ON b.id = bi.bill_id
       WHERE b.closed_at::date = $1::date AND b.payment_status <> 'refunded'
       GROUP BY bi.kind
       ORDER BY gross DESC`,
      [date],
    );
    // SPA-BILL-ITEMS — VAT. Spa prices are VAT-inclusive; vat_rate is the
    // operator-set percentage (default 20). VAT is charged on goods/services
    // actually taken — i.e. bill total minus tips (tips are outside the scope
    // of VAT). The per-kind net/VAT below is on list prices, so when a
    // whole-bill discount is applied the headline VAT (discount-accurate) is
    // the figure of record; the split is indicative.
    const vatRow = await pool.query(`SELECT value FROM settings WHERE key = 'vat_rate'`);
    const vatRate = Number(vatRow.rows[0]?.value || 20);
    const splitVat = (grossIn) => {
      const gross = +Number(grossIn || 0).toFixed(2);
      const net = +(gross / (1 + vatRate / 100)).toFixed(2);
      return { gross, net, vat: +(gross - net).toFixed(2) };
    };
    const byKindVat = byKind.rows.map((r) => ({ kind: r.kind, lines: r.lines, ...splitVat(r.gross) }));
    // Headline taxable = total − tips (discount already baked into total).
    const taxableGross = +(Number(totals.rows[0].total || 0) - Number(totals.rows[0].tips || 0)).toFixed(2);
    const vat = { rate: vatRate, ...splitVat(taxableGross) };
    // Split-aware payment-method aggregation: a bill paid by 'split'
    // contributes its split_payments[] entries to their underlying
    // methods (e.g. £30 cash + £20 card), so the owner sees real
    // cash/card totals instead of a generic "split" line.
    const byMethod = await billsByMethod(
      "closed_at::date = $1::date AND payment_status <> 'refunded'",
      [date],
    );
    const closed = await pool.query(
      `SELECT value FROM settings WHERE key = 'last_z_closed_date'`,
    );
    // SPA-PAY-001 — Z-report also surfaces Stripe deposit activity for
    // the day so the operator's end-of-day picture is complete (till
    // cash + Stripe-side movement). by_payment_method above already
    // splits each bill's deposit portion into the 'deposit' line.
    const onlineDeposits = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE payment_status = 'deposit_paid')::int  AS count_pending,
         COUNT(*) FILTER (WHERE payment_status = 'fully_paid')::int    AS count_consumed,
         COUNT(*) FILTER (WHERE payment_status = 'refunded')::int      AS count_refunded,
         COUNT(*) FILTER (WHERE payment_status = 'forfeit')::int       AS count_forfeit,
         COALESCE(SUM(deposit_amount) FILTER (WHERE payment_status IN ('deposit_paid','fully_paid','forfeit')), 0)::numeric AS total_taken,
         COALESCE(SUM(deposit_amount) FILTER (WHERE payment_status = 'refunded'), 0)::numeric AS total_refunded
       FROM appointments
       WHERE source = 'online' AND created_at::date = $1::date`,
      [date],
    );
    // Voucher sales for the day — mirrors the trading endpoint so the
    // operator sees them at end of day too. Deferred revenue (money in,
    // service to come) so it's a separate line from bill totals.
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
    // SPA-PETTYCASH-001 — cash paid OUT of the drawer today for expenses.
    // Not revenue; it reduces the cash that should be in the drawer at close.
    const pettyCash = await pool.query(
      `SELECT p.id, p.amount, p.reason, p.created_at, t.name AS staff_name
       FROM petty_cash p
       LEFT JOIN therapists t ON t.id = p.created_by
       WHERE p.created_at::date = $1::date
       ORDER BY p.created_at ASC`,
      [date],
    );
    // Spa identity so the receipt/print/CSV all carry the business name.
    const ident = await pool.query(
      `SELECT key, value FROM settings WHERE key IN ('spa_name','spa_email','spa_address','spa_phone')`,
    );
    const identity = Object.fromEntries(ident.rows.map((r) => [r.key, r.value]));
    // Cash-basis money-taken (mirrors /trading): till cash/card/Treatwell +
    // voucher SALES + online prepayments. `total`/`subtotal`/`vat` above stay on
    // the accrual (services-delivered) basis for the VAT record.
    const zod = onlineDeposits.rows[0];
    const zPrepayCount = Number(zod.count_pending) + Number(zod.count_consumed) + Number(zod.count_forfeit);
    const pb = buildPaymentBreakdown(byMethod.rows, voucherSalesByMethod.rows, { total: Number(zod.total_taken || 0), count: zPrepayCount });
    const billMoneyIn = byMethod.rows.filter((r) => MONEY_IN_METHODS.has(r.payment_method)).reduce((s, r) => s + Number(r.revenue || 0), 0);
    // SPA-PETTYCASH-001 — cash-drawer reconciliation. `cash_taken` is the CASH
    // physically received today (cash bills + cash-bought vouchers, from the
    // split-aware money_taken 'cash' line). Petty cash paid out reduces it to
    // `net_cash` — what should actually be in the drawer / go to the bank
    // (excludes any opening float, which the till doesn't track).
    const pettyTotal = pettyCash.rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const cashTaken = Number((pb.money_taken.find((m) => m.payment_method === 'cash') || {}).revenue || 0);
    const netCash = +(cashTaken - pettyTotal).toFixed(2);
    res.json({
      date,
      totals: { ...totals.rows[0], revenue: pb.revenue },
      revenue_breakdown: { till: +billMoneyIn.toFixed(2), voucher_sales: Number(voucherSales.rows[0].total || 0), prepayments: Number(zod.total_taken || 0) },
      payment_breakdown: { money_taken: pb.money_taken, already_paid: pb.already_paid },
      by_kind: byKindVat,
      vat,
      by_payment_method: pb.money_taken,   // back-compat; = money_taken
      online_deposits: zod,
      voucher_sales: {
        count: voucherSales.rows[0].count,
        total: voucherSales.rows[0].total,
        by_payment_method: voucherSalesByMethod.rows,
      },
      petty_cash: {
        total: +pettyTotal.toFixed(2),
        count: pettyCash.rows.length,
        entries: pettyCash.rows.map((r) => ({
          id: r.id,
          amount: Number(r.amount),
          reason: r.reason,
          staff_name: r.staff_name || null,
          created_at: r.created_at,
        })),
      },
      cash_reconciliation: {
        cash_taken: +cashTaken.toFixed(2),
        petty_cash: +pettyTotal.toFixed(2),
        net_cash: netCash,
      },
      identity: {
        spa_name:    identity.spa_name    || process.env.SPA_NAME    || 'SiamEPOS Spa',
        spa_email:   identity.spa_email   || process.env.SPA_EMAIL   || null,
        spa_address: identity.spa_address || process.env.SPA_ADDRESS || null,
        spa_phone:   identity.spa_phone   || null,
      },
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

// ── Petty cash (SPA-PETTYCASH-001) ──────────────────────────────────────────
// Cash removed from the drawer for expenses. Shown on the Z report where it is
// subtracted from cash taken to give net cash (see /z-report cash_reconciliation).

// GET /api/reports/petty-cash?date=   — the day's petty-cash entries + total.
router.get('/petty-cash', async (req, res) => {
  const date = req.query.date || today();
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.amount, p.reason, p.created_at, t.name AS staff_name
       FROM petty_cash p
       LEFT JOIN therapists t ON t.id = p.created_by
       WHERE p.created_at::date = $1::date
       ORDER BY p.created_at ASC`,
      [date],
    );
    const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    res.json({
      date,
      total: +total.toFixed(2),
      count: rows.length,
      entries: rows.map((r) => ({
        id: r.id, amount: Number(r.amount), reason: r.reason,
        staff_name: r.staff_name || null, created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[reports] petty-cash list', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/reports/petty-cash  body: { amount, reason }
// Records cash taken out of the drawer. Staff (not therapists) only.
router.post('/petty-cash', requireRole('admin', 'manager', 'reception'), async (req, res) => {
  const amount = Number(req.body?.amount);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (!reason) return res.status(400).json({ error: 'reason is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO petty_cash (amount, reason, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, amount, reason, created_at`,
      [+amount.toFixed(2), reason, req.staff?.id || null],
    );
    const r = rows[0];
    res.status(201).json({ ok: true, entry: { ...r, amount: Number(r.amount) } });
  } catch (err) {
    console.error('[reports] petty-cash create', err);
    res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/reports/petty-cash/:id  — remove a mistaken entry (admin/manager).
router.delete('/petty-cash/:id', requireRole('admin', 'manager'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  try {
    const { rowCount } = await pool.query('DELETE FROM petty_cash WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[reports] petty-cash delete', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
