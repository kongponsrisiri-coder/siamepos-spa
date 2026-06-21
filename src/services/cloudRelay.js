// SiamEPOS Spa — realtime cloud→local relay (SEPOS-SPA-PRO-001 Phase B4).
//
// In desktop-till (DB_MODE=local) mode, this opens a socket.io CLIENT
// connection to the cloud and forwards the cloud's realtime events onto THIS
// install's LOCAL socket.io. Net effect: a booking made in a browser (or on
// another till) shows up on this till in well under a second, instead of
// waiting up to the 5s sync tick. Each inbound event also schedules a debounced
// local pull so SQLite has the new rows before React's HTTP refetch arrives.
//
// No-op in cloud mode (the cloud server IS the source of these events) and when
// CLOUD_API_URL is unset.

const CLOUD_API_URL = process.env.CLOUD_API_URL || '';

// The events the spa cloud emits (kept in sync with the routes that emit them).
const RELAY_EVENTS = [
  'new_appointment',
  'appointment_updated',
  'appointment_status',
  'rota_updated',
  'turn_order_updated',
];

let cloudSocket = null;
let pullTimer = null;

// Coalesce a burst of events into one pull (150ms debounce).
function schedulePull(syncService) {
  if (pullTimer) return;
  pullTimer = setTimeout(() => {
    pullTimer = null;
    if (syncService && syncService.pullFromCloud) {
      syncService.pullFromCloud().catch(() => {});
    }
  }, 150);
}

function start(localIo, syncService) {
  if ((process.env.DB_MODE || '').toLowerCase() !== 'local' || !CLOUD_API_URL) return;

  let ioClient;
  try {
    ioClient = require('socket.io-client').io;
  } catch {
    console.warn('[cloud-relay] socket.io-client not installed — realtime relay disabled (5s pull still works)');
    return;
  }

  cloudSocket = ioClient(CLOUD_API_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
  });

  cloudSocket.on('connect', () => console.log('[cloud-relay] connected to', CLOUD_API_URL));
  cloudSocket.on('disconnect', (reason) => console.log('[cloud-relay] disconnected:', reason));
  // Quiet on connect errors — they spam while offline; reconnection handles it.
  cloudSocket.on('connect_error', () => {});

  for (const event of RELAY_EVENTS) {
    cloudSocket.on(event, (payload) => {
      schedulePull(syncService);
      try { localIo.emit(event, payload); } catch {}
    });
  }

  console.log('[cloud-relay] started — relaying', RELAY_EVENTS.length, 'cloud events to the local till');
}

function stop() {
  if (cloudSocket) {
    try { cloudSocket.disconnect(); } catch {}
    cloudSocket = null;
  }
  if (pullTimer) { clearTimeout(pullTimer); pullTimer = null; }
}

module.exports = { start, stop };
