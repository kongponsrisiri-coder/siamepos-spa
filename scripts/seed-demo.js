// SPA-DEMO-001 — seed script for the Baan Siam Spa demo content.
//
// Populates the spa-api with the rooms, treatment categories, treatments and
// therapists the mockup demo site renders. Run once locally after spinning
// up the backend, and again on production once spa-api.siamepos.co.uk goes
// live. The script is **idempotent**: it skips anything that already exists
// (matched by name).
//
// Usage:
//   node scripts/seed-demo.js               # talks to http://localhost:5050
//   node scripts/seed-demo.js --api=URL     # override (e.g. production)
//   node scripts/seed-demo.js --pin=1234    # override admin PIN (default 1234)

const API  = (process.argv.find(a => a.startsWith('--api=')) || '').slice(6) || 'http://localhost:5050';
const PIN  = (process.argv.find(a => a.startsWith('--pin=')) || '').slice(6) || '1234';

const ROOMS = ['Lotus', 'Jasmine', 'Orchid'];

const CATEGORIES = [
  { name: 'Thai Massage',  sort_order: 1 },
  { name: 'Aromatherapy',  sort_order: 2 },
  { name: 'Hot Stone',     sort_order: 3 },
  { name: 'Body Work',     sort_order: 4 },
  { name: 'Specialist',    sort_order: 5 },
  { name: 'Reflexology',   sort_order: 6 },
];

const TREATMENTS = [
  { category: 'Thai Massage', name: 'Traditional Thai Massage — 60 min', duration_minutes: 60, price: 55, description: 'Slow, deep stretching and pressure-point work along the body’s energy lines.' },
  { category: 'Thai Massage', name: 'Traditional Thai Massage — 90 min', duration_minutes: 90, price: 75, description: 'The full Thai session — every line worked, every stretch held.' },
  { category: 'Thai Massage', name: 'Thai Herbal Compress',               duration_minutes: 90, price: 85, description: 'Steamed herbal pouches release lemongrass, kaffir lime and turmeric into tight muscle.' },
  { category: 'Aromatherapy', name: 'Aromatherapy Massage — 60 min',      duration_minutes: 60, price: 65, description: 'Long flowing strokes with a blended oil chosen for what your day asks.' },
  { category: 'Aromatherapy', name: 'Aromatherapy Massage — 90 min',      duration_minutes: 90, price: 85, description: 'A deeper, slower aromatherapy session with scalp and foot work.' },
  { category: 'Hot Stone',    name: 'Hot Stone Therapy',                  duration_minutes: 75, price: 95, description: 'Warm basalt stones melt deep tension out of shoulders, back and hips.' },
  { category: 'Body Work',    name: 'Deep Tissue Massage',                duration_minutes: 60, price: 70, description: 'Firm, focused work for chronic knots — best paired with a heat treatment.' },
  { category: 'Body Work',    name: 'Sports Recovery',                    duration_minutes: 60, price: 70, description: 'Targeted to legs, glutes and lower back after running, cycling or training.' },
  { category: 'Specialist',   name: 'Pregnancy Massage',                  duration_minutes: 60, price: 75, description: 'Side-lying, second + third trimester only. Eases lower-back load and swelling.' },
  { category: 'Specialist',   name: 'Lymphatic Drainage',                 duration_minutes: 75, price: 85, description: 'Light, rhythmic strokes to encourage lymph flow — gentle but deeply restorative.' },
  { category: 'Reflexology',  name: 'Foot Reflexology',                   duration_minutes: 45, price: 45, description: 'Pressure-point work along the soles — surprisingly transformative on its own.' },
];

const THERAPISTS = [
  {
    name: 'Anong Chai',
    pin: '2001',
    specialisms: 'Deep tissue · Hot stone · Thai herbal compress',
    photo_url: 'https://images.unsplash.com/photo-1554151228-14d9def656e4?w=400&q=80&auto=format&fit=crop',
  },
  {
    name: 'Malee Sirikul',
    pin: '2002',
    specialisms: 'Aromatherapy · Reflexology · Lymphatic drainage',
    photo_url: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=400&q=80&auto=format&fit=crop',
  },
  {
    name: 'Niran Phakdee',
    pin: '2003',
    specialisms: 'Sports recovery · Deep tissue · Sciatica relief',
    photo_url: 'https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?w=400&q=80&auto=format&fit=crop',
  },
  {
    name: 'Suthida Roongroj',
    pin: '2004',
    specialisms: 'Pregnancy massage · Thai traditional · Reflexology',
    photo_url: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400&q=80&auto=format&fit=crop',
  },
];

let token = null;
function authHeaders() {
  return token ? { authorization: 'Bearer ' + token } : {};
}

async function req(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error('[' + method + ' ' + path + '] ' + res.status + ' ' + (data.error || res.statusText));
    err.status = res.status;
    throw err;
  }
  return data;
}

function tag(label) { return '\x1b[36m' + label + '\x1b[0m'; }
function ok(msg)    { console.log('  \x1b[32m✓\x1b[0m ' + msg); }
function skip(msg)  { console.log('  \x1b[90m·\x1b[0m ' + msg + ' (exists)'); }

(async () => {
  console.log('\n' + tag('Baan Siam Spa demo seed') + ' → ' + API + '\n');

  // ── Login ────────────────────────────────────────────────────────────
  console.log(tag('1. Login'));
  const auth = await req('POST', '/api/auth/login', { pin: PIN });
  token = auth.token;
  ok('Logged in as ' + auth.staff.name + ' (' + auth.staff.role + ')');

  // ── Rooms ────────────────────────────────────────────────────────────
  console.log('\n' + tag('2. Rooms'));
  const existingRooms = (await req('GET', '/api/rooms')).rooms || [];
  for (const name of ROOMS) {
    if (existingRooms.find(r => r.name === name)) { skip('Room: ' + name); continue; }
    await req('POST', '/api/rooms', { name });
    ok('Room: ' + name);
  }

  // ── Treatment categories ─────────────────────────────────────────────
  console.log('\n' + tag('3. Treatment categories'));
  const existingCats = (await req('GET', '/api/treatments/categories')).categories || [];
  const catByName = {};
  for (const c of CATEGORIES) {
    const found = existingCats.find(x => x.name === c.name);
    if (found) { skip('Category: ' + c.name); catByName[c.name] = found.id; continue; }
    const created = await req('POST', '/api/treatments/categories', c);
    catByName[c.name] = created.category.id;
    ok('Category: ' + c.name);
  }
  // Include the freshly-loaded ones too.
  existingCats.forEach(c => { if (!catByName[c.name]) catByName[c.name] = c.id; });

  // ── Treatments ───────────────────────────────────────────────────────
  console.log('\n' + tag('4. Treatments'));
  const existingTreatments = (await req('GET', '/api/treatments')).treatments || [];
  for (const t of TREATMENTS) {
    if (existingTreatments.find(x => x.name === t.name)) { skip('Treatment: ' + t.name); continue; }
    const cat_id = catByName[t.category];
    await req('POST', '/api/treatments', {
      category_id: cat_id || null,
      name: t.name,
      duration_minutes: t.duration_minutes,
      price: t.price,
      description: t.description,
    });
    ok('Treatment: ' + t.name);
  }

  // ── Therapists ───────────────────────────────────────────────────────
  console.log('\n' + tag('5. Therapists'));
  const existingTherapists = (await req('GET', '/api/therapists')).therapists || [];
  for (const th of THERAPISTS) {
    const found = existingTherapists.find(x => x.name === th.name);
    if (found) {
      // Top up specialisms + photo on existing rows so re-runs after
      // SPA-DEMO-001-PREP pick up the new columns.
      await req('PUT', '/api/therapists/' + found.id, {
        specialisms: th.specialisms,
        photo_url:   th.photo_url,
      });
      ok('Therapist: ' + th.name + ' (updated photo + specialisms)');
      continue;
    }
    await req('POST', '/api/therapists', {
      name: th.name,
      pin: th.pin,
      role: 'therapist',
      specialisms: th.specialisms,
      photo_url:   th.photo_url,
    });
    ok('Therapist: ' + th.name);
  }

  console.log('\n' + tag('Done.') + ' Visit the demo site (http://localhost:5500 or wherever you serve it from) — treatments + therapists should now render live.\n');
})().catch((err) => {
  console.error('\n\x1b[31m✗ Seed failed:\x1b[0m', err.message);
  if (err.status === 401) console.error('  (Hint: pass --pin=YOUR_PIN if the admin PIN isn’t 1234.)');
  process.exit(1);
});
