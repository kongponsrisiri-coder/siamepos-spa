// SPA-WALLET-BOOKING-001 — Apple Wallet .pkpass generator for spa appointments.
// Mirrors voucherWalletPass.js but produces an `eventTicket`-style pass so the
// booking surfaces on the customer's lock screen shortly before it starts
// (via `relevantDate`) and auto-greys once the appointment has passed
// (`expirationDate`). Served by GET /api/widget/booking/:token/wallet-pass.
//
// Reuses the SAME Apple pass-type ID + signing certs as the voucher/loyalty
// passes (pass.uk.co.siamepos.voucher) — see voucherWalletPass.getCerts().
// Template lives at wallet/booking.pass/. When the certs aren't set the
// endpoint returns 503 and the email hides the button.

const path = require('path');
const { PKPass } = require('passkit-generator');
const { getCerts, isConfigured } = require('./voucherWalletPass'); // shared cert loader
const { getBrandTheme } = require('./brandTheme');

const MODEL_DIR = path.join(__dirname, 'wallet', 'booking.pass');

const SPA_NAME    = process.env.SPA_NAME    || 'SiamEPOS Spa';
const SPA_ADDRESS = process.env.SPA_ADDRESS || '';
const SPA_EMAIL   = process.env.SPA_EMAIL   || 'info@siamepos.co.uk';

// Everything customer-facing renders in UK time — the DB stores naive UTC and
// Railway runs in UTC, so we MUST pin Europe/London or a 12:00 BST slot shows
// as 11:00 (the SPA-TZ-001 class of bug).
function fmtDate(startsAt) {
  return new Date(startsAt).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Europe/London',
  });
}
function fmtTime(startsAt) {
  return new Date(startsAt).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
  });
}

// End-of-appointment ISO for expirationDate: prefer ends_at, else starts +
// duration, else starts + 2h as a safe fallback.
function endIso(appt) {
  if (appt.ends_at) return new Date(appt.ends_at).toISOString();
  const start = new Date(appt.starts_at).getTime();
  const mins = Number(appt.duration_minutes || 0) || 120;
  return new Date(start + mins * 60000).toISOString();
}

// Returns a Buffer (the signed .pkpass zip). `opts.manageUrl` (optional) is
// embedded in the QR so staff/customer can open the booking portal by scanning.
async function buildBookingPass(appt, opts = {}) {
  const certs = getCerts();
  if (!certs) {
    const e = new Error('Wallet pass not configured on server');
    e.code = 'PASS_NOT_CONFIGURED';
    throw e;
  }

  const theme     = await getBrandTheme();
  const treatment = appt.treatment_name || 'Treatment';
  const startsIso = new Date(appt.starts_at).toISOString();

  const pass = await PKPass.from({
    model: MODEL_DIR,
    certificates: {
      wwdr:                certs.wwdr,
      signerCert:          certs.signerCert,
      signerKey:           certs.signerKey,
      signerKeyPassphrase: certs.signerKeyPassphrase,
    },
  }, {
    serialNumber:     `BOOK-${appt.id}`,
    description:      `${SPA_NAME} Appointment`,
    organizationName: SPA_NAME,
    backgroundColor:  theme.primaryRgb,
    foregroundColor:  theme.textOnPrimaryRgb,
    labelColor:       theme.accentRgb,
    relevantDate:     startsIso,      // lock-screen surfacing before the appt
    expirationDate:   endIso(appt),   // pass greys out after the appointment
  });

  pass.primaryFields.push({ key: 'treatment', label: 'Treatment', value: treatment });

  pass.secondaryFields.push(
    { key: 'date', label: 'Date', value: fmtDate(appt.starts_at) },
    { key: 'time', label: 'Time', value: fmtTime(appt.starts_at) },
  );

  const aux = [];
  if (appt.duration_minutes) aux.push({ key: 'duration', label: 'Duration', value: `${appt.duration_minutes} min` });
  if (appt.therapist_name)   aux.push({ key: 'therapist', label: 'Therapist', value: String(appt.therapist_name) });
  if (aux.length) pass.auxiliaryFields.push(...aux);

  pass.backFields.push(
    { key: 'reference', label: 'Booking reference', value: `#${appt.id}` },
    {
      key:   'where',
      label: 'Where',
      value: SPA_ADDRESS ? `${SPA_NAME}\n${SPA_ADDRESS}` : SPA_NAME,
    },
    {
      key:   'manage',
      label: 'Need to change or cancel?',
      value: opts.manageUrl
        ? `Manage your booking here:\n${opts.manageUrl}`
        : `Please contact ${SPA_NAME}.`,
    },
    { key: 'support', label: 'Support', value: SPA_EMAIL },
  );

  // QR — scanning opens the manage portal (or shows the reference if no URL).
  pass.setBarcodes({
    format:          'PKBarcodeFormatQR',
    message:         opts.manageUrl || `Booking #${appt.id}`,
    messageEncoding: 'iso-8859-1',
    altText:         `Booking #${appt.id}`,
  });

  return pass.getAsBuffer();
}

module.exports = { buildBookingPass, isConfigured };
