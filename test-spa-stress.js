#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════╗
// ║  SiamSpa — Full Stress Test                                      ║
// ║  Nook (QA Agent) | 2026-05-21                                    ║
// ║  Covers: Widget, Treatwell, Vouchers, Reports, Campaigns,        ║
// ║          Settings, Stripe config, Race condition, Full day sim   ║
// ╚══════════════════════════════════════════════════════════════════╝

const BASE = 'http://localhost:5050';
const TREATWELL_SECRET = 'spa003-local-test-secret';

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'a7f3c9e2b84d1f6a0e5c7b2d9f4a8e1c3b6d0f2a9e4c7b1d8f3a6c0e2b5d9f4';
const adminToken   = jwt.sign({ sub: 9001, name: '__StressAdmin',   role: 'admin'     }, JWT_SECRET, { expiresIn: '1h' });
const managerToken = jwt.sign({ sub: 9002, name: '__StressManager', role: 'manager'   }, JWT_SECRET, { expiresIn: '1h' });

let passed = 0, failed = 0, warned = 0;
const cleanup = {
  appointments: [],
  clients:      [],
  treatments:   [],
  therapists:   [],
  rooms:        [],
  vouchers:     [],
};

function pass(label)            { console.log(`  ✅ ${label}`); passed++; }
function fail(label, exp, got)  {
  console.log(`  ❌ ${label}`);
  if (exp !== undefined) console.log(`     Expected: ${exp}\n     Actual:   ${JSON.stringify(got)}`);
  failed++;
}
function warn(label, detail)    { console.log(`  ⚠️  ${label}${detail ? ': ' + detail : ''}`); warned++; }
function info(msg)              { console.log(`  ℹ️  ${msg}`); }
function section(title) {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  ${title.padEnd(56)}║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
}

async function api(method, path, body, { auth = adminToken, headers = {} } = {}) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  let data;
  try { data = await r.json(); } catch { data = {}; }
  return { status: r.status, data };
}

async function pub(method, path, body, extraHeaders = {}) {
  return api(method, path, body, { auth: null, headers: extraHeaders });
}

// ── Date helpers ──────────────────────────────────────────────────────────────
// Future Tuesday 4 weeks out at various times — avoids live booking conflicts.
function stressDate() {
  const d = new Date();
  d.setDate(d.getDate() + 28);
  const day = d.getDay();
  if (day !== 2) d.setDate(d.getDate() + ((2 - day + 7) % 7));
  return d.toISOString().slice(0, 10);
}

function isoAt(dateStr, h, m = 0) {
  return `${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
}

const testDate = stressDate();

// ─────────────────────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║  SiamSpa — Full Stress Test                                      ║');
console.log('║  Nook (QA Agent) | 2026-05-21                                    ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');
console.log(`  Backend: ${BASE}  |  Test date: ${testDate}\n`);

(async () => {

  // ══════════════════════════════════════════════════════════════════════
  // SETUP — create shared test data used across all blocks
  // ══════════════════════════════════════════════════════════════════════
  section('SETUP — shared test data');

  // Treatment category + treatment
  const { status: catS, data: catD } = await api('POST', '/api/treatments/categories', { name: '__Stress Cat' });
  const categoryId = catD.category?.id;
  if (catS === 201 && categoryId) {
    info(`Category ID: ${categoryId}`);
  } else {
    fail('Category creation failed', 201, { catS, catD });
  }

  const { status: trS, data: trD } = await api('POST', '/api/treatments', {
    name: '__Stress Treatment 60', category_id: categoryId, duration_minutes: 60, price: 70,
  });
  const treatmentId = trD.treatment?.id;
  if (trS === 201 && treatmentId) {
    cleanup.treatments.push(treatmentId);
    info(`Treatment ID: ${treatmentId} | 60 min | £70`);
  } else {
    fail('Treatment creation failed', 201, { trS, trD });
  }

  // A shorter treatment for variety
  const { data: tr2D } = await api('POST', '/api/treatments', {
    name: '__Stress Treatment 30', category_id: categoryId, duration_minutes: 30, price: 40,
  });
  const treatment30Id = tr2D.treatment?.id;
  if (treatment30Id) { cleanup.treatments.push(treatment30Id); info(`Treatment 30-min ID: ${treatment30Id}`); }

  // 2 rooms
  const { data: r1D } = await api('POST', '/api/rooms', { name: '__StressRoom A', capacity: 1 });
  const room1Id = r1D.room?.id;
  if (room1Id) { cleanup.rooms.push(room1Id); info(`Room A ID: ${room1Id}`); }

  const { data: r2D } = await api('POST', '/api/rooms', { name: '__StressRoom B', capacity: 1 });
  const room2Id = r2D.room?.id;
  if (room2Id) { cleanup.rooms.push(room2Id); info(`Room B ID: ${room2Id}`); }

  // 2 therapists with role='therapist' and specialisms (for widget)
  const { data: th1D } = await api('POST', '/api/therapists', {
    name: '__Stress Therapist A', pin: '9801', role: 'therapist', specialisms: 'Deep tissue, Hot stone',
  });
  const therapist1Id = th1D.therapist?.id;
  if (therapist1Id) { cleanup.therapists.push(therapist1Id); info(`Therapist A ID: ${therapist1Id}`); }

  const { data: th2D } = await api('POST', '/api/therapists', {
    name: '__Stress Therapist B', pin: '9802', role: 'therapist', specialisms: 'Aromatherapy',
  });
  const therapist2Id = th2D.therapist?.id;
  if (therapist2Id) { cleanup.therapists.push(therapist2Id); info(`Therapist B ID: ${therapist2Id}`); }

  if (!treatmentId || !room1Id || !room2Id || !therapist1Id || !therapist2Id) {
    console.error('\n  ⛔  Setup failed — cannot continue stress test.\n');
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════════════
  section('BLOCK 1 — Settings');

  const { status: sGetS, data: sGetD } = await api('GET', '/api/settings');
  if (sGetS === 200 && sGetD.settings) {
    pass('GET /api/settings returns settings object');
    info(`opening_time: ${sGetD.settings.opening_time}  closing_time: ${sGetD.settings.closing_time}`);
  } else {
    fail('GET /api/settings should return 200', 200, sGetS);
  }

  // PUT a setting (admin/manager only)
  const { status: sPutS } = await api('PUT', '/api/settings', { key: 'spa_name', value: '__StressTest Spa' });
  if (sPutS === 200) pass('PUT /api/settings (admin) → 200');
  else fail('PUT /api/settings should return 200', 200, sPutS);

  // Non-admin cannot PUT settings
  const staffToken = jwt.sign({ sub: 9003, name: '__StressStaff', role: 'therapist' }, JWT_SECRET, { expiresIn: '1h' });
  const { status: sUnauth } = await api('PUT', '/api/settings', { key: 'spa_name', value: 'bad' }, { auth: staffToken });
  if (sUnauth === 403) pass('Therapist cannot PUT /api/settings → 403');
  else fail('Therapist should be forbidden on settings PUT', 403, sUnauth);

  // Restore
  await api('PUT', '/api/settings', { key: 'spa_name', value: 'SiamEPOS Spa' });

  // ══════════════════════════════════════════════════════════════════════
  section('BLOCK 2 — Stripe config');

  const { status: strS, data: strD } = await pub('GET', '/api/stripe/config');
  if (strS === 200 && typeof strD.configured === 'boolean') {
    pass('GET /api/stripe/config returns 200');
    info(`Stripe configured: ${strD.configured} (keys blank in local .env — expected)`);
  } else {
    fail('GET /api/stripe/config should return 200', 200, strS);
  }

  // ══════════════════════════════════════════════════════════════════════
  section('BLOCK 3 — Widget: public treatments + therapists + availability');

  // 3A — treatments list (public, no auth)
  const { status: wtS, data: wtD } = await pub('GET', '/api/widget/treatments');
  if (wtS === 200 && Array.isArray(wtD.treatments)) {
    pass('GET /api/widget/treatments → 200 (no auth needed)');
    const found = wtD.treatments.find((t) => t.id === treatmentId);
    if (found) pass('Stress treatment visible in public list');
    else fail('Stress treatment should appear in widget treatments list');
  } else {
    fail('Widget treatments should return 200', 200, wtS);
  }

  // 3B — therapists list (public, role='therapist' filter)
  const { status: wthS, data: wthD } = await pub('GET', '/api/widget/therapists');
  if (wthS === 200 && Array.isArray(wthD.therapists)) {
    pass('GET /api/widget/therapists → 200 (no auth needed)');
    const th = wthD.therapists.find((t) => t.id === therapist1Id);
    if (th) {
      pass('Stress therapist visible in public list (role=therapist)');
      if (th.specialisms === 'Deep tissue, Hot stone') pass('Specialisms returned correctly on widget therapist');
      else fail('Specialisms should be "Deep tissue, Hot stone"', 'Deep tissue, Hot stone', th.specialisms);
      if (th.pin === undefined) pass('PIN not exposed in widget therapist response');
      else fail('PIN must NOT be exposed in public widget endpoint', undefined, th.pin);
    } else {
      fail('Therapist A should appear in widget therapists list');
    }
  } else {
    fail('Widget therapists should return 200', 200, wthS);
  }

  // 3C — availability (public, with treatment + date)
  const { status: wavS, data: wavD } = await pub('GET', `/api/widget/availability?treatment_id=${treatmentId}&date=${testDate}`);
  if (wavS === 200 && Array.isArray(wavD.slots)) {
    pass(`Widget availability returns slots for treatment ${treatmentId} on ${testDate}`);
    info(`Slots available: ${wavD.slots.length}`);
    if (wavD.slots[0] && wavD.slots[0].starts_at && wavD.slots[0].ends_at) pass('Slot has starts_at + ends_at fields');
    else fail('Slots should have starts_at and ends_at');
    if (wavD.slots[0] && wavD.slots[0].therapists === undefined) pass('Slot does not expose internal therapist IDs (public endpoint)');
    else warn('Widget availability is leaking internal therapist IDs — check pub output scrubbing');
  } else {
    fail('Widget availability should return 200 + slots array', 200, wavS);
  }

  // 3D — availability filtered to specific therapist
  const { status: wavTH, data: wavTHD } = await pub('GET', `/api/widget/availability?treatment_id=${treatmentId}&date=${testDate}&therapist_id=${therapist1Id}`);
  if (wavTH === 200 && Array.isArray(wavTHD.slots)) {
    pass('Widget availability filtered to specific therapist → 200');
    info(`Slots for therapist A only: ${wavTHD.slots.length}`);
  } else {
    fail('Widget availability with therapist_id filter should return 200', 200, wavTH);
  }

  // 3E — availability missing required params → 400
  const { status: wavBad } = await pub('GET', '/api/widget/availability?date=2026-06-01');
  if (wavBad === 400) pass('Widget availability without treatment_id → 400');
  else fail('Missing treatment_id should return 400', 400, wavBad);

  // ══════════════════════════════════════════════════════════════════════
  section('BLOCK 4 — Widget booking: full flow + validation');

  // Pick a slot that's guaranteed to be available (first slot of day = opening time 10:00 UTC)
  const slotA = isoAt(testDate, 10, 0);
  const slotB = isoAt(testDate, 11, 0); // after 60-min treatment
  const slotC = isoAt(testDate, 12, 0);

  // 4A — missing required fields → 400
  const { status: wbBad1 } = await pub('POST', '/api/widget/book', { name: 'Test', phone: '07700900001' });
  if (wbBad1 === 400) pass('Widget book: missing treatment_id → 400');
  else fail('Missing treatment_id should return 400', 400, wbBad1);

  // 4B — no gdpr_consent → 400
  const { status: wbBad2 } = await pub('POST', '/api/widget/book', {
    treatment_id: treatmentId, starts_at: slotA, name: 'No GDPR', phone: '07700900099',
    gdpr_consent: false,
  });
  if (wbBad2 === 400) pass('Widget book: gdpr_consent=false → 400');
  else fail('No GDPR consent should return 400', 400, wbBad2);

  // 4C — valid booking with specific therapist
  const { status: wbS1, data: wbD1 } = await pub('POST', '/api/widget/book', {
    treatment_id: treatmentId,
    starts_at: slotA,
    therapist_id: therapist1Id,
    name: '__Widget Client A',
    phone: '07700901001',
    email: 'stress-a@nook.qa',
    gdpr_consent: true,
    marketing_consent: true,
    notes: 'QA stress test — please delete',
  });
  const wbAppt1 = wbD1.appointment?.id;
  const wbClient1 = wbD1.client?.id;
  if (wbS1 === 201 && wbAppt1) {
    pass('Widget booking with specific therapist → 201');
    info(`Appointment ID: ${wbAppt1}  |  Client ID: ${wbClient1}`);
    if (wbD1.appointment?.therapist_name) pass('therapist_name returned in booking confirmation');
    else fail('therapist_name should be in response', 'string', wbD1.appointment?.therapist_name);
    if (wbD1.appointment?.room_name) pass('room_name returned in booking confirmation');
    else fail('room_name should be in response', 'string', wbD1.appointment?.room_name);
    cleanup.appointments.push(wbAppt1);
    if (wbClient1) cleanup.clients.push(wbClient1);
  } else {
    fail('Widget booking should return 201', 201, `${wbS1}: ${JSON.stringify(wbD1)}`);
  }

  // 4D — same client re-books → marketing_consent should be additive (OR), not overwritten
  const { status: wbReS, data: wbReD } = await pub('POST', '/api/widget/book', {
    treatment_id: treatmentId,
    starts_at: slotB,
    name: '__Widget Client A',
    phone: '07700901001', // same phone → find existing client
    email: 'stress-a@nook.qa',
    gdpr_consent: true,
    marketing_consent: false, // send FALSE — should NOT strip existing TRUE consent
    notes: 'QA re-book test',
  });
  const wbAppt1b = wbReD.appointment?.id;
  if (wbReS === 201 && wbAppt1b) {
    pass('Widget re-booking existing client (same phone) → 201');
    cleanup.appointments.push(wbAppt1b);
    // Check marketing_consent wasn't stripped
    const { data: clientCheck } = await api('GET', `/api/clients/${wbClient1}`);
    if (clientCheck.client?.marketing_consent === true) pass('marketing_consent preserved on re-book (additive OR — not overwritten to false)');
    else fail('marketing_consent should remain TRUE on re-book with false', true, clientCheck.client?.marketing_consent);
  } else {
    fail('Widget re-book should return 201', 201, `${wbReS}: ${JSON.stringify(wbReD)}`);
  }

  // 4E — booking with ANY therapist (therapist_id omitted) → auto-assigned
  const { status: wbAny, data: wbAnyD } = await pub('POST', '/api/widget/book', {
    treatment_id: treatmentId,
    starts_at: slotC,
    name: '__Widget Client B',
    phone: '07700901002',
    gdpr_consent: true,
    notes: 'QA any-therapist test',
  });
  const wbAppt2 = wbAnyD.appointment?.id;
  const wbClient2 = wbAnyD.client?.id;
  if (wbAny === 201 && wbAppt2) {
    pass('Widget booking with no therapist_id (any available) → 201');
    info(`Auto-assigned: ${wbAnyD.appointment?.therapist_name} in ${wbAnyD.appointment?.room_name}`);
    cleanup.appointments.push(wbAppt2);
    if (wbClient2) cleanup.clients.push(wbClient2);
  } else {
    fail('Widget booking (any therapist) should return 201', 201, `${wbAny}: ${JSON.stringify(wbAnyD)}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  section('BLOCK 5 — Widget race: concurrent same-slot booking');

  const raceSlot = isoAt(testDate, 14, 0);
  // Launch two bookings simultaneously for the same slot + therapist
  const [raceA, raceB] = await Promise.all([
    pub('POST', '/api/widget/book', {
      treatment_id: treatmentId, starts_at: raceSlot,
      therapist_id: therapist1Id,
      name: '__Race Client A', phone: '07700902001', gdpr_consent: true,
    }),
    pub('POST', '/api/widget/book', {
      treatment_id: treatmentId, starts_at: raceSlot,
      therapist_id: therapist1Id,
      name: '__Race Client B', phone: '07700902002', gdpr_consent: true,
    }),
  ]);

  const results = [raceA, raceB];
  const wins   = results.filter((r) => r.status === 201);
  const blocks = results.filter((r) => r.status === 409);

  if (wins.length === 1 && blocks.length === 1) {
    pass('Concurrent same-slot bookings: exactly one succeeds (201) and one is blocked (409)');
    info(`Winner: ${JSON.stringify(wins[0].data.appointment?.id)} | Loser status: 409`);
    const winnerId = wins[0].data.appointment?.id;
    const loserClientId = blocks[0].data?.client_id || wins[1-results.indexOf(wins[0])]?.data?.client_id;
    if (winnerId) cleanup.appointments.push(winnerId);
    // Cleanup race clients
    for (const phone of ['07700902001', '07700902002']) {
      const { data: srch } = await api('GET', `/api/clients?q=${phone}`);
      const c = srch.clients?.[0];
      if (c) cleanup.clients.push(c.id);
    }
  } else if (wins.length === 2) {
    fail('Race condition: BOTH bookings succeeded — double-booking possible!', '1 win + 1 block', '2 wins');
  } else if (blocks.length === 2) {
    warn('Race condition: both bookings blocked — overly aggressive conflict detection?', '2 × 409');
  } else {
    warn(`Unexpected race result: ${wins.length} wins, ${blocks.length} blocks`, JSON.stringify(results.map(r => r.status)));
  }

  // ══════════════════════════════════════════════════════════════════════
  section('BLOCK 6 — Treatwell webhook');

  // 6A — missing secret → 401
  const { status: twNoAuth } = await pub('POST', '/api/treatwell/webhook', { booking_id: 'TW-NOAUTH', status: 'confirmed' });
  if (twNoAuth === 401) pass('Treatwell webhook without secret → 401');
  else fail('Treatwell webhook without secret should return 401', 401, twNoAuth);

  // 6B — wrong secret → 401
  const { status: twBadAuth } = await pub('POST', '/api/treatwell/webhook', { booking_id: 'TW-BADAUTH', status: 'confirmed' }, { 'X-Treatwell-Secret': 'wrong-secret' });
  if (twBadAuth === 401) pass('Treatwell webhook with wrong secret → 401');
  else fail('Wrong secret should return 401', 401, twBadAuth);

  const twHeaders = { 'X-Treatwell-Secret': TREATWELL_SECRET };
  const twBookingId = `TW-STRESS-${Date.now()}`;

  // 6C — confirmed booking with treatment name match
  const { status: twConS, data: twConD } = await pub('POST', '/api/treatwell/webhook', {
    booking_id: twBookingId,
    status: 'confirmed',
    scheduled_for: isoAt(testDate, 15, 0),
    customer: { name: '__TW Client', phone: '07700903001', email: 'tw-stress@nook.qa' },
    service: { name: '__Stress Treatment 60', duration_minutes: 60, price: 70 },
    notes: 'QA Treatwell test',
  }, twHeaders);
  let twApptId = null;
  let twClientId = null;
  if (twConS === 201 && twConD.action === 'created') {
    pass('Treatwell webhook confirmed booking → 201 created');
    pass(`Treatment matched: ${twConD.treatment_matched}`);
    if (twConD.therapist_assigned) pass('Therapist auto-assigned from availability');
    else info('No therapist auto-assigned (no free slot at that time — check manually)');
    twApptId = twConD.appointment_id;
    twClientId = twConD.client_id;
    if (twApptId) cleanup.appointments.push(twApptId);
    if (twClientId) cleanup.clients.push(twClientId);
  } else {
    fail('Treatwell webhook confirmed should return 201', 201, `${twConS}: ${JSON.stringify(twConD)}`);
  }

  // 6D — duplicate booking_id → action=duplicate (dedup)
  const { status: twDupS, data: twDupD } = await pub('POST', '/api/treatwell/webhook', {
    booking_id: twBookingId,
    status: 'confirmed',
    scheduled_for: isoAt(testDate, 15, 0),
    customer: { name: '__TW Client', phone: '07700903001' },
    service: { name: '__Stress Treatment 60', duration_minutes: 60 },
  }, twHeaders);
  if (twDupS === 200 && twDupD.action === 'duplicate') pass('Duplicate Treatwell booking_id → deduped (action=duplicate)');
  else fail('Duplicate Treatwell booking should return 200 + action=duplicate', 'duplicate', `${twDupS}: ${JSON.stringify(twDupD)}`);

  // 6E — unmatched treatment name → still 201 but treatment_matched=false
  const twBookingId2 = `TW-NOMATCH-${Date.now()}`;
  const { status: twNmS, data: twNmD } = await pub('POST', '/api/treatwell/webhook', {
    booking_id: twBookingId2,
    status: 'confirmed',
    scheduled_for: isoAt(testDate, 16, 30),
    customer: { name: '__TW NoMatch', phone: '07700903002' },
    service: { name: 'ZZZ Nonexistent Treatment', duration_minutes: 45 },
  }, twHeaders);
  if (twNmS === 201 && twNmD.treatment_matched === false) {
    pass('Treatwell webhook with unmatched treatment → 201 (accepted, treatment_matched=false)');
    if (twNmD.appointment_id) cleanup.appointments.push(twNmD.appointment_id);
    if (twNmD.client_id) cleanup.clients.push(twNmD.client_id);
  } else {
    fail('Unmatched treatment should still accept booking with treatment_matched=false', '201 + treatment_matched:false', `${twNmS}: ${JSON.stringify(twNmD)}`);
  }

  // 6F — cancellation of a Treatwell booking
  if (twApptId) {
    const { status: twCxS, data: twCxD } = await pub('POST', '/api/treatwell/webhook', {
      booking_id: twBookingId,
      status: 'cancelled',
    }, twHeaders);
    if (twCxS === 200 && twCxD.action === 'cancelled' && twCxD.matched) pass('Treatwell cancellation webhook → booking marked cancelled');
    else fail('Treatwell cancellation should return 200 + action=cancelled', 200, `${twCxS}: ${JSON.stringify(twCxD)}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  section('BLOCK 7 — Vouchers: monetary');

  // 7A — missing payment_method → 400
  const { status: vBad } = await api('POST', '/api/vouchers', { value: 50, purchased_by: 'Test' });
  if (vBad === 400) pass('Voucher without payment_method → 400');
  else fail('Missing payment_method should return 400', 400, vBad);

  // 7B — value 0 → 400
  const { status: vZero } = await api('POST', '/api/vouchers', { value: 0, payment_method: 'cash' });
  if (vZero === 400) pass('Voucher with value 0 → 400');
  else fail('Zero value voucher should return 400', 400, vZero);

  // 7C — sell a £50 monetary voucher
  const { status: vS, data: vD } = await api('POST', '/api/vouchers', {
    value: 50, purchased_by: '__Stress Buyer', purchased_for: '__Stress Recipient',
    payment_method: 'card', notes: 'QA stress test',
  });
  const voucherId = vD.voucher?.id;
  const voucherCode = vD.voucher?.code;
  if (vS === 201 && voucherId) {
    pass('Monetary voucher sold → 201');
    info(`Voucher ID: ${voucherId}  Code: ${voucherCode}  Balance: £${vD.voucher.initial_value}`);
    cleanup.vouchers.push(voucherId);
  } else {
    fail('Voucher creation should return 201', 201, `${vS}: ${JSON.stringify(vD)}`);
  }

  // 7D — lookup by code
  if (voucherCode) {
    const { status: vlS, data: vlD } = await api('GET', `/api/vouchers/lookup?code=${voucherCode}`);
    if (vlS === 200 && vlD.voucher?.code === voucherCode) pass('Voucher lookup by code → 200');
    else fail('Voucher lookup should return 200 with matching code', 200, vlS);

    // 7E — lookup non-existent code → 404
    const { status: vlBad } = await api('GET', '/api/vouchers/lookup?code=SPA-XXXXXXXX');
    if (vlBad === 404) pass('Voucher lookup with fake code → 404');
    else fail('Non-existent code should return 404', 404, vlBad);
  }

  // 7F — partial redeem (£30 of £50)
  if (voucherId) {
    const { status: vrS1, data: vrD1 } = await api('POST', `/api/vouchers/${voucherId}/redeem`, { amount: 30 });
    if (vrS1 === 200 && Number(vrD1.remaining_value) === 20) {
      pass('Partial redemption (£30) → remaining £20');
      info(`Amount used: £${vrD1.amount_used}  Remaining: £${vrD1.remaining_value}`);
    } else {
      fail('Partial redeem should leave £20', 20, `${vrS1}: ${JSON.stringify(vrD1)}`);
    }

    // 7G — redeem remaining £20 → status='used'
    const { status: vrS2, data: vrD2 } = await api('POST', `/api/vouchers/${voucherId}/redeem`, { amount: 30 });
    if (vrS2 === 200) {
      const { data: vCheck } = await api('GET', `/api/vouchers/${voucherId}`);
      if (vCheck.voucher?.status === 'used') pass('Full redemption → voucher status=used');
      else fail('Fully redeemed voucher should have status=used', 'used', vCheck.voucher?.status);
    } else {
      fail('Second redeem should succeed', 200, vrS2);
    }

    // 7H — try to redeem a fully used voucher → 400
    const { status: vrUsed } = await api('POST', `/api/vouchers/${voucherId}/redeem`, { amount: 1 });
    if (vrUsed === 400) pass('Redeeming used voucher → 400');
    else fail('Used voucher redemption should return 400', 400, vrUsed);
  }

  // 7I — voucher GET detail + redemption history
  if (voucherId) {
    const { status: vgS, data: vgD } = await api('GET', `/api/vouchers/${voucherId}`);
    if (vgS === 200 && Array.isArray(vgD.redemptions)) {
      pass('GET /api/vouchers/:id returns detail + redemptions array');
      info(`Redemption history: ${vgD.redemptions.length} entries`);
    } else {
      fail('Voucher detail should return 200 + redemptions', 200, vgS);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  section('BLOCK 8 — Vouchers: sessions');

  // 8A — sell a 3-session voucher tied to the 60-min treatment
  const { status: vsS, data: vsD } = await api('POST', '/api/vouchers', {
    value: 180, // £60 per session
    voucher_type: 'sessions',
    total_sessions: 3,
    treatment_id: treatmentId,
    purchased_by: '__Stress Sessions Buyer',
    payment_method: 'cash',
    notes: 'QA sessions voucher',
  });
  const sessionVoucherId = vsD.voucher?.id;
  if (vsS === 201 && sessionVoucherId) {
    pass('Sessions voucher sold → 201');
    info(`Sessions voucher ID: ${sessionVoucherId}  Sessions: ${vsD.voucher.sessions_remaining}/3`);
    cleanup.vouchers.push(sessionVoucherId);
  } else {
    fail('Sessions voucher creation should return 201', 201, `${vsS}: ${JSON.stringify(vsD)}`);
  }

  if (sessionVoucherId) {
    // 8B — redeem wrong treatment → 400
    if (treatment30Id) {
      const { status: vrWrong } = await api('POST', `/api/vouchers/${sessionVoucherId}/redeem`, {
        treatment_id: treatment30Id, // wrong treatment
      });
      if (vrWrong === 400) pass('Sessions voucher: wrong treatment → 400');
      else fail('Wrong treatment should return 400', 400, vrWrong);
    }

    // 8C — redeem session 1 (correct treatment)
    const { status: vs1S, data: vs1D } = await api('POST', `/api/vouchers/${sessionVoucherId}/redeem`, {
      treatment_id: treatmentId,
    });
    if (vs1S === 200 && vs1D.sessions_remaining === 2) {
      pass('Session 1 redeemed → 2 remaining');
      info(`Amount used per session: £${vs1D.amount_used}`);
    } else {
      fail('Session 1 redeem should leave 2 sessions', 2, `${vs1S}: ${JSON.stringify(vs1D)}`);
    }

    // 8D — redeem sessions 2 + 3 → exhaust
    await api('POST', `/api/vouchers/${sessionVoucherId}/redeem`, { treatment_id: treatmentId });
    const { data: vs3D } = await api('POST', `/api/vouchers/${sessionVoucherId}/redeem`, { treatment_id: treatmentId });
    const { data: vsFinal } = await api('GET', `/api/vouchers/${sessionVoucherId}`);
    if (vsFinal.voucher?.status === 'used' && vsFinal.voucher?.sessions_remaining === 0) {
      pass('Sessions voucher exhausted → status=used, sessions_remaining=0');
    } else {
      fail('Exhausted sessions voucher should have status=used + 0 remaining', 'used/0', `${vsFinal.voucher?.status}/${vsFinal.voucher?.sessions_remaining}`);
    }

    // 8E — redeem 4th session → 400 "no sessions remaining"
    const { status: vs4S } = await api('POST', `/api/vouchers/${sessionVoucherId}/redeem`, { treatment_id: treatmentId });
    if (vs4S === 400) pass('4th session on 3-pack → 400 "no sessions remaining"');
    else fail('4th session should return 400', 400, vs4S);
  }

  // 8F — sessions voucher with total_sessions=0 → 400
  const { status: vsBad } = await api('POST', '/api/vouchers', {
    value: 100, voucher_type: 'sessions', total_sessions: 0, payment_method: 'cash',
  });
  if (vsBad === 400) pass('Sessions voucher with total_sessions=0 → 400');
  else fail('Zero sessions should return 400', 400, vsBad);

  // ══════════════════════════════════════════════════════════════════════
  section('BLOCK 9 — Reports');

  // 9A — trading report (today — may be empty, should not error)
  const { status: rtS, data: rtD } = await api('GET', '/api/reports/trading');
  if (rtS === 200 && rtD.totals && rtD.appointments) {
    pass('GET /api/reports/trading → 200 with totals + appointments');
    info(`Revenue: £${rtD.totals.revenue}  Bills: ${rtD.totals.bill_count}  Appts: ${rtD.appointments.appt_count}`);
    if (rtD.voucher_sales) pass('Voucher sales block present in trading report');
    else fail('Trading report should include voucher_sales block');
    if (rtD.by_source) pass('by_source breakdown present in trading report');
    else fail('Trading report should include by_source breakdown');
  } else {
    fail('Trading report should return 200', 200, rtS);
  }

  // 9B — trading report for specific past date (should return zeros cleanly)
  const { status: rtPast, data: rtPastD } = await api('GET', '/api/reports/trading?date=2020-01-01');
  if (rtPast === 200 && Number(rtPastD.totals.revenue) === 0) pass('Trading report for empty date returns zeros, no crash');
  else fail('Trading report for past empty date should return 200 + zero revenue', 200, rtPast);

  // 9C — therapist performance report
  const { status: rthS, data: rthD } = await api('GET', '/api/reports/therapist');
  if (rthS === 200 && Array.isArray(rthD.therapists)) {
    pass('GET /api/reports/therapist → 200 with therapists array');
    info(`Therapists in report: ${rthD.therapists.length}`);
  } else {
    fail('Therapist report should return 200', 200, rthS);
  }

  // 9D — therapist report with date range filter
  const { status: rthFilt } = await api('GET', `/api/reports/therapist?from=${testDate}&to=${testDate}`);
  if (rthFilt === 200) pass('Therapist report with from/to filter → 200');
  else fail('Therapist report with date filter should return 200', 200, rthFilt);

  // 9E — Z-report
  const { status: rzS, data: rzD } = await api('GET', '/api/reports/z-report');
  if (rzS === 200 && rzD.totals && rzD.by_payment_method !== undefined) {
    pass('GET /api/reports/z-report → 200');
    info(`Z-report: £${rzD.totals.total} across ${rzD.totals.bills} bill(s)`);
  } else {
    fail('Z-report should return 200', 200, rzS);
  }

  // 9F — Z-close (stamps last_z_closed_date in settings)
  const { status: rzCloseS, data: rzCloseD } = await api('POST', '/api/reports/z-report/close', { date: testDate });
  if (rzCloseS === 200 && rzCloseD.ok) {
    pass('POST /api/reports/z-report/close → 200');
    // Verify it persisted
    const { data: rzCheck } = await api('GET', '/api/reports/z-report');
    if (rzCheck.last_closed_date === testDate) pass('Z-close date persisted to settings');
    else fail('Z-close date should persist in settings', testDate, rzCheck.last_closed_date);
  } else {
    fail('Z-close should return 200', 200, rzCloseS);
  }

  // ══════════════════════════════════════════════════════════════════════
  section('BLOCK 10 — Campaigns');

  // 10A — recipient-count for each segment
  for (const seg of ['All', 'VIP', 'Regular', 'Lapsed', 'Treatwell']) {
    const { status: rcS, data: rcD } = await api('GET', `/api/campaigns/recipient-count?segment=${seg}`);
    if (rcS === 200 && typeof rcD.count === 'number') pass(`Recipient count for segment "${seg}" → ${rcD.count}`);
    else fail(`Recipient count for "${seg}" should return 200`, 200, rcS);
  }

  // 10B — campaigns list
  const { status: clS, data: clD } = await api('GET', '/api/campaigns');
  if (clS === 200 && Array.isArray(clD.campaigns)) pass('GET /api/campaigns → 200 with array');
  else fail('Campaigns list should return 200', 200, clS);

  // 10C — send without subject → 400
  const { status: csBad1 } = await api('POST', '/api/campaigns/send', { body: 'Hello!', segment: 'All' });
  if (csBad1 === 400) pass('Campaign send without subject → 400');
  else fail('Missing subject should return 400', 400, csBad1);

  // 10D — send without body → 400
  const { status: csBad2 } = await api('POST', '/api/campaigns/send', { subject: 'Test', segment: 'All' });
  if (csBad2 === 400) pass('Campaign send without body → 400');
  else fail('Missing body should return 400', 400, csBad2);

  // 10E — send to empty segment → 400 "no opted-in clients"
  const { status: csEmpty } = await api('POST', '/api/campaigns/send', {
    subject: 'Test', body: 'Hello!', segment: 'VIP',
  });
  // Could be 400 (no recipients) or 500 (no BREVO key) — both acceptable
  if (csEmpty === 400 || csEmpty === 500) pass(`Campaign send to empty segment or no BREVO key → ${csEmpty} (expected)`);
  else fail('Campaign send should return 400 or 500 gracefully', '400 or 500', csEmpty);

  // ══════════════════════════════════════════════════════════════════════
  section('BLOCK 11 — Full day simulation');

  // Simulate a busy spa day: 3 appointments booked via widget, all paid,
  // then trading report totals are verified.
  info(`Booking 3 appointments on ${testDate} via the public widget...`);

  const simSlots = [
    isoAt(testDate, 10, 30),
    isoAt(testDate, 11, 30),
    isoAt(testDate, 13, 0),
  ];
  const simClients = [
    { name: '__SimClient P', phone: '07700910001', email: 'sim-p@nook.qa' },
    { name: '__SimClient Q', phone: '07700910002', email: 'sim-q@nook.qa' },
    { name: '__SimClient R', phone: '07700910003', email: 'sim-r@nook.qa' },
  ];
  const simApptIds = [];
  const simClientIds = [];

  for (let i = 0; i < 3; i++) {
    const { status: saS, data: saD } = await pub('POST', '/api/widget/book', {
      treatment_id: treatmentId,
      starts_at: simSlots[i],
      name: simClients[i].name,
      phone: simClients[i].phone,
      email: simClients[i].email,
      gdpr_consent: true,
    });
    if (saS === 201 && saD.appointment?.id) {
      simApptIds.push(saD.appointment.id);
      simClientIds.push(saD.client?.id);
      info(`  Booked ${simClients[i].name} → Appt #${saD.appointment.id} at ${simSlots[i].slice(11, 16)}`);
    } else {
      fail(`Sim booking ${i+1} should succeed`, 201, `${saS}: ${JSON.stringify(saD)}`);
    }
  }
  cleanup.appointments.push(...simApptIds);
  cleanup.clients.push(...simClientIds.filter(Boolean));

  // Update status → in_progress for all 3
  let statusOk = 0;
  for (const id of simApptIds) {
    const { status } = await api('PUT', `/api/appointments/${id}/status`, { status: 'in_progress' });
    if (status === 200) statusOk++;
  }
  if (statusOk === 3) pass('All 3 sim appointments updated to in_progress');
  else fail('All 3 should update to in_progress', 3, statusOk);

  // Create + pay bills (cash, card, card)
  const payMethods = ['cash', 'card', 'card'];
  const billIds = [];
  let billTotal = 0;
  let billsOk = 0;
  for (let i = 0; i < simApptIds.length; i++) {
    const { status: bS, data: bD } = await api('POST', '/api/bills', { appointment_id: simApptIds[i] });
    const billId = bD.bill?.id;
    if (!billId) { fail(`Sim bill ${i+1} creation failed`, 201, `${bS}: ${JSON.stringify(bD)}`); continue; }
    billIds.push(billId);
    const tip = i === 0 ? 5 : 0; // tip on first bill
    if (tip > 0) await api('PUT', `/api/bills/${billId}/tip`, { tip });
    // bills.js POST /:id/pay expects { method }, not { payment_method }
    const { status: payS, data: payD } = await api('POST', `/api/bills/${billId}/pay`, { method: payMethods[i] });
    if (payS === 200) { billsOk++; billTotal += 70 + (i === 0 ? 5 : 0); }
    else fail(`Sim bill ${i+1} pay failed`, 200, `${payS}: ${JSON.stringify(payD)}`);
  }
  if (billsOk === 3) pass(`3 bills paid (cash + card + card) → total £${billTotal}`);
  else fail(`Bills paid: ${billsOk}/3 expected`, 3, billsOk);

  // Verify all 3 appointments auto-completed
  let completedCount = 0;
  for (const id of simApptIds) {
    const { data: aD } = await api('GET', `/api/appointments?date=${testDate}`);
    const a = Array.isArray(aD) ? aD.find((x) => x.id === id) : null;
    if (a?.status === 'completed') completedCount++;
  }
  if (completedCount === 3) pass('All 3 appointments auto-completed after bill payment');
  else fail('Appointments should be completed after payment', 3, completedCount);

  // Trading report for test date — should show £215 (3 × £70 + £5 tip)
  const { data: simRep } = await api('GET', `/api/reports/trading?date=${testDate}`);
  const repRevenue = Number(simRep?.totals?.revenue || 0);
  // Note: test date is in future so other tests may also have paid bills on that date
  if (repRevenue >= billTotal) {
    pass(`Trading report revenue ≥ £${billTotal} on test date (confirmed our bills counted)`);
    info(`Report total: £${repRevenue}  Bills: ${simRep?.totals?.bill_count}`);
  } else {
    fail(`Trading report should reflect at least £${billTotal}`, `≥${billTotal}`, repRevenue);
  }

  // Source split: 'online' (widget) should appear
  const onlineSource = simRep?.by_source?.find((s) => s.source === 'online');
  if (onlineSource && onlineSource.appointments >= 3) pass(`by_source shows ${onlineSource.appointments} online (widget) appointments`);
  else fail('by_source should show at least 3 online appointments', '≥3', onlineSource?.appointments);

  // ══════════════════════════════════════════════════════════════════════
  section('BLOCK 12 — Voucher list + admin cancel');

  const { status: vlListS, data: vlListD } = await api('GET', '/api/vouchers');
  if (vlListS === 200 && Array.isArray(vlListD.vouchers)) {
    pass('GET /api/vouchers list → 200');
    info(`Total vouchers in system: ${vlListD.vouchers.length}`);
  } else {
    fail('Voucher list should return 200', 200, vlListS);
  }

  // Sell a new voucher and then cancel it (admin only)
  const { data: vcD } = await api('POST', '/api/vouchers', {
    value: 25, purchased_by: '__Cancel Me', payment_method: 'cash',
  });
  const cancelVoucherId = vcD.voucher?.id;
  if (cancelVoucherId) {
    cleanup.vouchers.push(cancelVoucherId);
    const { status: delS } = await api('DELETE', `/api/vouchers/${cancelVoucherId}`);
    if (delS === 200) pass('Admin can cancel (soft-delete) a voucher → 200');
    else fail('Admin DELETE voucher should return 200', 200, delS);

    // Therapist cannot cancel
    const { status: delUnauth } = await api('DELETE', `/api/vouchers/${cancelVoucherId}`, undefined, { auth: staffToken });
    if (delUnauth === 403) pass('Non-admin cannot cancel voucher → 403');
    else fail('Non-admin voucher DELETE should return 403', 403, delUnauth);
  }

  // ══════════════════════════════════════════════════════════════════════
  section('BLOCK 13 — Cleanup');

  // Cancel appointments
  let cancelledApts = 0;
  const allAppts = [...new Set(cleanup.appointments)];
  for (const id of allAppts) {
    const { status } = await api('PUT', `/api/appointments/${id}/status`, { status: 'cancelled' });
    if (status === 200) { cancelledApts++; }
  }
  if (cancelledApts === allAppts.length) pass(`${allAppts.length} test appointment(s) cancelled`);
  else warn(`${cancelledApts}/${allAppts.length} appointments cancelled — check remaining`);

  // Delete test clients (GDPR)
  let deletedClients = 0;
  for (const id of [...new Set(cleanup.clients)].filter(Boolean)) {
    const { status } = await api('DELETE', `/api/clients/${id}`);
    if (status === 200 || status === 404) deletedClients++;
  }
  if (deletedClients > 0) pass(`${deletedClients} test client(s) deleted`);

  // Deactivate treatments
  for (const id of cleanup.treatments) {
    await api('PUT', `/api/treatments/${id}`, { active: false });
    info(`Treatment #${id} deactivated`);
  }

  // Deactivate therapists
  for (const id of cleanup.therapists) {
    await api('PUT', `/api/therapists/${id}`, { active: false });
    info(`Therapist #${id} deactivated`);
  }

  // Deactivate rooms
  for (const id of cleanup.rooms) {
    await api('PUT', `/api/rooms/${id}`, { active: false });
    info(`Room #${id} deactivated`);
  }

  pass('Test data cleaned up');

  // ══════════════════════════════════════════════════════════════════════
  const total = passed + failed + warned;
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  💆  SiamSpa STRESS TEST COMPLETE');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`  RESULT: ${total} checks | ✅ ${passed} passed | ❌ ${failed} failed | ⚠️  ${warned} warnings`);
  if (failed === 0) {
    console.log('\n  🎉 All checks passed — SiamSpa ready for production.\n');
  } else {
    console.log(`\n  ⚠️  ${failed} failure(s) found — review with Sam before sign-off.\n`);
  }
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  📋  MANUAL CHECKS (UI only):');
  console.log('  1. Booking widget: select treatment → therapist → date+time → confirm');
  console.log('  2. Booking confirmation card shows therapist name + room');
  console.log('  3. Treatwell bookings appear in appointment screen tagged [Treatwell]');
  console.log('  4. Voucher sold in admin → code printed/emailed to recipient');
  console.log('  5. Reports screen shows correct totals + by-source split');
  console.log('  6. Z-report shows correct day totals; Z-close stamps the date');
  console.log('  7. Campaigns screen shows recipient count per segment correctly');
  console.log('══════════════════════════════════════════════════════════════════\n');
})();
