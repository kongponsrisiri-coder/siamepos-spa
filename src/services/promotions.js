// SPA-PROMO-TIME-001 — time-window promotions ("10:00–16:00 = 5% off").
//
// Owner-configured in Admin → Booking → Time-based promotions, stored as
// JSON in settings.time_promotions:
//   [{ id, name, percent, start: 'HH:MM', end: 'HH:MM', days: [1,2,3,4,5],
//      channels: 'all' | 'online' | 'till', active: true }]
// days: 0 = Sunday … 6 = Saturday; empty = every day. Times are the
// APPOINTMENT's start time in UK time, not the time of booking.
//
// Applied in one place per channel: online widget (price shown + deposit +
// stored on the booking), chatbot holds, till bookings (stored) and the bill
// (discount line with the promotion's name, so it prints on the receipt).
const { pool } = require('../db/dbAdapter');

let cache = { at: 0, rules: [] };
const TTL_MS = 15_000;

function normalise(list) {
  if (!Array.isArray(list)) return [];
  return list.map((r, i) => ({
    id:       String(r.id || i + 1),
    name:     String(r.name || 'Promotion').slice(0, 60),
    percent:  Math.max(0, Math.min(100, Number(r.percent) || 0)),
    start:    /^\d{2}:\d{2}$/.test(r.start || '') ? r.start : '00:00',
    end:      /^\d{2}:\d{2}$/.test(r.end   || '') ? r.end   : '23:59',
    days:     Array.isArray(r.days) ? r.days.map(Number).filter((d) => d >= 0 && d <= 6) : [],
    channels: ['all', 'online', 'till'].includes(r.channels) ? r.channels : 'all',
    active:   r.active !== false,
  })).filter((r) => r.percent > 0);
}

async function loadPromotions() {
  if (Date.now() - cache.at < TTL_MS) return cache.rules;
  let rules = [];
  try {
    const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'time_promotions'`);
    if (rows[0]?.value) rules = normalise(JSON.parse(rows[0].value));
  } catch (e) { /* unreadable → no promotions */ }
  cache = { at: Date.now(), rules };
  return rules;
}
function invalidate() { cache = { at: 0, rules: [] }; }

const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };

// The best (highest %) active rule covering this appointment start, or null.
// channel: 'online' (widget / chatbot) | 'till' (staff-entered)
async function promoFor(startsAt, channel = 'online') {
  const rules = await loadPromotions();
  if (!rules.length) return null;
  const d = new Date(startsAt);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const mins = Number(get('hour')) % 24 * 60 + Number(get('minute'));
  let best = null;
  for (const r of rules) {
    if (!r.active) continue;
    if (r.channels !== 'all' && r.channels !== channel) continue;
    if (r.days.length && !r.days.includes(dow)) continue;
    if (mins < hm(r.start) || mins >= hm(r.end)) continue;
    if (!best || r.percent > best.percent) best = r;
  }
  return best ? { name: best.name, percent: best.percent } : null;
}

function applyPromo(price, promo) {
  const p = Number(price || 0);
  if (!promo || !promo.percent) return { discount: 0, discounted: +p.toFixed(2) };
  const discount = +((p * promo.percent) / 100).toFixed(2);
  return { discount, discounted: +(p - discount).toFixed(2) };
}

module.exports = { loadPromotions, invalidate, promoFor, applyPromo, normalise };
