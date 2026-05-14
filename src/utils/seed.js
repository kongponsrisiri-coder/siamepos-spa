// First-run seed helpers. Safe to call on every boot — checks before inserting.

const bcrypt = require('bcryptjs');
const { pool } = require('../db/database');

async function seedDefaultAdmin() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM therapists');
  if (rows[0].n > 0) return;
  const pinHash = bcrypt.hashSync('1234', 10);
  await pool.query(
    `INSERT INTO therapists (name, pin, role, active) VALUES ($1, $2, $3, TRUE)`,
    ['Admin', pinHash, 'admin'],
  );
  console.warn('[seed] No staff existed — created default admin with PIN 1234. CHANGE IT.');
}

module.exports = { seedDefaultAdmin };
