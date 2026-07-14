// SPA-WALLET-001 (Google) — "Add to Google Wallet" link generator.
//
// There is no reference implementation on the restaurant side — this is new.
// Google Wallet has no signed-package like Apple's .pkpass; instead you sign a
// JWT (RS256, with your Google Cloud service-account key) that describes the
// pass, and hand the user a link:  https://pay.google.com/gp/v/save/<JWT>.
// We embed the FULL class + object in the JWT ("skinny JWT with resources") so
// no separate Google Wallet API call is needed to pre-create anything — the
// first save auto-creates the class.
//
// Cert wiring (set on the spa's Railway service):
//   GOOGLE_WALLET_ISSUER_ID     numeric issuer id from the Google Wallet console
//   GOOGLE_WALLET_SA_EMAIL      service-account email (…@….iam.gserviceaccount.com)
//   GOOGLE_WALLET_SA_KEY_B64    base64 of the service-account private-key PEM
//                               (the "private_key" field of the SA JSON, base64'd
//                               so its newlines survive Railway's env editor)
//
// When any of these is missing the feature is disabled: buildSaveUrl throws
// GWALLET_NOT_CONFIGURED, the endpoint returns 503, and the email hides the button.

const jwt = require('jsonwebtoken');

const SAVE_URL_BASE = 'https://pay.google.com/gp/v/save/';
const CLASS_SUFFIX  = 'spa_voucher_v1'; // one class for all spa vouchers

// ── Config loading ─────────────────────────────────────────────────
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

// ── Spa branding ───────────────────────────────────────────────────
const SPA_NAME = process.env.SPA_NAME || 'SiamEPOS Spa';

// Google object/class ids must be `${issuerId}.${suffix}` where suffix is
// [A-Za-z0-9._-]. Sanitise the voucher code just in case.
function objectSuffix(code) {
  return String(code).replace(/[^A-Za-z0-9._-]/g, '_');
}

function fmtDateEndOfDay(expiresAt) {
  if (!expiresAt) return undefined;
  const dateStr = (expiresAt instanceof Date)
    ? expiresAt.toISOString().slice(0, 10)
    : String(expiresAt).slice(0, 10);
  return dateStr + 'T23:59:59Z';
}

function fmtExpiryLabel(expiresAt) {
  if (!expiresAt) return 'No expiry';
  const dateStr = (expiresAt instanceof Date)
    ? expiresAt.toISOString().slice(0, 10)
    : String(expiresAt).slice(0, 10);
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

// ── Build the signed "Save to Google Wallet" URL for a voucher ─────
function buildSaveUrl(voucher, { origins } = {}) {
  if (!isConfigured()) {
    const e = new Error('Google Wallet not configured on server');
    e.code = 'GWALLET_NOT_CONFIGURED';
    throw e;
  }

  const classId    = `${_issuerId}.${CLASS_SUFFIX}`;
  const objectId   = `${_issuerId}.${objectSuffix(voucher.code)}`;
  const isSessions = voucher.voucher_type === 'sessions';

  // Headline value shown under the title.
  let headlineValue;
  if (isSessions) {
    const total     = Number(voucher.total_sessions || 0);
    const remaining = Number(voucher.sessions_remaining != null ? voucher.sessions_remaining : total);
    headlineValue = `${remaining} of ${total} sessions`;
  } else {
    const amount  = Number(voucher.initial_value || 0);
    const balance = Number(voucher.remaining_value != null ? voucher.remaining_value : amount);
    headlineValue = '£' + balance.toFixed(2);
  }

  const textModules = [
    { header: isSessions ? 'Sessions remaining' : 'Balance', body: headlineValue, id: 'headline' },
    { header: 'Voucher code', body: voucher.code, id: 'code' },
    { header: 'Valid until', body: fmtExpiryLabel(voucher.expires_at), id: 'expires' },
  ];
  if (voucher.treatment_name) {
    textModules.push({ header: 'Treatment', body: voucher.treatment_name, id: 'treatment' });
  }
  if (voucher.purchased_for) {
    textModules.push({ header: 'For', body: voucher.purchased_for, id: 'recipient' });
  }

  const genericClass = {
    id: classId,
  };

  const genericObject = {
    id: objectId,
    classId,
    genericType: 'GENERIC_GIFT_CARD',
    hexBackgroundColor: '#1e3a6e',
    cardTitle:  { defaultValue: { language: 'en-GB', value: SPA_NAME } },
    header:     { defaultValue: { language: 'en-GB', value: 'Gift Voucher' } },
    subheader:  { defaultValue: { language: 'en-GB', value: headlineValue } },
    textModulesData: textModules,
    barcode: { type: 'QR_CODE', value: voucher.code, alternateText: voucher.code },
    ...(voucher.expires_at
      ? { validTimeInterval: { end: { date: fmtDateEndOfDay(voucher.expires_at) } } }
      : {}),
  };

  const claims = {
    iss: _saEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: origins && origins.length ? origins : [],
    payload: {
      genericClasses:  [genericClass],
      genericObjects:  [genericObject],
    },
  };

  const token = jwt.sign(claims, _privateKey, { algorithm: 'RS256' });
  return SAVE_URL_BASE + token;
}

module.exports = {
  buildSaveUrl,
  isConfigured,
};
