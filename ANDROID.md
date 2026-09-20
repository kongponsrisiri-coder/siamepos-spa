# SiamEPOS Spa — Android app (APK)

One APK serves every spa. On first run the app asks which spa this tablet
belongs to; the answer is stored on the device and can be changed from the
login screen ("Change spa"). The web tills are unaffected — they still have
their cloud address baked in at build time.

- App ID: `uk.co.siamepos.spa` (the restaurant app is `uk.co.siamepos.app`,
  so both can be installed side by side)
- Signed with the shared SiamEPOS upload keystore
  (`~/Documents/SiamEPOS-Android/siamepos-upload.keystore`)
- Capacitor project: `client/android/`

## Build a release APK

```bash
cd client
# NO VITE_API_BASE — that is what makes the app ask which spa on first run.
# VITE_APP_BUILD stamps the version so Admin → Mobile App can say
# "installed 1.0.1, latest 1.0.2".
rm -rf dist && VITE_APP_BUILD=<version> npx vite build
npx cap sync android
cd android
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleRelease
cp app/build/outputs/apk/release/app-release.apk \
   ~/Documents/SiamEPOS-Android/SiamEPOS-Spa-v<version>.apk
```

Bump `versionCode` (+1) and `versionName` in `client/android/app/build.gradle`
before every release. Name the file by version, never "latest".

## Publishing (the link the client downloads from)

Same channel as the restaurant app: a GitHub release on the public
`kongponsrisiri-coder/siamepos-releases` repo, tagged `spa-v<version>`.

```bash
gh release create spa-v1.0.1 \
  ~/Documents/SiamEPOS-Android/SiamEPOS-Spa-v1.0.1.apk#SiamEPOS-Spa-v1.0.1.apk \
  -R kongponsrisiri-coder/siamepos-releases \
  --title "SiamEPOS Spa (Android) v1.0.1" --notes "what changed"
```

The page to send a client is the release page; the tablet can also hit the
asset directly:

- page: `https://github.com/kongponsrisiri-coder/siamepos-releases/releases/tag/spa-v<version>`
- file: `https://github.com/kongponsrisiri-coder/siamepos-releases/releases/download/spa-v<version>/SiamEPOS-Spa-v<version>.apk`

A short link that always points at the newest build lives on the spa API:
`https://spa-api.siamepos.co.uk/app` (302 → the release asset). **The link
never changes — only the version behind it.** After publishing a release:

1. bump `ANDROID_APK_VERSION` in `src/server.js`
2. deploy the clouds

Admin → **Mobile App** then shows the new version, the link, a QR code, and —
for a till already running inside the app — an "Update available" banner
(`GET /api/app/android` serves the version; the app compares it with its own
`VITE_APP_BUILD` stamp).

## Adding a new spa to the first-run list

Edit `KNOWN_SPAS` in `client/src/apiBase.js`, then rebuild. A client whose spa
is not in the list can still type their address on the setup screen, so a new
client never has to wait for an app update.

## Server side

The app's requests come from `http://localhost` (Capacitor), so those origins
are in `ALLOWED_ORIGINS` in `src/server.js`. A new tenant deploy needs no extra
CORS setup.

## Booking notifications (SPA-PUSH-001)

Real notifications — the tablet buzzes with the app closed — go through
Firebase Cloud Messaging. Two pieces, both one-off:

**1. The app** needs `client/android/app/google-services.json` (Firebase →
Project settings → Your apps → Android app `uk.co.siamepos.spa`). Without it
the APK still builds and runs; push is simply off. Add the file, rebuild,
publish.

**2. Each spa cloud** needs `FCM_SERVICE_ACCOUNT` — the service-account JSON
(Firebase → Project settings → Service accounts → Generate new private key),
pasted whole or base64-encoded. Without it the server returns
`{ skipped: true }` and nothing else changes.

One Firebase project covers every spa: the app id is the same everywhere, and
each cloud keeps its own device list in `push_devices`.

What fires a notification: a booking from the website widget, Treatwell
(webhook or email), Fresha, or a chatbot hold once it is paid. Bookings typed
at the till stay silent, same rule as the on-screen alert card.

Admin → Mobile App shows whether push is on and has a **Send a test
notification** button.
