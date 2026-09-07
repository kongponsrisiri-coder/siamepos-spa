// SPA-HISTORY-LOCK-001 — "Prevent editing historical data" per role.
// When the owner switches it on for a role (Admin → Roles & Permissions),
// that role can still SEE past records but every write to a record dated
// before today (UK time) is refused: past bookings, past rota days, bills of
// past bookings, back-dated petty cash. Admin is never locked.
const { pool } = require('../db/dbAdapter');
const permissions = require('./permissions');

const londonDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const todayLondon = () => londonDate(new Date());
const isPast = (dateLike) => { const d = String(dateLike || '').slice(0, 10); return !!d && d < todayLondon() ? true : (dateLike instanceof Date || /T/.test(String(dateLike))) && londonDate(dateLike) < todayLondon(); };

async function lockedForRole(req) {
  if (!req.staff || req.staff.role === 'admin') return false;
  const perms = await permissions.load();
  return perms[req.staff.role]?.history_lock === 'on';
}

// Resolve the date the write touches. Exactly one of the options is used.
async function targetDate({ appointmentId, billId, date }) {
  if (date) return String(date).slice(0, 10);
  if (appointmentId) {
    const r = await pool.query('SELECT starts_at FROM appointments WHERE id = $1', [Number(appointmentId)]);
    return r.rows[0] ? londonDate(r.rows[0].starts_at) : null;
  }
  if (billId) {
    const r = await pool.query(
      `SELECT COALESCE(a.starts_at, b.closed_at) AS d FROM bills b LEFT JOIN appointments a ON a.id = b.appointment_id WHERE b.id = $1`,
      [Number(billId)]);
    return r.rows[0] && r.rows[0].d ? londonDate(r.rows[0].d) : null;
  }
  return null;
}

// Express helper: returns true (and has already replied 403) when the write
// must be refused. Usage: if (await guardPast(req, res, { appointmentId: id })) return;
async function guardPast(req, res, target) {
  try {
    if (!(await lockedForRole(req))) return false;
    const d = await targetDate(target || {});
    if (!d || d >= todayLondon()) return false;
    res.status(403).json({ error: 'Past records are locked for your role — ask a manager or the owner', code: 'history_locked', date: d });
    return true;
  } catch (e) { return false; }
}

module.exports = { guardPast, lockedForRole, isPast, todayLondon };
