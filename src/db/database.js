// PostgreSQL pool + schema for SiamEPOS Spa.
// Always use $1 $2 params and pool.query() in the rest of the codebase.

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('[db] DATABASE_URL not set — pool will fail to connect.');
}

// Railway requires SSL in production. Locally most installs don't, so we
// only flip SSL on when DATABASE_URL points at a non-localhost host.
const needsSsl = !!connectionString && !/localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('[db] unexpected pool error:', err);
});

async function query(text, params) {
  return pool.query(text, params);
}

// ---------------------------------------------------------------------------
// Schema — see SEPOS-SPA-001 ticket, Section 4.
// All CREATEs use IF NOT EXISTS. Any future column additions in this file
// MUST use ALTER TABLE … ADD COLUMN IF NOT EXISTS so re-running is safe.
// ---------------------------------------------------------------------------
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS treatment_categories (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      sort_order  INT  NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS treatments (
      id                SERIAL PRIMARY KEY,
      category_id       INT REFERENCES treatment_categories(id) ON DELETE SET NULL,
      name              TEXT NOT NULL,
      duration_minutes  INT  NOT NULL,
      price             NUMERIC(10,2) NOT NULL DEFAULT 0,
      description       TEXT,
      active            BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS therapists (
      id      SERIAL PRIMARY KEY,
      name    TEXT NOT NULL,
      pin     TEXT NOT NULL,
      role    TEXT NOT NULL DEFAULT 'therapist',
      active  BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS therapist_availability (
      id            SERIAL PRIMARY KEY,
      therapist_id  INT  NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
      day_of_week   INT  NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      start_time    TIME NOT NULL,
      end_time      TIME NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id      SERIAL PRIMARY KEY,
      name    TEXT NOT NULL,
      active  BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS clients (
      id                       SERIAL PRIMARY KEY,
      name                     TEXT NOT NULL,
      phone                    TEXT,
      email                    TEXT,
      date_of_birth            DATE,
      emergency_contact_name   TEXT,
      emergency_contact_phone  TEXT,
      gp_name                  TEXT,
      gp_surgery               TEXT,
      gdpr_consent             BOOLEAN NOT NULL DEFAULT FALSE,
      gdpr_consent_at          TIMESTAMPTZ,
      marketing_consent        BOOLEAN NOT NULL DEFAULT FALSE,
      notes                    TEXT,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS client_medical (
      id                      SERIAL PRIMARY KEY,
      client_id               INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      pregnancy               BOOLEAN NOT NULL DEFAULT FALSE,
      heart_condition         BOOLEAN NOT NULL DEFAULT FALSE,
      blood_pressure          TEXT    NOT NULL DEFAULT 'none',
      diabetes                BOOLEAN NOT NULL DEFAULT FALSE,
      epilepsy                BOOLEAN NOT NULL DEFAULT FALSE,
      cancer                  BOOLEAN NOT NULL DEFAULT FALSE,
      dvt                     BOOLEAN NOT NULL DEFAULT FALSE,
      recent_surgery          BOOLEAN NOT NULL DEFAULT FALSE,
      bone_fracture           BOOLEAN NOT NULL DEFAULT FALSE,
      skin_condition          BOOLEAN NOT NULL DEFAULT FALSE,
      varicose_veins          BOOLEAN NOT NULL DEFAULT FALSE,
      osteoporosis            BOOLEAN NOT NULL DEFAULT FALSE,
      lymphoedema             BOOLEAN NOT NULL DEFAULT FALSE,
      medications             TEXT,
      allergies               TEXT,
      areas_to_avoid          TEXT,
      skin_conditions_detail  TEXT,
      digital_signature       TEXT,
      signed_at               TIMESTAMPTZ,
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id            SERIAL PRIMARY KEY,
      client_id     INT REFERENCES clients(id)    ON DELETE SET NULL,
      treatment_id  INT REFERENCES treatments(id) ON DELETE SET NULL,
      therapist_id  INT REFERENCES therapists(id) ON DELETE SET NULL,
      room_id       INT REFERENCES rooms(id)      ON DELETE SET NULL,
      starts_at     TIMESTAMPTZ NOT NULL,
      ends_at       TIMESTAMPTZ NOT NULL,
      status        TEXT NOT NULL DEFAULT 'booked',
      source        TEXT NOT NULL DEFAULT 'walkin',
      notes         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS bills (
      id                        SERIAL PRIMARY KEY,
      appointment_id            INT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      subtotal                  NUMERIC(10,2) NOT NULL DEFAULT 0,
      tip                       NUMERIC(10,2) NOT NULL DEFAULT 0,
      total                     NUMERIC(10,2) NOT NULL DEFAULT 0,
      payment_method            TEXT,
      payment_status            TEXT NOT NULL DEFAULT 'pending',
      stripe_payment_intent_id  TEXT,
      closed_at                 TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY,
      value  TEXT
    );
  `);

  // ── appointments new columns ────────────────────────────────────────────
  await pool.query(`
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS therapist_requested BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  // SPA-TREATMENT-VISIBILITY — control which treatments appear on the
  // public booking widget. Defaults TRUE so existing treatments stay
  // available; operator unticks "Show on online booking" in the admin
  // to hide a treatment from customers without hiding it from staff.
  await pool.query(`
    ALTER TABLE treatments ADD COLUMN IF NOT EXISTS online_bookable BOOLEAN NOT NULL DEFAULT TRUE;
  `);

  // Indexes for common queries.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_appointments_starts_at    ON appointments (starts_at);
    CREATE INDEX IF NOT EXISTS idx_appointments_client_id    ON appointments (client_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_therapist_id ON appointments (therapist_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_status       ON appointments (status);
    CREATE INDEX IF NOT EXISTS idx_bills_appointment_id      ON bills (appointment_id);
    CREATE INDEX IF NOT EXISTS idx_bills_closed_at           ON bills (closed_at);
    CREATE INDEX IF NOT EXISTS idx_client_medical_client_id  ON client_medical (client_id);
    CREATE INDEX IF NOT EXISTS idx_clients_phone             ON clients (phone);
    CREATE INDEX IF NOT EXISTS idx_clients_email             ON clients (email);
    CREATE INDEX IF NOT EXISTS idx_therapist_avail_t_id      ON therapist_availability (therapist_id);
  `);

  // Default settings — only inserted if the key is missing.
  await pool.query(`
    INSERT INTO settings (key, value) VALUES
      ('spa_name',                 $1),
      ('spa_email',                $2),
      ('booking_advance_days',     '30'),
      ('booking_slot_minutes',     '15'),
      ('opening_time',             '10:00'),
      ('closing_time',             '20:00'),
      ('cancellation_policy_text', 'Please give 24 hours notice for cancellations.'),
      ('tip_suggestions',          '10,12.5,15'),
      ('vat_rate',                 '0')
    ON CONFLICT (key) DO NOTHING;
  `, [process.env.SPA_NAME || 'SiamEPOS Spa', process.env.SPA_EMAIL || 'info@siamepos.co.uk']);

  // ── client_medical new columns (intake form expansion) ──────────────────
  const medicalCols = [
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS areas_of_swelling      BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS autoimmune_disorder     BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS back_neck_problems      BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS bleeding_disorders      BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS blood_clots             BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS bruise_easily           BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS bursitis                BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS contagious_condition    BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS decreased_sensation     BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS fibromyalgia            BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS headaches               BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS hypertension            BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS kidney_disease          BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS multiple_sclerosis      BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS neurological_condition  BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS neuropathy              BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS osteoarthritis          BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS phlebitis               BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS sciatica                BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS seizures                BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS stroke                  BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS tendinitis              BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS tmj_disorder            BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS vertigo_dizziness       BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS pregnancy_months        TEXT`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS pregnancy_due_date      TEXT`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS under_medical_supervision BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS medical_supervision_detail TEXT`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS broken_skin             BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS broken_skin_where       TEXT`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS joint_replacement       BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS joint_replacement_detail TEXT`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS recent_injuries_yn      BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS recent_injuries_detail  TEXT`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS other_conditions        TEXT`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS had_massage_before      BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS massage_recency         TEXT`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS reason_for_massage      TEXT`,
    `ALTER TABLE client_medical ADD COLUMN IF NOT EXISTS pressure_preference     TEXT`,
  ];
  for (const sql of medicalCols) { await pool.query(sql); }

  // ── therapists new columns (booking-widget picker) ──────────────────────
  await pool.query(`
    ALTER TABLE therapists ADD COLUMN IF NOT EXISTS specialisms TEXT;
    ALTER TABLE therapists ADD COLUMN IF NOT EXISTS photo_url   TEXT;
  `);

  // ── SPA-003: Treatwell integration ──────────────────────────────────────
  // Treatwell pushes bookings to our webhook; we dedup by their booking id
  // so a re-delivery (Treatwell retries on non-2xx) doesn't double-book.
  // appointments.source already exists (default 'walkin'); the new value
  // 'treatwell' is a plain text token, no enum to extend.
  await pool.query(`
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS treatwell_booking_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_treatwell_booking_id
      ON appointments (treatwell_booking_id)
      WHERE treatwell_booking_id IS NOT NULL;
  `);

  // ── SPA-CAMPAIGNS-001: email campaigns + unsubscribe ────────────────────
  // Campaigns are sent via Brevo to segments of opted-in clients. We track
  // who unsubscribes (via HMAC-signed token clicked from inside an email)
  // so they're permanently removed from the campaign audience even if the
  // operator later re-toggles their marketing_consent — the unsubscribed_at
  // stamp wins.
  await pool.query(`
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS campaigns (
      id              SERIAL PRIMARY KEY,
      subject         TEXT NOT NULL,
      body            TEXT NOT NULL,
      segment         TEXT NOT NULL,
      recipient_count INT  NOT NULL DEFAULT 0,
      sent_count      INT  NOT NULL DEFAULT 0,
      failed_count    INT  NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON campaigns (created_at DESC);
  `);

  // ── SPA-ROTA-001 — therapist rota overrides ─────────────────────────────
  // Date-specific schedule changes: day off, or different start/end hours.
  // is_working=FALSE means the therapist is off that day entirely.
  // is_working=TRUE with start_time/end_time overrides the weekly template.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS therapist_rota_overrides (
      id            SERIAL PRIMARY KEY,
      therapist_id  INT  NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
      date          DATE NOT NULL,
      is_working    BOOLEAN NOT NULL DEFAULT FALSE,
      start_time    TIME,
      end_time      TIME,
      note          TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (therapist_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_rota_overrides_therapist_date
      ON therapist_rota_overrides (therapist_id, date);
  `);

  // ── SPA-VOUCHER-001 — gift vouchers ─────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vouchers (
      id              SERIAL PRIMARY KEY,
      code            TEXT NOT NULL UNIQUE,
      initial_value   NUMERIC(10,2) NOT NULL,
      remaining_value NUMERIC(10,2) NOT NULL,
      purchased_by    TEXT,
      purchased_for   TEXT,
      client_id       INT REFERENCES clients(id) ON DELETE SET NULL,
      purchased_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at      DATE,
      status          TEXT NOT NULL DEFAULT 'active',
      notes           TEXT,
      sold_by         INT REFERENCES therapists(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS voucher_redemptions (
      id            SERIAL PRIMARY KEY,
      voucher_id    INT NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
      bill_id       INT REFERENCES bills(id) ON DELETE SET NULL,
      amount_used   NUMERIC(10,2) NOT NULL,
      redeemed_by   INT REFERENCES therapists(id) ON DELETE SET NULL,
      redeemed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      notes         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_vouchers_code      ON vouchers (code);
    CREATE INDEX IF NOT EXISTS idx_vouchers_client_id ON vouchers (client_id);
    CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_voucher_id ON voucher_redemptions (voucher_id);
  `);

  // ── vouchers migration (existing DBs) ────────────────────────────────────
  await pool.query(`
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS sold_by INT REFERENCES therapists(id) ON DELETE SET NULL;
  `);

  // ── SPA-VOUCHER-002 — session-based vouchers ─────────────────────────────
  // Shops sell "10-session Thai Massage" bundles alongside money vouchers.
  // voucher_type='monetary' (default) keeps existing behaviour: spend the
  // £ balance against any bill. voucher_type='sessions' consumes one
  // session per redemption regardless of the bill amount; the bill is
  // closed via method='voucher' without taking cash.
  //
  // treatment_id NULL = "any treatment" (multi-treatment bundle).
  // initial_value still represents what the customer PAID — useful for
  // accounting + the sales report — even for session vouchers.
  await pool.query(`
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS voucher_type        TEXT NOT NULL DEFAULT 'monetary';
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS total_sessions      INT;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS sessions_remaining  INT;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS treatment_id        INT REFERENCES treatments(id) ON DELETE SET NULL;

    ALTER TABLE voucher_redemptions ADD COLUMN IF NOT EXISTS sessions_used INT NOT NULL DEFAULT 0;

    -- SPA-BILL-ITEMS: when a bill is refunded, the gift-voucher redemptions
    -- taken against it are reversed (balance / sessions restored) and stamped
    -- here so they're not reversed twice and reports can tell them apart.
    ALTER TABLE voucher_redemptions ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

    -- SPA-VOUCHER-003: recipient email so the voucher can be delivered
    -- by email at point of sale (also used for a "Resend" later).
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS recipient_email TEXT;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS email_sent_at   TIMESTAMPTZ;

    -- SPA-VOUCHER-004: payment method on voucher sale.
    -- Selling a voucher takes real cash/card from the customer, so we
    -- record it here. NULL is allowed for legacy rows; new sales are
    -- required to set this (enforced in the API + admin form).
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS payment_method TEXT;

    -- SPA-SEC-001: Stripe PaymentIntent backing an online voucher purchase.
    -- Lets the public /api/widget/vouchers endpoint verify a real payment
    -- and reject re-use of the same intent (unique). NULL for till sales.
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_stripe_pi
      ON vouchers (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

    -- SPA-SPLIT-001: per-method breakdown on a split-paid bill so the
    -- daily report can attribute the cash portion to "cash" and the
    -- card portion to "card" instead of dumping the whole thing in a
    -- "split" bucket. JSONB array of { method, amount }.
    ALTER TABLE bills ADD COLUMN IF NOT EXISTS split_payments JSONB;

    -- SPA-DISCOUNT — whole-bill discount in £. discount_reason stores
    -- the receptionist's free-text note ("VIP 10%", "Loyalty",
    -- "Senior", etc.). Default 0 so existing maths is unchanged.
    ALTER TABLE bills ADD COLUMN IF NOT EXISTS discount        NUMERIC(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE bills ADD COLUMN IF NOT EXISTS discount_reason TEXT;

    -- SPA-BILL-ITEMS — line items on a bill so a single checkout can carry
    -- the treatment PLUS retail products (oils, candles), add-ons /
    -- upgrades (+15 min, hot stone), or extra services. The treatment line
    -- is seeded automatically when the bill is created; bills.subtotal is
    -- kept in sync as SUM(line_total) so every existing report that reads
    -- bills.subtotal / bills.total keeps working unchanged.
    --   kind: 'treatment' | 'retail' | 'addon'
    ALTER TABLE bills ADD COLUMN IF NOT EXISTS refunded_at   TIMESTAMPTZ;
    ALTER TABLE bills ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(10,2);
    ALTER TABLE bills ADD COLUMN IF NOT EXISTS refund_reason TEXT;

    -- SPA-EXT-VOUCHER — a voucher the customer holds from BEFORE they moved to
    -- SiamEPOS (no record in our vouchers table). Staff record the code here
    -- when taking a voucher payment so there's an audit trail, without a
    -- SiamEPOS voucher redemption.
    ALTER TABLE bills ADD COLUMN IF NOT EXISTS external_voucher_code TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bill_items (
      id          SERIAL PRIMARY KEY,
      bill_id     INT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL DEFAULT 'retail',
      name        TEXT NOT NULL,
      quantity    INT  NOT NULL DEFAULT 1,
      unit_price  NUMERIC(10,2) NOT NULL DEFAULT 0,
      line_total  NUMERIC(10,2) NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_bill_items_bill_id ON bill_items (bill_id);
  `);

  // SPA-BILL-ITEMS — at most one 'treatment' line per bill. Dedupe any rows a
  // concurrent self-heal might already have created (keep the lowest id), then
  // a partial unique index makes the seed INSERT ... ON CONFLICT race-safe.
  await pool.query(`
    DELETE FROM bill_items a USING bill_items b
     WHERE a.kind = 'treatment' AND b.kind = 'treatment'
       AND a.bill_id = b.bill_id AND a.id > b.id;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bill_items_one_treatment
      ON bill_items (bill_id) WHERE kind = 'treatment';
  `);

  await pool.query(`
    -- (placeholder block kept so the trailing migrations below still run)
    SELECT 1;

    -- SPA-TREATWELL-COLOR — Treatwell bookings come in two flavours:
    -- 'full'    = customer prepaid the full price to Treatwell
    --              (the spa just closes the bill at £0 — Treatwell
    --              settles to the bank net of commission)
    -- 'partial' = customer paid a deposit only to Treatwell; spa
    --              collects the balance at the till.
    -- NULL = legacy / non-treatwell. Used to drive the colour
    -- distinction the operator asked for on the timeline.
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS treatwell_payment_type TEXT;

    -- SPA-PAY-001: online booking deposit + self-service amendments.
    -- deposit_amount = what the customer prepaid via Stripe when they
    -- booked online. deposit_stripe_id = the PaymentIntent ref so we
    -- can issue a refund later. payment_status tracks the deposit
    -- lifecycle: 'none' | 'deposit_paid' | 'refunded' | 'forfeit' |
    -- 'fully_paid'. The bill at checkout subtracts the deposit from
    -- the total — the operator collects only the balance.
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_amount    NUMERIC(10,2);
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_stripe_id TEXT;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_status    TEXT NOT NULL DEFAULT 'none';

    -- SPA-DEPOSIT-MANUAL — when the receptionist takes a deposit by
    -- cash or card at the till (e.g. customer phones, pays £25 over
    -- the phone via card terminal, or pops in to pay a deposit in
    -- person), we record HOW the deposit was taken and WHEN. Stripe
    -- deposits leave these NULL; the deposit_stripe_id is the canonical
    -- signal that the deposit was online.
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_method   TEXT;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_taken_at TIMESTAMPTZ;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_taken_by INT REFERENCES therapists(id) ON DELETE SET NULL;

    -- SPA-TURN-ORDER — receptionist-set column order on the timeline,
    -- per date. The "who's next in line" rotation common in Thai spas
    -- (whoever arrived first that day gets the first walk-in's turn).
    -- One row per (therapist, date); the row's position is 1-based.
    CREATE TABLE IF NOT EXISTS therapist_turn_order (
      date          DATE NOT NULL,
      therapist_id  INT  NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
      position      INT  NOT NULL,
      set_by        INT  REFERENCES therapists(id) ON DELETE SET NULL,
      set_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (date, therapist_id)
    );
    CREATE INDEX IF NOT EXISTS idx_turn_order_date ON therapist_turn_order (date);

    -- SPA-PRICE-SNAPSHOT — capture treatment price AT BOOKING TIME so
    -- edits to the treatment's price don't retroactively change a
    -- customer's bill. Previously the bill read treatments.price live
    -- at checkout — change the price between booking and checkout and
    -- the customer paid the new price. Now the booking carries the
    -- quoted price; the bill reads it with a fallback to the live
    -- treatment price for legacy bookings.
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS price_at_booking NUMERIC(10,2);

    -- Backfill existing rows so the column is never NULL going forward.
    -- For past bookings the "right" price is unknowable; we set the
    -- current treatment price (same value the bill would have computed
    -- under the old code path). No behavioural change for past
    -- bookings; locked-in pricing for everything new.
    UPDATE appointments a
       SET price_at_booking = t.price
      FROM treatments t
     WHERE a.treatment_id = t.id
       AND a.price_at_booking IS NULL;

    -- Audit log so the spa knows who changed what and when (whether
    -- the customer self-serviced via the manage-link, or the
    -- receptionist edited from admin).
    CREATE TABLE IF NOT EXISTS appointment_amendments (
      id              SERIAL PRIMARY KEY,
      appointment_id  INT  NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,                -- 'rescheduled' | 'cancelled' | 'therapist_changed' | 'refunded'
      from_value      TEXT,                          -- e.g. previous starts_at, previous therapist
      to_value        TEXT,                          -- new value
      by_customer     BOOLEAN NOT NULL DEFAULT FALSE,
      by_staff_id     INT REFERENCES therapists(id) ON DELETE SET NULL,
      note            TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_appt_amendments_appointment_id ON appointment_amendments (appointment_id);

    -- Seed default treatment rooms if none exist yet.
    INSERT INTO rooms (name, active)
    SELECT name, TRUE FROM (VALUES ('Lotus'),('Jasmine'),('Orchid')) AS r(name)
    WHERE NOT EXISTS (SELECT 1 FROM rooms LIMIT 1);

    -- Default policy settings (no-op if already present).
    INSERT INTO settings (key, value) VALUES
      ('deposit_model',         'fixed_amount'),
      ('deposit_amount',        '25'),
      ('deposit_percentage',    '25'),
      ('cancel_window_hours',   '24'),
      ('cancel_policy_text',    'Cancellations within 24 hours of your appointment forfeit the deposit. We''re happy to reschedule any time before then.')
    ON CONFLICT (key) DO NOTHING;

    -- Seed default 7-day rota (10:00–20:00) for any therapist that has
    -- no rota entries at all. This keeps demos working out-of-the-box and
    -- is a safe no-op for therapists who already have a rota configured.
    INSERT INTO therapist_availability (therapist_id, day_of_week, start_time, end_time)
    SELECT t.id, d.day, '10:00', '20:00'
    FROM   therapists t
    CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5),(6)) AS d(day)
    WHERE  t.active = TRUE
    AND    NOT EXISTS (
             SELECT 1 FROM therapist_availability a WHERE a.therapist_id = t.id
           )
    ON CONFLICT DO NOTHING;

    -- Fill in any missing days for therapists whose rota is incomplete
    -- (has some days but not all 7). Only adds missing rows — never
    -- overwrites days the operator has explicitly configured.
    INSERT INTO therapist_availability (therapist_id, day_of_week, start_time, end_time)
    SELECT t.id, d.day, '10:00', '20:00'
    FROM   therapists t
    CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5),(6)) AS d(day)
    WHERE  t.active = TRUE
    AND    EXISTS (
             SELECT 1 FROM therapist_availability a WHERE a.therapist_id = t.id
           )
    AND    NOT EXISTS (
             SELECT 1 FROM therapist_availability a
             WHERE  a.therapist_id = t.id AND a.day_of_week = d.day
           )
    ON CONFLICT DO NOTHING;
  `);

  // ── SEPOS-SPA-PRO-001 Phase B — offline push idempotency ────────────────
  // The cloud records every op_key it has applied from a desktop till's push
  // queue, so a retried push (after a flaky connection) never double-creates a
  // booking/bill. On a repeat op_key we return the stored cloud_id instead of
  // re-applying. Lives on the cloud only; the local till has sync_queue.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_applied_ops (
      op_key      TEXT PRIMARY KEY,
      action      TEXT NOT NULL,
      cloud_id    INT,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // GDPR erasure propagation (B4). Every permanent client deletion is recorded
  // here so each offline desktop till can pull the tombstone and wipe its local
  // (encrypted) copy too — erasure must reach every device, not just the cloud.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deleted_records (
      id          SERIAL PRIMARY KEY,
      entity      TEXT NOT NULL,
      cloud_id    INT  NOT NULL,
      deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_deleted_records_deleted_at ON deleted_records (deleted_at);
  `);

  // ── Payment links (SEPOS-SPA-PAYLINK-001, Phase 1) ──────────────────────
  // Staff-generated one-off Stripe Checkout links (ad-hoc custom amount). The
  // status is reconciled by the checkout.session.completed webhook AND by an
  // on-demand refresh in GET /api/payment-links, so it works on the cloud and
  // the local till regardless of webhook delivery.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_links (
      id                SERIAL PRIMARY KEY,
      purpose           TEXT NOT NULL DEFAULT 'adhoc',
      amount            NUMERIC(10,2) NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'gbp',
      description       TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | cancelled | expired
      stripe_session_id TEXT UNIQUE,
      url               TEXT,
      customer_email    TEXT,
      appointment_id    INT REFERENCES appointments(id) ON DELETE SET NULL,  -- set for a 'deposit' link tied to a phone booking
      created_by        INT REFERENCES therapists(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at        TIMESTAMPTZ,
      paid_at           TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_payment_links_created_at ON payment_links (created_at);
    -- Older deploys created payment_links before appointment_id existed.
    ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS appointment_id INT REFERENCES appointments(id) ON DELETE SET NULL;
  `);

  // ── Device heartbeat (SEPOS-SPA-LICENSE-001 Part B) ─────────────────────
  // Each installed desktop till POSTs /api/device/heartbeat; ops reads these
  // back via /api/health to track installed devices + their version + last-seen.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id   TEXT PRIMARY KEY,
      spa_id      TEXT,
      app_version TEXT,
      platform    TEXT,
      last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices (last_seen);
  `);

  console.log('[db] schema ready');
}

module.exports = { pool, query, initSchema };
