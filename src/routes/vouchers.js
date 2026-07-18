// Voucher routes — sell, look up, redeem, track spending
const express = require('express');
const { pool } = require('../db/dbAdapter');
const { requireRole } = require('../middleware/auth');
const { sendVoucherGiftEmail } = require('../services/emailService');
const { buildAt } = require('../services/availability');
const { isOffline, pushVoucherOp } = require('../services/syncService');
const offlineQueue = require('../services/offlineQueue');
const walletPush = require('../services/walletPush'); // SPA-LOYALTY-001 L2 — live pass balances

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
      // treatment_duration lets the till accept a session voucher against ANY
      // treatment of the SAME duration (a 60-min bundle → any 60-min treatment),
      // matching the server-side redeem rule instead of an exact-treatment lock.
      `SELECT v.*, c.name AS client_name, t.name AS treatment_name,
              t.duration_minutes AS treatment_duration
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

  // Phase B Option A — gift-voucher balances live in the cloud and could be
  // redeemed on another device, so redeeming offline risks double-spend.
  // Block it on an offline desktop till; no-op in cloud mode.
  if (isOffline()) {
    return res.status(503).json({
      error: 'offline',
      offline: true,
      message: 'Gift vouchers can only be redeemed with an internet connection. Please take cash for now, or redeem the voucher once you’re back online.',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: vRows } = await client.query(
      'SELECT * FROM vouchers WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!vRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    const v = vRows[0];

    // SEPOS-SPA-BUGHUNT C2 — idempotency. Voucher redemption and bill closure are
    // two separate client calls; if /pay failed after a successful redeem and the
    // operator retried, the voucher would be decremented a SECOND time (double
    // spend / lost value). Checked first (before the status gate) so a retry on a
    // now-'used' voucher still returns success rather than "Voucher is used".
    // The FOR UPDATE lock above serializes concurrent retries on the same voucher.
    if (bill_id) {
      const dup = await client.query(
        `SELECT * FROM voucher_redemptions
           WHERE voucher_id = $1 AND bill_id = $2 AND reversed_at IS NULL
           ORDER BY id DESC LIMIT 1`,
        [id, Number(bill_id)],
      );
      if (dup.rows[0]) {
        await client.query('COMMIT');
        const r = dup.rows[0];
        return res.json({
          redemption: r,
          idempotent: true,
          amount_used: Number(r.amount_used || 0),
          sessions_used: Number(r.sessions_used || 0),
          remaining_value: Number(v.remaining_value || 0),
          sessions_remaining: Number(v.sessions_remaining || 0),
        });
      }
    }

    if (v.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Voucher is ${v.status}` });
    }
    if (isExpired(v.expires_at)) {
      // Roll back the redemption transaction, THEN persist the expiry flip
      // on the pool — doing the UPDATE inside the about-to-rollback tx threw
      // the status change away, so expired vouchers kept showing as active.
      await client.query('ROLLBACK');
      await pool.query("UPDATE vouchers SET status = 'expired' WHERE id = $1 AND status = 'active'", [id]);
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
      // SPA-LOYALTY-001 L2 — refresh the voucher's Wallet pass (new count).
      walletPush.bumpVoucherPass(v.code).catch(() => {});
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

    // SPA-LOYALTY-001 L2 — refresh the voucher's Wallet pass (new balance).
    walletPush.bumpVoucherPass(v.code).catch(() => {});
    res.json({ redemption: rRows[0], amount_used: deduct, remaining_value: newRemaining });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[vouchers] redeem', err);
    res.status(500).json({ error: 'server error' });
  } finally {
    client.release();
  }
});

// DELETE /api/vouchers/:id  — admin only.
//   default            → CANCEL (voids the voucher but keeps it for reports/audit)
//   ?permanent=1       → DELETE the row + its redemption history entirely.
//     Meant for test/demo vouchers (incl. ones redeemed during a demo) so they
//     don't pollute the list or reports. Real customer vouchers should be
//     cancelled, not deleted — cancellation preserves the money trail.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const permanent = req.query.permanent === '1' || req.query.permanent === 'true';
  try {
    // SPA-VOUCHER-SYNC-001 — on a local desktop till, vouchers are cloud-
    // authoritative (same rule as redemption). A local-only cancel/delete gets
    // re-activated by the next pull (which carries the still-active cloud copy),
    // so it "comes back". Fix: block when offline, and when online push the op to
    // the CLOUD first (by cloud_id), then mirror it locally below. No-op in cloud
    // mode (offlineQueue.isLocal is false there).
    if (offlineQueue.isLocal) {
      if (isOffline()) {
        return res.status(503).json({
          error: 'offline', offline: true,
          message: 'Cancelling or deleting a voucher needs an internet connection so the change reaches the cloud (and other tills). Please try again when back online.',
        });
      }
      const cid = await pool.query('SELECT cloud_id FROM vouchers WHERE id = $1', [id]);
      if (!cid.rows[0]) return res.status(404).json({ error: 'not found' });
      const cloudId = cid.rows[0].cloud_id;
      // Vouchers created on the cloud carry a cloud_id; push the op up so the
      // cloud stops sending this voucher back as active. (A rare till-only
      // voucher with no cloud_id simply applies locally — nothing to push.)
      if (cloudId != null) {
        try {
          await pushVoucherOp(cloudId, permanent ? 'delete' : 'cancel');
        } catch (e) {
          return res.status(502).json({
            error: 'cloud_unreachable',
            message: 'Could not reach the cloud to save this change. Please check your connection and try again in a moment.',
          });
        }
      }
      // fall through → apply the same op to the local SQLite copy
    }

    if (!permanent) {
      const { rows } = await pool.query(
        "UPDATE vouchers SET status = 'cancelled' WHERE id = $1 RETURNING *",
        [id],
      );
      if (!rows[0]) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query('DELETE FROM voucher_redemptions WHERE voucher_id = $1', [id]);
      const v = await client.query('DELETE FROM vouchers WHERE id = $1 RETURNING code', [id]);
      if (!v.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
      await client.query('COMMIT');
      console.warn(`[vouchers] PERMANENT delete ${v.rows[0].code} (+${r.rowCount || 0} redemption rows) by staff id=${req.staff?.id}`);
      res.json({ ok: true, deleted: v.rows[0].code, redemptions_removed: r.rowCount || 0 });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[vouchers] delete', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
