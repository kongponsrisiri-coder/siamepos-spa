// SPA-SMS-COST-001 — inbound SMS sink for the platform Twilio number.
//
// The booking-confirmation number (+447861932999, TWILIO_FROM) is one-way: we
// never read replies. Until Sep 2026 the number had NO inbound SMS URL, so
// every customer who texted back ("thanks!", "can I change to 3pm?") got
// Twilio's DEFAULT robot reply ("Configure your number's SMS URL…") — a paid
// outbound SMS each time, and a confusing message for the customer.
//
// Twilio now POSTs replies here and we answer with an EMPTY TwiML document:
// nothing is sent back, nothing is charged. The body is deliberately not
// stored (a reply may carry health details) — only a masked "from" is logged
// so the shop can see in the Railway log that a customer tried to reply.
//
// Mounted PUBLIC at /api/sms (Twilio can't send our auth header). No side
// effects, so no signature check is needed — the worst an unauthenticated
// caller gets is an empty XML document.
const express = require('express');

const router = express.Router();
router.use(express.urlencoded({ extended: false }));

function emptyTwiml(_req, res) {
  res.set('Content-Type', 'text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

// POST /api/sms/inbound  (Twilio "A message comes in" webhook)
router.post('/inbound', (req, res) => {
  const from = String(req.body?.From || '');
  const masked = from ? from.slice(0, 4) + '…' + from.slice(-3) : '(unknown)';
  console.log('[sms] inbound reply from ' + masked + ' — no auto-reply sent (SPA-SMS-COST-001)');
  emptyTwiml(req, res);
});
// GET as well, so the URL can be sanity-checked in a browser / by curl.
router.get('/inbound', emptyTwiml);

module.exports = router;
