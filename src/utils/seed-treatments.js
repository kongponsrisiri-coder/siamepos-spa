// Run once to seed classic spa treatments.
// Usage: node src/utils/seed-treatments.js
// (Requires DATABASE_URL in env or a .env file in spa-epos/)

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CATEGORIES = [
  { name: 'Massage',            sort_order: 1 },
  { name: 'Facial',             sort_order: 2 },
  { name: 'Body Treatment',     sort_order: 3 },
  { name: 'Hands & Feet',       sort_order: 4 },
];

const TREATMENTS = [
  // ── Massage ─────────────────────────────────────────────────
  { category: 'Massage', name: 'Swedish Massage',           duration: 60,  price: 65.00,  description: 'A classic full-body relaxation massage using long, flowing strokes to ease muscle tension.' },
  { category: 'Massage', name: 'Swedish Massage',           duration: 90,  price: 90.00,  description: 'Extended full-body Swedish massage for deeper relaxation.' },
  { category: 'Massage', name: 'Deep Tissue Massage',       duration: 60,  price: 75.00,  description: 'Firm pressure targeting deeper muscle layers to release chronic tension and knots.' },
  { category: 'Massage', name: 'Deep Tissue Massage',       duration: 90,  price: 100.00, description: 'Extended deep tissue massage for whole-body muscle relief.' },
  { category: 'Massage', name: 'Hot Stone Massage',         duration: 75,  price: 90.00,  description: 'Warm basalt stones combined with massage to melt tension and improve circulation.' },
  { category: 'Massage', name: 'Aromatherapy Massage',      duration: 60,  price: 70.00,  description: 'Gentle massage using blended essential oils tailored to your mood and needs.' },
  { category: 'Massage', name: 'Thai Massage',              duration: 60,  price: 70.00,  description: 'Traditional dry Thai stretching and acupressure to release energy blockages.' },
  { category: 'Massage', name: 'Thai Massage',              duration: 90,  price: 95.00,  description: 'Full traditional Thai massage session with extended stretching.' },
  { category: 'Massage', name: 'Couples Massage',           duration: 60,  price: 130.00, description: 'Side-by-side Swedish massage for two in our couples suite.' },
  { category: 'Massage', name: 'Back, Neck & Shoulder',     duration: 30,  price: 40.00,  description: 'Focused massage on the upper body to relieve desk tension and stiffness.' },

  // ── Facial ──────────────────────────────────────────────────
  { category: 'Facial', name: 'Classic Cleansing Facial',   duration: 60,  price: 60.00,  description: 'Deep cleanse, exfoliation, steam, extraction, mask and moisturiser for a clear, fresh complexion.' },
  { category: 'Facial', name: 'Hydrating Facial',           duration: 60,  price: 70.00,  description: 'Intensive moisture boost using hyaluronic-rich products to plump and soften the skin.' },
  { category: 'Facial', name: 'Anti-Ageing Facial',         duration: 75,  price: 85.00,  description: 'Firming and brightening treatment targeting fine lines and loss of elasticity.' },
  { category: 'Facial', name: 'Express Facial',             duration: 30,  price: 40.00,  description: 'A quick refresh — cleanse, tone, mask and moisturise for an instant glow.' },
  { category: 'Facial', name: 'Men\'s Facial',              duration: 60,  price: 65.00,  description: 'Deep cleanse and oil-control treatment formulated for men\'s skin.' },

  // ── Body Treatment ──────────────────────────────────────────
  { category: 'Body Treatment', name: 'Full Body Scrub',          duration: 45,  price: 55.00,  description: 'Exfoliating salt or sugar scrub to buff away dead skin, leaving it silky smooth.' },
  { category: 'Body Treatment', name: 'Body Wrap',                duration: 60,  price: 75.00,  description: 'Nourishing wrap infused with minerals or essential oils to detoxify and hydrate.' },
  { category: 'Body Treatment', name: 'Scrub & Massage Combo',    duration: 90,  price: 110.00, description: 'Full body scrub followed by a relaxing Swedish massage — the ultimate treat.' },

  // ── Hands & Feet ────────────────────────────────────────────
  { category: 'Hands & Feet', name: 'Classic Manicure',      duration: 45,  price: 35.00,  description: 'File, shape, cuticle care and polish for beautifully groomed nails.' },
  { category: 'Hands & Feet', name: 'Luxury Manicure',       duration: 60,  price: 50.00,  description: 'Classic manicure plus hand scrub and mask treatment.' },
  { category: 'Hands & Feet', name: 'Classic Pedicure',      duration: 60,  price: 45.00,  description: 'Soak, exfoliation, cuticle care, nail shaping and polish for soft, pretty feet.' },
  { category: 'Hands & Feet', name: 'Luxury Pedicure',       duration: 75,  price: 60.00,  description: 'Classic pedicure enhanced with a foot scrub, mask and extended massage.' },
  { category: 'Hands & Feet', name: 'Gel Manicure',          duration: 60,  price: 45.00,  description: 'Long-lasting gel polish for chip-free, glossy nails up to three weeks.' },
  { category: 'Hands & Feet', name: 'Gel Pedicure',          duration: 75,  price: 55.00,  description: 'Pedicure with chip-resistant gel polish finish.' },
];

async function seed() {
  const client = await pool.connect();
  try {
    // Insert categories (skip if already present)
    const catMap = {};
    for (const cat of CATEGORIES) {
      const existing = await client.query(
        'SELECT id FROM treatment_categories WHERE name = $1', [cat.name]
      );
      if (existing.rows.length > 0) {
        catMap[cat.name] = existing.rows[0].id;
        console.log(`  [skip] category already exists: ${cat.name}`);
      } else {
        const { rows } = await client.query(
          'INSERT INTO treatment_categories (name, sort_order) VALUES ($1, $2) RETURNING id',
          [cat.name, cat.sort_order]
        );
        catMap[cat.name] = rows[0].id;
        console.log(`  [+] category: ${cat.name}`);
      }
    }

    // Insert treatments (skip exact name+duration duplicates)
    let added = 0, skipped = 0;
    for (const t of TREATMENTS) {
      const categoryId = catMap[t.category];
      const existing = await client.query(
        'SELECT id FROM treatments WHERE name = $1 AND duration_minutes = $2',
        [t.name, t.duration]
      );
      if (existing.rows.length > 0) {
        skipped++;
      } else {
        await client.query(
          `INSERT INTO treatments (category_id, name, duration_minutes, price, description)
           VALUES ($1, $2, $3, $4, $5)`,
          [categoryId, t.name, t.duration, t.price, t.description]
        );
        added++;
        console.log(`  [+] ${t.category} / ${t.name} (${t.duration}min) £${t.price}`);
      }
    }

    console.log(`\nDone — ${added} treatments added, ${skipped} already existed.`);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => { console.error(err); process.exit(1); });
