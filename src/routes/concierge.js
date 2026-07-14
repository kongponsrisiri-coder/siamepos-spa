// SPA-WHATSAPP-AI-001 — HTTP surface for the concierge tools.
//
// The Stage-2 orchestrator (same Node service) calls the conciergeTools
// functions DIRECTLY. This router exists so the exact same tools can also be
// driven over HTTP — for isolated testing or a Make.com prototype.
//
// Because holdSlot performs a REAL booking + charge, every route is gated by a
// shared secret (X-Concierge-Secret header == CONCIERGE_SECRET env). If the
// secret isn't set the whole surface is disabled (503) — it never runs open.

const express = require('express');
const tools = require('../services/conciergeTools');

const router = express.Router();

router.use((req, res, next) => {
  const secret = process.env.CONCIERGE_SECRET;
  if (!secret) return res.status(503).json({ error: 'concierge HTTP surface disabled (set CONCIERGE_SECRET to enable)' });
  const given = req.get('X-Concierge-Secret') || '';
  // constant-time-ish compare (lengths differ → fail fast, fine for a shared secret)
  if (given.length !== secret.length || given !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// Map a thrown tool error to an HTTP status (badRequest carries .status).
function fail(res, err) {
  const status = err && err.status ? err.status : 500;
  if (status >= 500) console.error('[concierge] tool error', err);
  res.status(status).json({ error: err.message || 'server error' });
}

// GET /api/concierge/treatments
router.get('/treatments', async (_req, res) => {
  try { res.json({ treatments: await tools.getTreatments() }); }
  catch (err) { fail(res, err); }
});

// GET /api/concierge/spa-info
router.get('/spa-info', async (_req, res) => {
  try { res.json({ spa: await tools.getSpaInfo() }); }
  catch (err) { fail(res, err); }
});

// GET /api/concierge/availability?treatment_id=&date=YYYY-MM-DD&therapist_id=
router.get('/availability', async (req, res) => {
  try {
    const slots = await tools.checkAvailability({
      treatment_id: req.query.treatment_id,
      date: req.query.date,
      therapist_id: req.query.therapist_id,
    });
    res.json({ slots });
  } catch (err) { fail(res, err); }
});

// POST /api/concierge/hold
// body: { treatment_id, slot_datetime, customer:{name,phone,email?}, therapist_id?, notes? }
router.post('/hold', async (req, res) => {
  try { res.status(201).json(await tools.holdSlot(req.body || {})); }
  catch (err) { fail(res, err); }
});

// GET /api/concierge/booking/:id
router.get('/booking/:id', async (req, res) => {
  try {
    const b = await tools.getBookingStatus(req.params.id);
    if (!b) return res.status(404).json({ error: 'booking not found' });
    res.json({ booking: b });
  } catch (err) { fail(res, err); }
});

module.exports = router;
