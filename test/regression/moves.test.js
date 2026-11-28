// SPA-REGRESSION-001 — moving bookings on the timetable. Every way staff move a
// booking, plus the refusals that must still happen (and say the right thing).
'use strict';
const h = require('./helpers');
const { pool, ok } = h;

(async () => {
  await h.initSchema();
  const staff = { id: await h.admin(), name: 'Admin', role: 'admin' };
  const api = h.server({ '/api/appointments': 'src/routes/appointments.js' }, staff);
  const d = h.tomorrow();
  const at = (hm) => `${d}T${hm}:00Z`;

  const nuan = await h.therapist('Nuan'), money = await h.therapist('Money'), eakky = await h.therapist('Eakky');
  const offToday = await h.therapist('Tim', { days: [] });
  await pool.query('UPDATE rooms SET active = FALSE');   // a shop with exactly two rooms
  const r1 = await h.room('Room 1'), r2 = await h.room('Room 2');
  const t60 = await h.treatment(`Aroma 60 ${h.tag}`, 60, 69);
  const c = await h.client('Move Client');

  console.log('Moving bookings:');
  let a = await h.appt({ client: c, treatment: t60, therapist: nuan, start: '10:00', end: '11:00' });
  let r = await api.j(`/api/appointments/${a}`, { method: 'PUT', body: { therapist_id: money, starts_at: at('11:00') } });
  ok('drag to another therapist + time', r.s === 200 && (await h.row('appointments', a)).therapist_id === money, r.b);
  r = await api.j(`/api/appointments/${a}`, { method: 'PUT', body: { therapist_id: nuan } });
  ok('change therapist only (edit pop-up)', r.s === 200 && (await h.row('appointments', a)).therapist_id === nuan, r.b);

  const b = await h.appt({ client: c, treatment: t60, therapist: money, start: '13:00', end: '14:00' });
  const b2 = await h.appt({ client: c, treatment: t60, therapist: nuan, start: '13:00', end: '14:00' });
  r = await api.j('/api/appointments/swap', { method: 'POST', body: { id_a: b, id_b: b2 } });
  ok('swap two bookings', r.s === 200 && (await h.row('appointments', b)).therapist_id === nuan, r.b);

  // SPA-TREATWELL-DURATION-001 — a 90-min booking on a 60-min treatment keeps its length when moved.
  const long = await h.appt({ client: c, treatment: t60, therapist: nuan, start: '15:00', end: '16:30', source: 'treatwell' });
  r = await api.j(`/api/appointments/${long}`, { method: 'PUT', body: { therapist_id: eakky, starts_at: at('15:00') } });
  const lr = await h.row('appointments', long);
  ok('moved Treatwell booking keeps its 90 minutes', r.s === 200 && (lr.ends_at - lr.starts_at) === 90 * 60000, r.b);

  console.log('Rooms (SPA-ROOM-AUTO-001):');
  const sophia = await h.appt({ client: c, treatment: t60, therapist: money, room: r1, start: '17:00', end: '17:45', source: 'fresha' });
  const georgia = await h.appt({ client: c, treatment: t60, therapist: nuan, room: r1, start: '17:30', end: '18:30', source: 'treatwell' });
  r = await api.j(`/api/appointments/${georgia}`, { method: 'PUT', body: { therapist_id: eakky, room_id: r1, starts_at: at('17:30'), treatment_id: t60 } });
  let g = await h.row('appointments', georgia);
  ok('move with a busy room picks a free room', r.s === 200 && g.therapist_id === eakky && g.room_id === r2, r.b);
  const filler = await h.appt({ client: c, room: r2, start: '17:00', end: '19:00' });
  await pool.query('UPDATE appointments SET therapist_id = $1, room_id = $2 WHERE id = $3', [nuan, r1, georgia]);
  r = await api.j(`/api/appointments/${georgia}`, { method: 'PUT', body: { therapist_id: eakky, starts_at: at('17:30') } });
  ok('every room full → refused and says it is the ROOM', r.s === 409 && r.b?.conflicting?.reason === 'room', r.b);
  await pool.query('DELETE FROM appointments WHERE id IN ($1, $2)', [filler, sophia]);

  console.log('Refusals that must still happen:');
  const busy = await h.appt({ client: c, treatment: t60, therapist: eakky, start: '19:00', end: '20:00' });
  const x = await h.appt({ client: c, treatment: t60, therapist: nuan, start: '19:00', end: '20:00' });
  r = await api.j(`/api/appointments/${x}`, { method: 'PUT', body: { therapist_id: eakky, starts_at: at('19:00') } });
  ok('therapist already booked → refused, says THERAPIST', r.s === 409 && r.b?.conflicting?.reason === 'therapist', r.b);
  r = await api.j(`/api/appointments/${x}`, { method: 'PUT', body: { therapist_id: offToday, starts_at: at('19:00') } });
  ok('therapist off on the rota → refused', r.s === 409, r.b);
  r = await api.j(`/api/appointments/${x}`, { method: 'PUT', body: { notes: 'just a note' } });
  ok('notes-only edit always saves', r.s === 200, r.b);
  void busy; void sophia;

  api.close();
  h.done();
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
