# Onboarding a new SiamEPOS Spa client

SiamEPOS Spa is **single-tenant**: every client is a copy of the same
architecture — their **own** Railway backend, **own** Postgres database, **own**
Netlify site, **own** `<slug>.siamepos.co.uk` address. Nothing is shared between
clients, so each spa's client medical records stay legally isolated, and standing
up a new client **cannot affect an existing one**.

You do **not** copy any code. Both clients run this same GitHub repo; a new client
is just this repo deployed again as a fresh, separate instance.

---

## Step 0 — Generate the client's setup sheet

```
npm run new-client
```

Answer the prompts (only the business name is required). The tool:

- generates **fresh, unique secrets** for this client (never shared),
- derives their web address from the name, and
- writes a complete, paste-ready sheet to `client-setups/<slug>.md`.

`client-setups/` is git-ignored because the sheet contains secrets — keep it
somewhere safe, never commit it.

## Steps 1–7 — Follow the generated sheet

The sheet walks you through, in order:

1. **Railway** — new project from this repo + a Postgres plugin; paste the env block.
2. **Netlify** — new site from this repo; set `VITE_API_BASE` to the new API URL.
3. **DNS** — two CNAME records under `siamepos.co.uk`.
4. **Stripe** — the client's keys + a webhook (test mode is fine to launch).
5. **The till** — type the cloud address / spa ID / sync key into its setup screen.
6. **Go live** — log in with **PIN 1234**, add treatments/rooms/staff, change the PIN.
7. **Ops registry** — add a `product='spa'` client row in the shared back-office so
   Pose's dashboard health-checks and bills the deployment.

## What "first deploy" does automatically (verified)

On its first boot, the backend runs `initSchema()` (creates all ~23 tables) and
`seedDefaultAdmin()` (`src/utils/seed.js`) — a default admin with **PIN 1234**.
`GET /api/health` then returns `{ok:true,…}`. Optional starter content:
`node scripts/seed-demo.js --api=<their-api-url> --pin=1234`.

## Notes

- **No code edits per client.** A client's website origin is allowed via the
  `ALLOWED_ORIGINS` env var (comma-separated) on their Railway — not by editing
  `src/server.js`.
- **Licensing is optional per client.** The till works without it (fails open);
  set the shared `LICENSE_PRIVATE_KEY` only to enforce paid-up status. See the
  licensing runbook for the rollout order.
- **Do not modify the `restaurant-epos` repo.** Its `back-office/` ops app is the
  shared registry (it already supports `product='spa'`), but it is a separate
  project — pattern reference only.
