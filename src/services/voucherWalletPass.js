// SPA-WALLET-001 — Apple Wallet .pkpass generator for spa gift vouchers.
// Ported from restaurant-epos/src/services/voucherWalletPass.js and adapted
// to the spa's voucher schema (initial_value / remaining_value / purchased_for)
// and to SESSION vouchers (a bundle of N treatments) as well as monetary ones.
//
// Given a voucher row, produces a signed .pkpass Buffer the recipient can add
// to their iPhone/Mac Wallet. Served by GET /api/widget/voucher/:code/wallet-pass.
//
// Cert wiring (set on the spa's Railway service — SAME values as the EPOS
// Railway, since the spa reuses the restaurant's Apple pass type + cert):
//   PASS_SIGNER_CERT_B64       base64-encoded signer cert PEM
//   PASS_SIGNER_KEY_B64        base64-encoded encrypted signer key PEM
//   PASS_SIGNER_KEY_PASSPHRASE passphrase used when exporting the .p12
//
// The Apple WWDR G4 intermediate cert is committed at wallet/wwdr.pem (public
// Apple cert, not a secret). Pass template lives at wallet/voucher.pass/.

const fs   = require('fs');
const path = require('path');
const { PKPass } = require('passkit-generator');

const MODEL_DIR = path.join(__dirname, 'wallet', 'voucher.pass');
const WWDR_PATH = path.join(__dirname, 'wallet', 'wwdr.pem');

// ── Cert loading (once at startup) ─────────────────────────────────
let _wwdr, _signerCert, _signerKey, _signerKeyPassphrase, _configured = false;

function loadCerts() {
  if (_configured) return true;

  const certB64 = process.env.PASS_SIGNER_CERT_B64;
  const keyB64  = process.env.PASS_SIGNER_KEY_B64;
  const pass    = process.env.PASS_SIGNER_KEY_PASSPHRASE;

  if (!certB64 || !keyB64 || !pass) {
    return false; // Wallet pass disabled — endpoint returns 503, email hides the button
  }

  try {
    _wwdr        = fs.readFileSync(WWDR_PATH);
    _signerCert  = Buffer.from(certB64, 'base64');
    _signerKey   = Buffer.from(keyB64,  'base64');
    _signerKeyPassphrase = pass;
    _configured = true;
    return true;
  } catch (err) {
    console.error('[wallet] cert load failed:', err.message);
    return false;
  }
}

function isConfigured() {
  return loadCerts();
}

// ── Spa branding (env, with sane defaults) ─────────────────────────
const SPA_NAME    = process.env.SPA_NAME    || 'SiamEPOS Spa';
const SPA_ADDRESS = process.env.SPA_ADDRESS || '';
const SPA_EMAIL   = process.env.SPA_EMAIL   || 'info@siamepos.co.uk';

function formatExpiry(expiresAt) {
  if (!expiresAt) return '';
  const dateStr = (expiresAt instanceof Date)
    ? expiresAt.toISOString().slice(0, 10)
    : String(expiresAt).slice(0, 10);
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

// Wallet stores numeric Date as ISO with timezone — set expiration to end of
// expiry day in UTC so the pass auto-greys at the right moment.
function expiryIsoEndOfDay(expiresAt) {
  if (!expiresAt) return undefined;
  const dateStr = (expiresAt instanceof Date)
    ? expiresAt.toISOString().slice(0, 10)
    : String(expiresAt).slice(0, 10);
  return dateStr + 'T23:59:59Z';
}

// ── Main generator ─────────────────────────────────────────────────
// Returns a Buffer (the signed .pkpass zip). Caller writes it to res with
// content-type application/vnd.apple.pkpass.
async function buildVoucherPass(voucher) {
  if (!isConfigured()) {
    const e = new Error('Wallet pass not configured on server');
    e.code = 'PASS_NOT_CONFIGURED';
    throw e;
  }

  const code       = voucher.code;
  const isSessions = voucher.voucher_type === 'sessions';
  const expires    = formatExpiry(voucher.expires_at);
  const expIso     = expiryIsoEndOfDay(voucher.expires_at);
  const toName     = voucher.purchased_for || '';
  const treatment  = voucher.treatment_name || '';

  // serialNumber must be unique per pass — the voucher code already is unique
  // + stable. Apple uses this as the Wallet-side identity.
  const pass = await PKPass.from({
    model: MODEL_DIR,
    certificates: {
      wwdr:                _wwdr,
      signerCert:          _signerCert,
      signerKey:           _signerKey,
      signerKeyPassphrase: _signerKeyPassphrase,
    },
  }, {
    serialNumber:     code,
    description:      `${SPA_NAME} Gift Voucher`,
    organizationName: SPA_NAME,
    ...(expIso ? { expirationDate: expIso } : {}),
  });

  if (isSessions) {
    // ── Session bundle: show sessions remaining big on the front ──
    const total     = Number(voucher.total_sessions || 0);
    const remaining = Number(voucher.sessions_remaining != null ? voucher.sessions_remaining : total);
    pass.primaryFields.push({
      key:   'sessions',
      label: 'Sessions left',
      value: `${remaining} of ${total}`,
    });
    pass.secondaryFields.push(
      { key: 'code',    label: 'Code',    value: code },
      { key: 'expires', label: 'Expires', value: expires || 'No expiry' },
    );
    if (treatment) {
      pass.auxiliaryFields.push({ key: 'treatment', label: 'Treatment', value: treatment });
    }
    if (toName) {
      pass.auxiliaryFields.push({ key: 'recipient', label: 'For', value: toName });
    }
  } else {
    // ── Monetary voucher: show £ balance big on the front ─────────
    const amount     = Number(voucher.initial_value || 0);
    const balance    = Number(voucher.remaining_value != null ? voucher.remaining_value : amount);
    const amountFmt  = '£' + amount.toFixed(2);
    const balanceFmt = '£' + balance.toFixed(2);
    pass.primaryFields.push({ key: 'balance', label: 'Balance', value: balanceFmt });
    pass.secondaryFields.push(
      { key: 'code',    label: 'Code',    value: code },
      { key: 'expires', label: 'Expires', value: expires || 'No expiry' },
    );
    if (toName) {
      pass.auxiliaryFields.push({ key: 'recipient', label: 'For', value: toName });
    }
    if (Math.abs(balance - amount) > 0.001) {
      pass.auxiliaryFields.push({ key: 'original', label: 'Original value', value: amountFmt });
    }
  }

  // Back of pass — long-form terms + how to use + spa address.
  pass.backFields.push(
    {
      key:   'how_to_use',
      label: 'How to use',
      value: `Show this pass when you book or arrive at ${SPA_NAME}. Reception will scan the QR code or enter the voucher code to apply it. ${isSessions ? 'One session is used per treatment until the bundle is fully redeemed.' : 'The balance can be used over multiple visits until fully redeemed.'}`,
    },
    {
      key:   'spa',
      label: 'Where to use',
      value: SPA_ADDRESS ? `${SPA_NAME}\n${SPA_ADDRESS}` : SPA_NAME,
    },
    {
      key:   'terms',
      label: 'Terms & Conditions',
      value: 'Non-refundable. Not exchangeable for cash. Valid until the expiry date shown. Lost or stolen vouchers cannot be replaced.',
    },
    {
      key:   'support',
      label: 'Support',
      value: SPA_EMAIL,
    },
  );

  // QR code containing the voucher code — reception can scan it from the
  // recipient's phone instead of typing it in.
  pass.setBarcodes({
    format:          'PKBarcodeFormatQR',
    message:         code,
    messageEncoding: 'iso-8859-1',
    altText:         code,
  });

  return pass.getAsBuffer();
}

module.exports = {
  buildVoucherPass,
  isConfigured,
};
