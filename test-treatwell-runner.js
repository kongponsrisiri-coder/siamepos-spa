// test-treatwell-runner.js
// Boots the SiamEPOS Spa server in-process using pg-mem, seeds minimal data,
// then runs test-treatwell.js against it on an ephemeral port.
//
// Usage:  node test-treatwell-runner.js
//
// This file is the test harness only — it is NOT loaded by the production server.

process.env.NODE_ENV        = 'test';
process.env.JWT_SECRET      = 'test-secret-32-chars-minimum-xx';
process.env.TREATWELL_WEBHOOK_SECRET = 'spa003-local-test-secret';
process.env.PUBLIC_API_URL  = 'http://localhost';  // set properly once port is known

const { newDb } = require('pg-mem');
const http       = require('http');
const { execSync, spawn } = require('child_process');

// ── 1. Build a pg-mem–backed Pool that fixes the two unsupported constructs ──
// pg-mem v3 lacks: LATERAL JOIN,  FOR UPDATE
// We rewrite those in-flight so the rest of the server code is unchanged.

function buildPool() {
  const pgmem = newDb();

  // Register missing built-in functions that pg-mem doesn't ship with.
  pgmem.public.registerFunction({ name: 'trim',    args: ['text'],       returns: 'text',    implementation: (s) => (s ?? '').trim() });
  pgmem.public.registerFunction({ name: 'btrim',   args: ['text'],       returns: 'text',    implementation: (s) => (s ?? '').trim() });
  pgmem.public.registerFunction({ name: 'ltrim',   args: ['text'],       returns: 'text',    implementation: (s) => (s ?? '').trimStart() });
  pgmem.public.registerFunction({ name: 'rtrim',   args: ['text'],       returns: 'text',    implementation: (s) => (s ?? '').trimEnd() });
  pgmem.public.registerFunction({ name: 'now',     args: [],             returns: 'timestamp with time zone', implementation: () => new Date() });
  pgmem.public.registerFunction({ name: 'gen_random_uuid', args: [],     returns: 'uuid',    implementation: () => require('crypto').randomUUID() });
  pgmem.public.registerFunction({ name: 'nullif',   args: ['text', 'text'], returns: 'text',    implementation: (a, b) => (a === b ? null : a) });
  pgmem.public.registerFunction({ name: 'length',   args: ['text'],         returns: 'integer',  implementation: (s) => (s ?? '').length });
  pgmem.public.registerFunction({ name: 'char_length', args: ['text'],      returns: 'integer',  implementation: (s) => (s ?? '').length });

  // pg-mem supplies a pg-compatible Pool/Client adapter
  const { Pool: PgMemPool, Client: PgMemClient } = pgmem.adapters.createPg();

  const rawPool = new PgMemPool();

  function rewriteQuery(text) {
    if (typeof text !== 'string') return text;
    // 1. Strip FOR UPDATE / FOR SHARE lock hints
    let q = text.replace(/\bFOR\s+UPDATE\b/gi, '').replace(/\bFOR\s+SHARE\b/gi, '');
    // 1b. Rewrite NOT IN ('a','b') to NOT (x = 'a' OR x = 'b') — pg-mem bug with NOT IN strings.
    q = q.replace(
      /(\w+)\s+NOT\s+IN\s*\(('(?:[^']*)'(?:\s*,\s*'[^']*')*)\)/gi,
      (_, col, vals) => {
        const items = vals.match(/'[^']*'/g) || [];
        return '(' + items.map(v => `${col} != ${v}`).join(' AND ') + ')';
      },
    );
    // 2. Drop the LATERAL bills join entirely.
    //    pg-mem supports neither LATERAL, correlated sub-selects in JOIN ON,
    //    nor window functions, nor derived-table lookups for this pattern.
    //    The test only needs appointment fields (source, treatwell_payment_type,
    //    etc.), not bill columns, so we strip the whole JOIN and replace the
    //    selected bill columns with NULLs so the SELECT list still compiles.
    //    Pattern matched:
    //      …b.payment_method, b.payment_status AS bill_status, b.total AS bill_total
    //         FROM appointments a … LEFT JOIN LATERAL (…) b ON TRUE …
    q = q.replace(
      /LEFT\s+JOIN\s+LATERAL\s*\(\s*SELECT\s+payment_method,\s*payment_status,\s*total\s+FROM\s+bills\s+WHERE\s+appointment_id\s*=\s*a\.id\s+ORDER\s+BY\s+id\s+DESC\s+LIMIT\s+1\s*\)\s*b\s+ON\s+TRUE/gi,
      '',  // remove the join — b.* columns become undefined, handled below
    );
    // Replace the selected bill columns with NULLs to avoid "column b.X does not exist".
    q = q.replace(/\bb\.payment_method\b/g, 'NULL AS payment_method')
         .replace(/\bb\.payment_status\s+AS\s+bill_status\b/gi, 'NULL AS bill_status')
         .replace(/\bb\.total\s+AS\s+bill_total\b/gi, 'NULL AS bill_total');
    return q;
  }

  // Wrap query() so rewrites happen transparently
  const pool = {
    query: (text, params) => rawPool.query(rewriteQuery(text), params),
    connect: async () => {
      const client = await rawPool.connect();
      return {
        query:   (text, params) => client.query(rewriteQuery(text), params),
        release: ()             => client.release(),
      };
    },
    on: (ev, fn) => rawPool.on(ev, fn),
    end:  () => rawPool.end(),
  };

  return { pool, pgmem };
}

// ── 2. Patch require('pg') before anything else imports it ──────────────────
// The database module does  const { Pool } = require('pg');
// We swap that out with our wrapped version.
const { pool, pgmem } = buildPool();

// Monkey-patch the module resolver so any require('pg') gets our mock Pool
const Module = require('module');
const _origLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'pg') {
    return {
      Pool: class FakePool {
        constructor() { return pool; }
      },
      Client: class FakeClient {},
    };
  }
  return _origLoad.apply(this, arguments);
};

// ── 3. Initialise schema + seed data ────────────────────────────────────────
async function setup() {
  const { initSchema } = require('./src/db/database');

  // pg-mem doesn't support all the ALTER TABLE … ADD COLUMN IF NOT EXISTS
  // inside a single multi-statement string, so we call initSchema() which
  // fires pool.query() — but first we need to handle its multi-statement
  // blocks by wrapping each statement individually.
  // initSchema fires one big pool.query(...) call; pg-mem can handle most
  // of it but not the big multi-ALTER block.  We'll call it inside a try
  // and ignore "column already exists" warnings.
  try { await initSchema(); } catch (e) {
    // Schema partially applied — that's fine for testing
    if (!e.message?.includes('already exists') && !e.message?.includes('does not exist')) {
      console.warn('[setup] initSchema warning:', e.message?.slice(0, 120));
    }
  }

  // Seed minimal data needed for Treatwell tests
  await pool.query(`
    INSERT INTO treatment_categories (name, sort_order)
    VALUES ('Massage', 1)
    ON CONFLICT DO NOTHING
  `);

  // Insert a treatment matching the webhook test payload ("Swedish Massage")
  const cats = await pool.query('SELECT id FROM treatment_categories LIMIT 1');
  const catId = cats.rows[0]?.id || null;
  await pool.query(`
    INSERT INTO treatments (category_id, name, duration_minutes, price, active)
    VALUES ($1, 'Swedish Massage', 60, 60.00, TRUE),
           ($1, 'Thai Massage',    60, 55.00, TRUE),
           ($1, 'Hot Stone',       90, 80.00, TRUE)
    ON CONFLICT DO NOTHING
  `, [catId]);

  // Seed a room
  await pool.query(`INSERT INTO rooms (name, active) VALUES ('Room 1', TRUE) ON CONFLICT DO NOTHING`);

  // Seed a therapist + availability (works all 7 days 09:00–21:00)
  const bcrypt = require('bcryptjs');
  const pinHash = bcrypt.hashSync('1234', 8);   // cost=8 is fast enough for tests
  const thRes = await pool.query(
    `INSERT INTO therapists (name, pin, role, active) VALUES ($1, $2, 'admin', TRUE) RETURNING id`,
    ['Test Therapist', pinHash],
  );
  const thId = thRes.rows[0].id;
  for (let d = 0; d <= 6; d++) {
    await pool.query(
      `INSERT INTO therapist_availability (therapist_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, '09:00', '21:00')`,
      [thId, d],
    );
  }

  // Seed specialism column if not added by schema
  try { await pool.query(`ALTER TABLE therapists ADD COLUMN IF NOT EXISTS specialisms TEXT`); } catch {}

  // Insert settings keys needed by availability / booking logic
  await pool.query(`
    INSERT INTO settings (key, value) VALUES
      ('booking_slot_minutes', '15'),
      ('booking_lead_hours',   '0'),
      ('booking_advance_days', '365'),
      ('vat_rate',             '20'),
      ('tip_suggestions',      '10,12.5,15')
    ON CONFLICT (key) DO NOTHING
  `);

  console.log('[setup] schema + seed data ready');
  return thId;
}

// ── 4. Start the Express server on a random port ────────────────────────────
async function startServer() {
  const app = require('./src/server');   // imports database.js which now uses our mock pool
  return new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      console.log(`[server] listening on :${port}`);
      resolve({ srv, port });
    });
  });
}

// ── 5. Run test-treatwell.js as a child process ─────────────────────────────
function runTests(port) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      TREATWELL_WEBHOOK_SECRET: 'spa003-local-test-secret',
      TEST_BASE_URL: `http://127.0.0.1:${port}`,
    };
    const child = spawn('node', ['test-treatwell.js'], {
      cwd: __dirname,
      env,
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code));
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await setup();
  } catch (e) {
    console.error('[setup] fatal:', e.message);
    process.exit(1);
  }

  let srv, port;
  try {
    ({ srv, port } = await startServer());
    // Update BASE in test script via env (test-treatwell.js reads TEST_BASE_URL)
  } catch (e) {
    console.error('[server] failed to start:', e.message);
    process.exit(1);
  }

  // Patch test-treatwell.js to use the dynamic port instead of hard-coded :5050
  // We do this by overriding process.env.TEST_BASE_URL and patching the BASE constant
  // at runtime using the env approach already built into the test file.
  // The test file reads:  const BASE = process.env.TEST_BASE_URL || 'http://localhost:5050'
  // So we just need the env var set (done above in runTests).
  const code = await runTests(port);

  srv.close();
  process.exit(code);
})();
