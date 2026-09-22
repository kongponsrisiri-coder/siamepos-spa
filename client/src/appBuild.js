// SPA-ANDROID-001 — what this copy of the till is.
//
// The Android build stamps its version in at build time (VITE_APP_BUILD, set
// by the APK recipe in ANDROID.md). The web tills have no stamp, which is
// also how we tell the two apart alongside Capacitor's own marker.
export const APP_BUILD = import.meta.env.VITE_APP_BUILD || null;

export function isNativeApp() {
  try {
    const c = window.Capacitor;
    if (!c) return false;
    return typeof c.isNativePlatform === 'function' ? c.isNativePlatform() : true;
  } catch { return false; }
}

// SPA-IOS-001 — which native shell this is. 'ios' on the iPad app (updates come
// through TestFlight, there is no APK to offer), 'android' on the APK, null on the web.
export function nativePlatform() {
  try {
    const c = window.Capacitor;
    if (!c || !isNativeApp()) return null;
    const p = typeof c.getPlatform === 'function' ? c.getPlatform() : null;
    return p === 'ios' || p === 'android' ? p : null;
  } catch { return null; }
}

// "1.0.10" > "1.0.9" — compare as numbers, not as text.
export function isNewer(latest, installed) {
  if (!latest || !installed) return false;
  const a = String(latest).split('.').map(Number);
  const b = String(installed).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}
