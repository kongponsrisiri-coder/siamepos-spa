// SPA-ANDROID-001 — where this till talks to.
//
// On the web the address is baked in at build time (VITE_API_BASE), so nothing
// changes for spa.siamepos.co.uk, highbury.siamepos.co.uk and the rest. In the
// Android app there is no build-time address: one APK serves every shop, and
// the person setting the tablet up chooses their spa on first run. The choice
// is stored on the device and can be changed later from the login screen.
const KEY = 'spa_api_base';

// SPA-DEVICE-PAIR-001 — there is deliberately no list of spas here any more.
// One APK serves every shop and it is published on a public download link, so
// a list of clients by name was both a directory of who our clients are and a
// one-tap route to a real shop's till for anyone who downloaded the app. A
// tablet is now invited with a setup code generated inside the spa instead.
// Kept as an empty export so nothing that still imports it breaks.
export const KNOWN_SPAS = [];

// Where a tablet redeems its setup code. Same broker as the LINE pairing.
export const PAIR_BROKER = 'https://spa-api.siamepos.co.uk';

const BUILT_IN = import.meta.env.VITE_API_BASE || '';

// SPA-DESKTOP-SETUP-001 — the Electron desktop till is a THIRD case and it was
// missed. It serves the app from its own bundled server on localhost and works
// offline, so its address is simply "same origin": there is no address to bake
// in and nothing for anyone to choose. But it is built without VITE_API_BASE,
// exactly like the Android app, so needsSetup() said true and v0.2.51 opened on
// "Which spa is this?" — a question the desktop till must never ask, and whose
// every answer is wrong (picking a cloud would point an OFFLINE till at someone
// else's online database).
function isDesktop() {
  try { return !!(window.siamposSpa && window.siamposSpa.isElectron); } catch { return false; }
}

// True when this build has no address of its own — i.e. the Android app.
export function needsSetup() {
  if (isDesktop()) return false;
  return !BUILT_IN && !stored();
}
function stored() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}
export function getApiBase() {
  // Ignore any stored address on the desktop: someone who tapped a spa on the
  // broken 0.2.51 setup screen has a cloud URL saved, which would silently
  // point their offline till at another shop's live data. Same origin, always.
  if (isDesktop()) return '';
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
// The address can only be CHANGED on a build that has no baked-in one — and
// never on the desktop till, which is always its own server.
export function canChangeSpa() { return !BUILT_IN && !isDesktop(); }
