#!/usr/bin/env node
/**
 * SPA-REGRESSION-001 — the checks every update must pass before it reaches a shop.
 *
 * Why this exists. On 28 Nov 2026 Highbury said "fix one thing, break another":
 * each deploy put their off-duty therapists back on the rota, and a booking
 * could not be moved. Every fix had been checked on its own and shipped the
 * same hour; nothing checked the rest of the till. deploy-all.js now runs this
 * first and refuses to deploy if anything fails.
 *
 * It starts its OWN throwaway Postgres in a temp folder (never a real database),
 * runs every test file as a separate process, then deletes the database.
 *
 *   node scripts/regression.js            # everything
 *   node scripts/regression.js moves      # only files whose name contains "moves"
 *   REGRESSION_VERBOSE=1 …                # show the server's own logs too
 *
 * What it covers (add a file to test/regression/ for each new thing a shop
 * can't afford to lose — it is picked up automatically):
 *   restart   a deploy changes nothing the shop set up (rota, rooms, settings…)
 *   moves     drag / edit / swap, rooms, the refusals that must still happen
 *   checkout  every payment method + the reports count it in the right place
 *   treatwell a real email → booking with the right length and paid state
 *   + the existing parser tests (test/*.test.js) and client merge (test/merge/merge-e2e.js)
 * Not covered here: the offline desktop till (needs Electron — see test/merge/README.md).
 */
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', bold: '\x1b[1m', off: '\x1b[0m' };
const filter = process.argv[2] || '';

function pgBin(name) {
  for (const dir of ['/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/lib/postgresql/16/bin', '/usr/bin']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`${name} not found — install Postgres (brew install postgresql@16)`);
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'test/regression')).filter((f) => f.endsWith('.test.js')).map((f) => `test/regression/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => `test/${f}`),
    'test/merge/merge-e2e.js',   // wipes client tables, so it runs last
  ].filter((f) => f.includes(filter));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-regression-'));
  const data = path.join(dir, 'pg');
  const port = await freePort();
  let started = false;
  const stop = () => {
    if (started) { try { execFileSync(pgBin('pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } catch { /* already down */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  process.on('SIGINT', () => { stop(); process.exit(130); });

  try {
    console.log(`\n${C.bold}SiamEPOS Spa — regression checks${C.off} ${C.dim}(throwaway database, port ${port})${C.off}`);
    execFileSync(pgBin('initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-sync'], { stdio: 'ignore' });
    // -k '': TCP only — the Unix socket path inside a temp dir is too long.
    execFileSync(pgBin('pg_ctl'), ['-D', data, '-o', `-p ${port} -k '' -F`, '-l', path.join(dir, 'pg.log'), '-w', 'start'], { stdio: 'ignore' });
    started = true;
    execFileSync(pgBin('createdb'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', 'spa_regression'], { stdio: 'ignore' });
    const url = `postgres://postgres@127.0.0.1:${port}/spa_regression`;

    const results = [];
    for (const f of files) {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [path.join(ROOT, f)], {
        cwd: ROOT, encoding: 'utf8', timeout: 180000,
        env: { ...process.env, TEST_DATABASE_URL: url, DATABASE_URL: url, NODE_ENV: 'test' },
      });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      const okRun = r.status === 0;
      const tally = (out.match(/(\d+) passed, (\d+) failed/) || []).slice(1).map(Number);
      results.push({ f, okRun, tally });
      const label = tally.length ? `${tally[0]} passed${tally[1] ? `, ${tally[1]} failed` : ''}` : (okRun ? 'ok' : `exit ${r.status}`);
      console.log(`${okRun ? `${C.green}✓` : `${C.red}✗`}${C.off} ${f} ${C.dim}— ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)${C.off}`);
      if (!okRun) console.log(out.split('\n').filter((l) => /✗|CRASH|Error|^\s{6}/.test(l)).slice(0, 25).map((l) => `    ${l}`).join('\n'));
    }

    const failed = results.filter((r) => !r.okRun);
    const total = results.reduce((s, r) => s + (r.tally[0] || 0), 0);
    if (failed.length) {
      console.log(`\n${C.red}${C.bold}✗ ${failed.length} of ${results.length} test files failed — DO NOT DEPLOY.${C.off}\n`);
      stop(); process.exit(1);
    }
    console.log(`\n${C.green}${C.bold}✓ All ${results.length} test files passed (${total} checks).${C.off}\n`);
    stop(); process.exit(0);
  } catch (e) {
    console.error(`\n${C.red}✗ regression run could not start: ${e.message}${C.off}`);
    try { console.error(fs.readFileSync(path.join(dir, 'pg.log'), 'utf8').slice(-1500)); } catch { /* no log */ }
    stop(); process.exit(1);
  }
})();
