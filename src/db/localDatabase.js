// ===========================================================================
// SiamEPOS Spa — LOCAL (SQLite) database module.
//
// This is the offline / desktop (Electron) equivalent of src/db/database.js
// (PostgreSQL on Railway). It is selected when DB_MODE=local. It exposes the
// SAME public surface as database.js — `{ pool, query, initSchema }` — so the
// rest of the codebase (routes that call `pool.query(text, params)` with PG
// `$1 $2` placeholders, and transaction code using `pool.connect()` /
// `client.query('BEGIN'|'COMMIT'|'ROLLBACK')`) works unchanged.
//
// The machinery here mirrors the restaurant EPOS's proven localDatabase.js:
//   • better-sqlite3 (synchronous) wrapped in a pg-compatible async shim
//   • a PostgreSQL → SQLite SQL translator ($1→?, NOW()→CURRENT_TIMESTAMP,
//     ::casts stripped, ILIKE→LIKE, = ANY(...) expansion, RETURNING support…)
//   • naive-UTC timestamp normalisation on output (the BST off-by-one fix)
//   • addColumnIfMissing() + runMigrations()
//
// ---------------------------------------------------------------------------
// ENCRYPTION AT REST (medical data — SQLCipher)
// ---------------------------------------------------------------------------
// client_medical holds health data, so the local DB file MUST be encrypted.
// We use `better-sqlite3-multiple-ciphers` — a drop-in replacement for
// better-sqlite3 that bundles SQLCipher. After opening the DB we apply the
// key with a `PRAGMA key=...` BEFORE running any other statement (the key
// pragma must be the very first thing SQLCipher sees).
//
// The key is read from process.env.SQLITE_ENCRYPTION_KEY. If that env var is
// empty/missing we open the DB WITHOUT encryption (so dev/test still works)
// and console.warn loudly that the DB is unencrypted. In production
// (Electron desktop install) SQLITE_ENCRYPTION_KEY MUST be set — derive it
// per-install and store it in the OS keychain / config, never in the repo.
//
// If better-sqlite3-multiple-ciphers is not installed we fall back to plain
// better-sqlite3 (no encryption). That keeps test environments working but
// the warning makes it obvious you are running unprotected.
// ===========================================================================

const path = require('path');
const fs = require('fs');

// --- Pick a SQLite driver: prefer the SQLCipher-capable build ---------------
let Database;
let DRIVER = 'better-sqlite3-multiple-ciphers';
let HAS_CIPHER = true;
try {
  Database = require('better-sqlite3-multiple-ciphers');
} catch (e) {
  HAS_CIPHER = false;
  DRIVER = 'better-sqlite3';
  try {
    Database = require('better-sqlite3');
  } catch (e2) {
    throw new Error(
      '[localDb] Neither better-sqlite3-multiple-ciphers nor better-sqlite3 ' +
      'is installed. Run `npm i better-sqlite3-multiple-ciphers` in spa-epos.'
    );
  }
}

// --- Resolve the DB file path ----------------------------------------------
const SQLITE_PATH =
  process.env.SQLITE_PATH ||
  path.join(process.cwd(), 'spa-local.db');

// Ensure the parent directory exists.
try {
  fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
} catch (_) { /* ignore */ }

// --- Open the database ------------------------------------------------------
const db = new Database(SQLITE_PATH);

// --- Encryption key (apply BEFORE any other statement) ----------------------
const ENC_KEY = process.env.SQLITE_ENCRYPTION_KEY;
if (ENC_KEY && HAS_CIPHER) {
  // SQLCipher: the key pragma must run first. Escape single quotes in the key.
  const safeKey = String(ENC_KEY).replace(/'/g, "''");
  db.pragma(`key='${safeKey}'`);
  // Touch the schema to verify the key actually decrypts the file. A wrong
  // key throws "file is not a database" here rather than silently later.
  try {
    db.exec('SELECT count(*) FROM sqlite_master;');
    console.log('[localDb] opened ENCRYPTED SQLite DB (SQLCipher) at', SQLITE_PATH);
  } catch (e) {
    throw new Error(
      '[localDb] Failed to open encrypted DB — wrong SQLITE_ENCRYPTION_KEY? ' +
      e.message
    );
  }
} else {
  if (ENC_KEY && !HAS_CIPHER) {
    console.warn(
      '[localDb] ⚠️  SQLITE_ENCRYPTION_KEY is set but ' +
      'better-sqlite3-multiple-ciphers is NOT installed — the local DB is ' +
      'UNENCRYPTED. Install better-sqlite3-multiple-ciphers to protect ' +
      'medical data at rest.'
    );
  } else {
    console.warn(
      '[localDb] ⚠️  SQLITE_ENCRYPTION_KEY not set — the local DB is ' +
      'UNENCRYPTED. This is fine for dev/test, but a production spa install ' +
      'storing client_medical data MUST set SQLITE_ENCRYPTION_KEY.'
    );
  }
}

// --- Pragmas (after the key) ------------------------------------------------
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ===========================================================================
// PostgreSQL → SQLite SQL translator
// ===========================================================================
// The spa routes are written for Postgres ($1 $2 params, ::casts, ILIKE,
// now(), RETURNING, = ANY(...), COALESCE, FILTER, etc.). better-sqlite3 speaks
// a different dialect, so we translate the SQL text and re-shape the params
// before execution.
//
// Constructs handled (verified against src/routes/*.js):
//   $1 $2            → ? ? (positional, in textual order)
//   now() / NOW()    → CURRENT_TIMESTAMP
//   CURRENT_DATE     → date('now')
//   ::date / ::int / ::numeric / ::timestamp / ::text / ::jsonb / ::int[] …
//                    → cast suffix stripped (SQLite is dynamically typed)
//   ILIKE            → LIKE  (SQLite LIKE is case-insensitive for ASCII)
//   x = ANY($n::int[])  / x = ANY($n::text[])
//                    → x IN (?,?,…)  with the JS array spread into params
//   GREATEST(a,b)    → max(a,b)      LEAST(a,b) → min(a,b)
//   TRUE / FALSE     → 1 / 0
//   IS DISTINCT FROM → IS NOT  (close enough for our nullable comparisons)
//   "RETURNING *" / "RETURNING col,…"  → emulated via a follow-up SELECT
//   ON CONFLICT … DO NOTHING / DO UPDATE SET … EXCLUDED.col
//                    → SQLite supports the same upsert syntax verbatim
//                      (EXCLUDED works; partial-index conflict targets work)
//
// NOTE: a handful of report-only Postgres constructs are NOT translated —
// see the header note in this file / the handoff report. They only run on the
// cloud (reports.js is a cloud-mode screen); the Mac uses cloud reporting.
// ---------------------------------------------------------------------------

// Strip Postgres type-casts: `expr::date`, `$1::int[]`, `'[]'::jsonb`, etc.
// We remove the `::type` (and any trailing `[]`) — SQLite ignores types.
function stripCasts(sql) {
  // Repeatedly strip `::ident` and `::ident[]` and `::ident(n,n)` forms.
  // e.g. ::numeric(10,2), ::timestamp, ::int[], ::text
  return sql.replace(/::\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?(\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?(\s*\[\s*\])?/g, '');
}

// Translate keywords / functions that differ between PG and SQLite.
function preTranslate(sql) {
  let out = sql;

  // now() / NOW()  →  CURRENT_TIMESTAMP   (word-boundary, optional spaces)
  out = out.replace(/\bnow\s*\(\s*\)/gi, 'CURRENT_TIMESTAMP');

  // CURRENT_DATE → date('now')
  out = out.replace(/\bCURRENT_DATE\b/gi, "date('now')");

  // GREATEST / LEAST → max / min
  out = out.replace(/\bGREATEST\s*\(/gi, 'max(');
  out = out.replace(/\bLEAST\s*\(/gi, 'min(');

  // ILIKE → LIKE (SQLite LIKE is ASCII-case-insensitive)
  out = out.replace(/\bILIKE\b/gi, 'LIKE');

  // IS DISTINCT FROM → IS NOT  /  IS NOT DISTINCT FROM → IS
  out = out.replace(/\bIS\s+NOT\s+DISTINCT\s+FROM\b/gi, 'IS');
  out = out.replace(/\bIS\s+DISTINCT\s+FROM\b/gi, 'IS NOT');

  // TRUE / FALSE literals → 1 / 0 (only standalone keywords)
  out = out.replace(/\bTRUE\b/g, '1').replace(/\bFALSE\b/g, '0');

  // FOR UPDATE [OF alias, …] [NOWAIT | SKIP LOCKED] → stripped.
  // SQLite is single-writer (a write holds a DB-level lock), so Postgres
  // row-level locking is implicit and the clause is a safe no-op — but SQLite
  // can't parse it. Used by the bill-refund + medical-save transactions.
  out = out.replace(/\s+FOR\s+UPDATE(\s+OF\s+[A-Za-z_][\w.]*(\s*,\s*[A-Za-z_][\w.]*)*)?(\s+NOWAIT|\s+SKIP\s+LOCKED)?/gi, '');

  // DATE / TIMESTAMP casts carry MEANING — they must become a function call,
  // not be stripped. Postgres `starts_at::date = $1::date` compares calendar
  // days; if we just dropped `::date` it would compare a full timestamp string
  // to a date string and never match. Convert BEFORE the generic strip below.
  //   expr::date        → date(expr)
  //   expr::timestamp[tz]→ datetime(expr)
  // Operand = a string literal, a $n param, or an identifier (a.b.c).
  const OPERAND = "('(?:[^']|'')*'|\\$\\d+|[A-Za-z_][\\w.]*)";
  out = out.replace(new RegExp(OPERAND + "\\s*::\\s*timestamptz?\\b", 'gi'), 'datetime($1)');
  out = out.replace(new RegExp(OPERAND + "\\s*::\\s*date\\b", 'gi'), 'date($1)');

  // JSON access:  x ->> 'key'  →  json_extract(x, '$.key')
  // (operand: identifier or a single-level parenthesised expression)
  out = out.replace(/([A-Za-z_][\w.]*|\([^()]*\))\s*->>\s*'([^']+)'/g, "json_extract($1, '$.$2')");

  // date_trunc('day'|'month'|'year', x) → strftime(...) (used by reports)
  out = out.replace(/\bdate_trunc\s*\(\s*'day'\s*,\s*([^()]+?)\s*\)/gi, "date($1)");
  out = out.replace(/\bdate_trunc\s*\(\s*'month'\s*,\s*([^()]+?)\s*\)/gi, "strftime('%Y-%m-01', $1)");
  out = out.replace(/\bdate_trunc\s*\(\s*'year'\s*,\s*([^()]+?)\s*\)/gi, "strftime('%Y-01-01', $1)");

  // Strip the REMAINING casts (::int, ::numeric, ::text, ::jsonb, ::int[]…),
  // which are type-only and safe to drop in dynamically-typed SQLite.
  out = stripCasts(out);

  return out;
}

// Coerce a single bound param into something better-sqlite3 accepts.
// node-postgres tolerates JS booleans (and undefined); better-sqlite3 only
// binds numbers, strings, bigints, buffers and null — a raw `true`/`false`
// throws "SQLite3 can only bind …". The spa routes pass JS booleans all over
// (the medical questionnaire's ~39 flags, clients.gdpr_consent, treatments
// .active, etc.), so map booleans → 1/0 and undefined → null here.
function coerceParam(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  if (v === undefined) return null;
  // node-postgres accepts Date objects (e.g. a computed ends_at); better-sqlite3
  // only binds numbers/strings/bigints/buffers/null, so serialise to ISO. Stored
  // as ISO-8601 UTC, which the query() timestamp normaliser already understands.
  if (v instanceof Date) return v.toISOString();
  return v;
}

// Convert a PG statement ($1..$n) + params into a SQLite statement (?) +
// ordered params, expanding `= ANY($n)` array params into IN-lists.
function substituteParams(sql, params) {
  params = params || [];

  // Identify which params are ANY()-array params so we expand them in place.
  const arrayMarkers = {}; // marker number -> array value
  const anyRe = /=\s*ANY\s*\(\s*\$(\d+)\s*\)/gi;
  let am;
  while ((am = anyRe.exec(sql)) !== null) {
    const n = parseInt(am[1], 10);
    if (Array.isArray(params[n - 1])) arrayMarkers[n] = params[n - 1];
  }

  // First, rewrite `= ANY($n)` → a sentinel `ANY_IN($n)` so the $n marker
  // survives the walk below. NOTE: use a function replacer (not the string
  // '$1') — in String.replace the literal "$1" is a backreference to the
  // captured group, which would replace the marker with the bare digit and
  // break param substitution.
  let work = sql.replace(/=\s*ANY\s*\(\s*\$(\d+)\s*\)/gi, (full, n) => `= ANY_IN($${n})`);

  const outParams = [];
  // Walk every $n marker in textual order; emit "?" (or "?,?,…" for arrays).
  const out = work.replace(/\$(\d+)/g, (full, numStr) => {
    const n = parseInt(numStr, 10);
    const val = params[n - 1];
    if (arrayMarkers[n] && Array.isArray(val)) {
      if (val.length === 0) {
        // Empty array: `IN ()` is invalid; emit a never-true placeholder.
        return 'NULL';
      }
      for (const el of val) outParams.push(coerceParam(el));
      return val.map(() => '?').join(',');
    }
    outParams.push(coerceParam(val));
    return '?';
  });

  // Now turn `= ANY_IN(<placeholders>)` back into `IN (<placeholders>)`.
  const finalSql = out.replace(/=\s*ANY_IN\(/gi, 'IN (');

  return { sql: finalSql, params: outParams };
}

// Full translate pipeline: PG text + PG params -> SQLite text + flat params.
function translate(text, params) {
  const pre = preTranslate(text);
  return substituteParams(pre, params);
}

// ---------------------------------------------------------------------------
// RETURNING support.
// Modern SQLite (3.35+, which ships in current better-sqlite3) supports
// RETURNING natively for INSERT/UPDATE/DELETE. We use it directly. If the
// underlying SQLite were too old this would throw — but the bundled build is
// new enough, matching the restaurant EPOS approach.
// ---------------------------------------------------------------------------
function isReturning(sql) {
  return /\bRETURNING\b/i.test(sql);
}

function looksLikeSelect(sql) {
  return /^\s*(WITH|SELECT|PRAGMA)\b/i.test(sql);
}

// ===========================================================================
// Timestamp normalisation (the BST off-by-one fix)
// ===========================================================================
// SQLite stores CURRENT_TIMESTAMP as a naive UTC string "YYYY-MM-DD HH:MM:SS"
// (no timezone). When JS does `new Date("2026-05-12 10:00:00")` it interprets
// that as LOCAL time, so in UK summer (BST) every server timestamp reads 1h
// ahead. Postgres' driver returns proper Date objects, so cloud mode is fine.
//
// Fix: post-process every result row. Any string value that looks like a
// naive SQLite datetime is rewritten to ISO-8601 with a 'Z' suffix so JS
// parses it as UTC. Date-only values ("YYYY-MM-DD") are left untouched.
// ---------------------------------------------------------------------------
const NAIVE_DT_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/;

function normaliseValue(v) {
  if (typeof v !== 'string') return v;
  const m = NAIVE_DT_RE.exec(v);
  if (!m) return v;
  // Rewrite "2026-05-12 10:00:00[.sss]" -> "2026-05-12T10:00:00[.sss]Z"
  return `${m[1]}T${m[2]}${m[3] || ''}Z`;
}

function normaliseRow(row) {
  if (!row || typeof row !== 'object') return row;
  for (const k of Object.keys(row)) {
    row[k] = normaliseValue(row[k]);
  }
  return row;
}

function normaliseRows(rows) {
  if (Array.isArray(rows)) for (const r of rows) normaliseRow(r);
  return rows;
}

// ===========================================================================
// Core synchronous executor — returns a pg-shaped { rows, rowCount } object.
// ===========================================================================
function runSync(text, params) {
  const { sql, params: flat } = translate(text, params);

  // Multi-statement scripts (semicolon-separated) only come from initSchema /
  // migrations and never carry params or expect rows — run via db.exec.
  if (!flat.length && /;\s*\S/.test(sql.trim().replace(/;\s*$/, ''))) {
    db.exec(sql);
    return { rows: [], rowCount: 0 };
  }

  if (looksLikeSelect(sql) || isReturning(sql)) {
    const stmt = db.prepare(sql);
    const rows = stmt.all(...flat);
    normaliseRows(rows);
    return { rows, rowCount: rows.length };
  }

  // INSERT / UPDATE / DELETE without RETURNING.
  const stmt = db.prepare(sql);
  const info = stmt.run(...flat);
  return {
    rows: [],
    rowCount: info.changes,
    lastInsertRowid: info.lastInsertRowid,
  };
}

// ===========================================================================
// pg-compatible async shim
// ===========================================================================
// better-sqlite3 is synchronous; pg is async. We wrap every result in a
// resolved Promise so `await pool.query(...)` works, and provide
// `pool.connect()` returning a client whose `query()` is also async and whose
// `release()` is a no-op. Transaction control (BEGIN/COMMIT/ROLLBACK) maps
// straight onto SQLite's own transaction statements via db.exec.
// ---------------------------------------------------------------------------
function execControl(text) {
  // BEGIN / COMMIT / ROLLBACK (and savepoints) — run raw.
  db.exec(text);
  return { rows: [], rowCount: 0 };
}

function isTxnControl(text) {
  return /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i.test(text);
}

async function query(text, params) {
  try {
    if (isTxnControl(text)) return execControl(text);
    return runSync(text, params);
  } catch (err) {
    // Surface the translated SQL to help debugging dialect gaps.
    err.message = `[localDb] ${err.message}\n  PG SQL: ${String(text).slice(0, 400)}`;
    throw err;
  }
}

const pool = {
  query,
  // A "client" is just the same db with a no-op release(); SQLite has a single
  // connection and serialises statements, so BEGIN/COMMIT on it is correct.
  async connect() {
    return {
      query: (text, params) => query(text, params),
      release: () => {},
    };
  },
  // pg compatibility no-ops.
  on() {},
  async end() { try { db.close(); } catch (_) {} },
};

// ===========================================================================
// addColumnIfMissing — idempotent ALTER for existing local DBs.
// ===========================================================================
function tableColumns(table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch (_) {
    return [];
  }
}

function addColumnIfMissing(table, column, definition) {
  const cols = tableColumns(table);
  if (cols.includes(column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    // Ignore "duplicate column" races; rethrow anything else.
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

// ===========================================================================
// Schema (SQLite dialect) — mirrors src/db/database.js initSchema().
// PG → SQLite type mapping:
//   SERIAL PRIMARY KEY  → INTEGER PRIMARY KEY AUTOINCREMENT
//   TIMESTAMPTZ         → TEXT (ISO; DEFAULT CURRENT_TIMESTAMP)
//   NUMERIC(10,2)       → REAL
//   BOOLEAN DEFAULT T/F → INTEGER NOT NULL DEFAULT 1/0
//   DATE / TIME         → TEXT
//   JSONB               → TEXT
// REFERENCES / ON DELETE / CHECK / UNIQUE / partial unique indexes preserved.
// `cloud_id INTEGER` (+ partial unique index) is added to the sync-relevant
// tables: clients, client_medical, appointments, bills, bill_items, vouchers,
// voucher_redemptions, appointment_amendments.
// ===========================================================================
async function initSchema() {
  db.exec(`
    -- ── config / catalog tables (cloud-authoritative; no cloud_id) ──────────
    CREATE TABLE IF NOT EXISTS treatment_categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS treatments (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id       INTEGER REFERENCES treatment_categories(id) ON DELETE SET NULL,
      name              TEXT NOT NULL,
      duration_minutes  INTEGER NOT NULL,
      price             REAL NOT NULL DEFAULT 0,
      description       TEXT,
      active            INTEGER NOT NULL DEFAULT 1,
      online_bookable   INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS therapists (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      pin          TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'therapist',
      active       INTEGER NOT NULL DEFAULT 1,
      specialisms  TEXT,
      photo_url    TEXT
    );

    CREATE TABLE IF NOT EXISTS therapist_availability (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      therapist_id  INTEGER NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
      day_of_week   INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      start_time    TEXT NOT NULL,
      end_time      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name    TEXT NOT NULL,
      active  INTEGER NOT NULL DEFAULT 1
    );

    -- ── clients ─────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS clients (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      name                     TEXT NOT NULL,
      phone                    TEXT,
      email                    TEXT,
      date_of_birth            TEXT,
      emergency_contact_name   TEXT,
      emergency_contact_phone  TEXT,
      gp_name                  TEXT,
      gp_surgery               TEXT,
      gdpr_consent             INTEGER NOT NULL DEFAULT 0,
      gdpr_consent_at          TEXT,
      marketing_consent        INTEGER NOT NULL DEFAULT 0,
      notes                    TEXT,
      unsubscribed_at          TEXT,
      created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at               TEXT,
      cloud_id                 INTEGER
    );

    -- ── client_medical (health data — encrypted at rest) ────────────────────
    CREATE TABLE IF NOT EXISTS client_medical (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id               INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      pregnancy               INTEGER NOT NULL DEFAULT 0,
      heart_condition         INTEGER NOT NULL DEFAULT 0,
      blood_pressure          TEXT    NOT NULL DEFAULT 'none',
      diabetes                INTEGER NOT NULL DEFAULT 0,
      epilepsy                INTEGER NOT NULL DEFAULT 0,
      cancer                  INTEGER NOT NULL DEFAULT 0,
      dvt                     INTEGER NOT NULL DEFAULT 0,
      recent_surgery          INTEGER NOT NULL DEFAULT 0,
      bone_fracture           INTEGER NOT NULL DEFAULT 0,
      skin_condition          INTEGER NOT NULL DEFAULT 0,
      varicose_veins          INTEGER NOT NULL DEFAULT 0,
      osteoporosis            INTEGER NOT NULL DEFAULT 0,
      lymphoedema             INTEGER NOT NULL DEFAULT 0,
      medications             TEXT,
      allergies               TEXT,
      areas_to_avoid          TEXT,
      skin_conditions_detail  TEXT,
      digital_signature       TEXT,
      signed_at               TEXT,
      -- intake-form expansion (SPA medical intake) --------------------------
      areas_of_swelling          INTEGER NOT NULL DEFAULT 0,
      autoimmune_disorder        INTEGER NOT NULL DEFAULT 0,
      back_neck_problems         INTEGER NOT NULL DEFAULT 0,
      bleeding_disorders         INTEGER NOT NULL DEFAULT 0,
      blood_clots                INTEGER NOT NULL DEFAULT 0,
      bruise_easily              INTEGER NOT NULL DEFAULT 0,
      bursitis                   INTEGER NOT NULL DEFAULT 0,
      contagious_condition       INTEGER NOT NULL DEFAULT 0,
      decreased_sensation        INTEGER NOT NULL DEFAULT 0,
      fibromyalgia               INTEGER NOT NULL DEFAULT 0,
      headaches                  INTEGER NOT NULL DEFAULT 0,
      hypertension               INTEGER NOT NULL DEFAULT 0,
      kidney_disease             INTEGER NOT NULL DEFAULT 0,
      multiple_sclerosis         INTEGER NOT NULL DEFAULT 0,
      neurological_condition     INTEGER NOT NULL DEFAULT 0,
      neuropathy                 INTEGER NOT NULL DEFAULT 0,
      osteoarthritis             INTEGER NOT NULL DEFAULT 0,
      phlebitis                  INTEGER NOT NULL DEFAULT 0,
      sciatica                   INTEGER NOT NULL DEFAULT 0,
      seizures                   INTEGER NOT NULL DEFAULT 0,
      stroke                     INTEGER NOT NULL DEFAULT 0,
      tendinitis                 INTEGER NOT NULL DEFAULT 0,
      tmj_disorder               INTEGER NOT NULL DEFAULT 0,
      vertigo_dizziness          INTEGER NOT NULL DEFAULT 0,
      pregnancy_months           TEXT,
      pregnancy_due_date         TEXT,
      under_medical_supervision  INTEGER NOT NULL DEFAULT 0,
      medical_supervision_detail TEXT,
      broken_skin                INTEGER NOT NULL DEFAULT 0,
      broken_skin_where          TEXT,
      joint_replacement          INTEGER NOT NULL DEFAULT 0,
      joint_replacement_detail   TEXT,
      recent_injuries_yn         INTEGER NOT NULL DEFAULT 0,
      recent_injuries_detail     TEXT,
      other_conditions           TEXT,
      had_massage_before         INTEGER NOT NULL DEFAULT 0,
      massage_recency            TEXT,
      reason_for_massage         TEXT,
      pressure_preference        TEXT,
      updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cloud_id                INTEGER
    );

    -- ── appointments ────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS appointments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id     INTEGER REFERENCES clients(id)    ON DELETE SET NULL,
      treatment_id  INTEGER REFERENCES treatments(id) ON DELETE SET NULL,
      therapist_id  INTEGER REFERENCES therapists(id) ON DELETE SET NULL,
      room_id       INTEGER REFERENCES rooms(id)      ON DELETE SET NULL,
      starts_at     TEXT NOT NULL,
      ends_at       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'booked',
      source        TEXT NOT NULL DEFAULT 'walkin',
      notes         TEXT,
      therapist_requested     INTEGER NOT NULL DEFAULT 0,
      treatwell_booking_id    TEXT,
      treatwell_payment_type  TEXT,
      deposit_amount          REAL,
      deposit_stripe_id       TEXT,
      payment_status          TEXT NOT NULL DEFAULT 'none',
      deposit_method          TEXT,
      deposit_taken_at        TEXT,
      deposit_taken_by        INTEGER REFERENCES therapists(id) ON DELETE SET NULL,
      price_at_booking        REAL,
      hold_expires_at         TEXT,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cloud_id      INTEGER
    );

    -- ── bills ───────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS bills (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      appointment_id            INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      subtotal                  REAL NOT NULL DEFAULT 0,
      tip                       REAL NOT NULL DEFAULT 0,
      total                     REAL NOT NULL DEFAULT 0,
      payment_method            TEXT,
      payment_status            TEXT NOT NULL DEFAULT 'pending',
      stripe_payment_intent_id  TEXT,
      split_payments            TEXT,
      discount                  REAL NOT NULL DEFAULT 0,
      discount_reason           TEXT,
      already_paid              REAL NOT NULL DEFAULT 0,
      refunded_at               TEXT,
      refund_amount             REAL,
      refund_reason             TEXT,
      external_voucher_code     TEXT,
      closed_at                 TEXT,
      cloud_id                  INTEGER
    );

    -- ── bill_items ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS bill_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id     INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL DEFAULT 'retail',
      name        TEXT NOT NULL,
      quantity    INTEGER NOT NULL DEFAULT 1,
      unit_price  REAL NOT NULL DEFAULT 0,
      line_total  REAL NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cloud_id    INTEGER
    );

    -- ── settings ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY,
      value  TEXT
    );

    -- ── campaigns ───────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS campaigns (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      subject         TEXT NOT NULL,
      body            TEXT NOT NULL,
      segment         TEXT NOT NULL,
      recipient_count INTEGER NOT NULL DEFAULT 0,
      sent_count      INTEGER NOT NULL DEFAULT 0,
      failed_count    INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- ── therapist_rota_overrides ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS therapist_rota_overrides (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      therapist_id  INTEGER NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
      date          TEXT NOT NULL,
      is_working    INTEGER NOT NULL DEFAULT 0,
      start_time    TEXT,
      end_time      TEXT,
      note          TEXT,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (therapist_id, date)
    );

    -- ── vouchers ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS vouchers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      code            TEXT NOT NULL UNIQUE,
      initial_value   REAL NOT NULL,
      remaining_value REAL NOT NULL,
      purchased_by    TEXT,
      purchased_for   TEXT,
      client_id       INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      purchased_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at      TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      notes           TEXT,
      sold_by         INTEGER REFERENCES therapists(id) ON DELETE SET NULL,
      voucher_type        TEXT NOT NULL DEFAULT 'monetary',
      total_sessions      INTEGER,
      sessions_remaining  INTEGER,
      treatment_id        INTEGER REFERENCES treatments(id) ON DELETE SET NULL,
      recipient_email     TEXT,
      email_sent_at       TEXT,
      payment_method      TEXT,
      stripe_payment_intent_id TEXT,
      cloud_id        INTEGER
    );

    -- ── voucher_redemptions ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS voucher_redemptions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id    INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
      bill_id       INTEGER REFERENCES bills(id) ON DELETE SET NULL,
      amount_used   REAL NOT NULL,
      redeemed_by   INTEGER REFERENCES therapists(id) ON DELETE SET NULL,
      redeemed_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      notes         TEXT,
      sessions_used INTEGER NOT NULL DEFAULT 0,
      reversed_at   TEXT,
      cloud_id      INTEGER
    );

    -- ── therapist_turn_order ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS therapist_turn_order (
      date          TEXT NOT NULL,
      therapist_id  INTEGER NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
      position      INTEGER NOT NULL,
      set_by        INTEGER REFERENCES therapists(id) ON DELETE SET NULL,
      set_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (date, therapist_id)
    );

    -- ── appointment_amendments ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS appointment_amendments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      appointment_id  INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,
      from_value      TEXT,
      to_value        TEXT,
      by_customer     INTEGER NOT NULL DEFAULT 0,
      by_staff_id     INTEGER REFERENCES therapists(id) ON DELETE SET NULL,
      note            TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cloud_id        INTEGER
    );

    -- ── sync engine bookkeeping (mirrors restaurant localDatabase.js) ───────
    -- sync_queue: locally-originated mutations awaiting push to the cloud.
    CREATE TABLE IF NOT EXISTS sync_queue (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      entity        TEXT NOT NULL,         -- e.g. 'appointment','bill','client'
      entity_id     INTEGER,               -- local row id
      op            TEXT NOT NULL,         -- 'insert' | 'update' | 'delete'
      payload       TEXT,                  -- JSON body to push
      status        TEXT NOT NULL DEFAULT 'pending',  -- pending | done | error
      attempts      INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- sync_state: per-feed pull cursors (e.g. closed_at high-water marks).
    CREATE TABLE IF NOT EXISTS sync_state (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- sync_applied_ops: push idempotency (mirrors the cloud table). Only used
    -- when this DB acts as the RECEIVER of a push (i.e. a server). On a desktop
    -- till it stays empty, but the column shape matches the cloud so the same
    -- /api/sync/push handler works under either backend.
    CREATE TABLE IF NOT EXISTS sync_applied_ops (
      op_key      TEXT PRIMARY KEY,
      action      TEXT NOT NULL,
      cloud_id    INTEGER,
      applied_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- GDPR erasure tombstones (mirrors the cloud table). Used when this DB acts
    -- as the receiver/cloud; on a till it's unused but kept for shape parity.
    CREATE TABLE IF NOT EXISTS deleted_records (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity      TEXT NOT NULL,
      cloud_id    INTEGER NOT NULL,
      deleted_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- ── payment_links (SEPOS-SPA-PAYLINK-001) — mirrors the cloud table ──────
    CREATE TABLE IF NOT EXISTS payment_links (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      purpose           TEXT NOT NULL DEFAULT 'adhoc',
      amount            REAL NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'gbp',
      description       TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      stripe_session_id TEXT UNIQUE,
      url               TEXT,
      customer_email    TEXT,
      appointment_id    INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
      created_by        INTEGER REFERENCES therapists(id) ON DELETE SET NULL,
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at        TEXT,
      paid_at           TEXT,
      cloud_id          INTEGER
    );

    -- ── devices (SEPOS-SPA-LICENSE-001 Part B) — mirrors the cloud table ─────
    CREATE TABLE IF NOT EXISTS devices (
      device_id   TEXT PRIMARY KEY,
      spa_id      TEXT,
      app_version TEXT,
      platform    TEXT,
      last_seen   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- SEPOS-SPA-OWNER-001 — owner magic-link tokens (parity with PG; owner login is
    -- a cloud feature, but kept here so the shared code never hits a missing table).
    CREATE TABLE IF NOT EXISTS owner_login_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash  TEXT NOT NULL,
      email       TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used_at     TEXT,
      created_at  TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_owner_login_token_hash ON owner_login_tokens (token_hash);

    -- SPA-TREATWELL-001 — Treatwell email ingest audit (cloud feature; mirrored
    -- here so the shared ingest code never hits a missing table on a till).
    CREATE TABLE IF NOT EXISTS ingestion_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      source         TEXT NOT NULL DEFAULT 'treatwell_email',
      external_ref   TEXT,
      action         TEXT,
      status         TEXT NOT NULL DEFAULT 'received',
      confidence     TEXT,
      parsed         TEXT,
      raw            TEXT,
      appointment_id INTEGER,
      error          TEXT,
      created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ingestion_log_ref    ON ingestion_log (external_ref);
    CREATE INDEX IF NOT EXISTS idx_ingestion_log_status ON ingestion_log (status, created_at);

    -- SEPOS-SPA-AUDIT S1 — schema parity with cloud database.js: the WhatsApp
    -- concierge SELECT/INSERTs concierge_conversations; it was missing here, so
    -- any concierge activity under DB_MODE=local would 500 ("no such table").
    -- (JSONB→TEXT, BOOLEAN→INTEGER, TIMESTAMPTZ→TEXT per this file's dialect.)
    CREATE TABLE IF NOT EXISTS concierge_conversations (
      phone         TEXT PRIMARY KEY,
      customer_name TEXT,
      messages      TEXT NOT NULL DEFAULT '[]',
      handoff       INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_concierge_conv_updated ON concierge_conversations (updated_at);

    -- SPA-LOYALTY-001 — loyalty events (earn/redeem/revoke/unredeem audit).
    -- Mirrors cloud database.js; cloud_id is LOCAL-ONLY (sync push mapping,
    -- like bills/appointments). Client counters live on clients
    -- (loyalty_visits / loyalty_cycle — added in runMigrations()).
    CREATE TABLE IF NOT EXISTS loyalty_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      bill_id       INTEGER REFERENCES bills(id) ON DELETE SET NULL,
      type          TEXT NOT NULL CHECK (type IN ('earn','redeem','revoke','unredeem')),
      visit_number  INTEGER,
      tier_visit    INTEGER,
      reward        TEXT,
      cycle         INTEGER NOT NULL DEFAULT 0,
      visits_before INTEGER,
      cycle_before  INTEGER,
      visits_after  INTEGER,
      cycle_after   INTEGER,
      created_by    INTEGER REFERENCES therapists(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cloud_id      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_loyalty_events_client ON loyalty_events (client_id, cycle);
    CREATE INDEX IF NOT EXISTS idx_loyalty_events_bill   ON loyalty_events (bill_id);

    -- SPA-LOYALTY-001 Layer 2 — schema parity with cloud wallet tables. The
    -- Apple pass web service only runs on the CLOUD (Apple must reach it);
    -- these exist locally purely so shared code never hits "no such table".
    CREATE TABLE IF NOT EXISTS wallet_passes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL CHECK (kind IN ('loyalty','voucher')),
      client_id  INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      voucher_id INTEGER REFERENCES vouchers(id) ON DELETE CASCADE,
      serial     TEXT NOT NULL UNIQUE,
      auth_token TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS wallet_registrations (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      device_library_id TEXT NOT NULL,
      push_token        TEXT NOT NULL,
      serial            TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (device_library_id, serial)
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_reg_serial ON wallet_registrations (serial);

    -- SPA-PETTYCASH-001 — cash paid OUT of the drawer for small expenses.
    -- Mirrors cloud database.js (SERIAL→AUTOINCREMENT, NUMERIC→REAL,
    -- TIMESTAMPTZ→TEXT). Reduces cash-taken on the Z report; not a sale.
    CREATE TABLE IF NOT EXISTS petty_cash (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      amount     REAL NOT NULL CHECK (amount > 0),
      reason     TEXT NOT NULL,
      created_by INTEGER REFERENCES therapists(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_petty_cash_created_at ON petty_cash (created_at);
  `);

  // ── indexes ───────────────────────────────────────────────────────────────
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_campaigns_created_at      ON campaigns (created_at);
    CREATE INDEX IF NOT EXISTS idx_rota_overrides_therapist_date ON therapist_rota_overrides (therapist_id, date);
    CREATE INDEX IF NOT EXISTS idx_vouchers_code             ON vouchers (code);
    CREATE INDEX IF NOT EXISTS idx_vouchers_client_id        ON vouchers (client_id);
    CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_voucher_id ON voucher_redemptions (voucher_id);
    CREATE INDEX IF NOT EXISTS idx_turn_order_date           ON therapist_turn_order (date);
    CREATE INDEX IF NOT EXISTS idx_appt_amendments_appointment_id ON appointment_amendments (appointment_id);

    -- partial unique indexes (SQLite supports CREATE UNIQUE INDEX ... WHERE)
    CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_treatwell_booking_id
      ON appointments (treatwell_booking_id) WHERE treatwell_booking_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_stripe_pi
      ON vouchers (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bill_items_one_treatment
      ON bill_items (bill_id) WHERE kind = 'treatment';

    -- cloud_id partial-unique indexes (for bidirectional sync matching) ------
    CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_cloud_id
      ON clients (cloud_id) WHERE cloud_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_client_medical_cloud_id
      ON client_medical (cloud_id) WHERE cloud_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_cloud_id
      ON appointments (cloud_id) WHERE cloud_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_bills_cloud_id
      ON bills (cloud_id) WHERE cloud_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_bill_items_cloud_id
      ON bill_items (cloud_id) WHERE cloud_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_vouchers_cloud_id
      ON vouchers (cloud_id) WHERE cloud_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_voucher_redemptions_cloud_id
      ON voucher_redemptions (cloud_id) WHERE cloud_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_appt_amendments_cloud_id
      ON appointment_amendments (cloud_id) WHERE cloud_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue (status);
  `);

  // ── runMigrations: idempotent column adds for pre-existing local DBs ──────
  runMigrations();

  // ── default settings seed (simple INSERT OR IGNORE only) ──────────────────
  // PG-only seeds (rooms VALUES self-join, rota cross-joins, price backfill
  // UPDATE...FROM) are intentionally skipped — those rows arrive via cloud
  // sync, not local init. Only plain key/value settings are seeded here.
  const seedSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );
  const defaults = [
    ['spa_name',                 process.env.SPA_NAME || 'SiamEPOS Spa'],
    ['spa_email',                process.env.SPA_EMAIL || 'info@siamepos.co.uk'],
    ['booking_advance_days',     '30'],
    ['booking_slot_minutes',     '15'],
    ['opening_time',             '10:00'],
    ['closing_time',             '20:00'],
    ['cancellation_policy_text', 'Please give 24 hours notice for cancellations.'],
    ['tip_suggestions',          '10,12.5,15'],
    ['vat_rate',                 '0'],
    ['deposit_model',            'fixed_amount'],
    ['deposit_amount',           '25'],
    ['deposit_percentage',       '25'],
    ['cancel_window_hours',      '24'],
    ['cancel_policy_text',       "Cancellations within 24 hours of your appointment forfeit the deposit. We're happy to reschedule any time before then."],
  ];
  const seedAll = db.transaction((rows) => {
    for (const [k, v] of rows) seedSetting.run(k, v);
  });
  seedAll(defaults);

  console.log(`[localDb] schema ready (driver: ${DRIVER}) at ${SQLITE_PATH}`);
}

// ===========================================================================
// runMigrations — addColumnIfMissing for every column that, on the cloud,
// was added via ALTER TABLE ... ADD COLUMN IF NOT EXISTS. Idempotent: the
// CREATE TABLEs above already include these columns for fresh DBs; this keeps
// older local DB files in step. Booleans default to 0, NUMERIC → REAL, etc.
// ===========================================================================
function runMigrations() {
  // treatments
  addColumnIfMissing('treatments', 'online_bookable', 'INTEGER NOT NULL DEFAULT 1');

  // therapists
  addColumnIfMissing('therapists', 'specialisms', 'TEXT');
  addColumnIfMissing('therapists', 'photo_url',   'TEXT');
  addColumnIfMissing('therapists', 'email',         'TEXT'); // SEPOS-SPA-OWNER-001 v2 — email+password login
  addColumnIfMissing('therapists', 'password_hash', 'TEXT');

  // clients
  addColumnIfMissing('clients', 'source',          "TEXT NOT NULL DEFAULT 'direct'"); // SPA-TREATWELL-001
  addColumnIfMissing('clients', 'unsubscribed_at', 'TEXT');
  addColumnIfMissing('clients', 'updated_at',      'TEXT'); // SEPOS-SPA-BUGHUNT H5 (nullable: SQLite ALTER can't default CURRENT_TIMESTAMP)
  addColumnIfMissing('clients', 'cloud_id',        'INTEGER');
  addColumnIfMissing('clients', 'loyalty_visits',  'INTEGER NOT NULL DEFAULT 0'); // SPA-LOYALTY-001
  addColumnIfMissing('clients', 'loyalty_cycle',   'INTEGER NOT NULL DEFAULT 0'); // SPA-LOYALTY-001

  // appointments
  addColumnIfMissing('appointments', 'therapist_requested',    'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('appointments', 'treatwell_booking_id',   'TEXT');
  addColumnIfMissing('appointments', 'treatwell_payment_type', 'TEXT');
  addColumnIfMissing('appointments', 'deposit_amount',         'REAL');
  addColumnIfMissing('appointments', 'deposit_stripe_id',      'TEXT');
  addColumnIfMissing('appointments', 'payment_status',         "TEXT NOT NULL DEFAULT 'none'");
  addColumnIfMissing('appointments', 'deposit_method',         'TEXT');
  addColumnIfMissing('appointments', 'deposit_taken_at',       'TEXT');
  addColumnIfMissing('appointments', 'deposit_taken_by',       'INTEGER');
  addColumnIfMissing('appointments', 'price_at_booking',       'REAL');
  addColumnIfMissing('appointments', 'hold_expires_at',        'TEXT');
  addColumnIfMissing('appointments', 'cloud_id',               'INTEGER');

  // client_medical — full intake-form expansion
  const medBool = [
    'areas_of_swelling', 'autoimmune_disorder', 'back_neck_problems',
    'bleeding_disorders', 'blood_clots', 'bruise_easily', 'bursitis',
    'contagious_condition', 'decreased_sensation', 'fibromyalgia',
    'headaches', 'hypertension', 'kidney_disease', 'multiple_sclerosis',
    'neurological_condition', 'neuropathy', 'osteoarthritis', 'phlebitis',
    'sciatica', 'seizures', 'stroke', 'tendinitis', 'tmj_disorder',
    'vertigo_dizziness', 'under_medical_supervision', 'broken_skin',
    'joint_replacement', 'recent_injuries_yn', 'had_massage_before',
  ];
  for (const c of medBool) {
    addColumnIfMissing('client_medical', c, 'INTEGER NOT NULL DEFAULT 0');
  }
  const medText = [
    'pregnancy_months', 'pregnancy_due_date', 'medical_supervision_detail',
    'broken_skin_where', 'joint_replacement_detail', 'recent_injuries_detail',
    'other_conditions', 'massage_recency', 'reason_for_massage',
    'pressure_preference',
  ];
  for (const c of medText) {
    addColumnIfMissing('client_medical', c, 'TEXT');
  }
  addColumnIfMissing('client_medical', 'cloud_id', 'INTEGER');

  // bills
  addColumnIfMissing('bills', 'split_payments',  'TEXT');
  addColumnIfMissing('bills', 'discount',        'REAL NOT NULL DEFAULT 0');
  addColumnIfMissing('bills', 'discount_reason', 'TEXT');
  addColumnIfMissing('bills', 'already_paid',    'REAL NOT NULL DEFAULT 0');
  addColumnIfMissing('bills', 'refunded_at',     'TEXT');
  addColumnIfMissing('bills', 'refund_amount',   'REAL');
  addColumnIfMissing('bills', 'refund_reason',   'TEXT');
  addColumnIfMissing('bills', 'external_voucher_code', 'TEXT');
  addColumnIfMissing('bills', 'cloud_id',        'INTEGER');

  // bill_items
  addColumnIfMissing('bill_items', 'cloud_id', 'INTEGER');

  // vouchers
  addColumnIfMissing('vouchers', 'sold_by',                  'INTEGER');
  addColumnIfMissing('vouchers', 'voucher_type',             "TEXT NOT NULL DEFAULT 'monetary'");
  addColumnIfMissing('vouchers', 'total_sessions',           'INTEGER');
  addColumnIfMissing('vouchers', 'sessions_remaining',       'INTEGER');
  addColumnIfMissing('vouchers', 'treatment_id',             'INTEGER');
  addColumnIfMissing('vouchers', 'recipient_email',          'TEXT');
  addColumnIfMissing('vouchers', 'email_sent_at',            'TEXT');
  addColumnIfMissing('vouchers', 'payment_method',           'TEXT');
  addColumnIfMissing('vouchers', 'stripe_payment_intent_id', 'TEXT');
  addColumnIfMissing('vouchers', 'cloud_id',                 'INTEGER');

  // voucher_redemptions
  addColumnIfMissing('voucher_redemptions', 'sessions_used', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('voucher_redemptions', 'reversed_at',   'TEXT');
  addColumnIfMissing('voucher_redemptions', 'cloud_id',      'INTEGER');

  // appointment_amendments
  addColumnIfMissing('appointment_amendments', 'cloud_id', 'INTEGER');

  // payment_links
  addColumnIfMissing('payment_links', 'appointment_id', 'INTEGER');

  // ── Unique-index backstops (SEPOS-SPA-BUGHUNT follow-up) — mirror the cloud.
  // Dedup pre-existing duplicates ONCE (keyed on the never-null PK id, so a
  // single row always survives), then add the unique index. Guarded on the
  // index's existence so the dedup runs only on the first boot after this ships.
  ensureUniqueIndex(
    'uq_client_medical_client_id',
    `DELETE FROM client_medical WHERE id NOT IN (SELECT MAX(id) FROM client_medical GROUP BY client_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_client_medical_client_id ON client_medical (client_id)`,
  );
  ensureUniqueIndex(
    'uq_appointments_deposit_stripe_id',
    `UPDATE appointments SET deposit_stripe_id = NULL
       WHERE deposit_stripe_id IS NOT NULL
         AND id NOT IN (SELECT MIN(id) FROM appointments WHERE deposit_stripe_id IS NOT NULL GROUP BY deposit_stripe_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_deposit_stripe_id ON appointments (deposit_stripe_id) WHERE deposit_stripe_id IS NOT NULL`,
  );
}

// Idempotent: dedup + create a unique index only if it doesn't already exist.
// Runs raw SQLite (no PG translation needed — these statements are dialect-neutral).
function ensureUniqueIndex(idxName, dedupSql, createSql) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?").get(idxName);
  if (exists) return;
  db.exec(dedupSql);
  db.exec(createSql);
}

module.exports = { pool, query, initSchema };
