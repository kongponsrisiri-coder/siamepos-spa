// SPA-REGRESSION-001 — taking money. Every payment method closes a bill, and
// the reports count it in the right place (cash must match the drawer).
'use strict';
const h = require('./helpers');
const { pool, ok } = h;

(async () => {
  await h.initSchema();
  const staff = { id: await h.admin(), name: 'Admin', role: 'admin' };
  const api = h.server({
    '/api/appointments': 'src/routes/appointments.js',
    '/api/bills':        'src/routes/bills.js',
    '/api/vouchers':     'src/routes/vouchers.js',
    '/api/reports':      'src/routes/reports.js',
  }, staff);
  const today = new Date().toISOString().slice(0, 10);
  const t = await h.treatment(`Checkout 60 ${h.tag}`, 60, 70);
  const c = await h.client('Checkout Client');
  const th = await h.therapist('Pay');
  const money = async () => {
    const r = await api.j(`/api/reports/trading?from=${today}&to=${today}`);
    const m = {};
    for (const x of r.b?.payment_breakdown?.money_taken || []) m[x.payment_method] = Number(x.revenue);
    return m;
  };
  const bill = async () => {
    const a = (await pool.query(
      `INSERT INTO appointments (client_id, treatment_id, therapist_id, starts_at, ends_at, status, source, price_at_booking)
       VALUES ($1, $2, $3, now(), now() + interval '1 hour', 'booked', 'phone', 70) RETURNING id`, [c, t, th])).rows[0].id;
    const r = await api.j('/api/bills', { method: 'POST', body: { appointment_id: a } });
    return r.b?.bill;
  };

  console.log('Checkout:');
  const before = await money();
  for (const m of ['cash', 'card', 'bank_transfer']) {
    const b = await bill();
    const r = await api.j(`/api/bills/${b.id}/pay`, { method: 'POST', body: { method: m } });
    ok(`pay £70 by ${m}`, r.s === 200, r.b);
  }
  const s = await bill();
  let r = await api.j(`/api/bills/${s.id}/pay`, { method: 'POST', body: { method: 'split', split_payments: [{ method: 'cash', amount: 30 }, { method: 'card', amount: 40 }] } });
  ok('split £30 cash + £40 card', r.s === 200, r.b);
  const bad = await bill();
  r = await api.j(`/api/bills/${bad.id}/pay`, { method: 'POST', body: { method: 'cheque' } });
  ok('unknown payment method refused', r.s >= 400 && r.s < 500, r.b);

  const after = await money();
  const diff = (k) => Math.round(((after[k] || 0) - (before[k] || 0)) * 100) / 100;
  ok('Trading: cash +£100 (70 + 30 split)', diff('cash') === 100, { before, after });
  ok('Trading: card +£110 (70 + 40 split)', diff('card') === 110, { before, after });
  ok('Trading: bank transfer +£70', diff('bank_transfer') === 70, { before, after });
  const z = await api.j(`/api/reports/z-report?date=${today}`);
  ok('Z report opens', z.s === 200, z.b);

  console.log('Deposits and vouchers:');
  const da = (await pool.query(
    `INSERT INTO appointments (client_id, treatment_id, therapist_id, starts_at, ends_at, status, source, price_at_booking)
     VALUES ($1, $2, $3, now() + interval '2 hours', now() + interval '3 hours', 'booked', 'phone', 70) RETURNING id`, [c, t, th])).rows[0].id;
  r = await api.j(`/api/appointments/${da}/deposit-manual`, { method: 'POST', body: { amount: 20, method: 'cash' } });
  ok('take a £20 cash deposit', r.s === 200, r.b);
  r = await api.j('/api/vouchers', { method: 'POST', body: { value: 40, purchased_by: 'Buyer', purchased_for: 'Friend', payment_method: 'card' } });
  ok('sell a £40 gift voucher by card', r.s === 200 || r.s === 201, r.b);

  api.close();
  h.done();
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
