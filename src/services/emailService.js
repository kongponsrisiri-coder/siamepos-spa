// Brevo (formerly Sendinblue) transactional email.
// Uses native fetch (Node 20+) so we don't pull in another SDK.

const crypto = require('crypto');

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

async function sendBookingConfirmation({ client, appointment, treatment, cancellationPolicy }) {
  if (!client?.email) return { skipped: true };
  const spaName = process.env.SPA_NAME || 'SiamEPOS Spa';
  const when = formatStarts(appointment.starts_at);
  const html = `
    <div style="font-family: Arial, sans-serif; max-width:560px; margin:0 auto; color:#222;">
      <h2 style="color:#7a4f1e;">${spaName} — Booking Confirmation</h2>
      <p>Hi ${client.name || 'there'},</p>
      <p>Your booking is confirmed:</p>
      <table style="border-collapse:collapse; margin:16px 0;">
        <tr><td style="padding:6px 12px;"><strong>Treatment</strong></td><td>${treatment?.name || ''}</td></tr>
        <tr><td style="padding:6px 12px;"><strong>Duration</strong></td><td>${treatment?.duration_minutes || ''} minutes</td></tr>
        <tr><td style="padding:6px 12px;"><strong>When</strong></td><td>${when}</td></tr>
        <tr><td style="padding:6px 12px;"><strong>Reference</strong></td><td>#${appointment.id}</td></tr>
      </table>
      ${cancellationPolicy ? `<p style="font-size:13px; color:#666;">${cancellationPolicy}</p>` : ''}
      <p>We look forward to seeing you.</p>
      <p style="font-size:13px; color:#666;">${spaName}</p>
    </div>
  `;
  return sendBrevoEmail({
    to: [{ email: client.email, name: client.name }],
    subject: `${spaName} — Booking confirmed for ${when}`,
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

module.exports = {
  sendBrevoEmail,
  sendBookingConfirmation,
  buildCampaignEmail,
  unsubscribeToken,
  parseUnsubscribeToken,
};
