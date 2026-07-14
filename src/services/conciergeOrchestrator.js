// SPA-WHATSAPP-AI-001 (Stage 2) — the WhatsApp AI concierge orchestrator.
//
// Runs a Claude tool-use loop over the SiamSpa tools (conciergeTools) for an
// inbound WhatsApp message, keeps per-number conversation memory, and returns
// the reply text. The Twilio route (routes/whatsapp.js) sends that reply back.
//
// Dormant until ANTHROPIC_API_KEY is set — handleInboundMessage returns a
// graceful "not configured" so nothing crashes pre-credentials.

const { pool } = require('../db/dbAdapter');
const tools = require('./conciergeTools');
const twilio = require('./twilioWhatsapp');

const MODEL      = process.env.CONCIERGE_MODEL || 'claude-sonnet-5';
const MAX_STEPS  = 6;      // tool-call rounds before we bail with a safe message
const MAX_TURNS  = 24;     // conversation messages kept for context (token bound)

// ── Tool schemas exposed to Claude ─────────────────────────────────
const TOOL_DEFS = [
  {
    name: 'get_treatments',
    description: 'List the spa treatments that can be booked online, with duration (minutes) and price (GBP). Use this before quoting any treatment, price or duration — never invent them.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_spa_info',
    description: 'Get the spa name, address, phone and opening hours. Use this to answer questions about where the spa is or when it is open.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'check_availability',
    description: 'Get the REAL free appointment slots for a treatment on a given date. Only ever offer times this returns.',
    input_schema: {
      type: 'object',
      properties: {
        treatment_id: { type: 'integer', description: 'id from get_treatments' },
        date: { type: 'string', description: 'date to check, YYYY-MM-DD' },
        therapist_id: { type: 'integer', description: 'optional preferred therapist id' },
      },
      required: ['treatment_id', 'date'],
    },
  },
  {
    name: 'hold_slot',
    description: 'Hold a specific slot for the customer and get a secure payment link. Call ONLY after the customer has clearly confirmed treatment, date/time and their name. The booking is confirmed only once they pay via the link.',
    input_schema: {
      type: 'object',
      properties: {
        treatment_id:  { type: 'integer' },
        slot_datetime: { type: 'string', description: 'exact slot_datetime (ISO 8601) returned by check_availability' },
        customer_name: { type: 'string', description: "the customer's name for the booking" },
        therapist_id:  { type: 'integer', description: 'optional, if a specific therapist was chosen' },
      },
      required: ['treatment_id', 'slot_datetime', 'customer_name'],
    },
  },
  {
    name: 'request_human_handoff',
    description: 'Escalate to a human team member. Use for complaints, medical/pregnancy/injury questions, refunds or cancellations, special requests, an upset customer, or anything you are unsure about. After calling this, tell the customer a team member will help.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'short reason for the handoff' } },
      required: ['reason'],
    },
  },
];

function normalizePhone(from) {
  return String(from || '').replace(/^whatsapp:/i, '').trim();
}

function buildSystemPrompt(spaName, ttlMin) {
  const name = spaName || 'our spa';
  return `You are the friendly booking concierge for ${name}, chatting with customers on WhatsApp. Your job is to help people learn about treatments, answer questions about the spa, and book an appointment by holding a slot and sending a secure payment link.

LANGUAGE
- Reply in the SAME language the customer uses — Thai or English. If they mix, follow their lead. Keep Thai natural and polite (ค่ะ/ครับ).
- Be warm, concise and professional. Short WhatsApp-style messages, not essays.

WHAT YOU CAN DO
- Answer treatment questions using get_treatments. Never quote a price, duration or treatment you didn't get from this tool.
- Answer spa questions (address, hours, phone) using get_spa_info.
- Check real availability with check_availability. Only ever offer times it returns. Never guess or invent slots.
- Hold a slot with hold_slot, which returns a secure payment link. Send that link so the customer can confirm and pay.

HOW A BOOKING MUST GO — follow exactly
1. Help the customer choose a treatment and a date/time from real available slots.
2. Collect their name and confirm their phone (this WhatsApp number is usually fine).
3. Read the details back and get a clear "yes": e.g. "To confirm: [treatment], [day date] at [time], under [name] — shall I hold it for you?"
4. Only after "yes", call hold_slot. Then send the returned payment link and say the hold lasts ${ttlMin} minutes, and that the booking is confirmed once payment is received.
5. Do NOT say the booking is "confirmed" or "booked" yet. The system sends a confirmation automatically once they've paid.

HARD RULES — never break these
- Never invent treatments, prices, durations or available times. If a tool doesn't give it, say you'll check or offer a human.
- Never take payment or card details in the chat. Payment happens only through the link.
- Never claim a booking is confirmed before payment. Held ≠ confirmed.
- If a wanted slot isn't available, offer the nearest real alternatives from check_availability.
- Hand off to a human (request_human_handoff) for complaints, medical/pregnancy/injury questions, special requests, refunds/cancellations, an upset customer, or anything you're unsure of.
- If a tool errors, apologise briefly and offer a callback or a human — never guess or expose technical errors.
- Don't discuss anything outside the spa and its bookings. Politely steer back.
- When taking details, briefly note their information is used only to manage their booking (GDPR).

Today's date is ${new Date().toISOString().slice(0, 10)}. Treatment and slot times are in UK (Europe/London) time.`;
}

// ── Tool execution ─────────────────────────────────────────────────
// Returns { result, handoff? }. Never throws — a tool error becomes a result
// the model can read and apologise for.
async function execTool(name, input, ctx) {
  try {
    if (name === 'get_treatments')     return { result: await tools.getTreatments() };
    if (name === 'get_spa_info')       return { result: await tools.getSpaInfo() };
    if (name === 'check_availability') return { result: await tools.checkAvailability({
      treatment_id: input.treatment_id, date: input.date, therapist_id: input.therapist_id }) };
    if (name === 'hold_slot') {
      const r = await tools.holdSlot({
        treatment_id: input.treatment_id,
        slot_datetime: input.slot_datetime,
        therapist_id: input.therapist_id,
        // Phone comes from the WhatsApp channel, never the model — the payment
        // link + confirmation must reach the real number.
        customer: { name: input.customer_name || ctx.customerName || 'WhatsApp customer', phone: ctx.phone },
      });
      return { result: r };
    }
    if (name === 'request_human_handoff') {
      return { result: { ok: true, message: 'A team member has been notified and will follow up shortly.' }, handoff: true };
    }
    return { result: { error: `unknown tool ${name}` } };
  } catch (e) {
    return { result: { error: e.message || 'tool failed' } };
  }
}

// ── Anthropic Messages call ────────────────────────────────────────
async function callClaude({ system, messages }) {
  const key = process.env.ANTHROPIC_API_KEY;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, tools: TOOL_DEFS, messages }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// ── Conversation persistence ───────────────────────────────────────
async function loadConversation(phone) {
  const { rows } = await pool.query('SELECT * FROM concierge_conversations WHERE phone = $1', [phone]);
  return rows[0] || { phone, customer_name: null, messages: [], handoff: false };
}
async function saveConversation(phone, { customer_name, messages, handoff }) {
  const trimmed = messages.slice(-MAX_TURNS);
  await pool.query(
    `INSERT INTO concierge_conversations (phone, customer_name, messages, handoff, updated_at)
     VALUES ($1,$2,$3::jsonb,$4, now())
     ON CONFLICT (phone) DO UPDATE
       SET customer_name = COALESCE(EXCLUDED.customer_name, concierge_conversations.customer_name),
           messages = EXCLUDED.messages,
           handoff  = EXCLUDED.handoff,
           updated_at = now()`,
    [phone, customer_name || null, JSON.stringify(trimmed), !!handoff],
  );
}

// ── Public: handle one inbound WhatsApp message ────────────────────
// Returns { reply } to send back, or { skipped, reason } when we should stay
// silent (not configured, or the conversation is in human-handoff).
async function handleInboundMessage({ from, body }) {
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: true, reason: 'ANTHROPIC_API_KEY not set' };
  const text = String(body || '').trim();
  if (!text) return { skipped: true, reason: 'empty message' };
  const phone = normalizePhone(from);

  const conv = await loadConversation(phone);
  if (conv.handoff) {
    // A human is handling this thread — don't auto-reply. (Staff can clear the
    // handoff flag to hand it back to the bot.)
    return { skipped: true, reason: 'handoff' };
  }

  const spa = await tools.getSpaInfo().catch(() => ({ name: null }));
  const system = buildSystemPrompt(spa.name, tools.HOLD_TTL_MIN);

  const messages = Array.isArray(conv.messages) ? conv.messages.slice() : [];
  messages.push({ role: 'user', content: text });

  let handoff = false;
  let reply = '';
  const ctx = { phone, customerName: conv.customer_name };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const data = await callClaude({ system, messages });
      messages.push({ role: 'assistant', content: data.content });

      if (data.stop_reason === 'tool_use') {
        const results = [];
        for (const block of data.content || []) {
          if (block.type !== 'tool_use') continue;
          const out = await execTool(block.name, block.input || {}, ctx);
          if (out.handoff) handoff = true;
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out.result) });
        }
        messages.push({ role: 'user', content: results });
        continue; // let Claude read the tool results and respond
      }

      reply = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      break;
    }
  } catch (err) {
    console.error('[concierge] orchestrator', err.message);
    // Fail safe (guardrail) — apologise, offer a human, never expose the error.
    reply = "Sorry — I'm having a little trouble right now. A team member will get back to you shortly, or please call the spa directly. 🙏";
    handoff = true;
  }

  if (!reply) reply = "Sorry, I didn't quite catch that — could you rephrase? Or I can have a team member help you.";

  await saveConversation(phone, { customer_name: ctx.customerName, messages, handoff });
  return { reply, handoff };
}

// ── Public: proactive booking-confirmed message (called by the Stripe webhook)
async function sendBookingConfirmationWhatsApp(appointmentId) {
  if (!twilio.isConfigured()) return { skipped: true, reason: 'twilio not configured' };
  try {
    const { rows } = await pool.query(
      `SELECT ap.starts_at, ap.source, c.phone, c.name AS client_name, t.name AS treatment_name
         FROM appointments ap
         LEFT JOIN clients c ON c.id = ap.client_id
         LEFT JOIN treatments t ON t.id = ap.treatment_id
        WHERE ap.id = $1`,
      [Number(appointmentId)],
    );
    const a = rows[0];
    if (!a || !a.phone) return { skipped: true, reason: 'no phone' };
    // Only message customers who actually came through WhatsApp.
    if (a.source !== 'whatsapp') return { skipped: true, reason: 'not a whatsapp booking' };
    const when = new Date(a.starts_at).toLocaleString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
    });
    const msg = `✅ Payment received — your booking is confirmed!\n\n${a.treatment_name || 'Treatment'}\n${when}\n\nWe look forward to seeing you. Reply here if you need anything. 🌸`;
    await twilio.sendWhatsApp(a.phone, msg);
    return { ok: true };
  } catch (err) {
    console.error('[concierge] sendBookingConfirmationWhatsApp', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  handleInboundMessage,
  sendBookingConfirmationWhatsApp,
  // exported for testing
  execTool,
  normalizePhone,
  buildSystemPrompt,
  TOOL_DEFS,
};
