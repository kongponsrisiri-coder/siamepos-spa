#!/usr/bin/env node
/**
 * SPA-DEPLOY-ALL-001 — ship one commit to every spa, in stages, with proof.
 *
 * Why this exists. On 2026-09-20 three separate deploy mistakes hit clients in
 * one afternoon, and every one of them was a human holding the pieces:
 *
 *   1. `railway up` uploads the CURRENT DIRECTORY. Run from client/ by mistake
 *      and Railway sees a website, not an API — Highbury's till went down and
 *      the login screen showed "No till staff set up yet".
 *   2. `netlify deploy` without --no-build re-runs the site's own build, which
 *      bakes in the DEMO api url and silently points a shop at the wrong cloud.
 *   3. A client simply gets forgotten, and runs old code for weeks.
 *
 * So this script never trusts the laptop. It exports a CLEAN copy of one commit
 * to a temp dir and deploys from there; it reads every tenant from
 * scripts/tenants.json so nobody can be forgotten; and after each step it goes
 * and LOOKS at the live site to prove the deploy worked, refusing to continue
 * to the next shop if it did not.
 *
 * Usage
 *   node scripts/deploy-all.js                 # deploy HEAD to every tenant, staged
 *   node scripts/deploy-all.js --dry-run       # print the plan, change nothing
 *   node scripts/deploy-all.js --only highbury # one tenant
 *   node scripts/deploy-all.js --stage 0       # just the demo
 *   node scripts/deploy-all.js --commit abc123 # ship a specific commit
 *   node scripts/deploy-all.js --api-only      # clouds only, skip the tills
 *   node scripts/deploy-all.js --till-only     # tills only, skip the clouds
 *
 * Stages run in order and the whole run STOPS at the first failure, so a broken
 * build reaches the demo and goes no further.
 *
 * IMPORTANT — auto-deploy defeats staging. A cloud that is git-linked to main
 * redeploys itself the moment you push, before this script has checked anything.
 * For staged rollout to mean anything, client services must NOT be git-linked;
 * push your commit, then run this. The script warns if it finds one.
 */

const { execFileSync, execSync } = require('child_process');
const https = require('https');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');

const ROOT     = path.resolve(__dirname, '..');
const REGISTRY = path.join(__dirname, 'tenants.json');

// ── arguments ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt  = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

const DRY       = flag('dry-run');
const ONLY      = opt('only');
const STAGE     = opt('stage');
const COMMIT    = opt('commit') || 'HEAD';
const API_ONLY  = flag('api-only');
const TILL_ONLY = flag('till-only');

// ── output ──────────────────────────────────────────────────────────────────
const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };
const say  = (m) => console.log(m);
const step = (m) => console.log(`   ${C.dim}·${C.off} ${m}`);
const ok   = (m) => console.log(`   ${C.green}✓${C.off} ${m}`);
const warn = (m) => console.log(`   ${C.yellow}!${C.off} ${m}`);
const die  = (m) => { console.error(`\n${C.red}✗ ${m}${C.off}\n`); process.exit(1); };

// ── helpers ─────────────────────────────────────────────────────────────────
function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function getJson(url, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const req = https.get(url, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(b) }); }
        catch { resolve({ status: r.statusCode, body: null, text: b.slice(0, 200) }); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, body: null, text: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, body: null, text: e.code }));
  });
}

function getText(url, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const req = https.get(url, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => resolve({ status: r.statusCode, text: b }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, text: '' }); });
    req.on('error', () => resolve({ status: 0, text: '' }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the two checks that would have caught every real incident ───────────────

// Proves the cloud restarted on new code AND is still a working API.
// `booted_at` changes only on a real restart; `ok:true` means Express answered
// rather than Caddy serving a static copy of the till (incident 1).
async function waitForApi(t, previousBoot) {
  const deadline = Date.now() + 6 * 60 * 1000;
  let lastSeen = '';
  while (Date.now() < deadline) {
    const { status, body, text } = await getJson(`${t.api}/api/health`);
    if (body && body.ok) {
      if (!previousBoot || body.booted_at !== previousBoot) {
        return body;
      }
      lastSeen = 'still the old process';
    } else if (status === 200 && !body) {
      // JSON expected, HTML received: the service is serving the front-end.
      lastSeen = 'answering with HTML, not JSON — wrong folder was deployed';
    } else {
      lastSeen = `health ${status}${text ? ' ' + text : ''}`;
    }
    await sleep(8000);
  }
  die(`${t.name}: cloud did not come back within 6 minutes (${lastSeen}).`);
}

// The login screen makes exactly these two calls before anyone can sign in.
// If either is wrong the shop sees "No till staff set up yet" and a blank brand.
async function smokeApi(t) {
  const staff = await getJson(`${t.api}/api/auth/staff`);
  if (!staff.body || !Array.isArray(staff.body.staff) || staff.body.staff.length === 0) {
    die(`${t.name}: /api/auth/staff returned no staff — the till cannot be signed into.`);
  }
  const brand = await getJson(`${t.api}/api/widget/branding`);
  const name  = brand.body && (brand.body.spa_name || brand.body.name);
  ok(`API healthy — ${staff.body.staff.length} staff, branding "${name || 'unset'}"`);
}

// Proves the deployed bundle talks to THIS tenant's cloud, not the demo.
// This is the check that would have caught incident 2 in seconds.
async function verifyTill(t) {
  const page = await getText(`${t.till}/`);
  const m = page.text.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
  if (!m) die(`${t.name}: could not find the app bundle at ${t.till}`);
  const bundle = await getText(`${t.till}/${m[0]}`);
  const host = new URL(t.api).host;
  if (!bundle.text.includes(host)) {
    die(`${t.name}: the live till does NOT point at ${host}. It was built against the wrong cloud — do not leave this deployed.`);
  }
  ok(`Till live and pointed at ${host}`);
}

// ── deploy steps ────────────────────────────────────────────────────────────
async function deployApi(t, src) {
  const before = await getJson(`${t.api}/api/health`);
  const previousBoot = before.body && before.body.booted_at;
  if (!previousBoot) warn('could not read the current boot time — will accept the first healthy answer');

  step(`railway up  (from ${src})`);
  if (DRY) { ok('dry run — not deployed'); return; }
  try {
    run('railway', [
      'up', '--detach',
      '--project', t.railway.project,
      '--environment', t.railway.environment,
      '--service', t.railway.service,
    ], src);   // <- cwd is the clean export, never the laptop's working dir
  } catch (e) {
    die(`${t.name}: railway up failed.\n${(e.stderr || e.stdout || e.message || '').toString().slice(0, 600)}`);
  }
  step('waiting for the cloud to restart…');
  const health = await waitForApi(t, previousBoot);
  ok(`restarted (booted ${health.booted_at})`);
  await smokeApi(t);
}

async function deployTill(t, src) {
  step(`vite build  VITE_API_BASE=${t.api}`);
  if (DRY) { ok('dry run — not built or deployed'); return; }

  const client = path.join(src, 'client');
  execSync('npm run build', {
    cwd: client, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VITE_API_BASE: t.api },
  });

  // Catch a wrong-cloud build BEFORE it reaches the shop, not after.
  const assets = path.join(client, 'dist', 'assets');
  const js = fs.readdirSync(assets).filter((f) => f.endsWith('.js'));
  const host = new URL(t.api).host;
  const good = js.some((f) => fs.readFileSync(path.join(assets, f), 'utf8').includes(host));
  if (!good) die(`${t.name}: the build does not contain ${host}. Refusing to deploy it.`);
  ok(`bundle contains ${host}`);

  step(`netlify deploy --no-build --site ${t.netlifySite}`);
  try {
    run('npx', [
      'netlify', 'deploy', '--prod', '--no-build',
      '--dir', 'dist',
      '--site', t.netlifySite,     // always explicit — see tenants.json
    ], client);
  } catch (e) {
    die(`${t.name}: netlify deploy failed.\n${(e.stderr || e.stdout || e.message || '').toString().slice(0, 600)}`);
  }
  await sleep(4000);
  await verifyTill(t);
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  let tenants = registry.tenants;
  if (ONLY)  tenants = tenants.filter((t) => t.key === ONLY);
  if (STAGE) tenants = tenants.filter((t) => String(t.stage) === String(STAGE));
  if (!tenants.length) die(`No tenants matched. Known: ${registry.tenants.map((t) => t.key).join(', ')}`);

  const sha     = run('git', ['rev-parse', '--short', COMMIT], ROOT).trim();
  const subject = run('git', ['log', '-1', '--format=%s', sha], ROOT).trim();
  const dirty   = run('git', ['status', '--porcelain'], ROOT).trim();

  say(`\n${C.bold}SiamEPOS Spa — staged deploy${C.off}`);
  say(`${C.dim}commit${C.off}  ${sha}  ${subject}`);
  if (dirty) warn('you have uncommitted changes — they will NOT be deployed (a clean copy of the commit is used)');
  if (DRY) say(`${C.yellow}DRY RUN — nothing will be changed${C.off}`);

  const stages = [...new Set(tenants.map((t) => t.stage))].sort((a, b) => a - b);
  say('');
  for (const s of stages) {
    const inStage = tenants.filter((t) => t.stage === s);
    say(`${C.dim}stage ${s}:${C.off} ${inStage.map((t) => t.hold ? `${t.key} (on hold)` : t.key).join(', ')}`);
  }

  // Clean export of the commit — the laptop's working directory never ships.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-deploy-'));
  say(`\n${C.dim}exporting ${sha} to ${src}${C.off}`);
  execSync(`git archive ${sha} | tar -x -C ${JSON.stringify(src)}`, { cwd: ROOT, shell: '/bin/bash' });
  if (!DRY && !API_ONLY) {
    step('npm install (client) — needed to build the tills');
    execSync('npm install --silent', { cwd: path.join(src, 'client'), stdio: ['ignore', 'pipe', 'pipe'] });
  }

  const done = [];
  for (const s of stages) {
    say(`\n${C.bold}── stage ${s} ──${C.off}`);
    for (const t of tenants.filter((x) => x.stage === s)) {
      say(`\n${C.bold}${t.name}${C.off} ${C.dim}(${t.key})${C.off}`);
      if (t.hold) { warn(`SKIPPED — ${t.hold}`); done.push(`${t.key}: skipped`); continue; }
      if (!TILL_ONLY) await deployApi(t, src);
      if (!API_ONLY)  await deployTill(t, src);
      done.push(`${t.key}: ok`);
    }
  }

  fs.rmSync(src, { recursive: true, force: true });
  say(`\n${C.green}${C.bold}Done.${C.off} ${sha} — ${done.join(' · ')}\n`);
})().catch((e) => die(e.stack || e.message));
