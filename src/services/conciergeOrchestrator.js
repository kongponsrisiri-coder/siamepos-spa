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
    name: 'list_therapists',
    description: "List the spa's therapists and who is working on a given date (with their hours), so the customer can choose a therapist by name. Pair with check_availability (therapist_id) to offer that therapist's actual free times.",
    input_schema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'date to check, YYYY-MM-DD; omit for today' } },
      required: [],
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
        customer_phone: { type: 'string', description: 'UK mobile number the customer gave (website chats only — on WhatsApp the number is already known)' },
        customer_email: { type: 'string', description: 'email address the customer gave, for the receipt and confirmation' },
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

// SPA-CHATBOT-FIX-001 — the calendar the model reasons with, in UK time.
// Previously the prompt said only "Today's date is 2026-09-07" (UTC, no
// weekday) and slots came as UTC ISO strings, so the model had to work out
// weekdays itself — which is how a customer asking for Friday got Saturday.
function ukCalendarContext(now = new Date()) {
  const fmt = (d, o) => d.toLocaleString('en-GB', { timeZone: 'Europe/London', ...o });
  const lines = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    const ymd = d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    const tag = i === 0 ? ' (TODAY)' : i === 1 ? ' (tomorrow)' : '';
    lines.push(`  ${fmt(d, { weekday: 'long' })} ${ymd}${tag}`);
  }
  return `Right now it is ${fmt(now, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })} UK time (Europe/London).
Calendar for the next days (use ONLY this to turn a weekday into a date):
${lines.join('\n')}
"This Friday" means the next Friday in this list. Always say the weekday AND the date when you offer or confirm a time, e.g. "Friday 11 September at 15:00". Use the "label" field the tools give you — never convert times yourself.`;
}

function buildSystemPrompt(spaName, ttlMin, channel = 'whatsapp') {
  const name = spaName || 'our spa';
  const contactRule = channel === 'web'
    ? `- This is the WEBSITE chat: you do NOT have the customer's phone number. Before holding a slot, ask for a UK mobile number (for the SMS confirmation) and/or an email address (for the receipt). Pass them to hold_slot as customer_phone / customer_email. Never say you will use "this WhatsApp number".`
    : `- This is WhatsApp: the customer's number is already known, so confirm "I'll use this WhatsApp number" and ask for an email only if they'd like a receipt.`;
  return `You are Tara, the friendly booking assistant for ${name}, chatting with customers on the spa's website and WhatsApp. Your job is to help people learn about treatments, answer questions about the spa, and book an appointment by holding a slot and sending a secure payment link.

WHO YOU ARE
- Your name is Tara, ${name}'s assistant. Introduce yourself as Tara when you first greet someone or when they ask your name.
- Be warm and personable, like a lovely receptionist. But stay honest: if someone asks whether you're a real person, a bot or AI, tell them warmly that you're ${name}'s digital assistant and you can connect them with the team any time. Never claim to be a specific human staff member or deny being automated.

LANGUAGE
- Reply in the SAME language the customer uses — Thai or English. If they mix, follow their lead.
- Tara is female. In Thai, always use feminine politeness — end sentences with ค่ะ/คะ and refer to yourself as หนู or by your name Tara. Do NOT use the stiff/formal ดิฉัน, and never use the male ครับ/ผม.
- Be warm, concise and professional. Short WhatsApp-style messages, not essays.

WHAT YOU CAN DO
- Answer treatment questions using get_treatments. Never quote a price, duration or treatment you didn't get from this tool.
- Answer spa questions (address, hours, phone) using get_spa_info.
- Check real availability with check_availability. Only ever offer times it returns. Never guess or invent slots.
- Hold a slot with hold_slot, which returns a secure payment link. Send that link so the customer can confirm and pay.

HOW A BOOKING MUST GO — follow exactly
1. Help the customer choose a treatment and a date/time from real available slots.
2. Collect their name and how to reach them (see CONTACT below).
3. Read the details back and get a clear "yes", using the slot's label: e.g. "To confirm: [treatment], Friday 11 September at 15:00, under [name] — shall I hold it for you?"
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
- Never address the customer by a name they have not given you in THIS conversation. If you don't know their name yet, don't use one.
- When taking details, briefly note their information is used only to manage their booking (GDPR).

CONTACT
${contactRule}

${ukCalendarContext()}`;
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
    if (name === 'list_therapists')    return { result: await tools.listTherapists({ date: input.date }) };
    if (name === 'hold_slot') {
      const r = await tools.holdSlot({
        treatment_id: input.treatment_id,
        slot_datetime: input.slot_datetime,
        therapist_id: input.therapist_id,
        // Phone comes from the WhatsApp channel, never the model — the payment
        // link + confirmation must reach the real number.
        customer: {
          name:    input.customer_name || ctx.customerName || (ctx.channel === 'web' ? 'Website customer' : 'WhatsApp customer'),
          // WhatsApp: the channel's number wins. Website: only what the customer typed.
          phone:   ctx.channel === 'web' ? (input.customer_phone || null) : ctx.phone,
          email:   input.customer_email || null,
          channel: ctx.channel,
        },
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
// SPA-CHATBOT-FIX-001 — keep the transcript valid for the API after trimming.
// A tool_result must directly follow its tool_use: cutting the window in the
// middle of a pair made Anthropic return 400 ("unexpected tool_use_id") and
// the bot fell back to "I'm having trouble" + handoff. Drop a leading
// tool_result-only message, and a trailing assistant tool_use with no result.
function sanitizeMessages(list) {
  const msgs = Array.isArray(list) ? list.slice() : [];
  const isToolResultMsg = (m) => m && m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result');
  const hasToolUse = (m) => m && m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_use');
  while (msgs.length && (isToolResultMsg(msgs[0]) || msgs[0].role !== 'user')) msgs.shift();
  while (msgs.length && hasToolUse(msgs[msgs.length - 1])) msgs.pop();
  // Never two consecutive same-role messages (merge would be lossy; drop the older).
  const out = [];
  for (const m of msgs) {
    if (out.length && out[out.length - 1].role === m.role) out.pop();
    out.push(m);
  }
  return out;
}

async function saveConversation(phone, { customer_name, messages, handoff }) {
  const trimmed = sanitizeMessages(messages.slice(-MAX_TURNS));
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

  const channel = /^web:/i.test(phone) ? 'web' : 'whatsapp';
  const spa = await tools.getSpaInfo().catch(() => ({ name: null }));
  const system = buildSystemPrompt(spa.name, tools.HOLD_TTL_MIN, channel);

  const messages = sanitizeMessages(conv.messages);
  messages.push({ role: 'user', content: text });

  let handoff = false;
  let reply = '';
  const ctx = { phone, customerName: conv.customer_name, channel };

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

// SPA-CHATBOT-FIX-001 — after payment, confirm on whatever channel we have:
// WhatsApp bookings get the WhatsApp message; website bookings get the
// branded email (if we have an address) and the SMS (if we have a mobile).
// Before this, a website customer who paid heard nothing at all.
async function sendBookingConfirmationAny(appointmentId) {
  try {
    const { rows } = await pool.query(
      `SELECT ap.*, c.name AS client_name, c.phone AS client_phone, c.email AS client_email,
              t.name AS treatment_name, t.duration_minutes, t.price,
              th.name AS therapist_name, r.name AS room_name
         FROM appointments ap
         LEFT JOIN clients c ON c.id = ap.client_id
         LEFT JOIN treatments t ON t.id = ap.treatment_id
         LEFT JOIN therapists th ON th.id = ap.therapist_id
         LEFT JOIN rooms r ON r.id = ap.room_id
        WHERE ap.id = $1`, [Number(appointmentId)]);
    const a = rows[0];
    if (!a) return { skipped: true, reason: 'not found' };
    if (a.source === 'whatsapp') return sendBookingConfirmationWhatsApp(appointmentId);
    const email = require('./emailService');
    const client = { name: a.client_name, phone: a.client_phone, email: a.client_email };
    const treatment = { name: a.treatment_name, duration_minutes: a.duration_minutes, price: a.price };
    const out = {};
    if (a.client_email) {
      try {
        let policyText = null;
        try { const r = await pool.query("SELECT value FROM settings WHERE key = 'cancel_policy_text'"); policyText = r.rows[0]?.value || null; } catch (_) {}
        await email.sendBookingConfirmation({
          client, appointment: a, treatment, therapistName: a.therapist_name, roomName: a.room_name,
          depositAmount: Number(a.deposit_amount || 0), totalAmount: Number(a.price_at_booking ?? a.price ?? 0), cancellationPolicy: policyText,
        });
        out.email = true;
      } catch (e) { console.error('[concierge] confirm email', e.message); }
    }
    if (a.client_phone) {
      try { await email.sendBookingSms({ client, appointment: a, treatment }); out.sms = true; }
      catch (e) { console.error('[concierge] confirm sms', e.message); }
    }
    return { ok: true, ...out };
  } catch (err) {
    console.error('[concierge] sendBookingConfirmationAny', err.message);
    return { ok: false, error: err.message };
  }
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
  sendBookingConfirmationAny,   // SPA-CHATBOT-FIX-001
  sanitizeMessages,
  ukCalendarContext,
  // exported for testing
  execTool,
  normalizePhone,
  buildSystemPrompt,
  TOOL_DEFS,
};
