// SPA-TREATWELL-001 — AI fallback extractor (Claude Sonnet).
//
// The deterministic parser (treatwellEmail.js) handles the known Treatwell
// formats for free. This is the SAFETY NET for the long tail: format drift,
// Thai text, odd forwarding, or any email the deterministic pass couldn't fully
// read. It returns the SAME shape as parseTreatwellEmail so the route can merge
// the two and only fall to the review queue when even AI is unsure.
//
// Uses the Anthropic Messages API via fetch (no SDK dependency) with a forced
// tool call for strict structured output. Model defaults to Sonnet.

const MODEL = process.env.TREATWELL_AI_MODEL || 'claude-sonnet-5';

const SCHEMA = {
  type: 'object',
  properties: {
    action:        { type: 'string', enum: ['create', 'reschedule', 'cancel', 'unknown'],
                     description: 'create = new booking, reschedule = moved time, cancel = cancellation' },
    source:        { type: ['string', 'null'],
                     description: "which booking source this email is from: 'treatwell', 'fresha', or another marketplace name if you can tell" },
    ref:           { type: ['string', 'null'], description: "the marketplace's booking/order reference (Treatwell e.g. 'T2185537204', or a Fresha booking id / reference)" },
    customer_name: { type: ['string', 'null'] },
    email:         { type: ['string', 'null'], description: "the GUEST's email — never the venue's own contact email" },
    phone:         { type: ['string', 'null'], description: "the GUEST's phone — never the venue's own number" },
    treatment:     { type: ['string', 'null'], description: 'treatment / product / service name' },
    duration_min:  { type: ['integer', 'null'] },
    date:          { type: ['string', 'null'], description: 'appointment date as YYYY-MM-DD' },
    time:          { type: ['string', 'null'], description: 'appointment start as 24h HH:mm (UK local)' },
    room:          { type: ['string', 'null'] },
    price:         { type: ['number', 'null'] },
    prepaid:       { type: ['boolean', 'null'] },
  },
  required: ['action', 'ref'],
};

// SPA-BOOKING-INGEST — generic across marketplaces (Treatwell, Fresha, …).
const PROMPT = `You extract booking details from a forwarded venue booking email — from a marketplace such as Treatwell or Fresha (English or Thai).
Rules:
- "ref" is the marketplace's booking/order reference (Treatwell uses a "T" followed by digits; Fresha uses its own booking id/reference). It appears on the email — capture it exactly.
- "source" is which marketplace sent it ('treatwell' or 'fresha') — infer it from the sender, branding, or wording.
- "create" = a new booking, "reschedule" = an existing booking moved to a new time, "cancel" = a cancellation.
- CRITICAL: capture the GUEST/customer contact, NOT the venue's own "Customer Service" email/phone.
- Times are UK local. Convert e.g. "4:30 pm" to "16:30". Convert dates to YYYY-MM-DD.
- If a field is genuinely absent, return null. Do not guess.
Call record_booking with what you find.`;

/**
 * @param {{subject?:string, text?:string, source?:string}} email
 * @returns parser-shaped object { ok, action, source, ref, name, email, phone, treatment,
 *   durationMin, date, time, startLocal, room, price, prepaid, confidence, missing, via:'ai' }
 *   or { ok:false, reason }.
 */
async function extractBookingWithAI({ subject = '', text = '', source = '' } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, reason: 'ANTHROPIC_API_KEY not set', via: 'ai' };
  if (!text) return { ok: false, reason: 'empty body', via: 'ai' };

  let data;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        tools: [{ name: 'record_booking', description: 'Record the extracted marketplace booking', input_schema: SCHEMA }],
        tool_choice: { type: 'tool', name: 'record_booking' },
        messages: [{ role: 'user', content: `${PROMPT}${source ? `\n\n(This email is from: ${source})` : ''}\n\nSubject: ${subject}\n\nEmail:\n${text}` }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, reason: `Anthropic ${res.status}: ${body.slice(0, 200)}`, via: 'ai' };
    }
    data = await res.json();
  } catch (e) {
    return { ok: false, reason: `AI request failed: ${e.message}`, via: 'ai' };
  }

  const tool = (data.content || []).find((c) => c.type === 'tool_use');
  if (!tool || !tool.input) return { ok: false, reason: 'no structured output', via: 'ai' };
  const a = tool.input;

  if (!a.ref || a.action === 'unknown') {
    return { ok: false, reason: 'AI could not identify ref/action', via: 'ai', confidence: 'low' };
  }
  const phone = a.phone ? String(a.phone).replace(/[^\d+]/g, '') : null;
  const startLocal = (a.date && a.time) ? `${a.date}T${a.time}:00` : null;

  const missing = [];
  if (!startLocal) missing.push('start time');
  if (!a.treatment) missing.push('treatment');
  if (a.action === 'create') {
    if (!a.customer_name) missing.push('name');
    if (!a.email && !phone) missing.push('contact (email/phone)');
  }
  // AI output is inherently less certain than a deterministic match — cap at medium.
  const confidence = missing.length === 0 ? 'medium' : 'low';

  return {
    ok: true, via: 'ai',
    action: a.action, ref: a.ref,
    source: (a.source || source || '').toLowerCase() || null,
    name: a.customer_name || null, email: a.email || null, phone,
    treatment: a.treatment || null, durationMin: a.duration_min || null,
    date: a.date || null, time: a.time || null, startLocal,
    room: a.room || null, price: a.price != null ? Number(a.price) : null,
    prepaid: !!a.prepaid, cancelReason: null,
    confidence, missing,
  };
}

module.exports = { extractBookingWithAI };
