'use strict';

// SEPOS-SPA-LICENSE-001 — SiamEPOS Spa license signing / verification (Ed25519).
//
// The cloud SIGNS a license token with the private key (LICENSE_PRIVATE_KEY env
// = base64 of the PKCS8 PEM). The desktop till VERIFIES it with the bundled
// PUBLIC key below. Asymmetric on purpose: a till can verify a license OFFLINE
// but can never forge one — it never holds the private key.
//
// Token format: "<base64url(JSON payload)>.<base64url(ed25519 signature)>"
// Payload: { status, issued_at, valid_until }

const crypto = require('crypto');

// Public key — safe to ship in the desktop bundle. This is the SHARED SiamEPOS
// keypair (same as restaurant-epos, per SEPOS-SPA-LICENSE-001 §A): ops/Pose hold
// ONE private key (BO-LICENSE-001) that signs for both products, so setting the
// same LICENSE_PRIVATE_KEY on a spa's Railway "just works". Do not fork the crypto.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAom6IYhuc0q4ITkFya3H3tusgKu7qPXxpC39zAjAjIhU=
-----END PUBLIC KEY-----`;

// How long an issued license is valid offline before the till must re-check in.
const GRACE_DAYS = parseInt(process.env.LICENSE_GRACE_DAYS, 10) || 14;

function getPrivateKey() {
  const b64 = process.env.LICENSE_PRIVATE_KEY;
  if (!b64) return null;
  try {
    return crypto.createPrivateKey(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) {
    console.warn('[license] invalid LICENSE_PRIVATE_KEY:', e.message);
    return null;
  }
}

// Sign a license payload → token string, or null if no signing key is set
// (licensing then "fails open" — a missing key must never lock a till).
function signLicense(payload) {
  const key = getPrivateKey();
  if (!key) return null;
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(body), key).toString('base64url');
  return `${body}.${sig}`;
}

// Verify a token's signature and return its payload, or null if invalid/tampered.
// Does NOT check expiry — the caller compares valid_until against the clock.
function verifyLicense(token) {
  try {
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;
    const ok = crypto.verify(null, Buffer.from(body), PUBLIC_KEY_PEM, Buffer.from(sig, 'base64url'));
    if (!ok) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

module.exports = { signLicense, verifyLicense, GRACE_DAYS, PUBLIC_KEY_PEM };
