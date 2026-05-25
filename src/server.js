// SiamEPOS Spa — Express entry point.
// Loads env, opens the PG pool, initialises the schema, mounts API routes,
// and starts Socket.io.

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server: SocketIOServer } = require('socket.io');

const { initSchema } = require('./db/database');
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
const campaignRoutes    = require('./routes/campaigns');
const bookingRoutes     = require('./routes/booking');
const { parseUnsubscribeToken } = require('./services/emailService');
const { pool: dbPool }  = require('./db/database');
const { router: stripeRouter, webhookHandler: stripeWebhookHandler } = require('./routes/stripe');

const app = express();
const server = http.createServer(app);

// CORS — allow the live spa app + localhost for dev.
const ALLOWED_ORIGINS = [
  'https://spa.siamepos.co.uk',
  'https://siamepos-spa.netlify.app',
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
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'siamepos-spa', time: new Date().toISOString() });
});

// Public booking widget — served from the backend so any external site can
// embed <script src="https://spa-api.siamepos.co.uk/widget.js">. The
// `/booking-widget.js` alias matches the embed code shipped in SPA-002.
function sendWidget(_req, res) {
  res.type('application/javascript');
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

// ---- Public routes (NO auth) ---------------------------------------------
app.use('/api/widget',    widgetRoutes);
app.use('/api/treatwell', treatwellRoutes);
app.use('/api/booking',   bookingRoutes);     // public self-service via HMAC token
app.use('/api/auth',      authRoutes);

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
app.use('/api/appointments', requireAuth, appointmentRoutes);
app.use('/api/clients',      requireAuth, clientRoutes);
app.use('/api/bills',        requireAuth, billRoutes);
app.use('/api/stripe',       requireAuth, stripeRouter);
app.use('/api/reports',      requireAuth, reportRoutes);
app.use('/api/settings',     requireAuth, settingsRoutes);
app.use('/api/vouchers',     requireAuth, voucherRoutes);
app.use('/api/campaigns',    requireAuth, campaignRoutes);

// 404 for any unmatched /api/* request.
app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

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
    } catch (err) {
      console.error('[server] fatal startup error:', err);
      process.exit(1);
    }
  })();
}

module.exports = app;
