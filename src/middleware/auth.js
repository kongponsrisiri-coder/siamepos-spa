// JWT auth middleware for staff-protected routes.
// Public endpoints (auth/login, widget/*, stripe/webhook) skip this.

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// SEPOS-061 parity — the 'dev-only-change-me' default is public (open-source repo),
// so on any deploy that forgets JWT_SECRET an attacker could forge admin tokens.
// If it's unset/default we use a RANDOM per-boot secret: tokens become unforgeable
// (the public default no longer validates). Trade-off: sessions reset on restart
// until JWT_SECRET is set on Railway. The desktop till always passes its own
// JWT_SECRET (electron config) so only an unconfigured cloud is affected.
let JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET || JWT_SECRET === 'dev-only-change-me') {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] JWT_SECRET not set — using a random per-boot secret (sessions reset on restart). Set JWT_SECRET on Railway for stable, persistent sessions.');
}

function signStaffToken(staff, expiresIn = '12h') {
  return jwt.sign(
    { sub: staff.id, name: staff.name, role: staff.role },
    JWT_SECRET,
    { expiresIn },
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.staff = { id: decoded.sub, name: decoded.name, role: decoded.role };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.staff) return res.status(401).json({ error: 'not authenticated' });
    if (!roles.includes(req.staff.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

module.exports = { signStaffToken, requireAuth, requireRole, JWT_SECRET };
