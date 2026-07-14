// SPA-WHATSAPP-AI-001 (Stage 2) — Twilio WhatsApp inbound webhook.
//
// Twilio POSTs each inbound customer message here (application/x-www-form-
// urlencoded). We authenticate it (Twilio signature, or a shared ?s= secret for
// testing), run the concierge orchestrator, and reply with TwiML so Twilio
// delivers the answer in the same round-trip.
//
// Mounted PUBLIC (Twilio can't send our auth header) at /api/whatsapp.

const express = require('express');
const orchestrator = require('../services/conciergeOrchestrator');
const twilio = require('../services/twilioWhatsapp');

const router = express.Router();

// Twilio sends urlencoded, not JSON — parse it just for this router.
router.use(express.urlencoded({ extended: false }));

function xmlEscape(s) {
  return String(s || '').replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}
function twiml(res, message) {
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response>${
    message ? `<Message>${xmlEscape(message)}</Message>` : ''
  }</Response>`);
}

// POST /api/whatsapp/inbound
router.post('/inbound', async (req, res) => {
  // ── Authenticate the caller ──────────────────────────────────────
  const inboundSecret = process.env.TWILIO_INBOUND_SECRET;
  const secretOk = inboundSecret && req.query.s && req.query.s === inboundSecret;
  if (!secretOk) {
    // Fall back to Twilio request signature over the exact public URL.
    const base = (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
    const url = base + req.originalUrl;
    const ok = twilio.validateSignature({
      url,
      params: req.body || {},
      signature: req.get('X-Twilio-Signature'),
    });
    if (!ok) return res.status(403).send('invalid signature');
  }

  const from = req.body.From || req.body.from;   // "whatsapp:+44…"
  const body = req.body.Body || req.body.body;
  if (!from) return twiml(res, ''); // nothing to do

  try {
    const out = await orchestrator.handleInboundMessage({ from, body });
    // On skip (not configured, or human handoff) stay silent — empty TwiML.
    return twiml(res, out.skipped ? '' : out.reply);
  } catch (err) {
    console.error('[whatsapp] inbound', err);
    // Never expose internals; give the customer a graceful line.
    return twiml(res, "Sorry — something went wrong on our side. Please try again shortly or call the spa. 🙏");
  }
});

module.exports = router;
