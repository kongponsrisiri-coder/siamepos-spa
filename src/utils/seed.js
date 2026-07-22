// First-run seed helpers. Safe to call on every boot — checks before inserting.

const bcrypt = require('bcryptjs');
const { pool } = require('../db/dbAdapter');

async function seedDefaultAdmin() {
  // Guard on TILL OPERATORS, not all therapists. The login picker (/auth/staff)
  // deliberately hides role='therapist' (bookable service providers aren't till
  // users). So a till that has therapists but no operator would show an EMPTY
  // picker → "No staff found" → nobody can sign in. Counting only non-therapist
  // roles means: (a) a fresh till always gets a login, AND (b) if a till ever
  // loses every operator (all deleted), the next boot re-creates Admin/1234 —
  // self-healing lockout recovery. Idempotent: runs on every boot, no-op once
  // an operator exists.
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM therapists WHERE role <> 'therapist' AND active = TRUE",
  );
  if (rows[0].n > 0) return;
  const pinHash = bcrypt.hashSync('1234', 10);
  // If a deactivated 'Admin' row is lying around, revive it (reset PIN too);
  // otherwise create one. Either way we end with exactly one active admin.
  const upd = await pool.query(
    "UPDATE therapists SET active = TRUE, role = 'admin', pin = $1 WHERE name = 'Admin' AND role IN ('admin','manager')",
    [pinHash],
  );
  if (!upd.rowCount) {
    await pool.query(
      "INSERT INTO therapists (name, pin, role, active) VALUES ('Admin', $1, 'admin', TRUE)",
      [pinHash],
    );
  }
  console.warn('[seed] No active till operator existed — created/restored default admin (PIN 1234). CHANGE IT.');
}

module.exports = { seedDefaultAdmin };
