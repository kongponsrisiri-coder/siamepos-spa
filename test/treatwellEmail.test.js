// SPA-TREATWELL-001 — parser tests against the REAL forwarded Treatwell emails
// (Highbury Thai Massage samples, 24 Jun 2026). Standalone — no test framework:
//   node test/treatwellEmail.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { parseTreatwellEmail } = require('../src/services/treatwellEmail');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); }
}
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

// ── NEW BOOKING ────────────────────────────────────────────────────────────
console.log('NEW booking (T2185537204 — Babette Stephens):');
{
  const r = parseTreatwellEmail({ subject: "Fwd: You've got a new Treatwell booking (Our Ref. T2185537204)", text: fixture('treatwell-new.txt') });
  eq('ok', r.ok, true);
  eq('action', r.action, 'create');
  eq('ref', r.ref, 'T2185537204');
  eq('name', r.name, 'Babette Stephens');                       // "New" badge stripped
  eq('email', r.email, 'stephensbabette@yahoo.co.uk');          // Guest Email, NOT venue Email
  eq('phone', r.phone, '+447889021321');                        // Guest Tel, normalised
  eq('treatment', r.treatment, 'Aromatherapy Massage');
  eq('durationMin', r.durationMin, 90);
  eq('date', r.date, '2026-06-23');
  eq('time', r.time, '16:30');                                  // 4:30 pm → 16:30
  eq('startLocal', r.startLocal, '2026-06-23T16:30:00');
  eq('room', r.room, 'Treatment Room 2');
  eq('price', r.price, 98);
  eq('prepaid', r.prepaid, true);
  eq('confidence', r.confidence, 'high');
  eq('missing', r.missing, []);
}

// ── RESCHEDULE ─────────────────────────────────────────────────────────────
console.log('RESCHEDULE (T2185537204):');
{
  const r = parseTreatwellEmail({ subject: 'Fwd: A booking has been rescheduled', text: fixture('treatwell-reschedule.txt') });
  eq('ok', r.ok, true);
  eq('action', r.action, 'reschedule');
  eq('ref', r.ref, 'T2185537204');
  eq('name', r.name, 'Babette Stephens');
  eq('treatment', r.treatment, 'Aromatherapy Massage');
  eq('startLocal', r.startLocal, '2026-06-23T16:30:00');
  eq('room', r.room, 'Treatment Room 2');
  eq('email (none — fine, client exists)', r.email, null);      // no Guest block on reschedule
  eq('confidence', r.confidence, 'high');
}

// ── CANCELLATION ───────────────────────────────────────────────────────────
console.log('CANCELLATION (T2185130278 — Romilly nolan):');
{
  const r = parseTreatwellEmail({ subject: 'Fwd: Order CANCELLATION', text: fixture('treatwell-cancel.txt') });
  eq('ok', r.ok, true);
  eq('action', r.action, 'cancel');
  eq('ref', r.ref, 'T2185130278');                              // different ref
  eq('name', r.name, 'Romilly nolan');                          // Client Name, trailing space trimmed
  eq('treatment', r.treatment, 'Traditional Thai Massage');
  eq('date (booking, NOT the forward header date)', r.date, '2026-06-20');
  eq('time', r.time, '11:00');
  eq('cancelReason', r.cancelReason, 'Customer changed their mind / Booked by mistake');
}

// ── GUARDS ─────────────────────────────────────────────────────────────────
console.log('Guards:');
{
  const r = parseTreatwellEmail({ subject: 'random', text: 'hello, no booking here' });
  eq('no ref → ok:false', r.ok, false);
  const r2 = parseTreatwellEmail({ subject: 'x', text: 'Order reference: T2185537204 but unknown type' });
  eq('ref but unclassified → ok:false, low confidence', [r2.ok, r2.confidence], [false, 'low']);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
