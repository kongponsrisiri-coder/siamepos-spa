// SPA-LOYALTY-001 Layer 2 — Apple Wallet LOYALTY pass (storeCard).
//
// The headline feature: a spa-branded card in the customer's Wallet showing a
// big "7 / 10" visit count that UPDATES ON THE PHONE after every visit. The
// pass carries webServiceURL + authenticationToken, so Wallet registers with
// our pass web service (routes/walletWebService.js); every loyalty event bumps
// wallet_passes.updated_at and APNs-pushes the registered devices
// (walletPush.js), and Wallet re-fetches the pass built here from live data.
//
// Reuses the voucher pass certificate + Pass Type ID (shared across SiamEPOS
// deployments) — a pass type can carry many pass styles. Because several spas
// share the pass type, serials embed a per-spa key so two spas can never mint
// the same serial.

const path = require('path');
const crypto = require('crypto');
const { PKPass } = require('passkit-generator');
const { pool } = require('../db/dbAdapter');
const { getCerts, isConfigured } = require('./voucherWalletPass');

const MODEL_DIR = path.join(__dirname, 'wallet', 'loyalty.pass');

const SPA_NAME    = process.env.SPA_NAME    || 'SiamEPOS Spa';
const SPA_ADDRESS = process.env.SPA_ADDRESS || '';
const SPA_EMAIL   = process.env.SPA_EMAIL   || 'info@siamepos.co.uk';

// Stable, spa-scoped serial for a client's loyalty card. Deterministic so a
// re-issued email always links to the SAME pass (Wallet replaces, not
// duplicates); hashed so serials from different spas sharing the Pass Type ID
// can't collide or be guessed.
function loyaltySerial(clientId) {
  const spaKey = process.env.SPA_ID || process.env.SPA_NAME || 'spa';
  const h = crypto.createHash('sha256').update(`loyalty:${spaKey}:${clientId}`).digest('hex');
  return `LOY-${h.slice(0, 16).toUpperCase()}`;
}

// Get-or-create the wallet_passes row for a client's loyalty card. The row
// holds the per-pass auth token that authenticates BOTH the public download
// link and Apple's web-service calls. Returns { serial, auth_token } or null
// when passes aren't configured.
async function ensurePassRecord(clientId) {
  if (!isConfigured()) return null;
  const serial = loyaltySerial(clientId);
  const existing = await pool.query(`SELECT serial, auth_token FROM wallet_passes WHERE serial = $1`, [serial]);
  if (existing.rows[0]) return existing.rows[0];
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO wallet_passes (kind, client_id, serial, auth_token) VALUES ('loyalty', $1, $2, $3)
     ON CONFLICT (serial) DO NOTHING`,
    [clientId, serial, token],
  );
  const row = await pool.query(`SELECT serial, auth_token FROM wallet_passes WHERE serial = $1`, [serial]);
  return row.rows[0] || null;
}

// Build the signed .pkpass from LIVE loyalty state. `status` comes from
// loyaltyService.getStatus (visits, tiers, next tier, ready rewards).
async function buildLoyaltyPass({ client, status, serial, authToken }) {
  const certs = getCerts();
  if (!certs) {
    const e = new Error('Wallet pass not configured on server');
    e.code = 'PASS_NOT_CONFIGURED';
    throw e;
  }
  const apiBase = (process.env.PUBLIC_API_URL || 'https://spa-api.siamepos.co.uk').replace(/\/$/, '');

  const pass = await PKPass.from({
    model: MODEL_DIR,
    certificates: {
      wwdr:                certs.wwdr,
      signerCert:          certs.signerCert,
      signerKey:           certs.signerKey,
      signerKeyPassphrase: certs.signerKeyPassphrase,
    },
  }, {
    serialNumber:        serial,
    description:         `${SPA_NAME} Loyalty Card`,
    organizationName:    SPA_NAME,
    webServiceURL:       `${apiBase}/api/wallet`,
    authenticationToken: authToken,
  });

  const visits = Number(status?.visits || 0);
  const next = status?.next_tier || null;
  const ready = status?.available_rewards || [];

  // Front: the big progress number — "7 / 10" toward the next reward, or the
  // plain visit count when the ladder is complete/not configured.
  pass.primaryFields.push({
    key:   'visits',
    label: next ? 'Visits' : 'Total visits',
    value: next ? `${visits} / ${next.at_visit}` : `${visits}`,
  });
  if (ready.length > 0) {
    pass.secondaryFields.push({
      key:   'ready',
      label: 'Ready to enjoy',
      value: ready.map((t) => t.reward).join(' · '),
    });
  } else if (next) {
    pass.secondaryFields.push({
      key:   'next',
      label: `${next.at_visit - visits} visit${next.at_visit - visits === 1 ? '' : 's'} to go`,
      value: next.reward,
    });
  }
  pass.auxiliaryFields.push({ key: 'member', label: 'Member', value: client.name || '—' });

  // Back: the full reward ladder + how it works.
  const ladder = (status?.tiers || [])
    .map((t) => {
      const redeemed = (status.redeemed_tiers || []).includes(t.at_visit);
      const isReady = ready.some((r) => r.at_visit === t.at_visit);
      const mark = redeemed ? '✓' : isReady ? '★' : '○';
      return `${mark} Visit ${t.at_visit} — ${t.reward}${isReady ? ' (ready!)' : redeemed ? ' (enjoyed)' : ''}`;
    })
    .join('\n');
  pass.backFields.push(
    {
      key: 'how',
      label: 'How it works',
      value: `Every visit booked directly with ${SPA_NAME} counts automatically — nothing to stamp. This card updates itself after each visit.`,
    },
    ...(ladder ? [{ key: 'ladder', label: 'Rewards', value: ladder }] : []),
    {
      key: 'spa',
      label: 'Where',
      value: SPA_ADDRESS ? `${SPA_NAME}\n${SPA_ADDRESS}` : SPA_NAME,
    },
    { key: 'support', label: 'Questions', value: SPA_EMAIL },
  );

  // QR carries the serial — lets reception look the card up in future
  // versions; harmless today.
  pass.setBarcodes({
    format:          'PKBarcodeFormatQR',
    message:         serial,
    messageEncoding: 'iso-8859-1',
    altText:         `${SPA_NAME} loyalty`,
  });

  return pass.getAsBuffer();
}

module.exports = {
  isConfigured,
  loyaltySerial,
  ensurePassRecord,
  buildLoyaltyPass,
};
