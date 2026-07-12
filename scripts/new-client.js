#!/usr/bin/env node
/**
 * scripts/new-client.js — SiamEPOS Spa "new client" onboarding generator.
 *
 * SiamEPOS Spa is SINGLE-TENANT: every client gets its own copy of the same
 * architecture — its own Railway backend, its own Postgres database, its own
 * Netlify site, its own web address. This script does NOT deploy anything. It
 * just asks you a handful of questions about the new client and prints (and
 * saves) a complete, paste-ready setup sheet:
 *
 *   • fresh, unique secrets (never reuse another client's)
 *   • the exact Railway env vars to paste in
 *   • the Netlify setting
 *   • the DNS records to add
 *   • the values to type into the till's setup wizard
 *   • a numbered go-live checklist
 *
 * You then follow the sheet in Railway / Netlify / the DNS panel by hand.
 *
 * Usage (interactive — recommended):
 *   node scripts/new-client.js
 *   npm run new-client
 *
 * Usage (non-interactive, e.g. scripted):
 *   node scripts/new-client.js --name="Baan Thai Spa" --slug=baanthai \
 *       --email=hello@baanthai.co.uk --stripe=test
 *
 * The finished sheet is written to  client-setups/<slug>.md  (git-ignored,
 * because it contains secrets — keep it somewhere safe, do NOT commit it).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const BASE_DOMAIN_DEFAULT = 'siamepos.co.uk';
const OUT_DIR = path.join(__dirname, '..', 'client-setups');

// A long random hex string — used for every generated secret.
const secret = () => crypto.randomBytes(32).toString('hex');

// Turn "Baan Thai Spa" into "baan-thai-spa" (safe for a subdomain + spa id).
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

// Read a --key=value command-line flag, or undefined.
function flag(key) {
  const hit = process.argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : undefined;
}

function ask(rl, question, def) {
  const suffix = def ? ` [${def}]` : '';
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (ans) => {
      resolve((ans || '').trim() || def || '');
    });
  });
}

async function collect() {
  const nonInteractive = !!flag('name');

  if (nonInteractive) {
    const name = flag('name');
    return {
      name,
      slug: slugify(flag('slug') || name),
      owner: flag('owner') || '',
      email: flag('email') || 'info@siamepos.co.uk',
      address: flag('address') || '',
      baseDomain: flag('domain') || BASE_DOMAIN_DEFAULT,
      plan: flag('plan') || 'Spa',
      stripeMode: (flag('stripe') || 'test').toLowerCase() === 'live' ? 'live' : 'test',
    };
  }

  if (!process.stdin.isTTY) {
    console.error(
      'No terminal to prompt on. Run interactively, or pass flags, e.g.:\n' +
        '  node scripts/new-client.js --name="Baan Thai Spa" --slug=baanthai\n'
    );
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n  SiamEPOS Spa — set up a NEW client');
  console.log('  Answer a few questions. Press Enter to accept the [default].\n');

  let name = '';
  while (!name) name = await ask(rl, 'Business name (required)');
  const slug = slugify(await ask(rl, 'Short ID / subdomain', slugify(name)));
  const owner = await ask(rl, 'Owner name (optional)', '');
  const email = await ask(rl, 'Contact email', 'info@siamepos.co.uk');
  const address = await ask(rl, 'Postal address (for the GDPR email footer, optional)', '');
  const baseDomain = await ask(rl, 'Base domain', BASE_DOMAIN_DEFAULT);
  const plan = await ask(rl, 'Plan (for the ops registry)', 'Spa');
  const stripeAns = (await ask(rl, 'Stripe mode (test/live)', 'test')).toLowerCase();

  rl.close();
  return { name, slug, owner, email, address, baseDomain, plan, stripeMode: stripeAns === 'live' ? 'live' : 'test' };
}

function buildSheet(d, now) {
  const s = {
    JWT_SECRET: secret(),
    SYNC_SECRET: secret(),
    BOOKING_SECRET: secret(),
    UNSUB_SECRET: secret(),
  };
  const apiUrl = `https://${d.slug}-api.${d.baseDomain}`;
  const appUrl = `https://${d.slug}.${d.baseDomain}`;
  const apiHost = `${d.slug}-api.${d.baseDomain}`;
  const appHost = `${d.slug}.${d.baseDomain}`;
  const stripeNote =
    d.stripeMode === 'live'
      ? 'LIVE keys — real cards will be charged.'
      : 'TEST keys — no real money moves (switch to live once their Stripe is approved).';

  // The paste-ready Railway env block.
  const envBlock = [
    `PORT=5050`,
    ``,
    `# --- unique secrets (generated for ${d.name} — never reuse another client's) ---`,
    `JWT_SECRET=${s.JWT_SECRET}`,
    `SYNC_SECRET=${s.SYNC_SECRET}`,
    `BOOKING_SECRET=${s.BOOKING_SECRET}`,
    `UNSUB_SECRET=${s.UNSUB_SECRET}`,
    ``,
    `# --- this spa's identity ---`,
    `SPA_NAME=${d.name}`,
    `SPA_EMAIL=${d.email}`,
    `SPA_ADDRESS=${d.address}`,
    `PUBLIC_API_URL=${apiUrl}`,
    ``,
    `# --- which website(s) may call this backend (comma-separated) ---`,
    `ALLOWED_ORIGINS=${appUrl}`,
    ``,
    `# --- payments (${stripeNote}) fill these in from the client's Stripe dashboard ---`,
    `STRIPE_SECRET_KEY=`,
    `STRIPE_PUBLISHABLE_KEY=`,
    `STRIPE_WEBHOOK_SECRET=`,
    ``,
    `# --- email confirmations (optional) ---`,
    `BREVO_API_KEY=`,
    ``,
    `# --- licensing (optional) — the SHARED SiamEPOS key, ask Pose/ops. ---`,
    `# The till works without it (fails open); set it only to enforce paid-up status.`,
    `# LICENSE_PRIVATE_KEY=`,
    ``,
    `# DATABASE_URL is added automatically by Railway's Postgres plugin — do NOT set it by hand.`,
  ].join('\n');

  return `# New client setup — ${d.name}

Generated: ${now.toISOString()}
⚠️  Contains secrets. Keep this file private. It is git-ignored — do NOT commit it.

| | |
|---|---|
| Business name | ${d.name} |
| Owner         | ${d.owner || '—'} |
| Spa ID / slug | \`${d.slug}\` |
| Plan          | ${d.plan} |
| Customer app  | ${appUrl} |
| Cloud API     | ${apiUrl} |
| Payments      | Stripe ${d.stripeMode.toUpperCase()} mode |

This client is a **copy of the same architecture** Highbury runs on — a new
Railway backend + its own Postgres + a new Netlify site. Highbury is not
touched. Work top to bottom.

---

## 1 — Backend (Railway)

1. Railway → **New Project → Deploy from GitHub repo** → pick \`siamepos-spa\`.
2. **Add the PostgreSQL plugin** (this gives the client their own empty database;
   Railway injects \`DATABASE_URL\` automatically).
3. **Variables →** paste the env block from the bottom of this sheet.
4. First deploy runs \`npm start\` → creates all tables + a default admin **PIN 1234**.
5. Settings → Networking → **Generate Domain**, then add the custom domain
   \`${apiHost}\`.

## 2 — Frontend (Netlify)

1. Netlify → **Add new site → Import from Git** → same \`siamepos-spa\` repo
   (suggested site name: \`siamspa-${d.slug}\`).
2. Site settings → **Environment variables** → set
   \`VITE_API_BASE = ${apiUrl}\`  (this points the website at THIS client's backend).
3. Domain management → add \`${appHost}\` → re-deploy.

## 3 — DNS (at the ${d.baseDomain} DNS provider)

Add two CNAME records:

| Type  | Name              | Points to (from the dashboards above) |
|-------|-------------------|----------------------------------------|
| CNAME | \`${d.slug}-api\`   | the Railway-generated domain |
| CNAME | \`${d.slug}\`       | the Netlify-generated domain |

## 4 — Payments (Stripe · ${d.stripeMode.toUpperCase()} mode)

1. In the client's Stripe dashboard, copy the **${d.stripeMode}** secret +
   publishable keys into \`STRIPE_SECRET_KEY\` / \`STRIPE_PUBLISHABLE_KEY\` on Railway.
2. Add a webhook endpoint:
   \`${apiUrl}/api/stripe/webhook\`  for the event \`payment_intent.succeeded\`.
3. Paste its signing secret into \`STRIPE_WEBHOOK_SECRET\` and redeploy.

## 5 — The till (on the client's device)

Install the SiamEPOS Spa app, open it, and in the **first-run setup screen** type:

| Field         | Value |
|---------------|-------|
| Spa name      | ${d.name} |
| Cloud address | ${apiUrl} |
| Spa ID        | ${d.slug} |
| Sync key      | ${s.SYNC_SECRET} |

(The Sync key is the same value as \`SYNC_SECRET\` above.)

## 6 — Go live

1. Open ${appUrl} (or the till) and log in with **PIN 1234**.
2. Add the client's treatments, rooms, therapists and staff.
   (Optional starter data: \`node scripts/seed-demo.js --api=${apiUrl}\`.)
3. **Change the admin PIN** in the Staff tab.
4. Sanity check: \`curl ${apiUrl}/api/health\` → \`{ok:true,…}\`.

## 7 — Register in the shared ops back-office (for Pose)

So this client appears in the SiamEPOS ops dashboard (uptime health checks,
billing, till telemetry), add a **clients** row with **product = spa** and the
values below. The back-office already supports spa clients — this is
registration only. (It lives in the separate ops app; we do not modify it here.)

| Registry field | Value |
|----------------|-------|
| Business name  | ${d.name} |
| Owner name     | ${d.owner || '—'} |
| Email          | ${d.email} |
| Slug           | ${d.slug} |
| Product        | spa |
| Plan           | ${d.plan} |
| Railway URL    | ${apiUrl} |
| Netlify URL    | ${appUrl} |
| Sync secret    | ${s.SYNC_SECRET} |

---

## Railway env block — paste this into Railway → Variables

\`\`\`
${envBlock}
\`\`\`
`;
}

async function main() {
  const d = await collect();
  const now = new Date();
  const sheet = buildSheet(d, now);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${d.slug}.md`);
  fs.writeFileSync(outPath, sheet, 'utf8');

  console.log('\n' + sheet);
  console.log(`\n  ✔ Saved to ${path.relative(path.join(__dirname, '..'), outPath)}`);
  console.log('  ⚠  This file contains secrets and is git-ignored — keep it safe.\n');
}

main().catch((err) => {
  console.error('\nSomething went wrong:', err.message);
  process.exit(1);
});
