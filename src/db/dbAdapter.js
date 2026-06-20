// Database adapter — the single switch between cloud (Postgres) and local
// (SQLite) modes for SiamEPOS Spa. Mirrors the restaurant EPOS pattern.
//
//   DB_MODE=cloud (default)  → src/db/database.js      (Postgres / Railway)
//   DB_MODE=local            → src/db/localDatabase.js (encrypted SQLite, offline)
//
// Both modules export the SAME shape: { pool, query, initSchema }, where
// `pool.query(text, params)` and `pool.connect()` are pg-compatible. Every
// route does `const { pool } = require('../db/dbAdapter')` and is completely
// unaware of which database is underneath — the local module translates
// Postgres SQL to SQLite at runtime.
//
// Set DB_MODE=local only inside the Electron desktop shell (Phase B). The
// cloud server and the browser PWA never set it, so they stay on Postgres.

const mode = (process.env.DB_MODE || 'cloud').toLowerCase();

let impl;
if (mode === 'local') {
  console.log('[dbAdapter] DB_MODE=local → SQLite (offline)');
  impl = require('./localDatabase');
} else {
  impl = require('./database');
}

module.exports = impl;
