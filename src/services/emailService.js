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

module.exports = {
  sendBrevoEmail,
  sendBookingConfirmation,
  buildCampaignEmail,
  unsubscribeToken,
  parseUnsubscribeToken,
  sendVoucherGiftEmail,
};
