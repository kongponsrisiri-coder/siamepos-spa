// SPA-BRAND-VOUCHER-001 — per-spa brand colours for CUSTOMER-FACING artefacts
// (Apple Wallet passes + voucher/loyalty emails). The till UI already themes
// itself from settings brand_primary/brand_accent (SPA-BRAND-001,
// client/src/theme.js); this is the server-side twin so the voucher a
// customer holds matches the spa that sold it — Highbury's burgundy & gold,
// the demo's navy & gold, each new client whatever they pick in Settings →
// Branding, with zero per-client code.
//
// Includes a luminance guard: text on the primary colour flips between white
// and near-black automatically, so a spa picking a pale brand colour can't
// produce an unreadable pass/email.

const { pool } = require('../db/dbAdapter');

// Keep in lockstep with client/src/theme.js DEFAULT_PRIMARY / DEFAULT_ACCENT.
const DEFAULT_PRIMARY = '#0D1B3E'; // SiamEPOS navy
const DEFAULT_ACCENT  = '#C9A84C'; // SiamEPOS gold

const HEX_RE = /^#?([0-9a-f]{6})$/i;

function parseHex(hex, fallback) {
  const m = HEX_RE.exec(String(hex || '').trim());
  const h = m ? m[1] : HEX_RE.exec(fallback)[1];
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

const toRgbString = ({ r, g, b }) => `rgb(${r}, ${g}, ${b})`;
const toHexString = ({ r, g, b }) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

// WCAG-ish relative luminance (0 = black, 1 = white).
function luminance({ r, g, b }) {
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Resolve the spa's brand theme from settings (with SiamEPOS defaults).
// Shape is ready for both Wallet pass props (rgb() strings — Apple's format)
// and email templates (hex strings).
async function getBrandTheme(db = pool) {
  let primaryRaw, accentRaw;
  try {
    const r = await db.query(
      `SELECT key, value FROM settings WHERE key IN ('brand_primary','brand_accent')`,
    );
    const kv = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
    primaryRaw = kv.brand_primary;
    accentRaw = kv.brand_accent;
  } catch { /* settings unreadable → defaults */ }

  const primary = parseHex(primaryRaw, DEFAULT_PRIMARY);
  const accent = parseHex(accentRaw, DEFAULT_ACCENT);
  const lightPrimary = luminance(primary) > 0.5;
  const textOnPrimary = lightPrimary ? { r: 28, g: 28, b: 28 } : { r: 255, g: 255, b: 255 };

  return {
    primaryHex: toHexString(primary),
    accentHex: toHexString(accent),
    primaryRgb: toRgbString(primary),
    accentRgb: toRgbString(accent),
    // Text sitting ON the primary colour (pass foreground, email hero text).
    textOnPrimaryRgb: toRgbString(textOnPrimary),
    textOnPrimaryHex: toHexString(textOnPrimary),
    // Softer secondary text on primary (labels/sublines).
    softOnPrimary: lightPrimary ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.7)',
    lightPrimary,
  };
}

module.exports = { getBrandTheme, DEFAULT_PRIMARY, DEFAULT_ACCENT };
