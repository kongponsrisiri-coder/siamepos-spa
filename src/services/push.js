// SPA-PUSH-001 — push notifications to the spa's own tablets and phones.
//
// A booking that arrives while the till is closed used to reach nobody: the
// in-app card and chime only play while the app is on screen. This sends a
// real notification through Firebase Cloud Messaging, so the tablet buzzes on
// its lock screen and tapping it opens that booking.
//
// Dormant until FCM_SERVICE_ACCOUNT is set (the JSON from Firebase →
// Project settings → Service accounts → Generate new private key). Without it
// every call returns { skipped: true } and nothing else changes.
const crypto = require('crypto');
const { pool } = require('../db/dbAdapter');

let cachedToken = null; // { access_token, expiresAt }

function serviceAccount() {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    // Accept the raw JSON or a base64 blob (easier to paste into Railway).
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const sa = JSON.parse(text);
    return (sa.client_email && sa.private_key && sa.project_id) ? sa : null;
  } catch (e) {
    console.error('[push] FCM_SERVICE_ACCOUNT is not valid JSON');
    return null;
  }
}

function isConfigured() { return !!serviceAccount(); }

// Google OAuth for service accounts: sign a JWT, swap it for an access token.
// Cached until a minute before it expires.
async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.access_token;
  const sa = serviceAccount();
  if (!sa) return null;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(sa.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    console.error('[push] token exchange failed', res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const data = await res.json();
  cachedToken = { access_token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.access_token;
}

async function registerDevice({ token, platform = 'android', staffId = null, label = null }) {
  if (!token) return { ok: false, reason: 'no token' };
  await pool.query(
    `INSERT INTO push_devices (token, platform, staff_id, label)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE
       SET platform = EXCLUDED.platform,
           staff_id = COALESCE(EXCLUDED.staff_id, push_devices.staff_id),
           label    = COALESCE(EXCLUDED.label, push_devices.label),
           last_seen_at = now()`,
    [String(token).slice(0, 500), platform, staffId, label],
  );
  return { ok: true };
}

async function unregisterDevice(token) {
  if (!token) return { ok: false };
  await pool.query('DELETE FROM push_devices WHERE token = $1', [token]);
  return { ok: true };
}

// Send to every registered device. Tokens Firebase says are dead are deleted,
// so the list stays clean without anyone tidying it.
async function sendToAll({ title, body, data = {} }) {
  const sa = serviceAccount();
  if (!sa) return { skipped: true, reason: 'FCM_SERVICE_ACCOUNT not set' };
  const at = await accessToken();
  if (!at) return { skipped: true, reason: 'could not get an access token' };

  const { rows } = await pool.query('SELECT token FROM push_devices');
  if (!rows.length) return { sent: 0, reason: 'no devices registered' };

  const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  let sent = 0;
  const dead = [];
  for (const { token } of rows) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
            android: {
              priority: 'HIGH',
              notification: { sound: 'default', default_vibrate_timings: true },
            },
          },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) { sent += 1; continue; }
      const text = await res.text();
      if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(text)) dead.push(token);
      else console.error('[push] send failed', res.status, text.slice(0, 160));
    } catch (e) {
      console.error('[push] send error', e.message);
    }
  }
  if (dead.length) {
    await pool.query('DELETE FROM push_devices WHERE token = ANY($1)', [dead]);
    console.log(`[push] pruned ${dead.length} dead device token(s)`);
  }
  return { sent, pruned: dead.length };
}

// The one call the booking paths make. Mirrors the in-app alert card: only
// bookings that arrived from OUTSIDE the till are worth buzzing about.
const EXTERNAL = new Set(['online', 'treatwell', 'fresha', 'whatsapp']);
const SOURCE_LABEL = { online: 'Online booking', treatwell: 'Treatwell', fresha: 'Fresha', whatsapp: 'WhatsApp' };

async function notifyNewBooking(appt) {
  try {
    if (!appt || !EXTERNAL.has(appt.source)) return { skipped: true, reason: 'not an external booking' };
    if (!isConfigured()) return { skipped: true, reason: 'push not configured' };
    const when = appt.starts_at
      ? new Date(appt.starts_at).toLocaleString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
      })
      : '';
    const bits = [appt.client_name || 'New customer', appt.treatment_name, when].filter(Boolean);
    return await sendToAll({
      title: `🔔 ${SOURCE_LABEL[appt.source] || 'New booking'}`,
      body: bits.join(' · '),
      data: {
        type: 'new_booking',
        appointment_id: appt.id,
        date: appt.starts_at ? new Date(appt.starts_at).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) : '',
      },
    });
  } catch (err) {
    console.error('[push] notifyNewBooking', err.message);
    return { ok: false };
  }
}

module.exports = { isConfigured, registerDevice, unregisterDevice, sendToAll, notifyNewBooking };
