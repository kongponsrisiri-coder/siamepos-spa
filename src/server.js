// SiamEPOS Spa — Express entry point.
// Loads env, opens the PG pool, initialises the schema, mounts API routes,
// and starts Socket.io.

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server: SocketIOServer } = require('socket.io');

const { initSchema } = require('./db/dbAdapter');
const { seedDefaultAdmin } = require('./utils/seed');
const { requireAuth } = require('./middleware/auth');

const authRoutes        = require('./routes/auth');
const treatmentRoutes   = require('./routes/treatments');
const therapistRoutes   = require('./routes/therapists');
const roomRoutes        = require('./routes/rooms');
const appointmentRoutes = require('./routes/appointments');
const clientRoutes      = require('./routes/clients');
const billRoutes        = require('./routes/bills');
const reportRoutes      = require('./routes/reports');
const settingsRoutes    = require('./routes/settings');
const voucherRoutes     = require('./routes/vouchers');
const widgetRoutes      = require('./routes/widget');
const treatwellRoutes   = require('./routes/treatwell');
const treatwellEmailRoutes = require('./routes/treatwellEmail'); // SPA-TREATWELL-001 — email ingest + review queue
const campaignRoutes    = require('./routes/campaigns');
const bookingRoutes     = require('./routes/booking');
const syncRoutes        = require('./routes/sync');     // SEPOS-SPA-PRO-001 Phase B — offline pull feed
const paymentLinkRoutes = require('./routes/paymentLinks'); // SEPOS-SPA-PAYLINK-001
const { router: licenseRoutes, requireValidLicense } = require('./routes/license'); // SEPOS-SPA-LICENSE-001
const licenseClient     = require('./services/licenseClient');
const deviceRoutes      = require('./routes/device');             // SEPOS-SPA-LICENSE-001 Part B
const deviceHeartbeat   = require('./services/deviceHeartbeat');
const { parseUnsubscribeToken } = require('./services/emailService');
const { pool: dbPool }  = require('./db/dbAdapter');
const { router: stripeRouter, webhookHandler: stripeWebhookHandler } = require('./routes/stripe');

const app = express();
const server = http.createServer(app);

// CORS — allow the live spa app + localhost for dev.
const ALLOWED_ORIGINS = [
  'https://spa.siamepos.co.uk',
  'https://siamepos-spa.netlify.app',
  'https://siamspa.netlify.app',
  'https://siamepos.com',
  'https://www.siamepos.com',
  'http://localhost:5173',
  'http://localhost:3000',
];
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)),
  credentials: true,
}));

// Stripe webhook needs the raw request body to verify the signature.
// Register it BEFORE express.json() so the JSON parser doesn't consume
// the stream first.
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhookHandler,
);

// JSON body parser for everything else.
app.use(express.json({ limit: '2mb' }));

// Health check for Railway + uptime monitors.
// SEPOS-SPA-LICENSE-001 Part B — ops polls this every 5 min and reads `tills`
// to see which desktop devices are installed, their version + last-seen. Tills
// sit behind NAT (can't be polled), so they POST /api/device/heartbeat up; this
// surfaces them. Shape matches restaurant-epos so one ops ingestion handles both.
app.get('/api/health', async (_req, res) => {
  let tills = [];
  try {
    const { rows } = await dbPool.query(
      `SELECT device_id, app_version, platform, last_seen
       FROM devices ORDER BY last_seen DESC LIMIT 100`,
    );
    tills = rows;
  } catch (e) { /* devices table may not exist on an old DB — report no tills */ }
  res.json({ ok: true, service: 'siamepos-spa', build: 'settings-sync-43c9321', time: new Date().toISOString(), tills });
});

// Public booking widget — served from the backend so any external site can
// embed <script src="https://spa-api.siamepos.co.uk/widget.js">. The
// `/booking-widget.js` alias matches the embed code shipped in SPA-002.
//
// Cache-Control: no-cache, must-revalidate forces the browser to send
// a conditional GET each page load. Express+sendFile auto-sets an ETag,
// so unchanged widgets return 304 (~0 bytes, ~50ms). After a deploy the
// ETag flips and clients pick up the new widget on the very next load
// — no more "I redeployed but customers still see old behaviour"
// because of stale cache.
function sendWidget(_req, res) {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.resolve(__dirname, '..', 'client', 'public', 'widget.js'));
}
app.get('/widget.js',         sendWidget);
app.get('/booking-widget.js', sendWidget);

// SPA-PAY-001 — self-service customer portal (static page).
// Served from the backend so the link in the confirmation email
// resolves at spa-api.siamepos.co.uk/my-booking.html?token=…
app.get('/my-booking.html', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'client', 'public', 'my-booking.html'));
});

// SEPOS-SPA-PAYLINK-001 — landing page a payment-link customer returns to after
// Stripe Checkout (success_url / cancel_url). Public, no auth.
app.get('/pay-thanks', (req, res) => {
  const ok = req.query.status !== 'cancelled';
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SiamEPOS Spa</title></head>
<body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0D1B3E;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="text-align:center;padding:32px;max-width:420px">
<div style="font-size:54px">${ok ? '✅' : '↩️'}</div>
<h1 style="margin:12px 0;color:#C9A84C">${ok ? 'Payment received' : 'Payment cancelled'}</h1>
<p style="opacity:.85;line-height:1.5">${ok
  ? 'Thank you — your payment was successful. You can close this page.'
  : 'No payment was taken. You can close this page, or ask the spa for a new link.'}</p>
</div></body></html>`);
});

// ---- Public routes (NO auth) ---------------------------------------------
app.use('/api/widget',    widgetRoutes);
app.use('/api/treatwell', treatwellRoutes);
app.use('/api/treatwell-email', treatwellEmailRoutes); // public /inbound (secret-gated) + staff review queue
app.use('/api/booking',   bookingRoutes);     // public self-service via HMAC token
app.use('/api/auth',      authRoutes);

// Offline sync pull feed (SEPOS-SPA-PRO-001 Phase B). Self-gates on the
// x-sync-secret header (not a staff JWT), so it sits outside requireAuth.
// Desktop installs poll this to mirror cloud data into local SQLite.
app.use('/api/sync',      syncRoutes);

// License — GET /api/license (cloud signs the pass), plus the till's local
// state/recheck endpoints. Public: the token is signed, no auth needed.
app.use('/api', licenseRoutes);

// Device heartbeat — POST /api/device/heartbeat (gated by SYNC_SECRET).
app.use('/api/device', deviceRoutes);

// Sync status for the desktop app's online/offline indicator (B4). Cheap +
// unauthenticated — it only reports connection state, no data. In cloud mode
// it always reads as online.
app.get('/api/sync-status', (_req, res) => {
  try {
    res.json(require('./services/syncService').getStatus());
  } catch {
    res.json({ mode: 'cloud', status: 'cloud', queueSize: 0 });
  }
});

// SPA-CAMPAIGNS-001 — public one-click unsubscribe. The token is a
// stateless HMAC of the email; no auth required because anyone with a
// valid token already knows the email it stands for (it was emailed to
// them). Stamps clients.unsubscribed_at and flips marketing_consent off
// so subsequent campaigns skip them.
app.get('/api/unsubscribe', async (req, res) => {
  const email = parseUnsubscribeToken(req.query.token);
  const safeHtml = (s) => String(s || '').replace(/[<>"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  if (!email) {
    return res.status(400).type('html').send(
      `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:60px;text-align:center;color:#555;">
        <h2 style="color:#1e3a6e;font-family:Georgia,serif;">Invalid unsubscribe link</h2>
        <p>Sorry — this link isn't valid. Please contact us directly if you'd like to opt out.</p>
      </body></html>`
    );
  }
  try {
    await dbPool.query(
      `UPDATE clients
       SET unsubscribed_at  = COALESCE(unsubscribed_at, now()),
           marketing_consent = FALSE
       WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`,
      [email],
    );
    res.type('html').send(`<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#faf7f2;color:#1c1c1c;margin:0;min-height:100vh;padding:60px 20px;text-align:center;">
  <div style="background:white;max-width:480px;margin:40px auto;padding:40px 32px;border-radius:14px;box-shadow:0 4px 16px rgba(20,38,74,0.08);border-top:4px solid #C9A84C;">
    <h1 style="color:#1e3a6e;font-family:Georgia,serif;margin:0 0 14px;font-size:26px;">You're unsubscribed</h1>
    <p style="color:#444;line-height:1.6;margin:0 0 14px;">We've removed <strong>${safeHtml(email)}</strong> from our marketing list. You won't receive any more promotional emails from us.</p>
    <p style="color:#888;font-size:13px;margin:24px 0 0;">If this was a mistake, contact the spa to opt back in.</p>
  </div>
</body></html>`);
  } catch (err) {
    console.error('[unsubscribe]', err);
    res.status(500).type('html').send('<!doctype html><html><body>Something went wrong. Please try again later.</body></html>');
  }
});

// ---- Protected routes (require staff token) ------------------------------
app.use('/api/treatments',   requireAuth, treatmentRoutes);
app.use('/api/therapists',   requireAuth, therapistRoutes);
app.use('/api/rooms',        requireAuth, roomRoutes);
app.use('/api/appointments', requireAuth, requireValidLicense, appointmentRoutes);
app.use('/api/clients',      requireAuth, clientRoutes);
app.use('/api/bills',        requireAuth, requireValidLicense, billRoutes);
app.use('/api/stripe',       requireAuth, stripeRouter);
app.use('/api/reports',      requireAuth, reportRoutes);
// Auth is per-route inside settings.js: GET is requireAuth, PUT is
// settingsAuth (admin/manager JWT OR the x-sync-secret so a desktop till can
// push its own settings up to the cloud). A blanket requireAuth here would
// block the sync-secret path — that's what silently reverted till saves.
app.use('/api/settings',     settingsRoutes);
app.use('/api/vouchers',     requireAuth, voucherRoutes);
app.use('/api/campaigns',    requireAuth, campaignRoutes);
app.use('/api/payment-links', requireAuth, paymentLinkRoutes);

// 404 for any unmatched /api/* request.
app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

// ---- Local desktop mode: serve the built client ---------------------------
// In cloud mode the React client is hosted on Netlify and this server is
// API-only. In the Electron desktop till (DB_MODE=local) there is no Netlify —
// the local server must also serve the bundled client so everything runs on
// one localhost origin (which also makes the client's `/api` calls same-origin,
// so no VITE_API_BASE is needed in the desktop build). CLIENT_DIST_PATH is set
// by electron/main.js to the bundled client/dist folder.
if (process.env.CLIENT_DIST_PATH) {
  const clientDist = process.env.CLIENT_DIST_PATH;
  app.use(express.static(clientDist));
  // SPA fallback — any non-/api GET serves index.html so react-router can
  // resolve the route client-side.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  console.log(`[server] serving desktop client from ${clientDist}`);
}

// ---- Socket.io ------------------------------------------------------------
const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling'],
});

io.on('connection', (socket) => {
  console.log(`[io] client connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`[io] client disconnected: ${socket.id}`));
});

app.set('io', io);

// ---- Boot -----------------------------------------------------------------
const PORT = process.env.PORT || 5050;

// Allow the app to be required as a module (e.g. by the test runner) without
// auto-booting.  Only listen when this file is the entry point.
if (require.main === module) {
  (async () => {
    try {
      await initSchema();
      await seedDefaultAdmin();
      server.listen(PORT, () => {
        console.log(`[server] SiamEPOS Spa listening on :${PORT}`);
      });

      // SEPOS-SPA-BUGHUNT C5/#7 — loudly flag insecure default secrets on a
      // CLOUD (internet-facing) deploy. Forgeable JWT/booking/unsub secrets allow
      // forged admin tokens (full medical-record access) and forged
      // cancel-with-Stripe-refund booking tokens. Ops MUST set these on the spa
      // Railway. Warn-only (not a hard boot-fail) so a missing env can never take a
      // live till offline; desktop mode injects its own random JWT_SECRET.
      if ((process.env.DB_MODE || '').toLowerCase() !== 'local') {
        const weak = [];
        if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-only-change-me') weak.push('JWT_SECRET');
        if (!process.env.BOOKING_SECRET) weak.push('BOOKING_SECRET');
        if (!process.env.UNSUB_SECRET)  weak.push('UNSUB_SECRET');
        if (weak.length) {
          console.error('==========================================================');
          console.error('[SECURITY] ⚠️  INSECURE DEFAULT secret(s) in use: ' + weak.join(', '));
          console.error('[SECURITY] These are forgeable. Set them on the spa Railway env NOW.');
          console.error('[SECURITY] Risk: forged admin tokens (medical records) + forged booking cancel/refund.');
          console.error('==========================================================');
        }
      }

      // Desktop offline mode: start the cloud⇆local sync engine. No-op in
      // cloud mode (the service guards on DB_MODE internally).
      if ((process.env.DB_MODE || '').toLowerCase() === 'local') {
        try {
          const syncService = require('./services/syncService');
          syncService.start();
          // Realtime relay (B4): forward cloud events to this till's local
          // socket.io for sub-second updates. Falls back to the 5s pull if it
          // can't connect.
          require('./services/cloudRelay').start(io, syncService);
          // SEPOS-SPA-LICENSE-001 — start the offline license poller (fail-open).
          licenseClient.start();
          // SEPOS-SPA-LICENSE-001 Part B — report this device up to ops.
          deviceHeartbeat.start();
        } catch (e) {
          console.error('[server] sync engine / relay failed to start:', e.message);
        }
      }
    } catch (err) {
      console.error('[server] fatal startup error:', err);
      process.exit(1);
    }
  })();
}

module.exports = app;
