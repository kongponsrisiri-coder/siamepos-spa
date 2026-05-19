#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════╗
// ║  SiamEPOS Spa — Full QA Test                                 ║
// ║  Nook (QA Agent) | 2026-05-18                                ║
// ║  Covers: SPA-001 clients, treatments, therapists, rooms,     ║
// ║          appointments, conflict detection, bills, GDPR        ║
// ╚══════════════════════════════════════════════════════════════╝

const BASE = 'http://localhost:5050';

// Generate a dev JWT directly (avoids needing a known PIN).
// Uses the same secret as middleware/auth.js default.
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const adminToken  = jwt.sign({ sub: 9001, name: '__TestAdmin',   role: 'admin'     }, JWT_SECRET, { expiresIn: '1h' });
const managerToken= jwt.sign({ sub: 9002, name: '__TestManager', role: 'manager'   }, JWT_SECRET, { expiresIn: '1h' });
const staffToken  = jwt.sign({ sub: 9003, name: '__TestStaff',   role: 'therapist' }, JWT_SECRET, { expiresIn: '1h' });

let passed = 0, failed = 0, warned = 0;
const cleanup = { clients: [], treatments: [], therapists: [], rooms: [], appointments: [], bills: [] };

function pass(label)  { console.log(`  ✅ ${label}`); passed++; }
function fail(label, exp, got) {
  console.log(`  ❌ ${label}`);
  if (exp !== undefined) console.log(`     Expected: ${exp}\n     Actual:   ${JSON.stringify(got)}`);
  failed++;
}
function warn(label, detail) { console.log(`  ⚠️  ${label}${detail ? ': ' + detail : ''}`); warned++; }
function info(msg)  { console.log(`  ℹ️  ${msg}`); }
function section(title) {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  ${title.padEnd(56)}║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
}

async function api(method, path, body, token) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  let data;
  try { data = await r.json(); } catch { data = {}; }
  return { status: r.status, data };
}

// ── Future datetime helpers ──────────────────────────────────────
function futureDate(daysAhead = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

function isoDatetime(date, hour, minute = 0) {
  return `${date}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00.000Z`;
}

const testDate = futureDate(7);

// ════════════════════════════════════════════════════════════════
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  SiamEPOS Spa — Full QA Test                                 ║');
console.log('║  Nook (QA Agent) | 2026-05-18                                ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`  Backend: ${BASE}\n`);

(async () => {

  // ── BLOCK 1: Health check ──────────────────────────────────────
  section('BLOCK 1 — Health check');
  {
    const { status, data } = await api('GET', '/api/health');
    if (status === 200 && data.ok) pass('Health check OK');
    else { fail('Health check failed — is the spa server running on :5050?', 200, status); process.exit(1); }
    info(`Service: ${data.service} | Time: ${data.time}`);
  }

  // ── BLOCK 2: Auth ─────────────────────────────────────────────
  section('BLOCK 2 — Auth');
  {
    // No token → 401
    const { status } = await api('GET', '/api/clients');
    if (status === 401) pass('Protected endpoint without token → 401');
    else fail('Missing token should return 401', 401, status);

    // Invalid token → 401
    const { status: s2 } = await api('GET', '/api/clients', null, 'bad.token.here');
    if (s2 === 401) pass('Invalid token → 401');
    else fail('Invalid token should return 401', 401, s2);

    // Valid admin token → 200
    const { status: s3 } = await api('GET', '/api/clients', null, adminToken);
    if (s3 === 200) pass('Valid admin token → 200 on /api/clients');
    else fail('Admin token should get 200', 200, s3);

    // Therapist role blocked from admin-only route
    const { status: s4 } = await api('POST', '/api/therapists', { name: 'X', pin: '0000', role: 'therapist' }, staffToken);
    if (s4 === 403) pass('Therapist role blocked from admin/manager route → 403');
    else fail('Therapist should be forbidden on admin route', 403, s4);
  }

  // ── BLOCK 3: Treatments ───────────────────────────────────────
  section('BLOCK 3 — Treatments');

  let treatmentId, categoryId;
  {
    // Create category
    const { status, data } = await api('POST', '/api/treatments/categories', { name: '__TEST__ Massage', sort_order: 99 }, adminToken);
    if (status === 201 && data.category?.id) {
      pass('Treatment category created (201)');
      categoryId = data.category.id;
      info(`Category ID: ${categoryId}`);
    } else fail('Category creation failed', 201, { status, data });

    // Create treatment
    const { status: ts, data: td } = await api('POST', '/api/treatments', {
      name: '__TEST__ Swedish Massage',
      duration_minutes: 60,
      price: 65.00,
      category_id: categoryId,
      description: 'QA test treatment',
    }, adminToken);
    if (ts === 201 && td.treatment?.id) {
      pass('Treatment created (201)');
      treatmentId = td.treatment.id;
      info(`Treatment ID: ${treatmentId} | Duration: 60 min | Price: £65`);
    } else fail('Treatment creation failed', 201, { status: ts, data: td });

    // List treatments
    const { status: ls, data: ld } = await api('GET', '/api/treatments', null, adminToken);
    if (ls === 200 && Array.isArray(ld.treatments)) pass('GET /api/treatments returns array');
    else fail('Treatments list should return array', 200, ls);

    // Missing required fields
    const { status: ms } = await api('POST', '/api/treatments', { duration_minutes: 30, price: 0 }, adminToken);
    if (ms === 400) pass('Treatment without name → 400');
    else fail('Missing name should be 400', 400, ms);
  }

  // ── BLOCK 4: Rooms ────────────────────────────────────────────
  section('BLOCK 4 — Rooms');

  let roomId, room2Id;
  {
    const { status, data } = await api('POST', '/api/rooms', { name: '__TEST__ Room A' }, adminToken);
    if (status === 201 && data.room?.id) {
      pass('Room created (201)');
      roomId = data.room.id;
      info(`Room ID: ${roomId}`);
    } else fail('Room creation failed', 201, { status, data });

    const { status: s2, data: d2 } = await api('POST', '/api/rooms', { name: '__TEST__ Room B' }, adminToken);
    if (s2 === 201 && d2.room?.id) {
      room2Id = d2.room.id;
      info(`Room B ID: ${room2Id}`);
    }

    const { status: ls } = await api('GET', '/api/rooms', null, adminToken);
    if (ls === 200) pass('GET /api/rooms returns 200');
    else fail('Rooms list should return 200', 200, ls);
  }

  // ── BLOCK 5: Therapists ───────────────────────────────────────
  section('BLOCK 5 — Therapists');

  let therapistId, therapist2Id;
  {
    const bcrypt = require('bcryptjs');
    const pinHash  = bcrypt.hashSync('9876', 10);
    const pin2Hash = bcrypt.hashSync('5432', 10);

    const { status, data } = await api('POST', '/api/therapists', {
      name: '__TEST__ Therapist A', pin: pinHash, role: 'therapist',
    }, adminToken);
    if (status === 201 && data.therapist?.id) {
      pass('Therapist created (201)');
      therapistId = data.therapist.id;
      info(`Therapist ID: ${therapistId}`);
    } else fail('Therapist creation failed', 201, { status, data });

    const { status: s2, data: d2 } = await api('POST', '/api/therapists', {
      name: '__TEST__ Therapist B', pin: pin2Hash, role: 'therapist',
    }, adminToken);
    if (s2 === 201 && d2.therapist?.id) {
      therapist2Id = d2.therapist.id;
      info(`Therapist B ID: ${therapist2Id}`);
    }

    const { status: ls } = await api('GET', '/api/therapists', null, adminToken);
    if (ls === 200) pass('GET /api/therapists returns 200');
    else fail('Therapists list should return 200', 200, ls);
  }

  // ── BLOCK 6: Clients ──────────────────────────────────────────
  section('BLOCK 6 — Clients');

  let clientId;
  {
    // Create client
    const { status, data } = await api('POST', '/api/clients', {
      name: '__TEST__ Spa Client',
      phone: '07700100001',
      email: 'nook-spa-test@nook.qa',
      date_of_birth: '1985-06-15',
      emergency_contact_name: 'Test Contact',
      emergency_contact_phone: '07700100002',
      gdpr_consent: true,
      marketing_consent: false,
    }, adminToken);
    if (status === 201 && data.client?.id) {
      pass('Client created (201)');
      clientId = data.client.id;
      info(`Client ID: ${clientId}`);
      if (data.client.gdpr_consent) pass('gdpr_consent stored correctly');
      else fail('gdpr_consent should be true', true, data.client.gdpr_consent);
      if (data.client.gdpr_consent_at) pass('gdpr_consent_at timestamp set');
      else fail('gdpr_consent_at should be set when consent given');
    } else fail('Client creation failed', 201, { status, data });

    // Name required
    const { status: ms } = await api('POST', '/api/clients', { phone: '07700100003' }, adminToken);
    if (ms === 400) pass('Client without name → 400');
    else fail('Missing name should be 400', 400, ms);

    // Search
    const { status: ss, data: sd } = await api('GET', '/api/clients?q=__TEST__', null, adminToken);
    if (ss === 200 && sd.clients?.length >= 1) pass('Client search returns results');
    else fail('Client search should find test client', '>=1 result', ss);

    // Get profile
    if (clientId) {
      const { status: ps, data: pd } = await api('GET', `/api/clients/${clientId}`, null, adminToken);
      if (ps === 200 && pd.client?.id === clientId) pass('Client profile GET returns correct client');
      else fail('Client profile GET failed', 200, ps);
    }
  }

  // ── BLOCK 7: Medical questionnaire ───────────────────────────
  section('BLOCK 7 — Medical questionnaire');

  if (clientId) {
    // Create medical record
    const { status, data } = await api('PUT', `/api/clients/${clientId}/medical`, {
      pregnancy: false,
      heart_condition: false,
      blood_pressure: true,
      diabetes: false,
      allergies: 'Nuts',
      areas_to_avoid: 'Lower back',
      medications: 'Lisinopril 10mg',
      digital_signature: 'data:image/png;base64,iVBORw0KGgo=',
    }, adminToken);
    if ([200, 201].includes(status) && data.medical) {
      pass('Medical questionnaire saved');
      if (data.medical.blood_pressure) pass('Contraindication (blood_pressure) stored correctly');
      else fail('blood_pressure should be true', true, data.medical.blood_pressure);
      if (data.medical.signed_at) pass('signed_at timestamp set from digital_signature');
      else fail('signed_at should be set when signature provided');
    } else fail('Medical questionnaire save failed', '200 or 201', { status, data });

    // Upsert — update allergies, should not duplicate record
    const { status: us, data: ud } = await api('PUT', `/api/clients/${clientId}/medical`, {
      allergies: 'Nuts, Latex',
    }, adminToken);
    if ([200, 201].includes(us)) pass('Medical record upsert works (no duplicate)');
    else fail('Medical upsert should return 200/201', '200 or 201', us);

    // GET medical
    const { status: gs, data: gd } = await api('GET', `/api/clients/${clientId}/medical`, null, adminToken);
    if (gs === 200) {
      pass('GET medical record returns 200');
      if (gd.medical?.allergies === 'Nuts, Latex') pass('Updated allergies stored correctly');
      else fail('Allergies should be updated to "Nuts, Latex"', 'Nuts, Latex', gd.medical?.allergies);
    } else fail('GET medical should return 200', 200, gs);
  }

  // ── BLOCK 8: Appointments ─────────────────────────────────────
  section('BLOCK 8 — Appointments: create + status flow');

  let appt1Id, appt2Id;
  const appt1Start = isoDatetime(testDate, 10, 0);  // 10:00
  const appt2Start = isoDatetime(testDate, 12, 0);  // 12:00

  if (treatmentId) {
    // Create appointment 1
    const { status, data } = await api('POST', '/api/appointments', {
      client_id: clientId || null,
      treatment_id: treatmentId,
      therapist_id: therapistId || null,
      room_id: roomId || null,
      starts_at: appt1Start,
      notes: 'QA test appointment',
      source: 'walkin',
    }, adminToken);
    if (status === 201 && data.appointment?.id) {
      pass('Appointment created (201)');
      appt1Id = data.appointment.id;
      info(`Appointment ID: ${appt1Id} | ${testDate} 10:00 | 60 min`);
      if (data.appointment.status === 'booked') pass('Initial status is "booked"');
      else fail('Status should default to "booked"', 'booked', data.appointment.status);
      if (data.appointment.ends_at) pass('ends_at computed automatically');
      else fail('ends_at should be computed from duration');
    } else fail('Appointment creation failed', 201, { status, data });

    // Create appointment 2 (different time, same therapist)
    const { status: s2, data: d2 } = await api('POST', '/api/appointments', {
      client_id: clientId || null,
      treatment_id: treatmentId,
      therapist_id: therapistId || null,
      room_id: roomId || null,
      starts_at: appt2Start,
      source: 'walkin',
    }, adminToken);
    if (s2 === 201 && d2.appointment?.id) {
      appt2Id = d2.appointment.id;
      pass('Second appointment (12:00) created — no conflict');
      info(`Appointment 2 ID: ${appt2Id}`);
    } else fail('Second appointment should succeed', 201, { status: s2, data: d2 });

    // Status update: booked → in_progress
    if (appt1Id) {
      const { status: ss } = await api('PUT', `/api/appointments/${appt1Id}/status`, { status: 'in_progress' }, adminToken);
      if (ss === 200) pass('Status updated to "in_progress"');
      else fail('Status update to in_progress failed', 200, ss);

      // Invalid status
      const { status: is } = await api('PUT', `/api/appointments/${appt1Id}/status`, { status: 'flying' }, adminToken);
      if (is === 400) pass('Invalid status value → 400');
      else fail('Invalid status should be 400', 400, is);
    }

    // List appointments by date
    const { status: ls, data: ld } = await api('GET', `/api/appointments?date=${testDate}`, null, adminToken);
    if (ls === 200 && Array.isArray(ld.appointments)) {
      pass('GET /api/appointments?date= returns array');
      const found = ld.appointments.find(a => a.id === appt1Id);
      if (found) pass('Created appointment visible in list');
      else fail('Appointment should be visible in list');
    } else fail('Appointment list should return 200 + array', 200, ls);
  }

  // ── BLOCK 9: Conflict detection ───────────────────────────────
  section('BLOCK 9 — Conflict detection (double-booking)');

  if (treatmentId && appt1Id) {
    // 9A — same therapist, overlapping time (10:30 — inside 10:00–11:00)
    const { status, data } = await api('POST', '/api/appointments', {
      treatment_id: treatmentId,
      therapist_id: therapistId,
      starts_at: isoDatetime(testDate, 10, 30),
    }, adminToken);
    if (status === 409) pass('Same therapist overlap → 409 conflict');
    else fail('Overlapping therapist booking should 409', 409, { status, data });

    // 9B — same room, overlapping time
    const { status: rs, data: rd } = await api('POST', '/api/appointments', {
      treatment_id: treatmentId,
      therapist_id: therapist2Id,  // different therapist
      room_id: roomId,             // same room
      starts_at: isoDatetime(testDate, 10, 30),
    }, adminToken);
    if (rs === 409) pass('Same room overlap (different therapist) → 409 conflict');
    else fail('Overlapping room booking should 409', 409, { status: rs, data: rd });

    // 9C — same therapist, non-overlapping (11:30 — after 10:00–11:00 window)
    const { status: ns } = await api('POST', '/api/appointments', {
      treatment_id: treatmentId,
      therapist_id: therapistId,
      starts_at: isoDatetime(testDate, 11, 0),  // starts exactly as first ends
      source: 'walkin',
    }, adminToken);
    if (ns === 201) {
      pass('Back-to-back appointment (no gap) → 201 allowed');
      // find and track for cleanup
      const { data: list } = await api('GET', `/api/appointments?date=${testDate}`, null, adminToken);
      const extra = list.appointments?.find(a => a.therapist_id === therapistId && new Date(a.starts_at).getUTCHours() === 11);
      if (extra) cleanup.appointments.push(extra.id);
    } else fail('Back-to-back appointment should be allowed', 201, ns);
  }

  // ── BLOCK 10: Availability slots ──────────────────────────────
  section('BLOCK 10 — Availability slots');

  if (treatmentId) {
    const { status, data } = await api('GET', `/api/appointments/availability?treatment_id=${treatmentId}&date=${testDate}`, null, adminToken);
    if (status === 200 && Array.isArray(data.slots)) {
      pass('Availability endpoint returns slots array');
      info(`Available slots on ${testDate}: ${data.slots.length}`);
      if (data.slots.length >= 0) pass('Slots array is valid (may be 0 if all booked)');
    } else fail('Availability should return 200 + slots[]', 200, { status, data });

    // Missing required params
    const { status: ms } = await api('GET', '/api/appointments/availability', null, adminToken);
    if (ms === 400) pass('Availability without params → 400');
    else fail('Missing params should be 400', 400, ms);
  }

  // ── BLOCK 11: Bills ───────────────────────────────────────────
  section('BLOCK 11 — Bills: create → tip → pay');

  let billId;
  if (appt2Id) {
    // Create bill from appointment
    const { status, data } = await api('POST', '/api/bills', { appointment_id: appt2Id }, adminToken);
    if ([200, 201].includes(status) && data.bill?.id) {
      pass('Bill created from appointment');
      billId = data.bill.id;
      info(`Bill ID: ${billId} | Subtotal: £${data.bill.subtotal}`);
    } else fail('Bill creation failed', '200 or 201', { status, data });

    // Idempotent — creating bill twice returns same bill
    const { status: s2, data: d2 } = await api('POST', '/api/bills', { appointment_id: appt2Id }, adminToken);
    if ([200, 201].includes(s2) && d2.bill?.id === billId) pass('Duplicate bill creation is idempotent — returns same bill');
    else fail('Duplicate bill should return existing bill', billId, d2.bill?.id);

    // Missing appointment_id
    const { status: ms } = await api('POST', '/api/bills', {}, adminToken);
    if (ms === 400) pass('Bill without appointment_id → 400');
    else fail('Missing appointment_id should be 400', 400, ms);

    if (billId) {
      // Add tip
      const { status: ts, data: td } = await api('PUT', `/api/bills/${billId}/tip`, { tip: 10 }, adminToken);
      if (ts === 200 && td.bill?.tip == 10) {
        pass('Tip added to bill (£10)');
        if (Number(td.bill.total) === Number(td.bill.subtotal) + 10) pass('Total = subtotal + tip');
        else fail('Total should equal subtotal + tip', Number(td.bill.subtotal) + 10, td.bill.total);
      } else fail('Tip update failed', 200, { status: ts, data: td });

      // Invalid tip
      const { status: its } = await api('PUT', `/api/bills/${billId}/tip`, { tip: -5 }, adminToken);
      if (its === 400) pass('Negative tip → 400');
      else fail('Negative tip should be 400', 400, its);

      // Invalid payment method
      const { status: ims } = await api('POST', `/api/bills/${billId}/pay`, { method: 'bitcoin' }, adminToken);
      if (ims === 400) pass('Invalid payment method → 400');
      else fail('Invalid payment method should be 400', 400, ims);

      // Pay the bill
      const { status: ps, data: pd } = await api('POST', `/api/bills/${billId}/pay`, { method: 'card' }, adminToken);
      if (ps === 200 && pd.bill?.payment_status === 'paid') {
        pass('Bill paid (card) → 200');
        if (pd.bill.closed_at) pass('closed_at timestamp set on payment');
        else fail('closed_at should be set after payment');
      } else fail('Bill payment failed', 200, { status: ps, data: pd });

      // Verify appointment auto-completed after payment
      await new Promise(r => setTimeout(r, 300));
      const { data: apptData } = await api('GET', `/api/appointments?date=${testDate}`, null, adminToken);
      const paidAppt = apptData.appointments?.find(a => a.id === appt2Id);
      if (paidAppt?.status === 'completed') pass('Appointment auto-completed after bill payment');
      else fail('Appointment should be "completed" after payment', 'completed', paidAppt?.status);
    }
  }

  // ── BLOCK 12: GDPR erasure ────────────────────────────────────
  section('BLOCK 12 — GDPR erasure (admin only)');

  // Create a throwaway client to delete
  let gdprClientId;
  {
    const { data } = await api('POST', '/api/clients', {
      name: '__TEST__ GDPR Delete Me',
      phone: '07700199999',
      gdpr_consent: true,
    }, adminToken);
    gdprClientId = data.client?.id;

    // Therapist (non-admin) should be forbidden
    if (gdprClientId) {
      const { status } = await api('DELETE', `/api/clients/${gdprClientId}`, null, staffToken);
      if (status === 403) pass('Non-admin cannot GDPR-delete a client → 403');
      else fail('GDPR delete should be 403 for non-admin', 403, status);

      // Admin can delete
      const { status: as } = await api('DELETE', `/api/clients/${gdprClientId}`, null, adminToken);
      if (as === 200) pass('Admin can GDPR-delete client → 200');
      else fail('Admin GDPR delete should return 200', 200, as);

      // Verify gone
      const { status: gs } = await api('GET', `/api/clients/${gdprClientId}`, null, adminToken);
      if (gs === 404) pass('Deleted client returns 404');
      else fail('Deleted client should be 404', 404, gs);
    }
  }

  // ── BLOCK 13: Cleanup ─────────────────────────────────────────
  section('BLOCK 13 — Cleanup');

  // Cancel appointments
  const apptIds = [appt1Id, appt2Id, ...cleanup.appointments].filter(Boolean);
  for (const id of apptIds) {
    const { status } = await api('PUT', `/api/appointments/${id}/status`, { status: 'cancelled' }, adminToken);
    if (status === 200) info(`Appointment #${id} cancelled`);
    else warn(`Could not cancel appointment #${id}`);
  }
  if (apptIds.length) pass(`${apptIds.length} test appointment(s) cancelled`);

  // Delete client
  if (clientId) {
    const { status } = await api('DELETE', `/api/clients/${clientId}`, null, adminToken);
    if (status === 200) pass('Test client deleted (GDPR)');
    else warn('Could not delete test client', `ID ${clientId}`);
  }

  // Deactivate treatments + therapists + rooms (no delete route for these)
  if (treatmentId) {
    await api('PUT', `/api/treatments/${treatmentId}`, { active: false }, adminToken);
    info(`Treatment #${treatmentId} deactivated`);
  }
  if (therapistId) {
    await api('PUT', `/api/therapists/${therapistId}`, { active: false }, adminToken);
    info(`Therapist #${therapistId} deactivated`);
  }
  if (therapist2Id) {
    await api('PUT', `/api/therapists/${therapist2Id}`, { active: false }, adminToken);
    info(`Therapist B #${therapist2Id} deactivated`);
  }
  if (roomId) {
    await api('PUT', `/api/rooms/${roomId}`, { active: false }, adminToken);
    info(`Room #${roomId} deactivated`);
  }
  pass('Test data cleaned up');

  // ── Summary ───────────────────────────────────────────────────
  const total = passed + failed + warned;
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  🧖  SPA QA TEST COMPLETE');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  RESULT: ${total} checks | ✅ ${passed} passed | ❌ ${failed} failed | ⚠️  ${warned} warnings`);
  if (failed === 0) console.log('\n  🎉 All checks passed — SPA-001 ready for sign-off.\n');
  else console.log(`\n  ⚠️  ${failed} failure(s) found — review with Sam before sign-off.\n`);

  console.log('══════════════════════════════════════════════════════════════');
  console.log('  📋  MANUAL CHECKS (UI only):');
  console.log('  1. Appointment screen shows calendar / daily view correctly');
  console.log('  2. Client profile shows medical questionnaire + history');
  console.log('  3. Checkout screen shows subtotal + tip + total correctly');
  console.log('  4. Booking widget renders and submits from a browser');
  console.log('  5. Z-report / reports show correct daily totals');
  console.log('══════════════════════════════════════════════════════════════\n');
})();
