// Brevo (formerly Sendinblue) transactional email.
// Uses native fetch (Node 20+) so we don't pull in another SDK.

const crypto = require('crypto');
const { pool } = require('../db/database');

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

// ─── SPA-CAMPAIGNS-001: HMAC unsubscribe token ─────────────────────────
// Stateless single-use-ish token: `<base64url(email)>.<hmac>` signed with
// UNSUB_SECRET. Public /api/unsubscribe?token=… verifies and stamps the
// client. The secret has an insecure default so dev still works, but the
// .env.example warns about setting it in production.
function unsubscribeToken(email) {
  const secret = process.env.UNSUB_SECRET || 'siamspa-default-unsub-secret-change-me';
  const e = String(email || '').trim().toLowerCase();
  const hmac = crypto.createHmac('sha256', secret).update(e).digest('hex').slice(0, 16);
  return Buffer.from(e).toString('base64url') + '.' + hmac;
}

function parseUnsubscribeToken(token) {
  try {
    const [b64, hmac] = String(token || '').split('.');
    if (!b64 || !hmac) return null;
    const email = Buffer.from(b64, 'base64url').toString('utf8');
    const secret = process.env.UNSUB_SECRET || 'siamspa-default-unsub-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(email).digest('hex').slice(0, 16);
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac))) return null;
    return email;
  } catch { return null; }
}

// SPA-PAY-001 — HMAC-signed booking token for the customer manage-link.
// Encodes the appointment id; the public /api/booking/by-token/:token
// endpoint verifies the HMAC before returning data. Separate secret
// from UNSUB_SECRET so a compromise of one doesn't compromise the other.
function bookingToken(appointmentId) {
  const secret = process.env.BOOKING_SECRET || 'siamspa-default-booking-secret-change-me';
  const id = String(appointmentId);
  const hmac = crypto.createHmac('sha256', secret).update(id).digest('hex').slice(0, 20);
  return Buffer.from(id).toString('base64url') + '.' + hmac;
}

function parseBookingToken(token) {
  try {
    const [b64, hmac] = String(token || '').split('.');
    if (!b64 || !hmac) return null;
    const id = Buffer.from(b64, 'base64url').toString('utf8');
    const secret = process.env.BOOKING_SECRET || 'siamspa-default-booking-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(id).digest('hex').slice(0, 20);
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac))) return null;
    const n = Number(id);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

async function sendBrevoEmail({ to, subject, html, replyTo }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('[email] BREVO_API_KEY missing — skipping send to', to);
    return { skipped: true };
  }
  const sender = {
    name: process.env.SPA_NAME || 'SiamEPOS Spa',
    email: process.env.SPA_EMAIL || 'info@siamepos.co.uk',
  };
  const body = {
    sender,
    to: Array.isArray(to) ? to : [{ email: to }],
    subject,
    htmlContent: html,
    replyTo: replyTo || sender,
  };
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('[email] brevo error', res.status, text);
    return { ok: false, status: res.status };
  }
  return { ok: true };
}

function formatStarts(starts_at) {
  const d = new Date(starts_at);
  return d.toLocaleString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function sendBookingConfirmation({ client, appointment, treatment, cancellationPolicy, depositAmount, totalAmount, therapistName, roomName }) {
  if (!client?.email) return { skipped: true };
  const spaName = process.env.SPA_NAME || 'SiamEPOS Spa';
  const when = formatStarts(appointment.starts_at);
  const apiBase = process.env.PUBLIC_API_URL || 'https://spa-api.siamepos.co.uk';
  const manageUrl = `${apiBase}/my-booking.html?token=${encodeURIComponent(bookingToken(appointment.id))}`;
  const dep = Number(depositAmount || 0);
  const tot = Number(totalAmount || treatment?.price || 0);
  const balance = +(tot - dep).toFixed(2);
  const depositLine = dep > 0
    ? `<tr><td style="padding:6px 12px;"><strong>Deposit paid</strong></td><td>£${dep.toFixed(2)}</td></tr>
       <tr><td style="padding:6px 12px;"><strong>Balance on arrival</strong></td><td>£${balance.toFixed(2)}</td></tr>`
    : '';
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width:560px; margin:0 auto; color:#1c1c1c;">
      <div style="background:#1e3a6e; color:#C9A84C; padding:24px 28px; border-radius:12px 12px 0 0; font-family:Georgia,serif; font-size:22px; font-weight:700;">
        ${spaName} — booking confirmed
      </div>
      <div style="background:white; border:1px solid #e8e3d8; border-top:none; padding:24px 28px; border-radius:0 0 12px 12px;">
        <p style="margin:0 0 16px;">Hi ${(client.name || 'there').replace(/[<>]/g,'')},</p>
        <p style="margin:0 0 18px;">Your appointment is confirmed:</p>
        <table style="border-collapse:collapse; margin:0 0 18px; font-size:15px;">
          <tr><td style="padding:6px 12px 6px 0;"><strong>Treatment</strong></td><td>${(treatment?.name || '').replace(/[<>]/g,'')}</td></tr>
          <tr><td style="padding:6px 12px 6px 0;"><strong>Duration</strong></td><td>${treatment?.duration_minutes || ''} minutes</td></tr>
          ${therapistName ? `<tr><td style="padding:6px 12px 6px 0;"><strong>Therapist</strong></td><td>${String(therapistName).replace(/[<>]/g,'')}</td></tr>` : ''}
          ${roomName ? `<tr><td style="padding:6px 12px 6px 0;"><strong>Room</strong></td><td>${String(roomName).replace(/[<>]/g,'')}</td></tr>` : ''}
          <tr><td style="padding:6px 12px 6px 0;"><strong>When</strong></td><td>${when}</td></tr>
          ${depositLine}
          <tr><td style="padding:6px 12px 6px 0;"><strong>Reference</strong></td><td>#${appointment.id}</td></tr>
        </table>
        <p style="margin:0 0 20px;">
          <a href="${manageUrl}" style="display:inline-block;background:#C9A84C;color:#1e3a6e;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;">Manage your booking</a>
        </p>
        ${cancellationPolicy ? `<p style="font-size:13px; color:#666; margin:0 0 12px;">${String(cancellationPolicy).replace(/[<>]/g,'')}</p>` : ''}
        <p style="margin:0; color:#1e3a6e;">We look forward to seeing you.<br><strong>${spaName}</strong></p>
      </div>
    </div>
  `;
  return sendBrevoEmail({
    to: [{ email: client.email, name: client.name }],
    subject: `${spaName} — Booking confirmed for ${when}`,
    html,
  });
}

// SPA-PAY-001 — sent when a customer reschedules or the spa moves them.
async function sendBookingRescheduled({ client, appointment, treatment, oldStartsAt }) {
  if (!client?.email) return { skipped: true };
  const spaName = process.env.SPA_NAME || 'SiamEPOS Spa';
  const newWhen = formatStarts(appointment.starts_at);
  const oldWhen = oldStartsAt ? formatStarts(oldStartsAt) : '';
  const apiBase = process.env.PUBLIC_API_URL || 'https://spa-api.siamepos.co.uk';
  const manageUrl = `${apiBase}/my-booking.html?token=${encodeURIComponent(bookingToken(appointment.id))}`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width:560px; margin:0 auto; color:#1c1c1c;">
      <div style="background:#1e3a6e; color:#C9A84C; padding:24px 28px; border-radius:12px 12px 0 0; font-family:Georgia,serif; font-size:22px; font-weight:700;">
        ${spaName} — booking rescheduled
      </div>
      <div style="background:white; border:1px solid #e8e3d8; border-top:none; padding:24px 28px; border-radius:0 0 12px 12px;">
        <p>Hi ${(client.name || 'there').replace(/[<>]/g,'')},</p>
        <p>Your booking for <strong>${(treatment?.name || '').replace(/[<>]/g,'')}</strong> has been moved.</p>
        <table style="border-collapse:collapse; margin:14px 0; font-size:15px;">
          ${oldWhen ? `<tr><td style="padding:4px 12px 4px 0;"><strong>From</strong></td><td style="color:#888;text-decoration:line-through;">${oldWhen}</td></tr>` : ''}
          <tr><td style="padding:4px 12px 4px 0;"><strong>To</strong></td><td style="color:#16a34a;font-weight:700;">${newWhen}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;"><strong>Reference</strong></td><td>#${appointment.id}</td></tr>
        </table>
        <p style="margin:14px 0 4px;"><a href="${manageUrl}" style="display:inline-block;background:#C9A84C;color:#1e3a6e;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700;">Manage your booking</a></p>
      </div>
    </div>
  `;
  return sendBrevoEmail({
    to: [{ email: client.email, name: client.name }],
    subject: `${spaName} — Booking moved to ${newWhen}`,
    html,
  });
}

// SPA-PAY-001 — sent when a booking is cancelled (by customer or by spa).
async function sendBookingCancelled({ client, appointment, treatment, refundAmount, refundReason }) {
  if (!client?.email) return { skipped: true };
  const spaName = process.env.SPA_NAME || 'SiamEPOS Spa';
  const when = formatStarts(appointment.starts_at);
  const refundLine = Number(refundAmount) > 0
    ? `<p style="background:#dcfce7;border:1px solid #86efac;color:#166534;padding:12px;border-radius:6px;font-size:14px;">💸 <strong>£${Number(refundAmount).toFixed(2)} refunded</strong> to your card — typically arrives in 5–10 working days.</p>`
    : refundReason
      ? `<p style="background:#fef3c7;border:1px solid #fcd34d;color:#92400e;padding:12px;border-radius:6px;font-size:14px;">⚠️ ${String(refundReason).replace(/[<>]/g,'')}</p>`
      : '';
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width:560px; margin:0 auto; color:#1c1c1c;">
      <div style="background:#1e3a6e; color:#C9A84C; padding:24px 28px; border-radius:12px 12px 0 0; font-family:Georgia,serif; font-size:22px; font-weight:700;">
        ${spaName} — booking cancelled
      </div>
      <div style="background:white; border:1px solid #e8e3d8; border-top:none; padding:24px 28px; border-radius:0 0 12px 12px;">
        <p>Hi ${(client.name || 'there').replace(/[<>]/g,'')},</p>
        <p>Your booking for <strong>${(treatment?.name || '').replace(/[<>]/g,'')}</strong> on <strong>${when}</strong> has been cancelled.</p>
        ${refundLine}
        <p style="margin-top:18px;color:#1e3a6e;">We're sorry to miss you — book again any time at our website.</p>
      </div>
    </div>
  `;
  return sendBrevoEmail({
    to: [{ email: client.email, name: client.name }],
    subject: `${spaName} — Booking #${appointment.id} cancelled`,
    html,
  });
}

// ─── SPA-CAMPAIGNS-001: campaign email HTML ───────────────────────────────
// Lotus-branded campaign template: navy header with the spa wordmark, body
// content unchanged from the operator's text (HTML allowed), GDPR footer
// with a one-click unsubscribe link. {{name}} merges the client's name.
function buildCampaignEmail({ subject, body, client_name, client_email }) {
  const spaName    = process.env.SPA_NAME    || 'SiamEPOS Spa';
  const spaAddress = process.env.SPA_ADDRESS || '';
  const safeName = String(client_name || 'there').replace(/[<>]/g, '');
  const personalisedBody = String(body || '').replace(/\{\{\s*name\s*\}\}/gi, safeName);
  const apiBase = process.env.PUBLIC_API_URL || 'https://spa-api.siamepos.co.uk';
  const unsubUrl = `${apiBase}/api/unsubscribe?token=${encodeURIComponent(unsubscribeToken(client_email))}`;
  return `
<!doctype html>
<html><body style="margin:0;padding:0;background:#faf7f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1c;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#faf7f2;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(20,38,74,0.08);">
        <tr><td style="background:#1e3a6e;padding:28px 30px;color:#C9A84C;font-family:Georgia,serif;font-size:24px;font-weight:700;letter-spacing:0.02em;">${spaName.replace(/[<>]/g, '')}</td></tr>
        <tr><td style="padding:32px;line-height:1.65;font-size:15px;color:#1c1c1c;">${personalisedBody}</td></tr>
        <tr><td style="padding:18px 30px;background:#faf7f2;border-top:1px solid #e8e3d8;font-size:11px;color:#6b6b6b;line-height:1.55;">
          <div style="margin-bottom:6px;"><strong style="color:#1e3a6e;">${spaName.replace(/[<>]/g, '')}</strong>${spaAddress ? ' · ' + spaAddress.replace(/[<>]/g, '') : ''}</div>
          <div>You're receiving this because you opted in to occasional offers when booking with us.
            <a href="${unsubUrl}" style="color:#6b6b6b;text-decoration:underline;">Unsubscribe</a> at any time.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`.trim();
}

// ─── SPA-VOUCHER-003: gift-voucher delivery email ────────────────────────
// Branded lotus / navy / gold layout, code displayed prominently, with the
// monetary OR session details rendered correctly per voucher_type.
async function sendVoucherGiftEmail({ voucher, treatment_name }) {
  if (!voucher?.recipient_email) return { skipped: true, reason: 'no recipient_email' };
  const spaName    = process.env.SPA_NAME    || 'SiamEPOS Spa';
  const spaAddress = process.env.SPA_ADDRESS || '';
  const safeFor = String(voucher.purchased_for || '').replace(/[<>]/g, '') || 'there';
  const safeFrom = String(voucher.purchased_by || '').replace(/[<>]/g, '');
  const isSessions = voucher.voucher_type === 'sessions';
  const valueBlock = isSessions
    ? `<div style="font-size:36px;font-weight:700;color:#C9A84C;margin:4px 0;">
         ${Number(voucher.total_sessions || 0)} session${Number(voucher.total_sessions) === 1 ? '' : 's'}
       </div>
       <div style="color:rgba(255,255,255,0.78);font-size:14px;">
         ${treatment_name ? `of ${String(treatment_name).replace(/[<>]/g, '')}` : 'of any treatment'}
       </div>`
    : `<div style="font-size:36px;font-weight:700;color:#C9A84C;margin:4px 0;">
         £${Number(voucher.initial_value || 0).toFixed(2)}
       </div>
       <div style="color:rgba(255,255,255,0.78);font-size:14px;">
         to spend on any treatment
       </div>`;
  const expiryLine = voucher.expires_at
    ? `<div style="font-size:13px;color:#6b6b6b;margin-top:14px;">
         Valid until ${new Date(voucher.expires_at).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}
       </div>`
    : '';
  const html = `
<!doctype html>
<html><body style="margin:0;padding:0;background:#faf7f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1c;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#faf7f2;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:white;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(20,38,74,0.10);">
        <tr><td style="background:#1e3a6e;padding:28px 30px;color:#C9A84C;font-family:Georgia,serif;font-size:24px;font-weight:700;letter-spacing:0.02em;">
          ${spaName.replace(/[<>]/g, '')}
        </td></tr>
        <tr><td style="padding:32px;line-height:1.65;color:#1c1c1c;">
          <p style="font-size:15px;margin:0 0 12px;">Hi ${safeFor},</p>
          <p style="font-size:15px;margin:0 0 22px;">
            ${safeFrom ? `${safeFrom} has` : 'Someone has'} sent you a gift voucher for ${spaName.replace(/[<>]/g, '')}.
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1e3a6e;border-radius:12px;margin:0 0 24px;">
            <tr><td style="padding:24px 28px;text-align:center;color:white;">
              <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.55);">Voucher code</div>
              <div style="font-family:'Menlo','Consolas',monospace;font-size:26px;font-weight:700;color:#C9A84C;letter-spacing:3px;margin:8px 0 14px;">
                ${String(voucher.code).replace(/[<>]/g, '')}
              </div>
              ${valueBlock}
            </td></tr>
          </table>
          <p style="font-size:14px;color:#444;margin:0 0 6px;">
            Show this code (or this email) at the spa when you book. We'll do the rest.
          </p>
          ${expiryLine}
        </td></tr>
        <tr><td style="padding:18px 30px;background:#faf7f2;border-top:1px solid #e8e3d8;font-size:11px;color:#6b6b6b;line-height:1.55;">
          <div style="margin-bottom:6px;"><strong style="color:#1e3a6e;">${spaName.replace(/[<>]/g, '')}</strong>${spaAddress ? ' · ' + spaAddress.replace(/[<>]/g, '') : ''}</div>
          <div>A gift sent through the SiamEPOS Spa voucher system. Please reply if you have any questions.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`.trim();

  return sendBrevoEmail({
    to: [{ email: voucher.recipient_email, name: voucher.purchased_for || undefined }],
    subject: `${spaName} — gift voucher for you (${voucher.code})`,
    html,
  });
}

// SPA-OWNER-NOTIFY — email the spa owner whenever a new booking
// arrives, regardless of source (widget / treatwell / admin POST).
// Reads recipient from settings.spa_email with env-var fallback.
// Fire-and-forget — wrap in try/catch at the call site so a Brevo
// hiccup never blocks the booking from being created.
async function sendOwnerNewBookingEmail({ appointment, client, treatment, therapistName, source }) {
  let ownerEmail = process.env.SPA_EMAIL || null;
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'spa_email'`);
    if (r.rows[0]?.value) ownerEmail = r.rows[0].value;
  } catch (e) { /* fall back to env */ }
  if (!ownerEmail) return { skipped: true, reason: 'no spa_email configured' };

  const spaName  = process.env.SPA_NAME || 'SiamEPOS Spa';
  const when     = formatStarts(appointment.starts_at);
  const sourceLabel = {
    online:    '🪷 Online (website widget)',
    treatwell: '🌐 Treatwell',
    walkin:    '🚶 Walk-in / in-store',
    phone:     '📞 Phone',
    staff:     '🧑‍💼 Staff-created',
  }[source] || source || '—';

  const safe = (s) => String(s || '').replace(/[<>]/g, '');
  const dep  = Number(appointment.deposit_amount || 0);
  const tot  = Number(treatment?.price || appointment.price_at_booking || 0);
  const balance = +(tot - dep).toFixed(2);

  const html = `
<!doctype html>
<html><body style="margin:0;padding:0;background:#faf7f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1c;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#faf7f2;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 14px rgba(20,38,74,0.08);">
        <tr><td style="background:#1e3a6e;padding:18px 24px;color:#C9A84C;font-family:Georgia,serif;font-size:18px;font-weight:700;">
          🔔 New booking — ${spaName}
        </td></tr>
        <tr><td style="padding:22px 24px;line-height:1.6;font-size:14px;">
          <div style="font-size:18px;font-weight:700;color:#1e3a6e;margin-bottom:14px;">
            ${safe(client?.name) || 'Walk-in'} · ${safe(treatment?.name) || 'Treatment'}
          </div>
          <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px;">
            <tr><td style="padding:4px 0;color:#6b6b6b;width:120px;">When</td><td style="padding:4px 0;font-weight:600;">${when}</td></tr>
            ${therapistName ? `<tr><td style="padding:4px 0;color:#6b6b6b;">Therapist</td><td style="padding:4px 0;font-weight:600;">${safe(therapistName)}</td></tr>` : ''}
            <tr><td style="padding:4px 0;color:#6b6b6b;">Treatment</td><td style="padding:4px 0;">${safe(treatment?.name)} · ${treatment?.duration_minutes || ''}min · £${tot.toFixed(2)}</td></tr>
            <tr><td style="padding:4px 0;color:#6b6b6b;">Source</td><td style="padding:4px 0;">${sourceLabel}</td></tr>
            ${client?.phone ? `<tr><td style="padding:4px 0;color:#6b6b6b;">Phone</td><td style="padding:4px 0;">${safe(client.phone)}</td></tr>` : ''}
            ${client?.email ? `<tr><td style="padding:4px 0;color:#6b6b6b;">Email</td><td style="padding:4px 0;">${safe(client.email)}</td></tr>` : ''}
            ${dep > 0 ? `<tr><td style="padding:4px 0;color:#6b6b6b;">Deposit paid</td><td style="padding:4px 0;color:#16a34a;font-weight:600;">£${dep.toFixed(2)}</td></tr><tr><td style="padding:4px 0;color:#6b6b6b;">Balance due</td><td style="padding:4px 0;">£${balance.toFixed(2)}</td></tr>` : ''}
            <tr><td style="padding:4px 0;color:#6b6b6b;">Reference</td><td style="padding:4px 0;">#${appointment.id}</td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:14px 24px;background:#faf7f2;border-top:1px solid #e8e3d8;font-size:11px;color:#6b6b6b;">
          This is an automatic owner notification from ${spaName}. To stop these, untick "Notify owner on new bookings" in Admin → Settings.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`.trim();

  return sendBrevoEmail({
    to: [{ email: ownerEmail }],
    subject: `🔔 New booking · ${safe(client?.name) || 'Walk-in'} · ${when}`,
    html,
  });
}

module.exports = {
  sendBrevoEmail,
  sendBookingConfirmation,
  sendBookingRescheduled,
  sendBookingCancelled,
  sendOwnerNewBookingEmail,
  buildCampaignEmail,
  unsubscribeToken,
  parseUnsubscribeToken,
  bookingToken,
  parseBookingToken,
  sendVoucherGiftEmail,
};
