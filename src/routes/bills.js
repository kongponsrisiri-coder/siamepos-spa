const express = require('express');
const Stripe = require('stripe');
const { pool } = require('../db/dbAdapter');
const { requireRole } = require('../middleware/auth');
const { isOffline } = require('../services/syncService');
const offlineQueue = require('../services/offlineQueue');

const router = express.Router();

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: '2024-06-20' });
}

// SPA-BILL-ITEMS — recompute the cached aggregates on a bill from its line
// items: subtotal = SUM(line_total); total = subtotal − discount + tip.
// Keeping bills.subtotal/total in sync means every existing report that
// reads those columns keeps working without knowing about line items.
// `db` may be the pool or a transaction client. Returns the updated row.
async function recomputeBillTotals(db, billId) {
  const { rows } = await db.query(
    `UPDATE bills b SET
       subtotal = COALESCE((SELECT SUM(line_total) FROM bill_items WHERE bill_id = b.id), 0),
       total    = COALESCE((SELECT SUM(line_total) FROM bill_items WHERE bill_id = b.id), 0)
                  - COALESCE(b.discount, 0) + COALESCE(b.tip, 0)
     WHERE b.id = $1 RETURNING *`,
    [billId],
  );
  return rows[0];
}

// Load a bill plus its line items. Legacy bills created before SPA-BILL-ITEMS
// have no rows in bill_items — self-heal by seeding the treatment line from
// the appointment so the checkout always shows the service line. subtotal is
// already the treatment price on those bills, so seeding keeps SUM in sync.
async function loadBillWithItems(billId) {
  const b = await pool.query('SELECT * FROM bills WHERE id = $1', [billId]);
  if (!b.rows[0]) return null;
  let items = (await pool.query('SELECT * FROM bill_items WHERE bill_id = $1 ORDER BY id', [billId])).rows;
  if (items.length === 0) {
    const ap = await pool.query(
      `SELECT COALESCE(a.price_at_booking, t.price, 0) AS price, t.name
       FROM bills bl JOIN appointments a ON a.id = bl.appointment_id
       LEFT JOIN treatments t ON t.id = a.treatment_id WHERE bl.id = $1`,
      [billId],
    );
    if (ap.rows[0]) {
      const price = Number(ap.rows[0].price || 0);
      // ON CONFLICT keeps two concurrent self-heals from each inserting a
      // treatment line — the partial unique index lets the loser no-op.
      await pool.query(
        `INSERT INTO bill_items (bill_id, kind, name, quantity, unit_price, line_total)
         VALUES ($1, 'treatment', $2, 1, $3, $3)
         ON CONFLICT (bill_id) WHERE kind = 'treatment' DO NOTHING`,
        [billId, ap.rows[0].name || 'Treatment', price],
      );
      items = (await pool.query('SELECT * FROM bill_items WHERE bill_id = $1 ORDER BY id', [billId])).rows;
    }
  }
  return { ...b.rows[0], items };
}

// POST /api/bills  body: { appointment_id }
// Creates a pending bill from the appointment's treatment price.
router.post('/', async (req, res) => {
  const { appointment_id } = req.body || {};
  if (!appointment_id) return res.status(400).json({ error: 'appointment_id required' });
  try {
    // Reuse the appointment's live bill, but SKIP a refunded one — after a
    // refund the appointment is reopened, so re-checkout should start a fresh
    // bill rather than re-surface the drained/refunded one (which would show
    // payment buttons next to a lingering "Refunded" badge). The refunded bill
    // stays as an audit record.
    const existing = await pool.query(
      `SELECT * FROM bills WHERE appointment_id = $1 AND payment_status <> 'refunded'
       ORDER BY id DESC LIMIT 1`,
      [appointment_id],
    );
    if (existing.rows[0]) return res.json({ bill: await loadBillWithItems(existing.rows[0].id) });

    // SPA-PRICE-SNAPSHOT — prefer the booking-time price. Only fall
    // back to the live treatment price for legacy bookings made before
    // the snapshot column existed (already backfilled by the migration,
    // but the COALESCE is belt-and-braces).
    const ap = await pool.query(
      `SELECT a.id, COALESCE(a.price_at_booking, t.price) AS price, t.name AS treatment_name
       FROM appointments a LEFT JOIN treatments t ON t.id = a.treatment_id
       WHERE a.id = $1`,
      [appointment_id],
    );
    if (!ap.rows[0]) return res.status(404).json({ error: 'appointment not found' });
    const subtotal = Number(ap.rows[0].price || 0);

    const { rows } = await pool.query(
      `INSERT INTO bills (appointment_id, subtotal, tip, total)
       VALUES ($1, $2, 0, $2) RETURNING *`,
      [appointment_id, subtotal],
    );
    // SPA-BILL-ITEMS — seed the treatment as the first line item so the
    // checkout starts from the service and the operator can add retail /
    // add-ons on top.
    await pool.query(
      `INSERT INTO bill_items (bill_id, kind, name, quantity, unit_price, line_total)
       VALUES ($1, 'treatment', $2, 1, $3, $3)`,
      [rows[0].id, ap.rows[0].treatment_name || 'Treatment', subtotal],
    );
    await offlineQueue.enqueue('create_bill', { localId: rows[0].id });
    res.status(201).json({ bill: await loadBillWithItems(rows[0].id) });
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
    // A paid bill is a closed transaction — editing tip/discount after the
    // fact would silently desync the recorded payment from the totals that
    // feed Reports / Z-report. Lock it.
    const { rows } = await pool.query(
      `UPDATE bills SET tip = $2, total = subtotal - COALESCE(discount, 0) + $2
       WHERE id = $1 AND payment_status != 'paid' RETURNING *`,
      [id, tipNum],
    );
    if (!rows[0]) {
      const check = await pool.query('SELECT payment_status FROM bills WHERE id = $1', [id]);
      if (!check.rows[0]) return res.status(404).json({ error: 'not found' });
      return res.status(409).json({ error: 'Bill is already paid — tip cannot be changed' });
    }
    res.json({ bill: await loadBillWithItems(id) });
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
  // SPA-EXT-VOUCHER — an external (pre-SiamEPOS) voucher code recorded against
  // this payment. Stored for audit; no SiamEPOS voucher is redeemed.
  const externalVoucherCode = (req.body && req.body.external_voucher_code)
    ? String(req.body.external_voucher_code).trim().slice(0, 64) || null
    : null;
  if (!['cash', 'card', 'split', 'voucher', 'treatwell'].includes(method)) {
    return res.status(400).json({ error: 'invalid method' });
  }

  // Phase B Option A — offline payment gating. Card (Stripe) and voucher
  // (shared cloud balance) both need the internet; cash does not. On a desktop
  // till that's currently offline, block the online-only methods with a clear,
  // OS-neutral message so the operator takes cash instead of hitting a cryptic
  // Stripe error. No-op in cloud mode (isOffline() is always false there).
  if (isOffline()) {
    const splitNeedsNet = method === 'split' && Array.isArray(split_payments)
      && split_payments.some((p) => ['card', 'voucher'].includes(String(p.method || '').toLowerCase()));
    if (method === 'card' || method === 'voucher' || method === 'treatwell' || splitNeedsNet) {
      return res.status(503).json({
        error: 'offline',
        offline: true,
        message: 'Card and voucher payments need an internet connection. Please take cash for now, or complete this payment once you’re back online.',
      });
    }
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
    // Validate sum against the BALANCE the customer owes at the till —
    // that is bill total minus any online deposit already pre-paid.
    // SPA-PAY-001: the frontend's SplitPaymentModal receives `balance`
    // (total − deposit) so the operator only enters the till portion.
    const totalRes = await pool.query(
      `SELECT b.total, COALESCE(a.deposit_amount, 0) AS deposit_amount
       FROM bills b JOIN appointments a ON a.id = b.appointment_id
       WHERE b.id = $1`,
      [id],
    );
    if (!totalRes.rows[0]) return res.status(404).json({ error: 'not found' });
    const billTotal     = Number(totalRes.rows[0].total);
    const depositAmount = Number(totalRes.rows[0].deposit_amount || 0);
    const expectedSum   = +(billTotal - depositAmount).toFixed(2);
    const sum = +clean.reduce((s, p) => s + p.amount, 0).toFixed(2);
    if (Math.abs(sum - expectedSum) > 0.01) {
      return res.status(400).json({
        error: depositAmount > 0
          ? `split_payments sum £${sum.toFixed(2)} should equal balance £${expectedSum.toFixed(2)} (deposit £${depositAmount.toFixed(2)} pre-paid online)`
          : `split_payments sum £${sum.toFixed(2)} does not match bill total £${billTotal.toFixed(2)}`,
      });
    }
    splitJson = JSON.stringify(clean);
  }

  // SPA-PAY-001 — auto-credit any deposit the customer already paid online.
  // If appointment.deposit_amount > 0 we prepend a 'deposit' row to the
  // breakdown so reports attribute that portion to the Stripe deposit
  // pool, and the chosen method (cash/card/etc) covers only the balance.
  // This means the bill row never shows £55-cash when the customer really
  // paid £25 deposit + £30 cash.
  try {
    const billRow = await pool.query(
      `SELECT b.total, b.appointment_id, COALESCE(a.deposit_amount, 0) AS deposit_amount
       FROM bills b JOIN appointments a ON a.id = b.appointment_id
       WHERE b.id = $1`,
      [id],
    );
    if (!billRow.rows[0]) return res.status(404).json({ error: 'not found' });
    const depositAmount = Number(billRow.rows[0].deposit_amount || 0);
    const billTotal = Number(billRow.rows[0].total);
    let effectiveMethod = method;
    if (depositAmount > 0 && method !== 'split') {
      const balance = +(billTotal - depositAmount).toFixed(2);
      effectiveMethod = 'split';
      splitJson = JSON.stringify(
        balance > 0
          ? [
              { method: 'deposit', amount: depositAmount },
              { method,           amount: balance },
            ]
          : [{ method: 'deposit', amount: billTotal }],
      );
    } else if (depositAmount > 0 && method === 'split') {
      // Sum was already validated above against billTotal − depositAmount.
      // Just prepend the deposit row so it appears in the split breakdown.
      const cleanRows = JSON.parse(splitJson || '[]');
      splitJson = JSON.stringify([
        { method: 'deposit', amount: depositAmount },
        ...cleanRows,
      ]);
    }

    const { rows } = await pool.query(
      `UPDATE bills SET
         payment_method = $2,
         split_payments = $3::jsonb,
         external_voucher_code = COALESCE($4, external_voucher_code),
         payment_status = 'paid',
         closed_at      = now()
       WHERE id = $1
         AND payment_status != 'paid'
       RETURNING *`,
      [id, effectiveMethod, splitJson, externalVoucherCode],
    );
    // rows[0] is null either because the bill was not found OR because it
    // was already paid. Distinguish with a second read so the error message
    // is correct rather than always returning 404.
    if (!rows[0]) {
      const check = await pool.query('SELECT payment_status FROM bills WHERE id = $1', [id]);
      if (!check.rows[0]) return res.status(404).json({ error: 'not found' });
      if (check.rows[0].payment_status === 'paid') return res.status(409).json({ error: 'Bill is already paid' });
      return res.status(404).json({ error: 'not found' });
    }
    // Stamp the deposit as fully consumed once the bill closes.
    if (depositAmount > 0) {
      await pool.query(
        `UPDATE appointments SET payment_status = 'fully_paid' WHERE id = $1 AND payment_status = 'deposit_paid'`,
        [rows[0].appointment_id],
      );
    }
    // Mark the appointment completed as a side-effect of taking payment.
    await pool.query(
      `UPDATE appointments SET status = 'completed'
       WHERE id = $1 AND status NOT IN ('cancelled','no_show')`,
      [rows[0].appointment_id],
    );
    if (method === 'cash') {
      await offlineQueue.enqueue('pay_bill_cash', { localId: id });
    }
    res.json({ bill: rows[0] });
  } catch (err) {
    console.error('[bills] pay', err);
    res.status(500).json({ error: 'server error' });
  }
});

// SPA-DISCOUNT — PUT /api/bills/:id/discount
//   body: { discount: number, reason?: string }
// Whole-bill discount in £. total recomputed = subtotal - discount + tip.
router.put('/:id/discount', requireRole('admin', 'manager', 'reception'), async (req, res) => {
  const id = Number(req.params.id);
  const { discount, reason } = req.body || {};
  const d = Number(discount);
  if (!isFinite(d) || d < 0) return res.status(400).json({ error: 'discount must be a number >= 0' });
  try {
    // Read the bill first so we can (a) refuse to discount a closed/paid
    // bill and (b) clamp the discount to the subtotal — a discount larger
    // than the subtotal would push the bill total negative and corrupt the
    // day's reported revenue.
    const cur = await pool.query('SELECT subtotal, payment_status FROM bills WHERE id = $1', [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
    if (cur.rows[0].payment_status === 'paid') {
      return res.status(409).json({ error: 'Bill is already paid — discount cannot be changed' });
    }
    const subtotal = Number(cur.rows[0].subtotal || 0);
    const clamped = +Math.min(d, subtotal).toFixed(2);
    const { rows } = await pool.query(
      `UPDATE bills
          SET discount = $2,
              discount_reason = $3,
              total = subtotal - $2 + COALESCE(tip, 0)
        WHERE id = $1 RETURNING *`,
      [id, clamped, reason || null],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ bill: await loadBillWithItems(id) });
  } catch (err) {
    console.error('[bills] discount', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/bills/:id/method
// Amend the payment method on a closed bill — for "I tapped Cash but
// it was actually Card" mistakes at the till. Admin/manager only.
// Mirrors the validation in POST /pay (incl. split_payments + the
// deposit auto-credit) so the resulting row is structurally identical
// to what we'd have written if the right method had been picked first.
router.put('/:id/method', requireRole('admin', 'manager'), async (req, res) => {
  const id = Number(req.params.id);
  const { method, split_payments } = req.body || {};
  if (!['cash', 'card', 'split', 'voucher', 'treatwell'].includes(method)) {
    return res.status(400).json({ error: 'invalid method' });
  }
  try {
    const billRow = await pool.query(
      `SELECT b.id, b.total, b.appointment_id, COALESCE(a.deposit_amount, 0) AS deposit_amount
       FROM bills b JOIN appointments a ON a.id = b.appointment_id
       WHERE b.id = $1`,
      [id],
    );
    if (!billRow.rows[0]) return res.status(404).json({ error: 'not found' });
    const billTotal = Number(billRow.rows[0].total);
    const depositAmount = Number(billRow.rows[0].deposit_amount || 0);

    let splitJson = null;
    let effectiveMethod = method;

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
      const expected = +(billTotal - depositAmount).toFixed(2);
      const sum = +clean.reduce((s, p) => s + p.amount, 0).toFixed(2);
      if (Math.abs(sum - expected) > 0.01) {
        return res.status(400).json({
          error: depositAmount > 0
            ? `split_payments sum £${sum.toFixed(2)} should equal balance £${expected.toFixed(2)} (deposit £${depositAmount.toFixed(2)} auto-credited)`
            : `split_payments sum £${sum.toFixed(2)} does not match bill total £${billTotal.toFixed(2)}`,
        });
      }
      const finalRows = depositAmount > 0
        ? [{ method: 'deposit', amount: depositAmount }, ...clean]
        : clean;
      splitJson = JSON.stringify(finalRows);
    } else if (depositAmount > 0) {
      // Non-split method on a deposit-paid appointment — auto-credit
      // the same way POST /pay does.
      const balance = +(billTotal - depositAmount).toFixed(2);
      effectiveMethod = 'split';
      splitJson = JSON.stringify(
        balance > 0
          ? [{ method: 'deposit', amount: depositAmount }, { method, amount: balance }]
          : [{ method: 'deposit', amount: billTotal }],
      );
    }

    const { rows } = await pool.query(
      `UPDATE bills SET payment_method = $2, split_payments = $3::jsonb
       WHERE id = $1 RETURNING *`,
      [id, effectiveMethod, splitJson],
    );
    res.json({ bill: rows[0] });
  } catch (err) {
    console.error('[bills] amend method', err);
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
    // Reset the linked appointment back to 'booked' so it can be re-processed.
    // Also roll back payment_status: 'fully_paid' → 'deposit_paid' (Stripe
    // deposit is still real; the bill was just reversed). Any other status
    // (none / deposit_paid / refunded / forfeit) left untouched.
    if (bill.appointment_id) {
      await client.query(
        `UPDATE appointments
            SET status = 'booked',
                payment_status = CASE
                  WHEN payment_status = 'fully_paid' THEN 'deposit_paid'
                  ELSE payment_status
                END
          WHERE id = $1`,
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

// ── SPA-BILL-ITEMS — line items ─────────────────────────────────────────

// GET /api/bills/:id/items — bill + its line items (refresh helper).
router.get('/:id/items', async (req, res) => {
  try {
    const full = await loadBillWithItems(Number(req.params.id));
    if (!full) return res.status(404).json({ error: 'not found' });
    res.json({ bill: full });
  } catch (err) {
    console.error('[bills] get items', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/bills/:id/items  body { kind, name, quantity, unit_price }
// Add a retail product / add-on / extra service line to an open bill.
router.post('/:id/items', async (req, res) => {
  const id = Number(req.params.id);
  const { kind, name, quantity, unit_price } = req.body || {};
  // Only products / add-ons can be added manually — the single 'treatment'
  // line is owned by the booking (seeded on create, synced on treatment swap)
  // and is guarded by a partial unique index.
  const k = ['retail', 'addon'].includes(kind) ? kind : 'retail';
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const price = Number(unit_price);
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  if (!isFinite(price) || price < 0) return res.status(400).json({ error: 'unit_price must be a number >= 0' });
  try {
    const cur = await pool.query('SELECT payment_status FROM bills WHERE id = $1', [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
    if (['paid', 'refunded'].includes(cur.rows[0].payment_status)) {
      return res.status(409).json({ error: `Bill is ${cur.rows[0].payment_status} — items cannot be changed` });
    }
    const lineTotal = +(price * qty).toFixed(2);
    const ins = await pool.query(
      `INSERT INTO bill_items (bill_id, kind, name, quantity, unit_price, line_total)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [id, k, String(name).trim().slice(0, 120), qty, +price.toFixed(2), lineTotal],
    );
    await recomputeBillTotals(pool, id);
    await offlineQueue.enqueue('add_bill_item', { localId: ins.rows[0].id });
    res.status(201).json({ bill: await loadBillWithItems(id) });
  } catch (err) {
    console.error('[bills] add item', err);
    res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/bills/:id/items/:itemId — remove a line from an open bill.
router.delete('/:id/items/:itemId', async (req, res) => {
  const id = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  try {
    const cur = await pool.query('SELECT payment_status FROM bills WHERE id = $1', [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
    if (['paid', 'refunded'].includes(cur.rows[0].payment_status)) {
      return res.status(409).json({ error: `Bill is ${cur.rows[0].payment_status} — items cannot be changed` });
    }
    const del = await pool.query('DELETE FROM bill_items WHERE id = $1 AND bill_id = $2', [itemId, id]);
    if (!del.rowCount) return res.status(404).json({ error: 'item not found' });
    await recomputeBillTotals(pool, id);
    res.json({ bill: await loadBillWithItems(id) });
  } catch (err) {
    console.error('[bills] delete item', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/bills/:id/refund  body { reason? }  — admin/manager only.
// Reverses a PAID bill. If the appointment carried an online Stripe deposit
// we refund that via Stripe; cash/card portions are recorded as a manual
// reversal (there's no card rail at the till). Marks the bill 'refunded',
// stamps refund_amount/refunded_at, and reopens the appointment to 'booked'
// so it can be re-rung or cancelled.
router.post('/:id/refund', requireRole('admin', 'manager'), async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = req.body || {};
  // Read the bill + deposit info first so the Stripe refund happens BEFORE we
  // open the DB transaction — a failed Stripe call must not leave a
  // half-applied refund.
  let bill;
  try {
    const billRow = await pool.query(
      `SELECT b.*, a.id AS appt_id, a.deposit_stripe_id, COALESCE(a.deposit_amount, 0) AS deposit_amount
       FROM bills b JOIN appointments a ON a.id = b.appointment_id
       WHERE b.id = $1`,
      [id],
    );
    if (!billRow.rows[0]) return res.status(404).json({ error: 'not found' });
    bill = billRow.rows[0];
    if (bill.payment_status !== 'paid') {
      return res.status(409).json({ error: 'only a paid bill can be refunded' });
    }
  } catch (err) {
    console.error('[bills] refund read', err);
    return res.status(500).json({ error: 'server error' });
  }

  let stripeRefunded = 0;
  if (bill.deposit_stripe_id) {
    const s = stripeClient();
    if (s) {
      try {
        await s.refunds.create({ payment_intent: bill.deposit_stripe_id });
        stripeRefunded = Number(bill.deposit_amount || 0);
      } catch (e) {
        console.error('[bills] stripe refund', e);
        return res.status(502).json({ error: `Stripe refund failed — ${e.message || 'try the Stripe dashboard'}` });
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Reverse any gift-voucher redemptions taken against this bill so the
    // customer's balance (or sessions) is put back. Without this, refunding a
    // voucher-paid bill silently kept the voucher drained.
    const reds = await client.query(
      `SELECT vr.id, vr.voucher_id, vr.amount_used, vr.sessions_used,
              v.voucher_type, v.total_sessions, v.initial_value
       FROM voucher_redemptions vr
       JOIN vouchers v ON v.id = vr.voucher_id
       WHERE vr.bill_id = $1 AND vr.reversed_at IS NULL`,
      [id],
    );
    const vouchersRestored = [];
    for (const r of reds.rows) {
      if (r.voucher_type === 'sessions') {
        const back = Number(r.sessions_used || 0);
        await client.query(
          `UPDATE vouchers
              SET sessions_remaining = sessions_remaining + $2,
                  remaining_value = ROUND((initial_value / NULLIF(total_sessions, 0)) * (sessions_remaining + $2), 2),
                  status = CASE WHEN status IN ('used', 'expired') THEN 'active' ELSE status END
            WHERE id = $1`,
          [r.voucher_id, back],
        );
      } else {
        await client.query(
          `UPDATE vouchers
              SET remaining_value = remaining_value + $2,
                  status = CASE WHEN status IN ('used', 'expired') THEN 'active' ELSE status END
            WHERE id = $1`,
          [r.voucher_id, Number(r.amount_used || 0)],
        );
      }
      await client.query(`UPDATE voucher_redemptions SET reversed_at = now() WHERE id = $1`, [r.id]);
      vouchersRestored.push({
        voucher_id: r.voucher_id,
        amount: Number(r.amount_used || 0),
        sessions: Number(r.sessions_used || 0),
      });
    }
    const { rows } = await client.query(
      `UPDATE bills
          SET payment_status = 'refunded', refunded_at = now(),
              refund_amount = $2, refund_reason = $3
        WHERE id = $1 RETURNING *`,
      [id, Number(bill.total), reason || null],
    );
    await client.query(
      `UPDATE appointments
          SET status = 'booked',
              payment_status = CASE WHEN payment_status = 'fully_paid' THEN 'refunded' ELSE payment_status END
        WHERE id = $1`,
      [bill.appt_id],
    );
    await client.query('COMMIT');
    req.app.get('io')?.emit('appointment_updated', { id: bill.appt_id });
    res.json({ bill: rows[0], stripe_refunded: stripeRefunded, vouchers_restored: vouchersRestored });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[bills] refund', err);
    res.status(500).json({ error: 'server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.recomputeBillTotals = recomputeBillTotals;
module.exports.loadBillWithItems = loadBillWithItems;
