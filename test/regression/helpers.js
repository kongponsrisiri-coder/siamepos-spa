// SPA-REGRESSION-001 — shared helpers for the regression suite.
// Every test file runs in its own process against the throwaway Postgres that
// scripts/regression.js starts (TEST_DATABASE_URL). Never point it at a real DB.
'use strict';
const path = require('path');

if (!process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL not set — run via: node scripts/regression.js');
  process.exit(2);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SYNC_SECRET = process.env.SYNC_SECRET || 'regression';
// Silence the server's own console noise so a failure is easy to spot.
if (!process.env.REGRESSION_VERBOSE) { console.warn = () => {}; console.error = () => {}; }

const ROOT = path.resolve(__dirname, '../..');
const req = (p) => require(path.join(ROOT, p));
const express = req('node_modules/express');
const { pool, initSchema } = req('src/db/database.js');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); }
}
function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// A tiny API server with the given routes mounted, signed in as `staff`.
function server(routes, staff) {
  const app = express();
  app.use(express.json());
  app.use((q, _r, n) => { q.staff = staff; n(); });
  app.set('io', { emit() {}, to() { return { emit() {} }; } });
  for (const [mount, file] of Object.entries(routes)) app.use(mount, req(file));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (p, o = {}) => {
    const r = await fetch(base + p, {
      ...o,
      headers: { 'content-type': 'application/json', 'x-sync-secret': process.env.SYNC_SECRET },
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    return { s: r.status, b: await r.json().catch(() => null) };
  };
  return { j, close: () => srv.close() };
}

// Unique-per-run names so test files never collide with each other's data.
const tag = `${process.pid}`;
const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

async function admin() {
  return (await pool.query(`INSERT INTO therapists (name, role, pin, active) VALUES ($1, 'admin', 'x', TRUE) RETURNING id`, [`Admin ${tag}`])).rows[0].id;
}
async function therapist(name, { from = '09:00', to = '21:00', days = [0, 1, 2, 3, 4, 5, 6] } = {}) {
  const id = (await pool.query(`INSERT INTO therapists (name, role, pin, active) VALUES ($1, 'therapist', 'x', TRUE) RETURNING id`, [`${name} ${tag}`])).rows[0].id;
  for (const d of days) {
    await pool.query(`INSERT INTO therapist_availability (therapist_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, $4)`, [id, d, from, to]);
  }
  return id;
}
async function treatment(name, minutes, price) {
  return (await pool.query(`INSERT INTO treatments (name, duration_minutes, price, active) VALUES ($1, $2, $3, TRUE) RETURNING id`, [name, minutes, price])).rows[0].id;
}
async function client(name) {
  return (await pool.query(`INSERT INTO clients (name) VALUES ($1) RETURNING id`, [`${name} ${tag}`])).rows[0].id;
}
async function room(name) {
  return (await pool.query(`INSERT INTO rooms (name, active) VALUES ($1, TRUE) RETURNING id`, [`${name} ${tag}`])).rows[0].id;
}
// UTC wall times on tomorrow's date: appt({ therapist, start: '14:00', end: '15:00' })
async function appt({ client: c, treatment: t = null, therapist: th = null, room: r = null, start, end, source = 'phone', status = 'booked', date = tomorrow(), price = 50 }) {
  return (await pool.query(
    `INSERT INTO appointments (client_id, treatment_id, therapist_id, room_id, starts_at, ends_at, status, source, price_at_booking)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [c, t, th, r, `${date}T${start}:00Z`, `${date}T${end}:00Z`, status, source, price])).rows[0].id;
}
const row = async (table, id) => (await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];

module.exports = { ROOT, req, pool, initSchema, ok, done, server, tag, tomorrow, admin, therapist, treatment, client, room, appt, row };
