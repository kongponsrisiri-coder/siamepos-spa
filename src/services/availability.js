// Compute bookable slots for a given treatment + date.
// Used by both /api/appointments/availability (staff) and /api/widget/availability (public).
// SPA-ROTA-001: now checks therapist_availability (weekly rota) AND
// therapist_rota_overrides (date-specific) before returning slots.

const { pool } = require('../db/database');

function parseHM(s) {
  const [h, m] = String(s).split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

// Interpret dateStr ("YYYY-MM-DD") + timeStr ("HH:MM" or "HH:MM:SS") as
// **Europe/London local time** and return the corresponding UTC Date.
//
// The previous implementation used `new Date(dateStr + 'T00:00:00')` +
// setHours(), which interprets the value in the SERVER'S local clock.
// Railway runs in UTC, so an override saved as "10:00" came out as
// 10:00 UTC = 11:00 BST, and a 10:30 BST booking (09:30 UTC) was
// wrongly rejected as outside-rota.
//
// All rota / override / settings times are owner-entered London local
// time, so anchoring them to Europe/London here makes the window
// independent of the server clock.
//
// (For a future non-UK customer this would need to read the spa's
// timezone from settings rather than hard-coding Europe/London.)
const SPA_TZ = 'Europe/London';
function londonOffsetHours(dateStr) {
  const sample = new Date(`${dateStr}T12:00:00Z`);
  const h = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: SPA_TZ, hour: 'numeric', hour12: false,
  }).format(sample));
  return h - 12;   // 0 in GMT (winter), 1 in BST (summer)
}
function buildAt(dateStr, timeStr) {
  const { h, m } = parseHM(timeStr);
  const off = londonOffsetHours(dateStr);
  const [y, mo, d] = dateStr.split('-').map(Number);
  // h:m London → (h-off):m UTC. Date.UTC normalises day overflow.
  return new Date(Date.UTC(y, mo - 1, d, h - off, m, 0, 0));
}

// Returns a working window { start, end } in ms, or null if the therapist
// is off that day. Resolution order: override > weekly rota > full-day fallback.
function resolveTherapistWindow(therapistId, dateStr, dayOfWeek, weeklyRota, overrides, openAtMs, closeAtMs) {
  // 1 — date-specific override
  const override = overrides.find(
    (o) => o.therapist_id === therapistId && o.date === dateStr,
  );
  if (override) {
    if (!override.is_working) return null; // day off
    return {
      start: override.start_time ? buildAt(dateStr, override.start_time).getTime() : openAtMs,
      end:   override.end_time   ? buildAt(dateStr, override.end_time).getTime()   : closeAtMs,
    };
  }

  // 2 — weekly rota for this therapist
  const todaySlots = weeklyRota.filter(
    (r) => r.therapist_id === therapistId && r.day_of_week === dayOfWeek,
  );

  const hasAnyRotaForTherapist = weeklyRota.some((r) => r.therapist_id === therapistId);
  if (!hasAnyRotaForTherapist) {
    // No rota set at all → backwards-compatible: assume working full day
    return { start: openAtMs, end: closeAtMs };
  }
  if (todaySlots.length === 0) {
    // Rota exists but no slot for today → day off
    return null;
  }

  // Use earliest start / latest end from their rota slots for the day
  const starts = todaySlots.map((s) => buildAt(dateStr, s.start_time).getTime());
  const ends   = todaySlots.map((s) => buildAt(dateStr, s.end_time).getTime());
  return { start: Math.min(...starts), end: Math.max(...ends) };
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
  const openTime  = settings.opening_time       || '10:00';
  const closeTime = settings.closing_time       || '20:00';
  const slotMin   = Number(settings.booking_slot_minutes || 15);

  const openAtMs  = buildAt(date, openTime).getTime();
  const closeAtMs = buildAt(date, closeTime).getTime();

  // day_of_week: 0=Sun … 6=Sat (matches JS Date.getDay())
  const dayOfWeek = new Date(date + 'T12:00:00').getDay();

  // Fetch therapists. Only role='therapist' is considered for slot
  // availability — admins, managers and reception are staff but they
  // don't deliver treatments, so we never auto-assign them.
  const therapistsRes = therapist_id
    ? await pool.query(`SELECT id FROM therapists WHERE id = $1 AND active = TRUE AND role = 'therapist'`, [therapist_id])
    : await pool.query(`SELECT id FROM therapists WHERE active = TRUE AND role = 'therapist'`);
  const allTherapists = therapistsRes.rows.map((r) => r.id);
  if (!allTherapists.length) return [];

  const roomsRes = await pool.query('SELECT id FROM rooms WHERE active = TRUE');
  const rooms = roomsRes.rows.map((r) => r.id);
  if (!rooms.length) return [];

  // SPA-ROTA-001 — load weekly rota for all therapists
  const rotaRes = await pool.query(
    `SELECT therapist_id, day_of_week, start_time, end_time
     FROM therapist_availability WHERE therapist_id = ANY($1)`,
    [allTherapists],
  );
  const weeklyRota = rotaRes.rows.map((r) => ({
    therapist_id: r.therapist_id,
    day_of_week:  r.day_of_week,
    start_time:   String(r.start_time).slice(0, 5),
    end_time:     String(r.end_time).slice(0, 5),
  }));

  // SPA-ROTA-001 — load date-specific overrides for this date
  const overrideRes = await pool.query(
    `SELECT therapist_id, date::text AS date, is_working, start_time, end_time
     FROM therapist_rota_overrides
     WHERE therapist_id = ANY($1) AND date = $2`,
    [allTherapists, date],
  );
  const overrides = overrideRes.rows;

  // Resolve each therapist's working window for today
  const therapistWindows = {};
  for (const id of allTherapists) {
    const window = resolveTherapistWindow(id, date, dayOfWeek, weeklyRota, overrides, openAtMs, closeAtMs);
    if (window) therapistWindows[id] = window;
  }

  const workingTherapists = Object.keys(therapistWindows).map(Number);
  if (!workingTherapists.length) return [];

  // Pull existing appointments for conflict checking
  const dayStart = new Date(date + 'T00:00:00');
  const dayEnd   = new Date(date + 'T23:59:59');
  const apptRes  = await pool.query(
    `SELECT therapist_id, room_id, starts_at, ends_at
     FROM appointments
     WHERE status NOT IN ('cancelled','no_show')
       AND starts_at < $2 AND ends_at > $1`,
    [dayStart.toISOString(), dayEnd.toISOString()],
  );
  const busy = apptRes.rows.map((r) => ({
    therapist_id: r.therapist_id,
    room_id:      r.room_id,
    start:        new Date(r.starts_at).getTime(),
    end:          new Date(r.ends_at).getTime(),
  }));

  const slots = [];
  for (let t = openAtMs; t + duration * 60_000 <= closeAtMs; t += slotMin * 60_000) {
    const startMs = t;
    const endMs   = t + duration * 60_000;

    const freeTherapists = workingTherapists.filter((id) => {
      const w = therapistWindows[id];
      if (startMs < w.start || endMs > w.end) return false; // outside rota hours
      return !busy.some((b) => b.therapist_id === id && b.start < endMs && b.end > startMs);
    });

    const freeRooms = rooms.filter(
      (id) => !busy.some((b) => b.room_id === id && b.start < endMs && b.end > startMs),
    );

    if (freeTherapists.length && freeRooms.length) {
      slots.push({
        starts_at:  new Date(startMs).toISOString(),
        ends_at:    new Date(endMs).toISOString(),
        therapists: freeTherapists,
        rooms:      freeRooms,
      });
    }
  }
  return slots;
}

// Single-therapist rota lookup — used by POST + PUT /api/appointments
// to reject bookings that fall outside a therapist's working window.
// Returns { start, end } in ms, or null if they're off that day.
async function getTherapistWorkingWindow(therapist_id, date) {
  const settingsRes = await pool.query(
    `SELECT key, value FROM settings WHERE key IN ('opening_time','closing_time')`,
  );
  const settings = Object.fromEntries(settingsRes.rows.map((r) => [r.key, r.value]));
  const openAtMs  = buildAt(date, settings.opening_time  || '10:00').getTime();
  const closeAtMs = buildAt(date, settings.closing_time || '20:00').getTime();
  const dayOfWeek = new Date(date + 'T12:00:00').getDay();

  const rotaRes = await pool.query(
    `SELECT therapist_id, day_of_week, start_time, end_time
     FROM therapist_availability WHERE therapist_id = $1`,
    [therapist_id],
  );
  const weeklyRota = rotaRes.rows.map((r) => ({
    therapist_id: r.therapist_id,
    day_of_week:  r.day_of_week,
    start_time:   String(r.start_time).slice(0, 5),
    end_time:     String(r.end_time).slice(0, 5),
  }));

  const overrideRes = await pool.query(
    `SELECT therapist_id, date::text AS date, is_working, start_time, end_time
     FROM therapist_rota_overrides
     WHERE therapist_id = $1 AND date = $2`,
    [therapist_id, date],
  );

  return resolveTherapistWindow(
    therapist_id, date, dayOfWeek,
    weeklyRota, overrideRes.rows,
    openAtMs, closeAtMs,
  );
}

// True if the therapist's rota window contains [starts_at, ends_at).
// Returns { working, window } so the caller can build a helpful message
// (e.g. "Anong works 14:00–18:00 on Tuesdays" or "Anong is off today").
async function isTherapistWorking(therapist_id, starts_at, ends_at) {
  const date = String(starts_at).slice(0, 10);
  const window = await getTherapistWorkingWindow(therapist_id, date);
  if (!window) return { working: false, window: null };
  const startMs = new Date(starts_at).getTime();
  const endMs   = new Date(ends_at).getTime();
  if (startMs < window.start || endMs > window.end) {
    return { working: false, window };
  }
  return { working: true, window };
}

// Return the YYYY-MM-DD calendar date in Europe/London for any Date/ms.
// Useful when computing "what calendar day is this UTC moment on for the spa".
function londonDateString(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SPA_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d instanceof Date ? d : new Date(d));
}

module.exports = {
  computeAvailability,
  getTherapistWorkingWindow,
  isTherapistWorking,
  buildAt,
  londonDateString,
  SPA_TZ,
};
