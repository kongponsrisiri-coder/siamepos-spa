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
  `);

  console.log('[db] schema ready');
}

module.exports = { pool, query, initSchema };
