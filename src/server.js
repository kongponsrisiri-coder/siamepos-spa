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
const widgetRoutes      = require('./routes/widget');
const { router: stripeRouter, webhookHandler: stripeWebhookHandler } = require('./routes/stripe');

const app = express();
const server = http.createServer(app);

// CORS — open for now. Lock down to spa.siamepos.co.uk before going live.
app.use(cors({ origin: true, credentials: true }));

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
// embed <script src="https://spa-api.siamepos.co.uk/widget.js">.
app.get('/widget.js', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.resolve(__dirname, '..', 'client', 'public', 'widget.js'));
});

// ---- Public routes (NO auth) ---------------------------------------------
app.use('/api/widget', widgetRoutes);
app.use('/api/auth',   authRoutes);

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
