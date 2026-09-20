# Deploying SiamEPOS Spa

One command ships a commit to every spa, in stages, checking as it goes.

```bash
git push                       # put the commit on GitHub first
node scripts/deploy-all.js     # then ship it
```

That is the whole thing. Run it from anywhere — the script does not care
which folder you are standing in, which is the point.

## What it does

It deploys **demo first**, then **one real shop**, then **everyone else**,
and it **stops the moment anything fails**. A broken build reaches the demo
and goes no further.

For each spa it deploys the cloud, waits for it to restart, and then checks:

- the cloud answers with real data, not a copy of the till
- staff come back, so somebody can actually sign in
- the shop's branding resolves
- the live till is talking to **that shop's** cloud and not the demo's

If any check fails it stops and tells you which shop and why. Nothing after
that point is touched.

## Before you run it

Commit and push. The script deploys a **clean copy of a commit**, not your
folder — uncommitted changes are ignored on purpose, so a half-finished edit
can never reach a shop by accident. It warns you if you have any.

## Useful variations

```bash
node scripts/deploy-all.js --dry-run        # show the plan, change nothing
node scripts/deploy-all.js --only highbury  # one shop
node scripts/deploy-all.js --stage 0        # demo only
node scripts/deploy-all.js --api-only       # clouds, not tills
node scripts/deploy-all.js --till-only      # tills, not clouds
node scripts/deploy-all.js --commit abc123  # ship an older commit
```

## Adding a new spa

Add one row to `scripts/tenants.json` — name, its API address, its till
address, its Netlify site id and its three Railway ids. That is the only
place a client is listed, so a client cannot be forgotten.

Put a new client at `"stage": 2` until you trust it.

## Pausing a spa

Add a `hold` key with the reason:

```json
"hold": "Korakot, 2026-09-20: do not touch jinta site yet"
```

The script skips it and prints the reason rather than passing over it
silently. Delete the key to resume.

## One rule that matters

**A cloud that is connected to GitHub redeploys itself the moment you push** —
before this script has checked anything. That undoes the staging: every shop
gets the new code at once, which is exactly the risk staging exists to avoid.

Right now the demo and Jinta clouds are connected to GitHub; Highbury is not.
For staged deploys to mean anything, **disconnect the client clouds from
GitHub** (Railway → the service → Settings → Source) and let this script
deploy them. Keeping the *demo* connected is fine and quite useful — it means
the demo always runs the newest code.

## Why this exists

Three deploys went wrong in one afternoon on 2026-09-20:

1. `railway up` uploads whatever folder you are in. Run from `client/` by
   mistake and Railway sees a website, so Highbury's API was replaced by a
   static copy of the till. The shop saw "No till staff set up yet".
2. `netlify deploy` without `--no-build` re-runs the site's own build, which
   bakes in the **demo** address and silently points a shop at the wrong
   cloud.
3. A client gets forgotten and quietly runs old code for weeks.

Every one of those was a person holding the pieces. The script holds them
instead, and refuses to continue when a check fails.
