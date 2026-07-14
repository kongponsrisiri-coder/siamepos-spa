// SPA-WHATSAPP-AI-001 (Stage 2) — thin Twilio WhatsApp client.
//
// No SDK: Twilio's REST API is a simple form-POST with basic auth, and inbound
// signature validation is an HMAC-SHA1. Keeping it dependency-free matches the
// rest of the spa (Brevo/Anthropic are also plain fetch).
//
// Env (set once the WhatsApp Business number is approved):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_WHATSAPP_FROM   e.g. "whatsapp:+447700900000"
// Optional:
//   TWILIO_INBOUND_SECRET  a shared secret accepted as ?s=… on the inbound URL,
//                          as an alternative to X-Twilio-Signature validation.

const crypto = require('crypto');

function isConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM);
}

// Send a WhatsApp message. `to` may be a bare "+44…" or already "whatsapp:+44…".
async function sendWhatsApp(to, body) {
  if (!isConfigured()) {
    const e = new Error('Twilio WhatsApp not configured');
    e.code = 'TWILIO_NOT_CONFIGURED';
    throw e;
  }
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_WHATSAPP_FROM;
  const toAddr = /^whatsapp:/.test(to) ? to : `whatsapp:${to}`;

  const form = new URLSearchParams({ From: from, To: toAddr, Body: String(body || '').slice(0, 1600) });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Twilio ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// Validate an inbound Twilio webhook. Twilio signs (url + sorted POST params)
// with the auth token → base64 HMAC-SHA1 in the X-Twilio-Signature header.
// `url` must be the exact public URL Twilio was configured to call.
function validateSignature({ url, params, signature }) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;
  const sorted = Object.keys(params || {}).sort();
  let data = url;
  for (const k of sorted) data += k + params[k];
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (_) {
    return false; // length mismatch
  }
}

module.exports = { isConfigured, sendWhatsApp, validateSignature };
