// Voucher routes — sell, look up, redeem, track spending
const express = require('express');
const { pool } = require('../db/database');
const { requireRole } = require('../middleware/auth');
const { sendVoucherGiftEmail } = require('../services/emailService');
const { buildAt } = require('../services/availability');

// Voucher is valid through the END of expires_at in London time. Without
// this, `new Date('2026-05-21') < new Date()` flips the voucher to expired
// the moment we cross 00:00 UTC = 01:00 BST — i.e. an hour into the day
// the voucher was supposed to still be valid for.
function isExpired(expires_at) {
  if (!expires_at) return false;
  // expires_at from PG is a Date at 00:00 in some TZ — normalise to a
  // YYYY-MM-DD string so buildAt can anchor it to London.
  const dateStr = (expires_at instanceof Date)
    ? expires_at.toISOString().slice(0, 10)
    : String(expires_at).slice(0, 10);
  // End of day London = next day's 00:00 in London.
  const [y, mo, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const nextStr = next.toISOString().slice(0, 10);
  return Date.now() >= buildAt(nextStr, '00:00').getTime();
}

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
              th.name AS sold_by_name,
              t.name  AS treatment_name
       FROM vouchers v
       LEFT JOIN clients    c  ON c.id  = v.client_id
       LEFT JOIN therapists th ON th.id = v.sold_by
       LEFT JOIN treatments t  ON t.id  = v.treatment_id
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
      `SELECT v.*, c.name AS client_name, t.name AS treatment_name
       FROM vouchers v
       LEFT JOIN clients   c ON c.id = v.client_id
       LEFT JOIN treatments t ON t.id = v.treatment_id
       WHERE v.code = $1`,
      [code],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Voucher not found' });
    const v = rows[0];
    // Auto-expire check
    if (v.status === 'active' && isExpired(v.expires_at)) {
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
      `SELECT v.*, c.name AS client_name, th.name AS sold_by_name, t.name AS treatment_name
       FROM vouchers v
       LEFT JOIN clients    c  ON c.id  = v.client_id
       LEFT JOIN therapists th ON th.id = v.sold_by
       LEFT JOIN treatments t  ON t.id  = v.treatment_id
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
// body (monetary, existing):
//   { value, purchased_by, purchased_for, client_id?, expires_at?, notes?, sold_by? }
// body (sessions, new):
//   { voucher_type:'sessions', value (sale price), total_sessions, treatment_id?, ... }
//   — treatment_id NULL means "any treatment in the menu".
const VOUCHER_PAYMENT_METHODS = ['cash', 'card', 'split'];

router.post('/', async (req, res) => {
  const {
    value, purchased_by, purchased_for, client_id, expires_at, notes, sold_by,
    voucher_type, total_sessions, treatment_id, recipient_email, payment_method,
  } = req.body || {};
  const isSessions = voucher_type === 'sessions';
  if (!value || Number(value) <= 0) return res.status(400).json({ error: 'value required' });
  if (!payment_method || !VOUCHER_PAYMENT_METHODS.includes(payment_method)) {
    return res.status(400).json({ error: 'payment_method required (cash | card | split)' });
  }
  if (isSessions) {
    if (!total_sessions || Number(total_sessions) <= 0) {
      return res.status(400).json({ error: 'total_sessions required for a sessions voucher' });
    }
    if (treatment_id) {
      const t = await pool.query('SELECT id FROM treatments WHERE id = $1 AND active = TRUE', [Number(treatment_id)]);
      if (!t.rows[0]) return res.status(400).json({ error: 'treatment not found' });
    }
  }
  try {
    // Ensure unique code
    let code;
    for (let i = 0; i < 10; i++) {
      code = generateCode();
      const exists = await pool.query('SELECT id FROM vouchers WHERE code = $1', [code]);
      if (!exists.rows[0]) break;
    }
    // For session vouchers, remaining_value still tracks "what's left of
    // what they paid" (sale_price × sessions_remaining / total_sessions),
    // so the existing accounting / outstanding-balance display still
    // makes sense — but it's recomputed on each redemption rather than
    // taking real deductions.
    const { rows } = await pool.query(
      `INSERT INTO vouchers
         (code, initial_value, remaining_value, purchased_by, purchased_for,
          client_id, expires_at, notes, sold_by,
          voucher_type, total_sessions, sessions_remaining, treatment_id,
          recipient_email, payment_method)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13) RETURNING *`,
      [
        code, Number(value), purchased_by || null, purchased_for || null,
        client_id || null, expires_at || null, notes || null,
        sold_by || req.staff?.id || null,
        isSessions ? 'sessions' : 'monetary',
        isSessions ? Number(total_sessions) : null,
        isSessions ? (treatment_id ? Number(treatment_id) : null) : null,
        recipient_email || null,
        payment_method,
      ],
    );
    const voucher = rows[0];

    // Fire-and-forget gift email. If BREVO_API_KEY isn't set the helper
    // returns { skipped:true } without throwing; recipient_email is left
    // on the row so the operator can resend later.
    if (voucher.recipient_email) {
      const tName = voucher.treatment_id
        ? (await pool.query('SELECT name FROM treatments WHERE id = $1', [voucher.treatment_id])).rows[0]?.name
        : null;
      sendVoucherGiftEmail({ voucher, treatment_name: tName })
        .then(async (r) => {
          if (r && r.ok) {
            await pool.query('UPDATE vouchers SET email_sent_at = now() WHERE id = $1', [voucher.id]);
          }
        })
        .catch((e) => console.error('[vouchers] gift email failed', e));
    }

    res.status(201).json({ voucher });
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
//
// Monetary voucher:  body { amount, bill_id?, notes? }  → deducts amount.
// Sessions voucher:  body { bill_id, treatment_id, notes? } → consumes 1
//   session if the treatment matches the voucher's treatment_id (or the
//   voucher accepts any). The amount written to voucher_redemptions is
//   the value of one session (initial_value / total_sessions) so reports
//   still see the £ that was used.
router.post('/:id/redeem', async (req, res) => {
  const id = Number(req.params.id);
  const { amount, bill_id, notes, treatment_id } = req.body || {};

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
    if (isExpired(v.expires_at)) {
      await client.query("UPDATE vouchers SET status = 'expired' WHERE id = $1", [id]);
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Voucher has expired' });
    }

    // ── Sessions voucher path ────────────────────────────────────────
    if (v.voucher_type === 'sessions') {
      const sessionsLeft = Number(v.sessions_remaining || 0);
      if (sessionsLeft <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'No sessions remaining on this voucher' });
      }
      // Treatment match — relaxed: allow if EITHER the IDs match OR
      // the durations match. So a "10 × 60-min Thai massage" voucher
      // can be used against ANY 60-minute treatment, not just the
      // exact treatment it was sold for. Voucher with treatment_id =
      // NULL is "any treatment" so this whole block is skipped.
      if (v.treatment_id && treatment_id && Number(treatment_id) !== Number(v.treatment_id)) {
        const durations = await pool.query(
          'SELECT id, name, duration_minutes FROM treatments WHERE id = ANY($1::int[])',
          [[Number(v.treatment_id), Number(treatment_id)]],
        );
        const voucherTreatment = durations.rows.find(t => t.id === Number(v.treatment_id));
        const billTreatment    = durations.rows.find(t => t.id === Number(treatment_id));
        const durationsMatch = voucherTreatment && billTreatment
          && Number(voucherTreatment.duration_minutes) === Number(billTreatment.duration_minutes);
        if (!durationsMatch) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `This voucher is for ${voucherTreatment?.name || 'a specific treatment'} (${voucherTreatment?.duration_minutes || '?'}min). The chosen treatment is ${billTreatment?.duration_minutes || '?'}min — durations don't match.`,
          });
        }
      }
      const sessionsValue = Number(v.total_sessions) > 0
        ? +(Number(v.initial_value) / Number(v.total_sessions)).toFixed(2)
        : 0;
      const newSessionsLeft = sessionsLeft - 1;
      const newRemainingValue = +(sessionsValue * newSessionsLeft).toFixed(2);
      const newStatus = newSessionsLeft <= 0 ? 'used' : 'active';

      await client.query(
        `UPDATE vouchers
         SET sessions_remaining = $2, remaining_value = $3, status = $4
         WHERE id = $1`,
        [id, newSessionsLeft, newRemainingValue, newStatus],
      );
      const { rows: rRows } = await client.query(
        `INSERT INTO voucher_redemptions
           (voucher_id, bill_id, amount_used, sessions_used, redeemed_by, notes)
         VALUES ($1,$2,$3,1,$4,$5) RETURNING *`,
        [id, bill_id || null, sessionsValue, req.staff?.id || null, notes || null],
      );
      await client.query('COMMIT');
      return res.json({
        redemption: rRows[0],
        sessions_used: 1,
        sessions_remaining: newSessionsLeft,
        amount_used: sessionsValue,
        remaining_value: newRemainingValue,
      });
    }

    // ── Monetary voucher path (existing) ─────────────────────────────
    const amtNum = Number(amount);
    if (!amtNum || amtNum <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'amount required' });
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
