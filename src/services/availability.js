// Compute bookable slots for a given treatment + date.
// Used by both /api/appointments/availability (staff) and /api/widget/availability (public).

const { pool } = require('../db/database');

function parseHM(s) {
  const [h, m] = String(s).split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

// Build local-time UTC ISO from "YYYY-MM-DD" + "HH:MM" interpreting the
// time as local server time. Good enough for a single-site spa.
function buildAt(dateStr, timeStr) {
  const { h, m } = parseHM(timeStr);
  const d = new Date(`${dateStr}T00:00:00`);
  d.setHours(h, m, 0, 0);
  return d;
}

async function computeAvailability({ treatment_id, date, therapist_id }) {
  const tr = await pool.query(
    'SELECT id, duration_minutes FROM treatments WHERE id = $1 AND active = TRUE',
    [treatment_id],
  );
  if (!tr.rows[0]) throw new Error('treatment not found');
  const duration = tr.rows[0].duration_minutes;

  const settingsRes = await pool.query(
    `SELECT key, value FROM settings
     WHERE key IN ('opening_time','closing_time','booking_slot_minutes')`,
  );
  const settings = Object.fromEntries(settingsRes.rows.map((r) => [r.key, r.value]));
  const openTime = settings.opening_time || '10:00';
  const closeTime = settings.closing_time || '20:00';
  const slotMin = Number(settings.booking_slot_minutes || 15);

  const openAt = buildAt(date, openTime);
  const closeAt = buildAt(date, closeTime);

  const therapistsRes = therapist_id
    ? await pool.query('SELECT id FROM therapists WHERE id = $1 AND active = TRUE', [therapist_id])
    : await pool.query('SELECT id FROM therapists WHERE active = TRUE');
  const therapists = therapistsRes.rows.map((r) => r.id);
  if (!therapists.length) return [];

  const roomsRes = await pool.query('SELECT id FROM rooms WHERE active = TRUE');
  const rooms = roomsRes.rows.map((r) => r.id);
  if (!rooms.length) return [];

  // Pull every non-cancelled appointment that overlaps the day so we can
  // check conflicts in memory (cheaper than one SQL per slot).
  const dayStart = new Date(date + 'T00:00:00');
  const dayEnd = new Date(date + 'T23:59:59');
  const apptRes = await pool.query(
    `SELECT therapist_id, room_id, starts_at, ends_at
     FROM appointments
     WHERE status NOT IN ('cancelled','no_show')
       AND starts_at < $2 AND ends_at > $1`,
    [dayStart.toISOString(), dayEnd.toISOString()],
  );
  const busy = apptRes.rows.map((r) => ({
    therapist_id: r.therapist_id,
    room_id: r.room_id,
    start: new Date(r.starts_at).getTime(),
    end: new Date(r.ends_at).getTime(),
  }));

  const slots = [];
  for (let t = openAt.getTime(); t + duration * 60_000 <= closeAt.getTime(); t += slotMin * 60_000) {
    const startMs = t;
    const endMs = t + duration * 60_000;
    const freeTherapists = therapists.filter(
      (id) => !busy.some((b) => b.therapist_id === id && b.start < endMs && b.end > startMs),
    );
    const freeRooms = rooms.filter(
      (id) => !busy.some((b) => b.room_id === id && b.start < endMs && b.end > startMs),
    );
    if (freeTherapists.length && freeRooms.length) {
      slots.push({
        starts_at: new Date(startMs).toISOString(),
        ends_at: new Date(endMs).toISOString(),
        therapists: freeTherapists,
        rooms: freeRooms,
      });
    }
  }
  return slots;
}

module.exports = { computeAvailability };
