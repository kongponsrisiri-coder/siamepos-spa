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
