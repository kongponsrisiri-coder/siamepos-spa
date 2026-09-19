// SPA-ANDROID-001 — where this till talks to.
//
// On the web the address is baked in at build time (VITE_API_BASE), so nothing
// changes for spa.siamepos.co.uk, highbury.siamepos.co.uk and the rest. In the
// Android app there is no build-time address: one APK serves every shop, and
// the person setting the tablet up chooses their spa on first run. The choice
// is stored on the device and can be changed later from the login screen.
const KEY = 'spa_api_base';

// Shops the app offers on first run. "Other" lets a new client type their own
// address before I've shipped an update.
export const KNOWN_SPAS = [
  { key: 'highbury', name: 'Highbury Thai Massage', url: 'https://highbury-api-production.up.railway.app' },
  { key: 'jinta',    name: 'Jinta Thai Massage',    url: 'https://jinta-api-production.up.railway.app' },
  { key: 'demo',     name: 'SiamEPOS Spa (demo)',   url: 'https://spa-api.siamepos.co.uk' },
];

const BUILT_IN = import.meta.env.VITE_API_BASE || '';

// True when this build has no address of its own — i.e. the Android app.
export function needsSetup() {
  return !BUILT_IN && !stored();
}
function stored() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}
export function getApiBase() {
  return stored() || BUILT_IN || '';
}
export function setApiBase(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  try { localStorage.setItem(KEY, clean); } catch { /* private mode */ }
  return clean;
}
export function clearApiBase() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
// The address can only be CHANGED on a build that has no baked-in one.
export function canChangeSpa() { return !BUILT_IN; }
