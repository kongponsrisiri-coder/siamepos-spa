// SPA-REGRESSION-001 — a real Treatwell email lands on the timetable correctly:
// right treatment, right LENGTH (90 stays 90), paid state only when the email
// says so, then reschedule and cancel follow it.
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const { pool, ok } = h;
const { parseTreatwellEmail } = h.req('src/services/treatwellEmail.js');
const { ingestBooking } = h.req('src/services/treatwellIngest.js');

const fixture = (n) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', n), 'utf8');
const io = { emit() {}, to() { return { emit() {} }; } };
// The fixtures are from June; move them to tomorrow so nothing is "in the past".
function toTomorrow(p) {
  const d = h.tomorrow();
  const fix = (s) => (s ? `${d}T${String(s).slice(11)}` : s);
  return { ...p, date: d, startLocal: fix(p.startLocal), services: (p.services || []).map((x) => ({ ...x, startLocal: fix(x.startLocal) })) };
}

(async () => {
  await h.initSchema();
  await h.therapist('TW One'); await h.therapist('TW Two');
  await h.treatment('Aromatherapy Massage 60 mins', 60, 69);
  await h.treatment('Aromatherapy Massage 90 mins', 90, 98);

  console.log('Treatwell import:');
  const ref = `T9${h.tag}`;
  const parsed = toTomorrow({ ...parseTreatwellEmail({ subject: "Fwd: You've got a new Treatwell booking (Our Ref. T2185537204)", text: fixture('treatwell-new.txt') }), ref });
  ok('email parses', parsed.ok && parsed.durationMin === 90, parsed);
  const r = await ingestBooking(parsed, 'raw', io, { source: 'treatwell' });
  ok('booking placed', ['placed', 'duplicate'].includes(r.status), r);
  const a = (await pool.query(`SELECT * FROM appointments WHERE treatwell_booking_id = $1`, [ref])).rows[0];
  ok('it is on the timetable', !!a, r);
  if (a) {
    ok('90-minute booking is 90 minutes long', (a.ends_at - a.starts_at) === 90 * 60000, { starts: a.starts_at, ends: a.ends_at });
    ok('given a therapist automatically', !!a.therapist_id, a);
    ok('email said prepaid → marked full prepaid', a.treatwell_payment_type === 'full', a.treatwell_payment_type);
  }
  const again = await ingestBooking(parsed, 'raw', io, { source: 'treatwell' });
  const count = (await pool.query(`SELECT COUNT(*)::int n FROM appointments WHERE treatwell_booking_id = $1`, [ref])).rows[0].n;
  ok('same email twice does not double-book', count === 1, { again, count });

  const unpaidRef = `T8${h.tag}`;
  const unpaid = { ...parsed, ref: unpaidRef, prepaid: false, unpaid: false };
  await ingestBooking(unpaid, 'raw', io, { source: 'treatwell' });
  const u = (await pool.query(`SELECT treatwell_payment_type FROM appointments WHERE treatwell_booking_id = $1`, [unpaidRef])).rows[0];
  ok('email silent on payment → NOT marked prepaid (SPA-TREATWELL-PREPAID-002)', u && u.treatwell_payment_type !== 'full', u);

  console.log('Reschedule and cancel:');
  const moved = toTomorrow({ ...parseTreatwellEmail({ subject: 'Fwd: A booking has been rescheduled', text: fixture('treatwell-reschedule.txt') }), ref });
  moved.startLocal = moved.startLocal.replace(/T\d\d:\d\d/, 'T12:00');
  moved.services = moved.services.map((x) => ({ ...x, startLocal: moved.startLocal }));
  const rr = await ingestBooking(moved, 'raw', io, { source: 'treatwell' });
  const m = (await pool.query(`SELECT * FROM appointments WHERE treatwell_booking_id = $1`, [ref])).rows[0];
  ok('reschedule moves it and keeps 90 minutes', m && (m.ends_at - m.starts_at) === 90 * 60000 && rr.status !== 'error', { rr, m: m && [m.starts_at, m.ends_at] });

  const cancel = { ...parseTreatwellEmail({ subject: 'Fwd: Order CANCELLATION', text: fixture('treatwell-cancel.txt') }), ref };
  await ingestBooking(cancel, 'raw', io, { source: 'treatwell' });
  const cx = (await pool.query(`SELECT status FROM appointments WHERE treatwell_booking_id = $1`, [ref])).rows[0];
  ok('cancellation email cancels it', cx && cx.status === 'cancelled', cx);

  h.done();
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
