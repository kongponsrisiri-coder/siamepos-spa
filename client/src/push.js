// SPA-PUSH-001 — booking notifications on the tablet.
//
// The in-app card only plays while the till is on screen. This asks Android
// for notification permission, hands the device's Firebase token to the spa's
// cloud, and opens the right day when someone taps the notification.
//
// Silent no-op on the web and on any build without Firebase configured, so
// nothing here can break the till.
import { api } from './api.js';
import { nativePlatform } from './appBuild.js';   // SPA-IOS-001

let registered = false;

function plugin() {
  try {
    const p = window.Capacitor?.Plugins?.PushNotifications;
    return (p && window.Capacitor?.isNativePlatform?.()) ? p : null;
  } catch { return null; }
}

export function pushAvailable() { return !!plugin(); }

// Called after sign-in. `onOpen({ date, appointment_id })` runs when the
// person taps a notification, so the app can jump to that booking.
export async function initPush(onOpen) {
  const push = plugin();
  if (!push || registered) return { skipped: true };
  registered = true;
  try {
    let perm = await push.checkPermissions();
    if (perm.receive !== 'granted') perm = await push.requestPermissions();
    if (perm.receive !== 'granted') return { skipped: true, reason: 'permission refused' };

    push.addListener('registration', async ({ value }) => {
      try {
        await api.post('/push/register', { token: value, platform: nativePlatform() || 'android' });
      } catch (e) { /* the till works fine without push */ }
    });
    push.addListener('registrationError', (e) => console.warn('[push] registration failed', e));
    push.addListener('pushNotificationActionPerformed', ({ notification }) => {
      const d = notification?.data || {};
      if (d.type === 'new_booking' && onOpen) onOpen(d);
    });

    await push.register();
    return { ok: true };
  } catch (e) {
    console.warn('[push] init failed', e?.message || e);
    return { skipped: true, reason: e?.message };
  }
}

export async function stopPush() {
  const push = plugin();
  if (!push) return;
  try { await push.removeAllListeners(); } catch { /* ignore */ }
  registered = false;
}
