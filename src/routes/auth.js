const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('../db/dbAdapter');
const { signStaffToken } = require('../middleware/auth');

const router = express.Router();

// ── SEPOS-SPA-OWNER-001 v2 — email + password login (same as the restaurant
// web-app login, so both products are consistent). scrypt hash format
// "<saltHex>:<scrypt(password,salt,64)Hex>" — no extra dependencies.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  if (!stored || stored.indexOf(':') === -1) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Secret-gate for set-credentials so it can't be abused to mint an admin login.
// SEPOS-061 parity — never accept the PUBLIC default in production: if no real
// secret is set, use a random per-boot one so the known default can't call it
// (ops must set SETUP_SECRET/JWT_SECRET to provision; same as the restaurant).
let SETUP_SECRET = process.env.SETUP_SECRET || process.env.JWT_SECRET || 'dev-only-change-me';
if (SETUP_SECRET === 'dev-only-change-me' && process.env.NODE_ENV === 'production') {
  SETUP_SECRET = crypto.randomBytes(32).toString('hex');
}

// SEPOS-SPA-BUGHUNT — PIN login bcrypt-compares against every staff row, so a
// flood of concurrent logins pegs the CPU (a stress test hit 10s p95 at 20
// concurrent). Cap it per IP: ~30 attempts / 60s — plenty for a busy till, but
// it stops a login flood from DoS-ing the spa.
const loginHits = new Map();
function loginThrottled(ip) {
  const now = Date.now(), win = 60 * 1000, max = 30;
  const arr = (loginHits.get(ip) || []).filter((t) => now - t < win);
  if (arr.length >= max) { loginHits.set(ip, arr); return true; }
  arr.push(now); loginHits.set(ip, arr); return false;
}

// POST /api/auth/login  body: { pin: '1234' }
// PINs are stored as bcrypt hashes — we compare against every active staff
// row. For a spa with <50 staff this is plenty fast.
// GET /api/auth/staff — public list for the "tap your name" login picker.
// Returns id/name/role only (never the PIN hash). The staff names being visible
// on a shared till's login screen is standard for PIN POS — same as the
// restaurant EPOS — and it's what lets login check a SINGLE bcrypt row.
router.get('/staff', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, role FROM therapists WHERE active = TRUE ORDER BY name',
    );
    res.json({ staff: rows });
  } catch (err) {
    console.error('[auth/staff] error', err);
    res.status(500).json({ error: 'server error' });
  }
});

router.post('/login', async (req, res) => {
  const { pin, staff_id } = req.body || {};
  if (!pin || typeof pin !== 'string') {
    return res.status(400).json({ error: 'pin required' });
  }
  if (loginThrottled('ip:' + (req.ip || ''))) {
    return res.status(429).json({ error: 'Too many sign-in attempts — please wait a moment and try again.' });
  }
  try {
    let match;
    if (staff_id != null && staff_id !== '') {
      // SEPOS-SPA-BUGHUNT — name-then-PIN: bcrypt-compare a SINGLE row, not every
      // staff row. Fixes the login DoS the stress test found (bcrypt-per-row × N).
      const r = await pool.query(
        'SELECT id, name, pin, role FROM therapists WHERE id = $1 AND active = TRUE',
        [Number(staff_id)],
      );
      const row = r.rows[0];
      if (row && bcrypt.compareSync(pin, row.pin)) match = row;
    } else {
      // Fallback (legacy clients / cached frontends that send only a PIN).
      const { rows } = await pool.query('SELECT id, name, pin, role FROM therapists WHERE active = TRUE');
      match = rows.find((row) => bcrypt.compareSync(pin, row.pin));
    }
    if (!match) return res.status(401).json({ error: 'invalid pin' });
    const staff = { id: match.id, name: match.name, role: match.role };
    return res.json({ staff, token: signStaffToken(staff) });
  } catch (err) {
    console.error('[auth/login] error', err);
    return res.status(500).json({ error: 'server error' });
  }
});

// POST /api/auth/email-login  body: { email, password }  → 14-day session.
// Owner / manager signs in remotely with email + password (same as the
// restaurant web app). Credentials live on the therapists table; PIN login is
// untouched. Single bcrypt-free scrypt verify of ONE row → no DoS.
router.post('/email-login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (loginThrottled('ip:' + (req.ip || ''))) {
    return res.status(429).json({ error: 'Too many sign-in attempts — please wait a moment.' });
  }
  try {
    const r = await pool.query(
      'SELECT id, name, role, password_hash FROM therapists WHERE LOWER(email) = LOWER($1) AND active = TRUE',
      [String(email).trim()],
    );
    const row = r.rows[0];
    if (!row || !row.password_hash || !verifyPassword(password, row.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const staff = { id: row.id, name: row.name, role: row.role };
    return res.json({ staff, token: signStaffToken(staff, '14d'), expires_at: Date.now() + 14 * 24 * 60 * 60 * 1000 });
  } catch (err) {
    console.error('[auth/email-login]', err);
    return res.status(500).json({ error: 'server error' });
  }
});

// POST /api/auth/set-credentials  body: { email, password, name?, pin? }
// Provisions an email+password owner login on the therapists table. Secret-gated
// (X-Setup-Secret must match SETUP_SECRET) so it can't be abused to mint admins.
// Mirrors the restaurant /api/auth/set-credentials.
router.post('/set-credentials', async (req, res) => {
  if ((req.get('X-Setup-Secret') || '') !== SETUP_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { email, password, name, pin } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  try {
    const clean = String(email).trim();
    const hash = hashPassword(password);
    // The therapists.pin is NOT NULL and PIN login keys on it, so the owner row
    // must carry a PIN. Use the one provided, else allocate a free 4-digit one.
    const requestedPin = pin != null ? String(pin).replace(/\D/g, '').slice(0, 6) : '';
    const freePin = async () => {
      const used = await pool.query('SELECT pin FROM therapists');
      const taken = new Set(used.rows.map((x) => String(x.pin)));
      for (let p = 1234; p <= 9999; p++) if (!taken.has(String(p))) return String(p);
      for (let p = 1000; p < 1234; p++) if (!taken.has(String(p))) return String(p);
      return null;
    };
    // PIN must be bcrypt-hashed to match the PIN-login path.
    const existing = await pool.query('SELECT id, pin FROM therapists WHERE LOWER(email) = LOWER($1)', [clean]);
    if (existing.rows[0]) {
      await pool.query('UPDATE therapists SET password_hash = $1, active = TRUE WHERE id = $2', [hash, existing.rows[0].id]);
      return res.json({ id: existing.rows[0].id, updated: true });
    }
    const ownerPin = requestedPin || (await freePin());
    const ins = await pool.query(
      "INSERT INTO therapists (name, pin, role, email, password_hash, active) VALUES ($1, $2, 'admin', $3, $4, TRUE) RETURNING id",
      [name || 'Owner', bcrypt.hashSync(ownerPin, 10), clean, hash],
    );
    return res.json({ id: ins.rows[0].id, created: true, pin: ownerPin });
  } catch (err) {
    console.error('[auth/set-credentials]', err);
    return res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
