// SPA-LOYALTY-001 — loyalty card service ("every Nth visit free"), auto-
// tracked from the till. THE single owner of the loyalty maths; routes, sync
// and email all call into here so the counting rules live in exactly one place.
//
// ── The model ──────────────────────────────────────────────────────────────
// A "visit" = a PAID bill for a DIRECT booking. Treatwell/Fresha-sourced
// appointments never earn a stamp (deliberate channel-shift incentive: "book
// direct and every visit counts"). Counting starts at zero on launch day —
// history is not back-counted.
//
// The scheme is a LADDER of reward tiers, configured per spa in settings:
//   loyalty_enabled            '1' | '0'            (default off)
//   loyalty_tiers              JSON [{at_visit: 5, reward: "Free hot-oil
//                              upgrade", value: 15}, …] — `value` (£, optional)
//                              is auto-applied as a bill discount on redeem;
//                              without it the reward is free text staff honour.
//   loyalty_min_spend          minimum bill SUBTOTAL for the visit to count
//                              (list value, so a free reward visit still earns)
//   loyalty_repeat_after_last  '1' (default) — classic punch-card: when the
//                              ladder is complete AND fully redeemed, the card
//                              resets to 0 and a new cycle starts.
//
// State lives on clients (loyalty_visits, loyalty_cycle) with an append-only
// loyalty_events audit (earn / redeem / revoke / unredeem). Every event stores
// the counters before AND after, so:
//   • a local till's events ride the ordinary sync queue and the cloud applies
//     them DETERMINISTICALLY (set counters to the after-state — no re-deriving)
//   • a refund can restore the exact pre-earn state.
//
// A tier is "redeemed this cycle" when (#redeem − #unredeem) > 0 for that
// (client, cycle, tier_visit). The card ROLLS (visits→0, cycle+1) after any
// earn or redeem that leaves the ladder complete: repeat_after_last is on,
// visits ≥ the last tier, and every tier is redeemed.
//
// Checkout nuance: the classic "10th visit free" means the visit being paid
// RIGHT NOW is the one that earns the reward — so redemption may count the
// current (still unpaid) visit as visits+1 (`counting_current_visit`). The
// roll then happens when that bill's earn lands at pay time.
//
// Cloud vs till:
//   cloud mode — /pay runs here directly; email + Wallet push fire in-process.
//   local till — counters/events apply to SQLite instantly (works offline),
//   the event is enqueued and drained to POST /api/sync/push, and the CLOUD
//   sends the email + Wallet push when the event arrives (Brevo/APNs keys only
//   exist cloud-side).

const { pool } = require('../db/dbAdapter');
const offlineQueue = require('./offlineQueue');

const IS_LOCAL = (process.env.DB_MODE || 'cloud').toLowerCase() === 'local';
// Marketplace-sourced appointments never earn a stamp.
const NON_EARNING_SOURCES = new Set(['treatwell', 'fresha']);

// ── Config ─────────────────────────────────────────────────────────────────
async function getConfig(db = pool) {
  const r = await db.query(
    `SELECT key, value FROM settings
     WHERE key IN ('loyalty_enabled','loyalty_tiers','loyalty_min_spend','loyalty_repeat_after_last')`,
  );
  const kv = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  let tiers = [];
  try {
    const parsed = JSON.parse(kv.loyalty_tiers || '[]');
    if (Array.isArray(parsed)) {
      tiers = parsed
        .map((t) => ({
          at_visit: Math.trunc(Number(t.at_visit)),
          reward: String(t.reward || '').trim(),
          value: t.value != null && isFinite(Number(t.value)) ? +Number(t.value).toFixed(2) : null,
        }))
        .filter((t) => Number.isFinite(t.at_visit) && t.at_visit > 0 && t.reward)
        .sort((a, b) => a.at_visit - b.at_visit);
      // Duplicate at_visit values would make "redeemed this tier" ambiguous —
      // keep the first of each.
      tiers = tiers.filter((t, i) => i === 0 || t.at_visit !== tiers[i - 1].at_visit);
    }
  } catch { /* bad JSON → no tiers → nothing to earn toward */ }
  return {
    enabled: kv.loyalty_enabled === '1' || kv.loyalty_enabled === 'true',
    tiers,
    minSpend: isFinite(Number(kv.loyalty_min_spend)) ? Number(kv.loyalty_min_spend) : 0,
    repeatAfterLast: kv.loyalty_repeat_after_last == null
      ? true
      : (kv.loyalty_repeat_after_last === '1' || kv.loyalty_repeat_after_last === 'true'),
  };
}

// Which tiers are redeemed in the client's CURRENT cycle → Set of at_visit.
async function redeemedTierSet(clientId, cycle, db = pool) {
  const r = await db.query(
    `SELECT tier_visit,
            SUM(CASE WHEN type = 'redeem'   THEN 1 ELSE 0 END) AS redeems,
            SUM(CASE WHEN type = 'unredeem' THEN 1 ELSE 0 END) AS unredeems
     FROM loyalty_events
     WHERE client_id = $1 AND cycle = $2 AND type IN ('redeem','unredeem')
     GROUP BY tier_visit`,
    [clientId, cycle],
  );
  const set = new Set();
  for (const row of r.rows) {
    if (Number(row.redeems || 0) > Number(row.unredeems || 0)) set.add(Number(row.tier_visit));
  }
  return set;
}

// ── Status (drives the checkout banner, client card and Wallet pass) ───────
// countingCurrentVisit: treat the current, still-unpaid visit as visits+1 so
// the "10th visit free" is offerable while bill #10 is still open.
async function getStatus(clientId, { countingCurrentVisit = false } = {}, db = pool) {
  const cfg = await getConfig(db);
  const c = await db.query(
    `SELECT id, name, email, loyalty_visits, loyalty_cycle FROM clients WHERE id = $1`,
    [clientId],
  );
  if (!c.rows[0]) return null;
  const client = c.rows[0];
  const visits = Number(client.loyalty_visits || 0);
  const cycle = Number(client.loyalty_cycle || 0);
  if (!cfg.enabled) {
    return { enabled: false, client_id: client.id, visits, cycle };
  }
  const redeemed = await redeemedTierSet(clientId, cycle, db);
  const effective = visits + (countingCurrentVisit ? 1 : 0);
  const available = cfg.tiers.filter((t) => effective >= t.at_visit && !redeemed.has(t.at_visit));
  const next = cfg.tiers.find((t) => effective < t.at_visit && !redeemed.has(t.at_visit)) || null;
  return {
    enabled: true,
    client_id: client.id,
    client_name: client.name,
    visits,
    cycle,
    counting_current_visit: !!countingCurrentVisit,
    effective_visits: effective,
    tiers: cfg.tiers,
    redeemed_tiers: [...redeemed],
    available_rewards: available,
    next_tier: next,
    visits_to_next: next ? next.at_visit - effective : null,
    repeat_after_last: cfg.repeatAfterLast,
  };
}

// ── Roll check ─────────────────────────────────────────────────────────────
// The ladder is COMPLETE when visits have reached the last tier and every tier
// is redeemed. With repeat_after_last on, completion rolls the card.
async function shouldRoll(cfg, clientId, visits, cycle, db) {
  if (!cfg.repeatAfterLast || cfg.tiers.length === 0) return false;
  const last = cfg.tiers[cfg.tiers.length - 1];
  if (visits < last.at_visit) return false;
  const redeemed = await redeemedTierSet(clientId, cycle, db);
  return cfg.tiers.every((t) => redeemed.has(t.at_visit));
}

// Insert an event + set the client counters to its after-state, atomically.
async function writeEvent(ev, db) {
  const r = await db.query(
    `INSERT INTO loyalty_events
       (client_id, bill_id, type, visit_number, tier_visit, reward, cycle,
        visits_before, cycle_before, visits_after, cycle_after, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [ev.client_id, ev.bill_id ?? null, ev.type, ev.visit_number ?? null,
     ev.tier_visit ?? null, ev.reward ?? null, ev.cycle,
     ev.visits_before, ev.cycle_before, ev.visits_after, ev.cycle_after,
     ev.created_by ?? null],
  );
  await db.query(
    `UPDATE clients SET loyalty_visits = $2, loyalty_cycle = $3 WHERE id = $1`,
    [ev.client_id, ev.visits_after, ev.cycle_after],
  );
  return r.rows[0].id;
}

// ── Earn (called from POST /bills/:id/pay after the bill closes) ───────────
// Never throws — a loyalty hiccup must not break taking payment.
// Returns the earn outcome (or null when the visit didn't qualify) so the
// caller can surface "visit 7 — 3 more to go" on the payment response.
async function recordEarnForBill(billId, { staffId = null } = {}) {
  try {
    const cfg = await getConfig();
    if (!cfg.enabled) return null;

    const b = await pool.query(
      `SELECT b.id, b.subtotal, b.payment_status, a.client_id, a.source
       FROM bills b JOIN appointments a ON a.id = b.appointment_id
       WHERE b.id = $1`,
      [billId],
    );
    const bill = b.rows[0];
    if (!bill || bill.payment_status !== 'paid') return null;
    if (!bill.client_id) return null;                       // walk-in, no client card
    if (NON_EARNING_SOURCES.has(String(bill.source || '').toLowerCase())) return null;
    if (Number(bill.subtotal || 0) < cfg.minSpend) return null;

    // One earn per bill — pay is guarded against double-firing, but replays
    // (e.g. a sync retry) must not double-stamp.
    const dup = await pool.query(
      `SELECT id FROM loyalty_events WHERE bill_id = $1 AND type = 'earn' LIMIT 1`,
      [billId],
    );
    if (dup.rows[0]) return null;

    const client = await pool.connect();
    let eventId, ev;
    try {
      await client.query('BEGIN');
      const c = await client.query(
        `SELECT loyalty_visits, loyalty_cycle FROM clients WHERE id = $1`,
        [bill.client_id],
      );
      if (!c.rows[0]) { await client.query('ROLLBACK'); return null; }
      const visitsBefore = Number(c.rows[0].loyalty_visits || 0);
      const cycleBefore = Number(c.rows[0].loyalty_cycle || 0);
      const visitNumber = visitsBefore + 1;

      // Does this earn COMPLETE a fully-redeemed ladder? Then the card rolls.
      const rolls = await shouldRoll(cfg, bill.client_id, visitNumber, cycleBefore, client);
      ev = {
        client_id: bill.client_id, bill_id: billId, type: 'earn',
        visit_number: visitNumber, cycle: cycleBefore,
        visits_before: visitsBefore, cycle_before: cycleBefore,
        visits_after: rolls ? 0 : visitNumber,
        cycle_after: rolls ? cycleBefore + 1 : cycleBefore,
        created_by: staffId,
      };
      eventId = await writeEvent(ev, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    await afterLocalEvent(eventId);
    const status = await getStatus(bill.client_id);
    return { event_id: eventId, visit_number: ev.visit_number, rolled: ev.visits_after === 0, status };
  } catch (err) {
    console.error('[loyalty] earn failed (bill', billId + '):', err.message);
    return null;
  }
}

// ── Redeem (checkout one-tap) ──────────────────────────────────────────────
// Validates the tier is genuinely available, records the redeem, applies the
// tier's £ value to the (open) bill as a discount when both are present, and
// rolls the card when this redeem completes the ladder.
// countingCurrentVisit lets the visit being paid right now count (see header).
async function redeemTier({ clientId, tierVisit, billId = null, staffId = null, countingCurrentVisit = false }) {
  const cfg = await getConfig();
  if (!cfg.enabled) { const e = new Error('loyalty is not enabled'); e.status = 400; throw e; }
  const tier = cfg.tiers.find((t) => t.at_visit === Number(tierVisit));
  if (!tier) { const e = new Error('unknown reward tier'); e.status = 400; throw e; }

  const status = await getStatus(clientId, { countingCurrentVisit });
  if (!status) { const e = new Error('client not found'); e.status = 404; throw e; }
  const available = status.available_rewards.some((t) => t.at_visit === tier.at_visit);
  if (!available) {
    const e = new Error(status.redeemed_tiers.includes(tier.at_visit)
      ? 'reward already redeemed this cycle'
      : `not there yet — ${status.visits_to_next ?? '?'} more visit(s) needed`);
    e.status = 409;
    throw e;
  }

  // Optional: auto-apply the tier's £ value to the open bill (mirrors the
  // discount route's rules — unpaid bills only, clamped to subtotal).
  let discountApplied = null;
  if (billId != null && tier.value != null && tier.value > 0) {
    const bres = await pool.query(
      `SELECT b.subtotal, b.payment_status, COALESCE(b.discount, 0) AS discount, a.client_id
       FROM bills b JOIN appointments a ON a.id = b.appointment_id WHERE b.id = $1`,
      [billId],
    );
    const bill = bres.rows[0];
    if (!bill) { const e = new Error('bill not found'); e.status = 404; throw e; }
    if (Number(bill.client_id) !== Number(clientId)) { const e = new Error('bill belongs to a different client'); e.status = 400; throw e; }
    if (bill.payment_status === 'paid') { const e = new Error('bill is already paid'); e.status = 409; throw e; }
    const subtotal = Number(bill.subtotal || 0);
    const newDiscount = +Math.min(Number(bill.discount || 0) + tier.value, subtotal).toFixed(2);
    // Same recompute as PUT /bills/:id/discount so the resulting row is
    // structurally identical to a hand-entered discount.
    await pool.query(
      `UPDATE bills SET discount = $2,
              discount_reason = $3,
              total = subtotal - $2 + COALESCE(tip, 0) - COALESCE(already_paid, 0)
       WHERE id = $1`,
      [billId, newDiscount, `Loyalty reward — ${tier.reward}`],
    );
    discountApplied = newDiscount;
  }

  const client = await pool.connect();
  let eventId, ev;
  try {
    await client.query('BEGIN');
    const c = await client.query(`SELECT loyalty_visits, loyalty_cycle FROM clients WHERE id = $1`, [clientId]);
    const visitsBefore = Number(c.rows[0].loyalty_visits || 0);
    const cycleBefore = Number(c.rows[0].loyalty_cycle || 0);

    ev = {
      client_id: clientId, bill_id: billId, type: 'redeem',
      visit_number: visitsBefore, tier_visit: tier.at_visit, reward: tier.reward,
      cycle: cycleBefore,
      visits_before: visitsBefore, cycle_before: cycleBefore,
      visits_after: visitsBefore, cycle_after: cycleBefore, // may roll below
      created_by: staffId,
    };
    eventId = await writeEvent(ev, client);

    // Roll if this redeem completed the ladder (visits already ≥ last tier —
    // the "saved it up" case; the pay-time earn handles the classic case).
    if (await shouldRoll(cfg, clientId, visitsBefore, cycleBefore, client)) {
      await client.query(
        `UPDATE loyalty_events SET visits_after = 0, cycle_after = $2 WHERE id = $1`,
        [eventId, cycleBefore + 1],
      );
      await client.query(
        `UPDATE clients SET loyalty_visits = 0, loyalty_cycle = $2 WHERE id = $1`,
        [clientId, cycleBefore + 1],
      );
      ev.visits_after = 0; ev.cycle_after = cycleBefore + 1;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  await afterLocalEvent(eventId);
  return {
    event_id: eventId,
    reward: tier.reward,
    tier_visit: tier.at_visit,
    discount_applied: discountApplied,
    rolled: ev.visits_after === 0 && ev.visits_before > 0,
    status: await getStatus(clientId),
  };
}

// ── Reversal (bill refunded or deleted) ────────────────────────────────────
// Puts the counters back for any earn tied to the bill, and un-redeems any
// reward that was applied to it. If the event being reversed is the client's
// LATEST loyalty event we restore its exact before-state (including a rolled
// cycle); otherwise later activity has moved the counters on, so we fall back
// to a best-effort decrement, floored at 0. Never throws.
async function revokeForBill(billId, { staffId = null } = {}) {
  try {
    const evs = await pool.query(
      `SELECT * FROM loyalty_events WHERE bill_id = $1 AND type IN ('earn','redeem') ORDER BY id`,
      [billId],
    );
    if (evs.rows.length === 0) return null;
    return await revokeEventList(evs.rows, { staffId, undoBillId: billId, checkDone: true });
  } catch (err) {
    console.error('[loyalty] revokeForBill failed:', err.message);
    return null;
  }
}

// Bill-DELETE path: the bill row is about to vanish (loyalty_events.bill_id
// goes NULL via the FK), so the caller captures the event ids inside its
// transaction and hands them here AFTER commit. Undo rows carry bill_id NULL.
async function revokeEventsById(ids, { staffId = null } = {}) {
  try {
    if (!Array.isArray(ids) || ids.length === 0) return null;
    const evs = await pool.query(
      `SELECT * FROM loyalty_events WHERE id = ANY($1) AND type IN ('earn','redeem') ORDER BY id`,
      [ids],
    );
    if (evs.rows.length === 0) return null;
    return await revokeEventList(evs.rows, { staffId, undoBillId: null, checkDone: false });
  } catch (err) {
    console.error('[loyalty] revokeEventsById failed:', err.message);
    return null;
  }
}

async function revokeEventList(origEvents, { staffId, undoBillId, checkDone }) {
    const out = [];
    for (const orig of origEvents) {
      // Skip if already reversed once (refund path only — a deleted bill's
      // events can't be re-found, so its reversal runs exactly once inline).
      const undoType = orig.type === 'earn' ? 'revoke' : 'unredeem';
      if (checkDone) {
        const done = await pool.query(
          `SELECT id FROM loyalty_events
           WHERE bill_id = $1 AND type = $2 AND tier_visit IS NOT DISTINCT FROM $3 LIMIT 1`,
          [undoBillId, undoType, orig.tier_visit ?? null],
        );
        if (done.rows[0]) continue;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const c = await client.query(`SELECT loyalty_visits, loyalty_cycle FROM clients WHERE id = $1`, [orig.client_id]);
        if (!c.rows[0]) { await client.query('ROLLBACK'); continue; }
        const visitsNow = Number(c.rows[0].loyalty_visits || 0);
        const cycleNow = Number(c.rows[0].loyalty_cycle || 0);
        const latest = await client.query(
          `SELECT id FROM loyalty_events WHERE client_id = $1 ORDER BY id DESC LIMIT 1`,
          [orig.client_id],
        );
        const isLatest = latest.rows[0] && Number(latest.rows[0].id) === Number(orig.id);

        let visitsAfter, cycleAfter;
        if (isLatest) {
          visitsAfter = Number(orig.visits_before);
          cycleAfter = Number(orig.cycle_before);
        } else if (orig.type === 'earn') {
          visitsAfter = Math.max(0, visitsNow - 1);
          cycleAfter = cycleNow;
        } else {
          visitsAfter = visitsNow;   // unredeem doesn't change the count —
          cycleAfter = cycleNow;     // it just frees the tier again
        }
        const eventId = await writeEvent({
          client_id: orig.client_id, bill_id: undoBillId, type: undoType,
          visit_number: orig.visit_number, tier_visit: orig.tier_visit,
          reward: orig.reward,
          cycle: Number(orig.cycle),   // counts against the SAME cycle as the original
          visits_before: visitsNow, cycle_before: cycleNow,
          visits_after: visitsAfter, cycle_after: cycleAfter,
          created_by: staffId,
        }, client);
        await client.query('COMMIT');
        out.push(eventId);
        await afterLocalEvent(eventId);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[loyalty] revoke failed (event', orig.id + '):', e.message);
      } finally {
        client.release();
      }
    }
    return out.length ? out : null;
}

// ── After an event lands LOCALLY ───────────────────────────────────────────
// Local till → enqueue for the sync drain (the CLOUD then emails/pushes when
// it arrives). Cloud → fire the notifications right here.
async function afterLocalEvent(eventId) {
  if (IS_LOCAL) {
    await offlineQueue.enqueue('loyalty_event', { localId: eventId });
    return;
  }
  notifyForEvent(eventId).catch((e) => console.error('[loyalty] notify failed:', e.message));
}

// ── Cloud-side apply for a synced event (called from sync.js /push) ────────
// The event row arrives with client_id/bill_id already remapped to cloud ids.
// Insert it and set the counters to its after-state — deterministic, no
// re-deriving (the till already ran the maths; events arrive in order).
async function applySyncedEvent(data, db) {
  const r = await db.query(
    `INSERT INTO loyalty_events
       (client_id, bill_id, type, visit_number, tier_visit, reward, cycle,
        visits_before, cycle_before, visits_after, cycle_after, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, COALESCE($13, now()))
     RETURNING id`,
    [data.client_id, data.bill_id ?? null, data.type, data.visit_number ?? null,
     data.tier_visit ?? null, data.reward ?? null, data.cycle ?? 0,
     data.visits_before ?? null, data.cycle_before ?? null,
     data.visits_after ?? null, data.cycle_after ?? null,
     data.created_by ?? null, data.created_at ?? null],
  );
  if (data.visits_after != null) {
    await db.query(
      `UPDATE clients SET loyalty_visits = $2, loyalty_cycle = COALESCE($3, loyalty_cycle)
       WHERE id = $1`,
      [data.client_id, data.visits_after, data.cycle_after ?? null],
    );
  }
  return r.rows[0].id;
}

// ── Notifications (cloud only): progress email + Wallet pass push ──────────
// Lazy-required to avoid import cycles (emailService ↔ wallet modules).
async function notifyForEvent(eventId) {
  const ev = await pool.query(`SELECT * FROM loyalty_events WHERE id = $1`, [eventId]);
  const event = ev.rows[0];
  if (!event) return;

  // Wallet: any change to the counters is a pass-content change.
  try {
    const { bumpLoyaltyPass } = require('./walletPush');
    await bumpLoyaltyPass(event.client_id);
  } catch (e) {
    console.error('[loyalty] wallet bump failed:', e.message);
  }

  // Email: earns only (progress is the point; revokes would just confuse).
  if (event.type !== 'earn') return;
  try {
    const c = await pool.query(`SELECT * FROM clients WHERE id = $1`, [event.client_id]);
    const client = c.rows[0];
    if (!client || !client.email || client.unsubscribed_at) return;
    const status = await getStatus(event.client_id);
    if (!status || !status.enabled) return;
    const { sendLoyaltyProgress } = require('./emailService');
    await sendLoyaltyProgress({
      client,
      visitNumber: Number(event.visit_number),
      rolled: Number(event.visits_after) === 0 && Number(event.visits_before) > 0,
      status,
    });
  } catch (e) {
    console.error('[loyalty] progress email failed:', e.message);
  }
}

module.exports = {
  getConfig,
  getStatus,
  recordEarnForBill,
  redeemTier,
  revokeForBill,
  revokeEventsById,
  applySyncedEvent,
  notifyForEvent,
};
