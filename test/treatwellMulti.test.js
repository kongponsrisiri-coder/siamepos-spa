// SPA-TREATWELL-MULTI-001 — one Treatwell order with TWO treatments must put
// BOTH on the timetable, and reschedule/cancel must act on the whole order.
// Found live 26 Sep 2026 (Highbury: Reflexology 10:00 + Head, Neck & Shoulder
// 10:45, one T-ref — only the first arrived). Runs on a throwaway SQLite DB:
//   node test/treatwellMulti.test.js
//   TEST_DATABASE_URL=postgres://… node test/treatwellMulti.test.js   (Postgres,
//   the cloud path — point it at an EMPTY scratch database, never a live one)
// Fixtures use a made-up guest (no real customer data).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-multi-'));
if (process.env.TEST_DATABASE_URL) {
  process.env.DB_MODE = 'cloud';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.DB_MODE = 'local';
  process.env.SQLITE_PATH = path.join(tmp, 'spa.db');
  delete process.env.SQLITE_ENCRYPTION_KEY;
}

const { pool, initSchema } = require('../src/db/dbAdapter');
const { parseTreatwellEmail } = require('../src/services/treatwellEmail');
const { ingestBooking } = require('../src/services/treatwellIngest');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); }
}
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const NEW_SUBJ = "Fwd: You've got a new Treatwell booking (Our Ref. T2199990001)";

async function order(ref) {
  const { rows } = await pool.query(
    `SELECT a.treatwell_booking_id AS k, a.status, a.starts_at, a.ends_at, a.price_at_booking AS price, t.name
       FROM appointments a LEFT JOIN treatments t ON t.id = a.treatment_id
      WHERE a.treatwell_booking_id = $1 OR a.treatwell_booking_id LIKE $1 || '#%'
      ORDER BY a.starts_at`, [ref]);
  return rows;
}
const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });

(async () => {
  await initSchema();
  await pool.query(`INSERT INTO treatments (name, duration_minutes, price, active) VALUES ('Reflexology', 45, 55, TRUE)`);
  await pool.query(`INSERT INTO treatments (name, duration_minutes, price, active) VALUES ('Head, Neck & Shoulder Massage', 30, 40, TRUE)`);

  for (const [label, file] of [['separate blocks per treatment', 'treatwell-new-multi.txt'],
                               ['one block + two product lines', 'treatwell-new-multi-oneblock.txt']]) {
    console.log(`NEW multi-treatment order (${label}):`);
    await pool.query(`DELETE FROM appointments`);
    const p = parseTreatwellEmail({ subject: NEW_SUBJ, text: fixture(file) });
    eq('parser finds 2 treatments', p.services.length, 2);
    const r = await ingestBooking(p, 'raw', null);
    eq('status placed', r.status, 'placed');
    let rows = await order('T2199990001');
    eq('two appointments', rows.map((x) => [x.k, x.name, hhmm(x.starts_at), hhmm(x.ends_at), Number(x.price)]), [
      ['T2199990001', 'Reflexology', '10:00', '10:45', 55],
      ['T2199990001#2', 'Head, Neck & Shoulder Massage', '10:45', '11:15', 40],
    ]);
    const again = await ingestBooking(parseTreatwellEmail({ subject: NEW_SUBJ, text: fixture(file) }), 'raw', null);
    eq('re-delivery is a duplicate, no extra rows', [again.status, (await order('T2199990001')).length], ['duplicate', 2]);
  }

  console.log('Order imported BEFORE the fix (only the first treatment) → re-delivery fills the gap:');
  {
    await pool.query(`DELETE FROM appointments WHERE treatwell_booking_id = 'T2199990001#2'`);
    const r = await ingestBooking(parseTreatwellEmail({ subject: NEW_SUBJ, text: fixture('treatwell-new-multi.txt') }), 'raw', null);
    eq('status placed', r.status, 'placed');
    eq('back to two', (await order('T2199990001')).length, 2);
  }

  console.log('RESCHEDULE with one new time → the whole order moves together:');
  {
    const r = await ingestBooking({ ok: true, action: 'reschedule', ref: 'T2199990001', treatment: null,
      startLocal: '2026-10-03T14:00:00', date: '2026-10-03', confidence: 'high' }, 'raw', null);
    // (scratch spa has no therapists on rota → the existing rota re-check flags
    // it for review; what matters here is that BOTH treatments were moved)
    eq('both appointments handled', (r.appointment_ids || []).length, 2);
    const rows = await order('T2199990001');
    eq('both moved, still back to back', rows.map((x) => [hhmm(x.starts_at), hhmm(x.ends_at)]), [['14:00', '14:45'], ['14:45', '15:15']]);
  }

  console.log('RESCHEDULE naming one treatment → only that one moves:');
  {
    await ingestBooking({ ok: true, action: 'reschedule', ref: 'T2199990001', treatment: 'Head, Neck & Shoulder Massage',
      startLocal: '2026-10-03T16:00:00', date: '2026-10-03', durationMin: 30, confidence: 'high' }, 'raw', null);
    const rows = await order('T2199990001');
    eq('reflexology stays, HNS moves', rows.map((x) => [x.name, hhmm(x.starts_at)]), [['Reflexology', '14:00'], ['Head, Neck & Shoulder Massage', '16:00']]);
  }

  console.log('CANCEL → every treatment in the order:');
  {
    const r = await ingestBooking({ ok: true, action: 'cancel', ref: 'T2199990001', confidence: 'high' }, 'raw', null);
    eq('status cancelled', r.status, 'cancelled');
    eq('both cancelled', (await order('T2199990001')).map((x) => x.status), ['cancelled', 'cancelled']);
  }

  console.log('Single-treatment order unchanged (bare ref, one row):');
  {
    const p = parseTreatwellEmail({ subject: "Fwd: You've got a new Treatwell booking", text: fixture('treatwell-new.txt') });
    const r = await ingestBooking(p, 'raw', null);
    eq('placed', r.status, 'placed');
    const rows = await order(p.ref);
    eq('one row, bare ref', rows.map((x) => x.k), [p.ref]);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (pool.end) await pool.end().catch(() => {});
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
