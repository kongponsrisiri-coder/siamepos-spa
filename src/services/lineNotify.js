// SPA-LINE-NOTIFY-001 — booking alerts straight to LINE.
//
// The restaurant side already does this (Krit's BO-BILLING-002), which is why
// Korakot gets restaurant alerts without installing anything: LINE needs no
// app build, no Firebase, no per-device token, and it reaches the phone
// wherever it is. The spa now uses the same channel for new bookings.
//
// Who gets the message:
//   settings.line_notify_user_id   — per spa, set by the shop (preferred)
//   LINE_NOTIFY_TO / LINE_KORAKOT_USER_ID — env fallback
// Dormant unless LINE_CHANNEL_ACCESS_TOKEN and one of those are present.
const { pool } = require('../db/dbAdapter');

async function recipient() {
  try {
    const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'line_notify_user_id'`);
    const fromDb = (rows[0]?.value || '').trim();
    if (fromDb) return fromDb;
  } catch (e) { /* fall through to env */ }
  return (process.env.LINE_NOTIFY_TO || process.env.LINE_KORAKOT_USER_ID || '').trim();
}

function isConfigured() {
  return !!(process.env.LINE_CHANNEL_ACCESS_TOKEN
    && (process.env.LINE_NOTIFY_TO || process.env.LINE_KORAKOT_USER_ID));
}

// Best-effort: a failed alert must never affect a booking.
async function notifyLine(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to = await recipient();
  if (!token || !to) return { skipped: true, reason: 'LINE not configured' };
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.warn('[line] push', res.status, body);
      return { ok: false, status: res.status, body };
    }
    return { ok: true };
  } catch (e) {
    console.warn('[line] push failed:', e.message);
    return { ok: false, error: e.message };
  }
}

const SOURCE_LABEL = { online: 'Online booking', treatwell: 'Treatwell', fresha: 'Fresha', whatsapp: 'WhatsApp' };

async function lineNewBooking(appt) {
  if (!appt) return { skipped: true };
  const spa = process.env.SPA_NAME || 'the spa';
  const when = appt.starts_at
    ? new Date(appt.starts_at).toLocaleString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
    })
    : 'time not set';
  const lines = [
    `🔔 ${SOURCE_LABEL[appt.source] || 'New booking'} — ${spa}`,
    '',
    `${appt.client_name || 'New customer'}`,
    appt.treatment_name ? `${appt.treatment_name}` : null,
    when,
    appt.therapist_name ? `with ${appt.therapist_name}` : null,
  ].filter(Boolean);
  return notifyLine(lines.join('\n'));
}

module.exports = { notifyLine, lineNewBooking, isConfigured };
