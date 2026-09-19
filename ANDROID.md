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
rm -rf dist && npx vite build          # NO VITE_API_BASE — that is what makes
                                       # the app ask which spa on first run
npx cap sync android
cd android
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleRelease
cp app/build/outputs/apk/release/app-release.apk \
   ~/Documents/SiamEPOS-Android/SiamEPOS-Spa-v<version>.apk
```

Bump `versionCode` (+1) and `versionName` in `client/android/app/build.gradle`
before every release. Name the file by version, never "latest".

## Adding a new spa to the first-run list

Edit `KNOWN_SPAS` in `client/src/apiBase.js`, then rebuild. A client whose spa
is not in the list can still type their address on the setup screen, so a new
client never has to wait for an app update.

## Server side

The app's requests come from `http://localhost` (Capacitor), so those origins
are in `ALLOWED_ORIGINS` in `src/server.js`. A new tenant deploy needs no extra
CORS setup.
