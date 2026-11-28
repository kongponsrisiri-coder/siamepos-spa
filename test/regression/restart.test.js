// SPA-REGRESSION-001 — a deploy (= server restart = initSchema + seedDefaultAdmin)
// must not change ANYTHING the shop has set up. Twice a boot-time "fill in a
// default if empty" seed rewrote Highbury's rota (2026-08-01, 2026-11-28).
// This snapshots every operator-owned table after shop-style edits, restarts
// twice, and demands an identical snapshot — so any future boot seed fails here.
'use strict';
const h = require('./helpers');
const { pool } = h;

const SNAP = {
  therapist_availability:   'SELECT therapist_id, day_of_week, start_time, end_time FROM therapist_availability ORDER BY 1, 2, 3',
  therapist_rota_overrides: 'SELECT therapist_id, date, is_working, start_time, end_time FROM therapist_rota_overrides ORDER BY 1, 2',
  therapists:               'SELECT id, name, role, active FROM therapists ORDER BY id',
  rooms:                    'SELECT id, name, active FROM rooms ORDER BY id',
  treatments:               'SELECT id, name, duration_minutes, price, active FROM treatments ORDER BY id',
  settings:                 'SELECT key, value FROM settings ORDER BY key',
  appointments:             'SELECT id, therapist_id, room_id, starts_at, ends_at, status, source, treatwell_payment_type, price_at_booking FROM appointments ORDER BY id',
};
const snapshot = async () => {
  const out = {};
  for (const [k, q] of Object.entries(SNAP)) out[k] = JSON.stringify((await pool.query(q)).rows);
  return out;
};

(async () => {
  await h.initSchema();
  console.log('Restart keeps the shop\'s setup:');

  // Shop-style edits, the kind that have been overwritten before.
  const off   = await h.therapist('Aoy', { days: [] });                                    // every day unticked
  const part  = await h.therapist('Nam', { from: '11:00', to: '19:00', days: [1, 2, 3] }); // some days off, custom hours
  await pool.query(`INSERT INTO therapist_rota_overrides (therapist_id, date, is_working) VALUES ($1, $2, FALSE)`, [part, h.tomorrow()]);
  await pool.query(`UPDATE rooms SET active = FALSE`);                                     // shop doesn't use rooms
  await pool.query(`UPDATE settings SET value = '40' WHERE key = 'deposit_amount'`);
  await pool.query(`UPDATE settings SET value = 'Our own words' WHERE key = 'cancel_policy_text'`);
  const c = await h.client('Restart Client');
  const t = await h.treatment(`Thai massage 90 mins ${h.tag}`, 90, 75);
  await h.appt({ client: c, treatment: t, therapist: part, start: '12:00', end: '13:30', source: 'treatwell' });

  const before = await snapshot();
  const { seedDefaultAdmin } = h.req('src/utils/seed.js');
  for (let i = 0; i < 2; i++) { await h.initSchema(); await seedDefaultAdmin(); }
  const after = await snapshot();

  for (const k of Object.keys(SNAP)) h.ok(`${k} unchanged after two restarts`, before[k] === after[k], { before: before[k].slice(0, 200), after: after[k].slice(0, 200) });
  const n = (await pool.query('SELECT COUNT(*)::int n FROM therapist_availability WHERE therapist_id = $1', [off])).rows[0].n;
  h.ok('therapist with every day off is still off', n === 0, n);

  h.done();
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
