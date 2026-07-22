// Brevo (formerly Sendinblue) transactional email.
// Uses native fetch (Node 20+) so we don't pull in another SDK.

const crypto = require('crypto');
const { pool } = require('../db/dbAdapter');
const voucherWalletPass   = require('./voucherWalletPass');   // Apple Wallet (isConfigured)
const voucherGoogleWallet = require('./voucherGoogleWallet'); // Google Wallet (isConfigured)
const { getBrandTheme }   = require('./brandTheme');          // SPA-BRAND-VOUCHER-001 — per-spa colours

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

// ─── SPA-CAMPAIGNS-001: HMAC unsubscribe token ─────────────────────────
// Stateless single-use-ish token: `<base64url(email)>.<hmac>` signed with
// UNSUB_SECRET. Public /api/unsubscribe?token=… verifies and stamps the
// client.
//
// L1 parity with auth.js JWT_SECRET — the committed default literal is
// public (open-source repo), so on any deploy that forgets UNSUB_SECRET an
// attacker could forge unsubscribe tokens. If it's unset OR equals the
// committed default we use a RANDOM per-boot secret: tokens become
// unforgeable (the public default no longer validates). Trade-off:
// already-issued links break on restart until UNSUB_SECRET is set on Railway.
let UNSUB_SECRET = process.env.UNSUB_SECRET || '';
if (!UNSUB_SECRET || UNSUB_SECRET === 'siamspa-default-unsub-secret-change-me') {
  UNSUB_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[email] UNSUB_SECRET not set — using a random per-boot secret (unsubscribe links reset on restart). Set UNSUB_SECRET on Railway for stable links.');
}

function unsubscribeToken(email) {
  const e = String(email || '').trim().toLowerCase();
  const hmac = crypto.createHmac('sha256', UNSUB_SECRET).update(e).digest('hex').slice(0, 16);
  return Buffer.from(e).toString('base64url') + '.' + hmac;
}

function parseUnsubscribeToken(token) {
  try {
    const [b64, hmac] = String(token || '').split('.');
    if (!b64 || !hmac) return null;
    const email = Buffer.from(b64, 'base64url').toString('utf8');
    const expected = crypto.createHmac('sha256', UNSUB_SECRET).update(email).digest('hex').slice(0, 16);
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac))) return null;
    return email;
  } catch { return null; }
}

// SPA-PAY-001 — HMAC-signed booking token for the customer manage-link.
// Encodes the appointment id; the public /api/booking/by-token/:token
// endpoint verifies the HMAC before returning data. Separate secret
// from UNSUB_SECRET so a compromise of one doesn't compromise the other.
//
// C2 parity with auth.js JWT_SECRET — appointment ids are sequential, so a
// public committed default would let anyone forge manage-link tokens to read
// PII / reschedule / DELETE bookings (firing real Stripe refunds). If it's
// unset OR equals the committed default we use a RANDOM per-boot secret so
// tokens become unforgeable. Trade-off: already-issued manage links break on
// restart until BOOKING_SECRET is set on Railway.
let BOOKING_SECRET = process.env.BOOKING_SECRET || '';
if (!BOOKING_SECRET || BOOKING_SECRET === 'siamspa-default-booking-secret-change-me') {
  BOOKING_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[email] BOOKING_SECRET not set — using a random per-boot secret (manage links reset on restart). Set BOOKING_SECRET on Railway for stable links.');
}

function bookingToken(appointmentId) {
  const id = String(appointmentId);
  const hmac = crypto.createHmac('sha256', BOOKING_SECRET).update(id).digest('hex').slice(0, 20);
  return Buffer.from(id).toString('base64url') + '.' + hmac;
}

function parseBookingToken(token) {
  try {
    const [b64, hmac] = String(token || '').split('.');
    if (!b64 || !hmac) return null;
    const id = Buffer.from(b64, 'base64url').toString('utf8');
    const expected = crypto.createHmac('sha256', BOOKING_SECRET).update(id).digest('hex').slice(0, 20);
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
  const th = await getBrandTheme(); // spa's own brand colours (matches vouchers/campaigns + the till)
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width:560px; margin:0 auto; color:#1c1c1c;">
      <div style="background:${th.primaryHex}; color:${th.accentHex}; padding:24px 28px; border-radius:12px 12px 0 0; font-family:Georgia,serif; font-size:22px; font-weight:700;">
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
          <a href="${manageUrl}" style="display:inline-block;background:${th.accentHex};color:${th.primaryHex};padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;">Manage your booking</a>
        </p>
        ${cancellationPolicy ? `<p style="font-size:13px; color:#666; margin:0 0 12px;">${String(cancellationPolicy).replace(/[<>]/g,'')}</p>` : ''}
        <p style="margin:0; color:${th.primaryHex};">We look forward to seeing you.<br><strong>${spaName}</strong></p>
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
  const th = await getBrandTheme(); // spa's own brand colours
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width:560px; margin:0 auto; color:#1c1c1c;">
      <div style="background:${th.primaryHex}; color:${th.accentHex}; padding:24px 28px; border-radius:12px 12px 0 0; font-family:Georgia,serif; font-size:22px; font-weight:700;">
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
        <p style="margin:14px 0 4px;"><a href="${manageUrl}" style="display:inline-block;background:${th.accentHex};color:${th.primaryHex};padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700;">Manage your booking</a></p>
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
  const th = await getBrandTheme(); // spa's own brand colours
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width:560px; margin:0 auto; color:#1c1c1c;">
      <div style="background:${th.primaryHex}; color:${th.accentHex}; padding:24px 28px; border-radius:12px 12px 0 0; font-family:Georgia,serif; font-size:22px; font-weight:700;">
        ${spaName} — booking cancelled
      </div>
      <div style="background:white; border:1px solid #e8e3d8; border-top:none; padding:24px 28px; border-radius:0 0 12px 12px;">
        <p>Hi ${(client.name || 'there').replace(/[<>]/g,'')},</p>
        <p>Your booking for <strong>${(treatment?.name || '').replace(/[<>]/g,'')}</strong> on <strong>${when}</strong> has been cancelled.</p>
        ${refundLine}
        <p style="margin-top:18px;color:${th.primaryHex};">We're sorry to miss you — book again any time at our website.</p>
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
function buildCampaignEmail({ subject, body, client_name, client_email, th }) {
  const primaryHex = (th && th.primaryHex) || '#1e3a6e'; // spa brand, navy fallback
  const accentHex  = (th && th.accentHex)  || '#C9A84C';
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
        <tr><td style="background:${primaryHex};padding:28px 30px;color:${accentHex};font-family:Georgia,serif;font-size:24px;font-weight:700;letter-spacing:0.02em;">${spaName.replace(/[<>]/g, '')}</td></tr>
        <tr><td style="padding:32px;line-height:1.65;font-size:15px;color:#1c1c1c;">${personalisedBody}</td></tr>
        <tr><td style="padding:18px 30px;background:#faf7f2;border-top:1px solid #e8e3d8;font-size:11px;color:#6b6b6b;line-height:1.55;">
          <div style="margin-bottom:6px;"><strong style="color:${primaryHex};">${spaName.replace(/[<>]/g, '')}</strong>${spaAddress ? ' · ' + spaAddress.replace(/[<>]/g, '') : ''}</div>
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
  // SPA-BRAND-VOUCHER-001 — the email wears the spa's own colours.
  const th = await getBrandTheme();
  const safeFor = String(voucher.purchased_for || '').replace(/[<>]/g, '') || 'there';
  const safeFrom = String(voucher.purchased_by || '').replace(/[<>]/g, '');
  const isSessions = voucher.voucher_type === 'sessions';
  const valueBlock = isSessions
    ? `<div style="font-size:36px;font-weight:700;color:${th.accentHex};margin:4px 0;">
         ${Number(voucher.total_sessions || 0)} session${Number(voucher.total_sessions) === 1 ? '' : 's'}
       </div>
       <div style="color:${th.softOnPrimary};font-size:14px;">
         ${treatment_name ? `of ${String(treatment_name).replace(/[<>]/g, '')}` : 'of any treatment'}
       </div>`
    : `<div style="font-size:36px;font-weight:700;color:${th.accentHex};margin:4px 0;">
         £${Number(voucher.initial_value || 0).toFixed(2)}
       </div>
       <div style="color:${th.softOnPrimary};font-size:14px;">
         to spend on any treatment
       </div>`;
  const expiryLine = voucher.expires_at
    ? `<div style="font-size:13px;color:#6b6b6b;margin-top:14px;">
         Valid until ${new Date(voucher.expires_at).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}
       </div>`
    : '';

  // "Add to Wallet" buttons — only shown for the platforms whose credentials
  // are set on Railway, so the email never links to a 503 endpoint. The code is
  // the bearer token; links point at the public API (absolute URL required in
  // email). PUBLIC_API_URL is set on the spa's Railway service.
  const apiBase = (process.env.PUBLIC_API_URL || 'https://spa-api.siamepos.co.uk').replace(/\/$/, '');
  const codeEnc = encodeURIComponent(voucher.code);
  const appleOn  = voucherWalletPass.isConfigured();
  const googleOn = voucherGoogleWallet.isConfigured();
  const walletBlock = (appleOn || googleOn)
    ? `<div style="text-align:center;margin:22px 0 4px;">
         <div style="font-size:12px;color:#6b6b6b;margin-bottom:10px;">Save it to your phone</div>
         ${appleOn ? `<a href="${apiBase}/api/widget/voucher/${codeEnc}/wallet-pass"
            style="display:inline-block;margin:4px 6px;padding:11px 20px;background:#000;color:#fff;text-decoration:none;border-radius:9px;font-weight:600;font-size:14px;">
            &#63743;&nbsp; Add to Apple Wallet</a>` : ''}
         ${googleOn ? `<a href="${apiBase}/api/widget/voucher/${codeEnc}/google-wallet"
            style="display:inline-block;margin:4px 6px;padding:11px 20px;background:${th.primaryHex};color:${th.textOnPrimaryHex};text-decoration:none;border-radius:9px;font-weight:600;font-size:14px;">
            &#128179;&nbsp; Add to Google Wallet</a>` : ''}
         <div style="font-size:11px;color:#9a9a9a;margin-top:9px;">Open this email on your phone to add the voucher to your wallet</div>
       </div>`
    : '';
  const html = `
<!doctype html>
<html><body style="margin:0;padding:0;background:#faf7f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1c;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#faf7f2;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:white;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(20,38,74,0.10);">
        <tr><td style="background:${th.primaryHex};padding:28px 30px;color:${th.accentHex};font-family:Georgia,serif;font-size:24px;font-weight:700;letter-spacing:0.02em;">
          ${spaName.replace(/[<>]/g, '')}
        </td></tr>
        <tr><td style="padding:32px;line-height:1.65;color:#1c1c1c;">
          <p style="font-size:15px;margin:0 0 12px;">Hi ${safeFor},</p>
          <p style="font-size:15px;margin:0 0 22px;">
            ${safeFrom ? `${safeFrom} has` : 'Someone has'} sent you a gift voucher for ${spaName.replace(/[<>]/g, '')}.
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${th.primaryHex};border-radius:12px;margin:0 0 24px;">
            <tr><td style="padding:24px 28px;text-align:center;color:${th.textOnPrimaryHex};">
              <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${th.softOnPrimary};">Voucher code</div>
              <div style="font-family:'Menlo','Consolas',monospace;font-size:26px;font-weight:700;color:${th.accentHex};letter-spacing:3px;margin:8px 0 14px;">
                ${String(voucher.code).replace(/[<>]/g, '')}
              </div>
              ${valueBlock}
            </td></tr>
          </table>
          <p style="font-size:14px;color:#444;margin:0 0 6px;">
            Show this code (or this email) at the spa when you book. We'll do the rest.
          </p>
          ${expiryLine}
          ${walletBlock}
        </td></tr>
        <tr><td style="padding:18px 30px;background:#faf7f2;border-top:1px solid #e8e3d8;font-size:11px;color:#6b6b6b;line-height:1.55;">
          <div style="margin-bottom:6px;"><strong style="color:${th.primaryHex};">${spaName.replace(/[<>]/g, '')}</strong>${spaAddress ? ' · ' + spaAddress.replace(/[<>]/g, '') : ''}</div>
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

// SPA-LOYALTY-001 Layer 1 — post-visit loyalty progress email.
// "That was visit 7 of 10 — 3 more for your free massage ⭐". The customer-
// facing progress visibility IS the point of the loyalty feature: the till
// counts automatically; this tells the customer where they stand. Includes an
// "Add to Apple Wallet" loyalty-card button when passes are configured, and
// the standard unsubscribe footer (caller already checks unsubscribed_at).
async function sendLoyaltyProgress({ client, visitNumber, rolled, status }) {
  if (!client?.email) return { skipped: true };
  const spaName    = (process.env.SPA_NAME || 'SiamEPOS Spa').replace(/[<>]/g, '');
  const spaAddress = (process.env.SPA_ADDRESS || '').replace(/[<>]/g, '');
  const apiBase = (process.env.PUBLIC_API_URL || 'https://spa-api.siamepos.co.uk').replace(/\/$/, '');
  const safeName = String(client.name || 'there').split(' ')[0].replace(/[<>]/g, '');
  // SPA-BRAND-VOUCHER-001 — the email wears the spa's own colours.
  const th = await getBrandTheme();

  const next = status.next_tier;
  const toNext = status.visits_to_next;
  const justEarned = (status.available_rewards || [])
    .filter((t) => t.at_visit <= visitNumber);
  const esc = (s) => String(s || '').replace(/[<>]/g, '');

  // Headline + subject: celebrate a fresh reward > completed card > progress.
  let subject, headline, subline;
  if (justEarned.length > 0) {
    const r = justEarned[justEarned.length - 1];
    subject  = `🎉 You've earned it — ${r.reward}`;
    headline = `You've earned: ${esc(r.reward)} 🎉`;
    subline  = `Just mention it at reception — it's waiting on your card.`;
  } else if (rolled) {
    subject  = `⭐ Card complete — thank you, ${safeName}!`;
    headline = `Loyalty card complete! 🎉`;
    subline  = `Your rewards are all collected and a fresh card has started — visit 1 begins next time.`;
  } else if (next) {
    subject  = `⭐ That was visit ${visitNumber} — ${toNext} more for your ${next.reward}`;
    headline = `That was visit ${visitNumber}`;
    subline  = `${toNext} more visit${toNext === 1 ? '' : 's'} until your <strong>${esc(next.reward)}</strong> ⭐`;
  } else {
    subject  = `⭐ Visit ${visitNumber} — thank you, ${safeName}!`;
    headline = `That was visit ${visitNumber}`;
    subline  = `Thank you for visiting — every direct booking counts on your card.`;
  }

  // Progress dots toward the next tier (email-safe: plain characters).
  let progressBlock = '';
  if (next) {
    const target = next.at_visit;
    const have = Math.min(status.visits, target);
    const emptyDot = th.lightPrimary ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.25)';
    const dots = Array.from({ length: target }, (_, i) =>
      `<span style="display:inline-block;width:14px;height:14px;border-radius:50%;margin:2px;background:${i < have ? th.accentHex : emptyDot};"></span>`,
    ).join('');
    progressBlock = `
      <div style="margin:14px 0 4px;">${dots}</div>
      <div style="color:${th.softOnPrimary};font-size:13px;">${have} of ${target} toward ${esc(next.reward)}</div>`;
  }

  // Ladder overview (multi-tier schemes) — ✓ redeemed, ★ ready, ○ upcoming.
  const ladderRows = (status.tiers || []).map((t) => {
    const redeemed = (status.redeemed_tiers || []).includes(t.at_visit);
    const ready = (status.available_rewards || []).some((a) => a.at_visit === t.at_visit);
    const mark = redeemed ? '✓' : ready ? '★' : '○';
    const color = redeemed ? '#8a8a8a' : ready ? th.accentHex : '#444';
    return `<tr>
      <td style="padding:4px 10px 4px 0;color:${color};font-weight:700;">${mark}</td>
      <td style="padding:4px 0;color:${color};">Visit ${t.at_visit} — ${esc(t.reward)}${ready ? ' <strong>(ready!)</strong>' : redeemed ? ' (enjoyed)' : ''}</td>
    </tr>`;
  }).join('');

  // Apple Wallet loyalty card button (only when passes are configured).
  let walletBlock = '';
  try {
    const loyaltyWalletPass = require('./loyaltyWalletPass');
    if (loyaltyWalletPass.isConfigured()) {
      const rec = await loyaltyWalletPass.ensurePassRecord(client.id);
      if (rec) {
        // Deliberately says "Wallet", not "Apple Wallet" — the email reaches
        // Android customers too (Korakot 07-18). The pass file itself is
        // Apple-format until a Google Wallet issuer account exists
        // (GOOGLE_WALLET_* — see voucherGoogleWallet).
        walletBlock = `
        <div style="text-align:center;margin:22px 0 4px;">
          <a href="${apiBase}/api/wallet/loyalty/${encodeURIComponent(rec.serial)}.pkpass?t=${encodeURIComponent(rec.auth_token)}"
             style="display:inline-block;margin:4px 6px;padding:11px 20px;background:#000;color:#fff;text-decoration:none;border-radius:9px;font-weight:600;font-size:14px;">
             📲&nbsp; Add your loyalty card to your Wallet</a>
          <div style="font-size:11px;color:#9a9a9a;margin-top:8px;">Your visit count updates on the card automatically after every visit</div>
        </div>`;
      }
    }
  } catch (e) { /* wallet optional — email still sends */ }

  const unsubUrl = `${apiBase}/api/unsubscribe?token=${encodeURIComponent(unsubscribeToken(client.email))}`;
  const html = `
<!doctype html>
<html><body style="margin:0;padding:0;background:#faf7f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1c;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#faf7f2;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:white;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(20,38,74,0.10);">
        <tr><td style="background:${th.primaryHex};padding:28px 30px;color:${th.accentHex};font-family:Georgia,serif;font-size:24px;font-weight:700;letter-spacing:0.02em;">
          ${spaName}
        </td></tr>
        <tr><td style="padding:32px;line-height:1.65;color:#1c1c1c;">
          <p style="font-size:15px;margin:0 0 18px;">Hi ${safeName}, thank you for coming in today.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${th.primaryHex};border-radius:12px;margin:0 0 24px;">
            <tr><td style="padding:26px 28px;text-align:center;color:${th.textOnPrimaryHex};">
              <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${th.softOnPrimary};">Loyalty card</div>
              <div style="font-size:28px;font-weight:700;color:${th.accentHex};margin:8px 0 2px;">${headline}</div>
              <div style="color:${th.softOnPrimary};font-size:14px;">${subline}</div>
              ${progressBlock}
            </td></tr>
          </table>
          ${ladderRows ? `
          <div style="font-size:13px;color:#6b6b6b;margin:0 0 6px;letter-spacing:0.08em;text-transform:uppercase;">Your rewards</div>
          <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 8px;">${ladderRows}</table>` : ''}
          <p style="font-size:13px;color:#6b6b6b;margin:12px 0 0;">
            Visits count automatically when you book with us directly — nothing to carry, nothing to stamp.
          </p>
          ${walletBlock}
        </td></tr>
        <tr><td style="padding:18px 30px;background:#faf7f2;border-top:1px solid #e8e3d8;font-size:11px;color:#6b6b6b;line-height:1.55;">
          <div style="margin-bottom:6px;"><strong style="color:${th.primaryHex};">${spaName}</strong>${spaAddress ? ' · ' + spaAddress : ''}</div>
          ${status.terms ? `
          <div style="margin:0 0 8px;">
            <div style="font-weight:700;color:#4a4a4a;margin-bottom:2px;">Terms &amp; Conditions</div>
            <div style="font-size:10px;white-space:pre-line;">${esc(status.terms)}</div>
          </div>` : ''}
          <div>You receive these because you're on our loyalty card. <a href="${unsubUrl}" style="color:#6b6b6b;">Unsubscribe</a></div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`.trim();

  return sendBrevoEmail({
    to: [{ email: client.email, name: client.name || undefined }],
    subject: `${spaName} — ${subject}`,
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

// SEPOS-SPA-OWNER-001 — owner mobile sign-in link (magic link).
async function sendOwnerLoginLink({ to, url, spaName }) {
  const safe = String(spaName || 'your spa').replace(/[<>]/g, '');
  const html = `
    <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px;color:#0D1B3E;">
      <h2 style="color:#0D1B3E;">Sign in to ${safe}</h2>
      <p style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#334155;">
        Tap the button below to sign in to your SiamEPOS Spa dashboard. This link works once and expires in 15 minutes.
      </p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${url}" style="background:#C9A84C;color:#0D1B3E;font-family:system-ui,sans-serif;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:10px;display:inline-block;">Sign in</a>
      </p>
      <p style="font-family:system-ui,sans-serif;font-size:12px;color:#94a3b8;">
        If you didn't request this, you can safely ignore this email — no one can sign in without the link.
      </p>
    </div>`;
  return sendBrevoEmail({ to, subject: `Your ${safe} sign-in link`, html });
}

// ─── SPA-SMS-001 — booking-confirmation SMS via Twilio ─────────────────
// Ported from the restaurant side (SEPOS-027). Dormant unless
// TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN are set on the tenant Railway.
// TWILIO_FROM should be the platform's bought number (+447861932999).
const https = require('https');
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN  || '';
const TWILIO_FROM  = process.env.TWILIO_FROM        || 'SiamEPOS';

function toE164Uk(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[^\d+]/g, '');
  if (p.startsWith('+')) return /^\+\d{10,15}$/.test(p) ? p : null;
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('44')) return /^\d{11,13}$/.test(p) ? '+' + p : null;
  if (p.startsWith('07') && p.length === 11) return '+44' + p.slice(1);
  return null;
}

function sendBookingSms({ client, appointment, treatment }) {
  return new Promise((resolve) => {
    if (!TWILIO_SID || !TWILIO_TOKEN) return resolve();
    const to = toE164Uk(client?.phone);
    if (!to) return resolve();
    const spaName = process.env.SPA_NAME || 'SiamEPOS Spa';
    const text = spaName + ': booking confirmed — ' + (treatment?.name || 'your treatment') +
      ', ' + formatStarts(appointment.starts_at) + '. Ref #' + appointment.id +
      '. We look forward to seeing you!';
    const body = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: text }).toString();
    const req = https.request({
      hostname: 'api.twilio.com',
      path:     '/2010-04-01/Accounts/' + TWILIO_SID + '/Messages.json',
      method:   'POST',
      auth:     TWILIO_SID + ':' + TWILIO_TOKEN,
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('✅ Booking SMS sent to ' + to + ' (appointment #' + appointment.id + ')');
        } else {
          console.error('❌ Twilio error ' + res.statusCode + ':', data);
        }
        resolve(); // best-effort — never fail the booking
      });
    });
    req.on('error', (err) => { console.error('❌ Twilio request error:', err.message); resolve(); });
    req.write(body);
    req.end();
  });
}

module.exports = {
  sendBrevoEmail,
  sendOwnerLoginLink,
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
  sendLoyaltyProgress,   // SPA-LOYALTY-001
  sendBookingSms,        // SPA-SMS-001
};
