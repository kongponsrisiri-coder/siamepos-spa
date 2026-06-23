const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('../db/dbAdapter');
const { signStaffToken } = require('../middleware/auth');
const { sendOwnerLoginLink } = require('../services/emailService');

const router = express.Router();

// ── SEPOS-SPA-OWNER-001 — owner mobile login via single-use magic link ──────
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// In-memory throttle: max 5 link requests per key per 15 min (email + IP).
const linkAttempts = new Map();
function throttled(key) {
  const now = Date.now(), win = 15 * 60 * 1000, max = 5;
  const arr = (linkAttempts.get(key) || []).filter((t) => now - t < win);
  if (arr.length >= max) { linkAttempts.set(key, arr); return true; }
  arr.push(now); linkAttempts.set(key, arr); return false;
}
async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
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

// POST /api/auth/owner/request-link  body: { email }
// Emails a single-use sign-in link IF the email matches this spa's owner_email.
// Always responds uniformly so the endpoint can't be used to probe emails.
router.post('/owner/request-link', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const uniform = () => res.json({ ok: true, message: 'If that email is on file, a sign-in link is on its way.' });
  if (!email || !email.includes('@')) return uniform();
  if (throttled(email) || throttled('ip:' + (req.ip || ''))) return uniform();
  try {
    const owner = String((await getSetting('owner_email')) || '').trim().toLowerCase();
    if (!owner || owner !== email) return uniform(); // no owner set, or no match → reveal nothing
    const raw = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await pool.query(
      'INSERT INTO owner_login_tokens (token_hash, email, expires_at) VALUES ($1, $2, $3)',
      [sha256(raw), email, expires],
    );
    const base = (req.headers.origin || process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
    const url = `${base}/owner-login?token=${raw}`;
    await sendOwnerLoginLink({ to: email, url, spaName: await getSetting('spa_name') });
    return uniform();
  } catch (err) {
    console.error('[auth/owner/request-link]', err);
    return uniform();
  }
});

// POST /api/auth/owner/verify  body: { token }  → issues an owner session (admin role)
router.post('/owner/verify', async (req, res) => {
  const token = String((req.body && req.body.token) || '');
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const nowIso = new Date().toISOString();
    const { rows } = await pool.query(
      'SELECT id, email FROM owner_login_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 ORDER BY id DESC LIMIT 1',
      [sha256(token), nowIso],
    );
    if (!rows[0]) return res.status(401).json({ error: 'This sign-in link is invalid or has expired — please request a new one.' });
    await pool.query('UPDATE owner_login_tokens SET used_at = $2 WHERE id = $1', [rows[0].id, nowIso]);
    const staff = { id: null, name: 'Owner', role: 'admin' };
    return res.json({ staff, token: signStaffToken(staff) });
  } catch (err) {
    console.error('[auth/owner/verify]', err);
    return res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
