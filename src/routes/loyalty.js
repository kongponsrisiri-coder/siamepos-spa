// SPA-LOYALTY-001 — loyalty card API (staff-facing; mounted behind requireAuth).
//
//   GET  /api/loyalty/status?client_id=&counting_current_visit=1
//        Progress + available rewards. counting_current_visit=1 treats the
//        bill currently being paid as visit N+1 (checkout preview — the
//        classic "10th visit free" applies to the visit being paid NOW).
//   POST /api/loyalty/redeem   { client_id, tier_visit, bill_id?,
//                                counting_current_visit? }
//        One-tap reward redemption from checkout. If the tier has a £ value
//        and a bill_id is given, the value is applied as a bill discount.
//   GET  /api/loyalty/events?client_id=   — audit trail for the client card.
//
// All maths lives in services/loyaltyService.js. Config is plain settings
// keys (loyalty_enabled / loyalty_tiers / loyalty_min_spend /
// loyalty_repeat_after_last) via the existing /api/settings routes.

const express = require('express');
const { pool } = require('../db/dbAdapter');
const { requireRole } = require('../middleware/auth');
const loyaltyService = require('../services/loyaltyService');

const router = express.Router();

router.get('/status', async (req, res) => {
  const clientId = Number(req.query.client_id);
  if (!Number.isInteger(clientId) || clientId <= 0) {
    return res.status(400).json({ error: 'client_id required' });
  }
  try {
    const status = await loyaltyService.getStatus(clientId, {
      countingCurrentVisit: req.query.counting_current_visit === '1',
    });
    if (!status) return res.status(404).json({ error: 'client not found' });
    res.json(status);
  } catch (err) {
    console.error('[loyalty] status', err);
    res.status(500).json({ error: 'server error' });
  }
});

router.post('/redeem', requireRole('admin', 'manager', 'reception'), async (req, res) => {
  const { client_id, tier_visit, bill_id, counting_current_visit } = req.body || {};
  const clientId = Number(client_id);
  if (!Number.isInteger(clientId) || clientId <= 0) {
    return res.status(400).json({ error: 'client_id required' });
  }
  try {
    const result = await loyaltyService.redeemTier({
      clientId,
      tierVisit: Number(tier_visit),
      billId: bill_id != null ? Number(bill_id) : null,
      staffId: req.staff?.id || null,
      countingCurrentVisit: !!counting_current_visit,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[loyalty] redeem', err);
    res.status(500).json({ error: 'server error' });
  }
});

router.get('/events', async (req, res) => {
  const clientId = Number(req.query.client_id);
  if (!Number.isInteger(clientId) || clientId <= 0) {
    return res.status(400).json({ error: 'client_id required' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.type, e.visit_number, e.tier_visit, e.reward, e.cycle,
              e.visits_after, e.bill_id, e.created_at, t.name AS staff_name
       FROM loyalty_events e
       LEFT JOIN therapists t ON t.id = e.created_by
       WHERE e.client_id = $1
       ORDER BY e.id DESC LIMIT 50`,
      [clientId],
    );
    res.json({ events: rows });
  } catch (err) {
    console.error('[loyalty] events', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
