// SPA-LINE-PAIR-001 — inbound LINE webhook (public; LINE calls it).
//
// Two jobs, in this order:
//   1. If the message is a pairing code, claim it and reply "connected".
//   2. Forward the event, untouched, to LINE_WEBHOOK_FORWARD when set.
//
// The forward exists because a LINE channel allows exactly ONE webhook URL.
// The restaurant's support bot already owns that slot, so pointing the channel
// here would silence it. Forwarding the RAW body and the original
// X-Line-Signature header means the restaurant validates and behaves exactly
// as before — this cloud simply sits in front and takes the pairing messages.
const express = require('express');
const crypto = require('crypto');
const linePair = require('../services/linePair');

const router = express.Router();

// Raw body: the signature is computed over the exact bytes LINE sent.
router.use(express.raw({ type: '*/*', limit: '1mb' }));

function signatureOk(raw, header) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !header) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function reply(replyToken, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || !replyToken) return;
  try {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { console.warn('[line] reply failed', e.message); }
}

async function forward(raw, headers) {
  const to = process.env.LINE_WEBHOOK_FORWARD;
  if (!to) return;
  try {
    await fetch(to, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-line-signature': headers['x-line-signature'] || '',
        'user-agent': headers['user-agent'] || 'LineBotWebhook/2.0',
      },
      body: raw,
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) { console.warn('[line] forward failed', e.message); }
}

const CODE_RE = /\bSPA-[A-Z0-9]{4}\b/i;

router.post('/webhook', async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  // Answer LINE immediately; it retries on any 5xx.
  res.sendStatus(200);

  if (!signatureOk(raw, req.get('x-line-signature'))) {
    console.warn('[line] webhook rejected: bad signature');
    return;
  }
  let body = {};
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { /* keep {} */ }

  let handled = false;
  for (const event of (body.events || [])) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue;
    const text = String(event.message.text || '');
    const m = text.match(CODE_RE);
    const userId = event.source?.userId;
    if (!m || !userId) continue;
    try {
      const row = await linePair.claim(m[0], userId);
      handled = true;
      await reply(event.replyToken, row
        ? `✅ Connected. ${row.spa || 'Your spa'} will send new bookings to this chat.`
        : '⚠️ That code has expired or was already used. Open Admin → Settings → Connect LINE for a fresh one.');
    } catch (e) {
      console.error('[line] pairing failed', e.message);
    }
  }

  // Anything that was not a pairing code belongs to whoever owned this webhook
  // before us (the restaurant support bot).
  if (!handled) await forward(raw, req.headers);
});

// Broker endpoints used by the other spa clouds.
router.post('/pair/start', express.json(), async (req, res) => {
  try {
    const out = await linePair.newCode((req.body || {}).spa);
    linePair.cleanup();
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message || 'server error' });
  }
});

router.get('/pair/:code', async (req, res) => {
  try {
    res.json(await linePair.lookup(req.params.code));
  } catch (err) {
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
