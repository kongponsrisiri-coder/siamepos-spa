// SPA-PIN-ONLY-001 — resolve a staff member from their PIN alone.
//
// The till used to ask "tap your name", then check that one person's PIN.
// Korakot wants the name list gone: staff type a PIN and the till knows who
// they are. Two things have to be true for that to be safe, and neither was
// true before:
//
//   1. A PIN must identify exactly ONE person. Admin → Staff never checked for
//      duplicates, so two people could share a PIN — and with the name list
//      gone, one of them would silently sign in AS THE OTHER. On a system with
//      a booking audit trail and medical notes, that is not a cosmetic bug.
//
//   2. Finding the owner of a PIN must be fast. bcrypt hashes cannot be looked
//      up, so PIN-only login previously bcrypt-compared EVERY staff row: ~100ms
//      each, so a 15-person spa took over a second per sign-in. With idle
//      logout signing people out every couple of minutes, that is felt all day.
//
// Both are solved by storing, alongside the bcrypt hash, a keyed HMAC of the
// PIN in an indexed column with a UNIQUE constraint:
//
//   · lookup is one indexed query instead of N bcrypt comparisons
//   · the database itself refuses to store the same PIN twice
//
// The HMAC is keyed with JWT_SECRET, so the column is useless to anyone who
// steals the table alone. It is NOT a password hash and never replaces bcrypt —
// the bcrypt hash is still what actually verifies the PIN. The HMAC only says
// "which row", never "is this correct".
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Same fallback shape the rest of the app uses: a missing secret must not make
// every PIN collide, so an absent JWT_SECRET yields a per-boot random key
// (lookup then misses and we fall back to the legacy scan, which still works).
const KEY = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

function pinHmac(pin) {
  return crypto.createHmac('sha256', KEY).update(String(pin)).digest('hex');
}

/**
 * Is this PIN already taken by someone else?
 * Checks migrated rows by HMAC and legacy rows (no HMAC yet) by bcrypt, so a
 * duplicate is caught even before the estate has finished migrating.
 * @returns the conflicting row, or null.
 */
async function pinTakenBy(pool, pin, exceptId = null) {
  const hmac = pinHmac(pin);
  const { rows } = await pool.query(
    `SELECT id, name, pin, pin_hmac FROM therapists
      WHERE active = TRUE ${exceptId ? 'AND id <> $1' : ''}`,
    exceptId ? [exceptId] : [],
  );
  for (const r of rows) {
    if (r.pin_hmac) { if (r.pin_hmac === hmac) return r; }
    else if (r.pin && bcrypt.compareSync(String(pin), r.pin)) return r;
  }
  return null;
}

/**
 * Find the single staff member whose PIN this is.
 * Fast path: one indexed HMAC lookup. Legacy path: bcrypt-scan only the rows
 * that have not been migrated yet, then backfill that row's HMAC so the next
 * sign-in takes the fast path. The estate migrates itself as people log in.
 * @returns { row, duplicate } — duplicate is true when the backfill hit the
 *          unique index, which means two active staff share this PIN.
 */
async function findByPin(pool, pin) {
  const hmac = pinHmac(pin);

  const fast = await pool.query(
    'SELECT id, name, pin, role FROM therapists WHERE pin_hmac = $1 AND active = TRUE',
    [hmac],
  );

  // Rows that have not been migrated yet. The unique index cannot see these, so
  // until the estate has finished migrating they are the one place a duplicate
  // can still hide — and a hidden duplicate under PIN-only login means signing
  // in as the wrong person. So they are checked even when the fast path hit.
  // This scan costs one bcrypt per un-migrated row and disappears entirely once
  // everyone has signed in once.
  const legacy = await pool.query(
    'SELECT id, name, pin, role FROM therapists WHERE pin_hmac IS NULL AND active = TRUE',
  );
  // filter, not find: two UN-migrated staff can share a PIN today, because
  // Admin → Staff never checked. Taking the first match would sign one of them
  // in as the other and there would be nothing in the logs to show it.
  const legacyMatches = legacy.rows.filter((r) => r.pin && bcrypt.compareSync(String(pin), r.pin));

  const holders = (fast.rows[0] ? 1 : 0) + legacyMatches.length;
  if (holders > 1) return { row: null, duplicate: true };
  if (holders === 0) return await rescue(pool, pin, hmac);
  if (fast.rows[0]) return { row: fast.rows[0], duplicate: false };

  const row = legacyMatches[0];

  try {
    await pool.query('UPDATE therapists SET pin_hmac = $1 WHERE id = $2', [hmac, row.id]);
  } catch (e) {
    // Unique violation: somebody else already holds this PIN. Refuse to guess
    // which of them is standing at the till.
    // Postgres: 23505. SQLite (the offline desktop till): SQLITE_CONSTRAINT_*.
    if (e && /^23505$|SQLITE_CONSTRAINT/.test(String(e.code || e.message))) {
      return { row: null, duplicate: true };
    }
    // Any other failure is just a missed optimisation — the sign-in is valid.
    console.error('[pin] hmac backfill failed', e.message);
  }
  return { row, duplicate: false };
}

/**
 * Last resort, and the reason it exists: the HMAC key IS JWT_SECRET. If that
 * ever changes — a rotated Railway variable, a reset desktop-till config — then
 * every stored pin_hmac is computed with the old key. The indexed lookup misses,
 * and those rows are NOT NULL so the legacy scan skips them too: every member of
 * staff is locked out of the till at once, with a correct PIN.
 *
 * So when nothing matched, scan the already-migrated rows by bcrypt and, on a
 * hit, rewrite that row's HMAC with the current key. The shop never notices.
 *
 * This only runs when a PIN matched NOTHING, i.e. on a wrong PIN, and the
 * existing brute-force lockout (8 failures / 15 min per IP) bounds how often an
 * attacker can make us pay for it.
 */
async function rescue(pool, pin, hmac) {
  const { rows } = await pool.query(
    'SELECT id, name, pin, role FROM therapists WHERE pin_hmac IS NOT NULL AND active = TRUE',
  );
  const matches = rows.filter((r) => r.pin && bcrypt.compareSync(String(pin), r.pin));
  if (matches.length > 1) return { row: null, duplicate: true };
  if (matches.length === 0) return { row: null, duplicate: false };

  const row = matches[0];
  console.warn(`[pin] re-keying pin_hmac for ${row.name} — JWT_SECRET appears to have changed`);
  try {
    await pool.query('UPDATE therapists SET pin_hmac = $1 WHERE id = $2', [hmac, row.id]);
  } catch (e) {
    console.error('[pin] re-key failed', e.message);
  }
  return { row, duplicate: false };
}

module.exports = { pinHmac, pinTakenBy, findByPin };
