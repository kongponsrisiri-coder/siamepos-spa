// SPA-WALLET-BOOKING-001 (Google) — "Add to Google Wallet" link for spa
// appointments. Mirrors voucherGoogleWallet.js: signs a skinny "save to
// wallet" JWT (RS256) embedding the full class + object, so the first save
// auto-creates the class. One class for all spa bookings (spa_booking_v1).
//
// Uses the SAME service-account config as the voucher Google pass:
//   GOOGLE_WALLET_ISSUER_ID   numeric issuer id from the Google Wallet console
//   GOOGLE_WALLET_SA_EMAIL    service-account email (…iam.gserviceaccount.com)
//   GOOGLE_WALLET_SA_KEY_B64  base64 of the service-account private-key PEM
//
// Missing any of these disables the feature: buildSaveUrl throws
// GWALLET_NOT_CONFIGURED, the endpoint 503s, and the email hides the button.

const jwt = require('jsonwebtoken');

const SAVE_URL_BASE = 'https://pay.google.com/gp/v/save/';
const CLASS_SUFFIX  = 'spa_booking_v1';

let _issuerId, _saEmail, _privateKey, _configured = false;

function loadConfig() {
  if (_configured) return true;
  const issuerId = process.env.GOOGLE_WALLET_ISSUER_ID;
  const saEmail  = process.env.GOOGLE_WALLET_SA_EMAIL;
  const keyB64   = process.env.GOOGLE_WALLET_SA_KEY_B64;
  if (!issuerId || !saEmail || !keyB64) return false;
  try {
    _privateKey = Buffer.from(keyB64, 'base64').toString('utf8');
    if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(_privateKey)) {
      console.error('[gwallet] GOOGLE_WALLET_SA_KEY_B64 does not decode to a PEM private key');
      return false;
    }
    _issuerId = String(issuerId);
    _saEmail  = saEmail;
    _configured = true;
    return true;
  } catch (err) {
    console.error('[gwallet] config load failed:', err.message);
    return false;
  }
}

function isConfigured() {
  return loadConfig();
}

const SPA_NAME = process.env.SPA_NAME || 'SiamEPOS Spa';

function objectSuffix(v) {
  return String(v).replace(/[^A-Za-z0-9._-]/g, '_');
}

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
function endIso(appt) {
  if (appt.ends_at) return new Date(appt.ends_at).toISOString();
  const start = new Date(appt.starts_at).getTime();
  const mins = Number(appt.duration_minutes || 0) || 120;
  return new Date(start + mins * 60000).toISOString();
}

// Build the signed "Save to Google Wallet" URL for an appointment.
function buildSaveUrl(appt, { origins, manageUrl } = {}) {
  if (!isConfigured()) {
    const e = new Error('Google Wallet not configured on server');
    e.code = 'GWALLET_NOT_CONFIGURED';
    throw e;
  }

  const classId  = `${_issuerId}.${CLASS_SUFFIX}`;
  const objectId = `${_issuerId}.${objectSuffix('BOOK-' + appt.id)}`;
  const treatment = appt.treatment_name || 'Treatment';
  const whenLabel = `${fmtDate(appt.starts_at)}, ${fmtTime(appt.starts_at)}`;

  const textModules = [
    { header: 'Treatment', body: treatment, id: 'treatment' },
    { header: 'When', body: whenLabel, id: 'when' },
  ];
  if (appt.therapist_name)  textModules.push({ header: 'Therapist', body: String(appt.therapist_name), id: 'therapist' });
  if (appt.duration_minutes) textModules.push({ header: 'Duration', body: `${appt.duration_minutes} min`, id: 'duration' });
  textModules.push({ header: 'Reference', body: `#${appt.id}`, id: 'reference' });

  const genericClass = { id: classId };

  const genericObject = {
    id: objectId,
    classId,
    genericType: 'GENERIC_TYPE_UNSPECIFIED',
    hexBackgroundColor: '#1e3a6e',
    cardTitle: { defaultValue: { language: 'en-GB', value: SPA_NAME } },
    header:    { defaultValue: { language: 'en-GB', value: treatment } },
    subheader: { defaultValue: { language: 'en-GB', value: whenLabel } },
    textModulesData: textModules,
    barcode: {
      type: 'QR_CODE',
      value: manageUrl || `Booking #${appt.id}`,
      alternateText: `Booking #${appt.id}`,
    },
    validTimeInterval: {
      start: { date: new Date(appt.starts_at).toISOString() },
      end:   { date: endIso(appt) },
    },
  };

  const claims = {
    iss: _saEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: origins && origins.length ? origins : [],
    payload: {
      genericClasses: [genericClass],
      genericObjects: [genericObject],
    },
  };

  const token = jwt.sign(claims, _privateKey, { algorithm: 'RS256' });
  return SAVE_URL_BASE + token;
}

module.exports = { buildSaveUrl, isConfigured };
