#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// SiamEPOS Spa — Demo Seed Script
// Creates: 2 categories, 8 treatments, 4 rooms, 6 therapists
//
// Usage:  node seed-demo.js [base_url]
//   e.g.  node seed-demo.js http://localhost:5050
//         node seed-demo.js https://spa-api.siamepos.co.uk
//
// Requires jsonwebtoken in node_modules (already present from spa-epos deps).
// ─────────────────────────────────────────────────────────────────────────────

const BASE = process.argv[2] || 'http://localhost:5050';
const jwt  = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'a7f3c9e2b84d1f6a0e5c7b2d9f4a8e1c3b6d0f2a9e4c7b1d8f3a6c0e2b5d9f4';

const token = jwt.sign({ sub: 9001, name: 'SeedScript', role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });

let created = 0, skipped = 0;

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.warn(`  ⚠️  ${path} → ${r.status} ${data.error || JSON.stringify(data)}`);
    skipped++;
    return null;
  }
  created++;
  return data;
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.json().catch(() => ({}));
}

async function run() {
  console.log(`\n🌸 SiamEPOS Spa — Demo Seed`);
  console.log(`   Target: ${BASE}\n`);

  // ── Treatment Categories ─────────────────────────────────────────────────
  console.log('── Treatment Categories ──');
  const catMassage = await post('/api/treatments/categories', { name: 'Massage Therapy', sort_order: 1 });
  const catSkin    = await post('/api/treatments/categories', { name: 'Skin & Beauty',   sort_order: 2 });

  // Fall back to fetching if categories already exist
  let massageCatId, skinCatId;
  if (catMassage?.category?.id) {
    massageCatId = catMassage.category.id;
    console.log(`  ✅ Massage Therapy (id ${massageCatId})`);
  }
  if (catSkin?.category?.id) {
    skinCatId = catSkin.category.id;
    console.log(`  ✅ Skin & Beauty (id ${skinCatId})`);
  }
  if (!massageCatId || !skinCatId) {
    const cats = await get('/api/treatments/categories');
    const list  = cats.categories || [];
    massageCatId = massageCatId || list.find(c => c.name.toLowerCase().includes('massage'))?.id;
    skinCatId    = skinCatId    || list.find(c => c.name.toLowerCase().includes('skin') || c.name.toLowerCase().includes('beauty'))?.id;
    if (!massageCatId || !skinCatId) {
      console.error('  ❌ Could not resolve category IDs — aborting treatments');
    }
  }

  // ── Treatments ───────────────────────────────────────────────────────────
  console.log('\n── Treatments ──');
  const treatments = [
    { category_id: massageCatId, name: 'Swedish Massage',     duration_minutes: 60,  price: 60,  description: 'Relaxing full-body massage with long, flowing strokes.' },
    { category_id: massageCatId, name: 'Deep Tissue Massage', duration_minutes: 90,  price: 85,  description: 'Targets deep muscle layers to release chronic tension.' },
    { category_id: massageCatId, name: 'Hot Stone Massage',   duration_minutes: 75,  price: 80,  description: 'Warm basalt stones melt away tension and stress.' },
    { category_id: massageCatId, name: 'Thai Massage',        duration_minutes: 60,  price: 65,  description: 'Traditional Thai stretching and acupressure.' },
    { category_id: massageCatId, name: 'Aromatherapy',        duration_minutes: 60,  price: 70,  description: 'Essential oils blended for your mood and needs.' },
    { category_id: massageCatId, name: 'Foot Reflexology',    duration_minutes: 45,  price: 45,  description: 'Pressure points on the feet linked to the whole body.' },
    { category_id: skinCatId,    name: 'Luxury Facial',       duration_minutes: 60,  price: 80,  description: 'Deep cleansing, exfoliation, mask and moisturiser.' },
    { category_id: skinCatId,    name: 'Body Scrub',          duration_minutes: 45,  price: 55,  description: 'Full-body exfoliation leaving skin silky smooth.' },
  ];
  for (const t of treatments) {
    const res = await post('/api/treatments', t);
    if (res?.treatment?.id) console.log(`  ✅ ${t.name} — ${t.duration_minutes}min £${t.price}`);
  }

  // ── Rooms ────────────────────────────────────────────────────────────────
  console.log('\n── Rooms ──');
  const rooms = ['Jasmine Room', 'Lotus Room', 'Orchid Room', 'Blossom Room'];
  for (const name of rooms) {
    const res = await post('/api/rooms', { name });
    if (res?.room?.id) console.log(`  ✅ ${name}`);
  }

  // ── Therapists ───────────────────────────────────────────────────────────
  console.log('\n── Therapists ──');
  const therapists = [
    { name: 'Nong',  pin: '1001', role: 'therapist', specialisms: 'Thai Massage, Deep Tissue' },
    { name: 'Ploy',  pin: '1002', role: 'therapist', specialisms: 'Swedish Massage, Aromatherapy' },
    { name: 'May',   pin: '1003', role: 'therapist', specialisms: 'Hot Stone, Reflexology' },
    { name: 'Kwan',  pin: '1004', role: 'therapist', specialisms: 'Facial, Body Scrub' },
    { name: 'Fah',   pin: '1005', role: 'therapist', specialisms: 'Thai Massage, Swedish Massage' },
    { name: 'Nan',   pin: '1006', role: 'therapist', specialisms: 'Deep Tissue, Hot Stone' },
  ];
  const therapistIds = [];
  for (const t of therapists) {
    const res = await post('/api/therapists', t);
    if (res?.therapist?.id) {
      therapistIds.push(res.therapist.id);
      console.log(`  ✅ ${t.name} — PIN: ${t.pin} (${t.specialisms})`);
    }
  }

  // ── Weekly Rota for each therapist ──────────────────────────────────────
  console.log('\n── Setting Weekly Rota ──');
  // Mon–Fri pattern (days 1–5), alternating start/end times for variety
  const rotaPatterns = [
    [1,2,3,4,5], // Nong  — Mon–Fri
    [1,2,3,4,6], // Ploy  — Mon–Thu + Sat
    [2,3,4,5,6], // May   — Tue–Sat
    [1,2,3,4,5], // Kwan  — Mon–Fri
    [1,3,4,5,6], // Fah   — Mon, Wed–Sat
    [2,3,4,5,6], // Nan   — Tue–Sat
  ];
  const startTimes = ['09:00','09:30','10:00','09:00','10:00','09:30'];
  const endTimes   = ['17:00','18:00','18:00','17:30','19:00','18:30'];

  for (let i = 0; i < therapistIds.length; i++) {
    const id = therapistIds[i];
    const slots = rotaPatterns[i].map(dow => ({
      day_of_week: dow,
      start_time:  startTimes[i],
      end_time:    endTimes[i],
    }));
    const r = await fetch(`${BASE}/api/therapists/${id}/availability`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ slots }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      console.log(`  ✅ ${therapists[i].name} — rota set (${rotaPatterns[i].map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')})`);
    } else {
      console.warn(`  ⚠️  ${therapists[i].name} rota failed: ${data.error || r.status}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n──────────────────────────────────`);
  console.log(`✅ Created: ${created}   ⚠️  Skipped: ${skipped}`);
  console.log(`\nLogin to the spa dashboard and go to Admin → Rota to see the timeline.`);
  console.log(`Therapist PINs: Nong=1001  Ploy=1002  May=1003  Kwan=1004  Fah=1005  Nan=1006\n`);
}

run().catch(err => { console.error('Seed failed:', err.message); process.exit(1); });
