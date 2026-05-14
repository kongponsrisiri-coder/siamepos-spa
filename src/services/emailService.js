// Brevo (formerly Sendinblue) transactional email.
// Uses native fetch (Node 20+) so we don't pull in another SDK.

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

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

module.exports = { sendBrevoEmail, sendBookingConfirmation };
