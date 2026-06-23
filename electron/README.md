# SiamEPOS Spa — Desktop App (Electron)

**Phase A: a desktop wrapper around the live cloud web app.**

The app opens `https://spa.siamepos.co.uk` in a clean, installed-app window
(no browser, no address bar). The cloud (Railway Postgres) stays the single
source of truth. It adds the things a browser can't do well on a till:

- A real installed app icon + kiosk-style window
- Silent receipt printing to a system printer
- Silent background auto-update (GitHub Releases)
- A friendly offline screen when the internet drops

> **Offline _data_ (book/checkout with no internet) is Phase B** — that needs a
> local SQLite mirror + a sync engine, rebuilt for the spa's appointment
> schema. Phase A deliberately does not attempt it. When we build Phase B, the
> wrapper stays; we just point it at a local server instead of the cloud URL.

---

## Run it (development)

```bash
cd spa-epos/electron
npm install        # first time only
npm start          # launches the app, loads the live spa
npm run start:dev  # same, but with DevTools + reload in the View menu
```

Point it at a different backend for staging/testing:

```bash
SPA_APP_URL=https://staging.spa.siamepos.co.uk npm start
```

## Build an installer locally

```bash
cd spa-epos/electron
npm run build:mac   # → dist-electron/SiamEPOS Spa-<ver>-Setup.dmg
npm run build:win   # → dist-electron/SiamEPOS Spa-<ver>-Setup.exe  (run on Windows)
```

A local Mac build is **unsigned** (no Apple cert on your machine), so on
another Mac Gatekeeper will warn — right-click the app → Open the first time.
Signed + notarized builds come from CI (below).

---

## Releasing (signed + auto-update) via GitHub Actions

Workflow: `.github/workflows/release.yml` (triggers on `v*` tags).
It builds a **signed + notarized** Mac DMG and a Windows EXE and publishes
them — with the `latest-mac.yml` / `latest.yml` manifests electron-updater
needs — as a normal GitHub Release in THIS repo (`siamepos-spa`).

### One-time setup
- **Apple signing secrets** in this repo's Actions secrets: `MAC_CERT_P12_BASE64`,
  `MAC_CERT_PASSWORD`, `MAC_APPLE_ID`, `MAC_APPLE_APP_PASSWORD`, `MAC_TEAM_ID`
  (without them the Mac build stays unsigned). No Personal Access Token, no
  separate releases repo — publishing uses the built-in `GITHUB_TOKEN`.

### Cut a release
```bash
# bump the version in electron/package.json first, then:
git tag v0.2.0
git push origin v0.2.0
```
GitHub Actions builds both installers and publishes the release. Installs
already on a build with this publish config then auto-update silently on next
restart. (The very first install on a machine is always a manual download.)

---

## Files
| File | Purpose |
|------|---------|
| `main.js` | Window, live-URL load, offline fallback, printing, auto-update, menu |
| `preload.js` | Safe `window.siamposSpa` bridge (print, retry, update-ready) |
| `offline.html` | Branded "no internet" screen with a retry button |
| `entitlements.mac.plist` | Hardened-runtime entitlements for notarization |
| `package.json` | electron-builder config + publish target |

## TODO / polish
- **Branded app icon** — currently the default Electron icon. Add a 512px
  PNG/ICNS and set `build.mac.icon` / `build.win.icon`.
- **ESC/POS thermal receipts** — Phase A prints the on-screen view. Proper
  thermal formatting comes once the spa's printer hardware is chosen (Phase A.2),
  reusing the restaurant's raw-print helper as a pattern.
