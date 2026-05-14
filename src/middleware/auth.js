// JWT auth middleware for staff-protected routes.
// Public endpoints (auth/login, widget/*, stripe/webhook) skip this.

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';

function signStaffToken(staff) {
  return jwt.sign(
    { sub: staff.id, name: staff.name, role: staff.role },
    JWT_SECRET,
    { expiresIn: '12h' },
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
