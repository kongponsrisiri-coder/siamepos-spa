// SPA-TREATWELL-001 — deterministic parser for forwarded Treatwell booking emails.
//
// Treatwell has no API, but it emails the venue on every new / rescheduled /
// cancelled booking. The venue auto-forwards those emails to us; this module
// turns the (plaintext) email into a normalised booking object that the
// Treatwell ingest engine (src/routes/treatwell.js) can place on the timetable.
//
// PRIMARY = deterministic (this file). The real emails carry a clean, stable
// "Booking Details" block, so we parse fields directly — free, instant, exact.
// Anything this can't confidently parse should fall back to AI (Haiku) and, if
// still uncertain, the review queue. This file does NOT call AI; it just reports
// `confidence` + `missing` so the caller can decide.
//
// Verified against real Highbury Thai Massage emails (24 Jun 2026):
//   new        → ref T2185537204 (Babette Stephens, Aromatherapy Massage 90m)
//   reschedule → ref T2185537204
//   cancel     → ref T2185130278 (Romilly nolan, Traditional Thai Massage)
//
// Format quirks the real emails revealed (do NOT "simplify" these away):
//  - The venue's OWN email/phone appear under "Customer Service" as
//    `Email:` / `Phone number:`. The GUEST fields are `Guest Email:` /
//    `Guest Tel.:`. Never read the bare `Email:` line as the customer.
//  - New/Reschedule give one `Date/time 23 June 2026 at 4:30 pm` line;
//    Cancel splits it into `Date:` + `Time:`.
//  - Name label is `Guest name … New` (new/resch, with a "New" badge word) vs
//    `Client Name:` (cancel).
//  - The `T########` order ref appears in EVERY type → the universal match key.

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// First labelled value matching any of the given label regexes (multiline).
// Labels in these emails are either "Label: value" or "Label value".
function field(text, labels) {
  for (const label of labels) {
    const re = new RegExp('^\\s*' + label + '\\s*:?\\s+(.+?)\\s*$', 'im');
    const m = text.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

// "23 June 2026" + optional "4:30 pm" → { date:'2026-06-23', time:'16:30',
// startLocal:'2026-06-23T16:30:00' }. Times are UK LOCAL wall-clock — the
// placement layer is responsible for storing them as Europe/London.
function parseDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const dm = dateStr.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!dm) return null;
  const day = Number(dm[1]);
  const month = MONTHS[dm[2].toLowerCase()];
  const year = Number(dm[3]);
  if (!month) return null;

  let hour = 0, min = 0;
  const ts = timeStr || (dateStr.match(/\bat\b\s+(.+)$/i) || [])[1];
  if (ts) {
    const tm = ts.match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
    if (tm) {
      hour = Number(tm[1]);
      min = Number(tm[2]);
      const mer = (tm[3] || '').toLowerCase();
      if (mer === 'pm' && hour < 12) hour += 12;
      if (mer === 'am' && hour === 12) hour = 0;
    }
  }
  const p2 = (n) => String(n).padStart(2, '0');
  const date = `${year}-${p2(month)}-${p2(day)}`;
  const time = `${p2(hour)}:${p2(min)}`;
  return { date, time, startLocal: `${date}T${time}:00`, hasTime: !!ts };
}

// Strip the Gmail "---------- Forwarded message ---------" header block so its
// own `Date:` / `Subject:` / `To:` lines can't be mistaken for booking fields
// (the cancel email's booking date lives in a later `Date:` line, and the
// forward header's `Date: Sat, 20 Jun 2026, 12:07` would otherwise win).
function stripForwardHeader(text) {
  return text.replace(/^[\s\S]*?-{3,}\s*Forwarded message\s*-{3,}[\s\S]*?\n\s*\n/, '');
}

// Detect the action from the original Treatwell subject + a marker scan of the
// body (the forwarded Gmail subject is "Fwd: …", so we also look in the text).
function detectAction(subject, text) {
  // Subject is the reliable signal (the original Treatwell subject survives the
  // "Fwd: " prefix). Check it first.
  const s = subject || '';
  if (/rescheduled/i.test(s)) return 'reschedule';
  if (/cancellation/i.test(s)) return 'cancel';
  if (/new Treatwell booking/i.test(s)) return 'create';
  // Body fallback — use SPECIFIC phrases, not loose words: a reschedule body
  // contains "cancellations" and "reschedule" in prose, so match the headline
  // sentence / banner instead.
  const b = text.slice(0, 1500);
  if (/appointment has been rescheduled/i.test(b)) return 'reschedule';
  if (/^\s*\*?CANCELLATION\*?\s*$/im.test(b) || /booking through Treatwell is\s+cancelled/i.test(b)) return 'cancel';
  if (/new customer via Treatwell/i.test(b)) return 'create';
  return 'unknown';
}

/**
 * Parse a forwarded Treatwell email.
 * @param {{subject?:string, text:string}} email  raw plaintext body (+ optional subject)
 * @returns normalised booking object.
 */
function parseTreatwellEmail({ subject = '', text = '' } = {}) {
  if (!text || typeof text !== 'string') {
    return { ok: false, reason: 'empty body', confidence: 'none' };
  }

  // Detect + match key on the FULL text (subject markers may live in the
  // forwarded header), then strip that header so its Date/Subject/To lines
  // can't pollute field extraction.
  const ref = (text.match(/\bT\d{8,}\b/) || [])[0] || null;
  const action = detectAction(subject, text);
  const body = stripForwardHeader(text);

  if (!ref) {
    return { ok: false, reason: 'no Treatwell order ref (T…) found', action, confidence: 'none' };
  }
  if (action === 'unknown') {
    return { ok: false, reason: 'could not classify (new/reschedule/cancel)', ref, confidence: 'low' };
  }

  // Name — strip the trailing "New" badge word on new/reschedule.
  let name = field(body, ['Client Name', 'Guest name']);
  if (name) name = name.replace(/\s+New$/i, '').trim();

  // Guest contact — ONLY the "Guest" labels (never the venue's Customer Service block).
  const email = field(body, ['Guest Email']);
  const phoneRaw = field(body, ['Guest Tel\\.?', 'Guest Phone']);
  const phone = phoneRaw ? phoneRaw.replace(/[^\d+]/g, '') : null;

  let treatment = field(body, ['Product Name']);
  if (!treatment) {
    // Reschedule has no "Product Name:" — the treatment is the Appointment-block
    // line "Aromatherapy Massage (1 hour 30 minutes )".
    const tm = body.match(/^\s*([A-Za-z][^\n(]+?)\s*\(\s*\d+\s*(?:hour|min)/im);
    if (tm) treatment = tm[1].trim();
  }
  const option = field(body, ['Product option']);   // e.g. "90 Minutes"
  let durationMin = null;
  if (option) {
    const d = option.match(/(\d+)\s*min/i);
    if (d) durationMin = Number(d[1]);
  }
  if (durationMin == null) {
    // fallback: "(1 hour 30 minutes)" on the appointment treatment line
    const hm = body.match(/\((?:(\d+)\s*hour[s]?)?\s*(?:(\d+)\s*min)/i);
    if (hm) durationMin = (Number(hm[1] || 0) * 60) + Number(hm[2] || 0);
  }

  // Date/time — "Date/time …" (new/resch) OR split "Date:" + "Time:" (cancel).
  const dateTimeLine = field(body, ['Date/time']);
  const dateOnly = field(body, ['Date']);
  const timeOnly = field(body, ['Time']);
  const when = dateTimeLine
    ? parseDateTime(dateTimeLine)
    : parseDateTime(dateOnly, timeOnly);

  const room = field(body, ['with']);   // "Treatment Room 2" — a ROOM, not a therapist
  const priceMatch = body.match(/Price(?:\s+paid)?\s*:?\s*£\s*([\d.,]+)/i);
  const price = priceMatch ? Number(priceMatch[1].replace(/,/g, '')) : null;
  const prepaid = /\bStatus\s+Prepaid\b/i.test(body) || /pre-?paid booking/i.test(body);
  // Reason is "...following reason: *Customer changed their mind / Booked by
  // mistake*" — bounded by the *…* markers, and wraps across a line.
  const cancelReason = action === 'cancel'
    ? ((body.match(/following reason:\s*\*([^*]+)\*/i) || [])[1] || '').replace(/\s+/g, ' ').trim() || null
    : null;

  // Confidence + what's missing (drives AI-fallback / review-queue decisions).
  const missing = [];
  if (!when || !when.hasTime) missing.push('start time');
  if (!treatment) missing.push('treatment');
  if (action === 'create') {
    if (!name) missing.push('name');
    if (!email && !phone) missing.push('contact (email/phone)');
  }
  const confidence = missing.length === 0 ? 'high' : (missing.length <= 1 ? 'medium' : 'low');

  return {
    ok: true,
    action,                       // 'create' | 'reschedule' | 'cancel'
    ref,                          // external_ref — match key for resched/cancel
    name,
    email,
    phone,
    treatment,
    durationMin,
    date: when ? when.date : null,
    time: when ? when.time : null,
    startLocal: when ? when.startLocal : null,   // London wall-clock, no tz
    room,
    price,
    prepaid,
    cancelReason,
    confidence,                   // 'high' | 'medium' | 'low'
    missing,                      // [] when fully parsed
  };
}

module.exports = { parseTreatwellEmail };
