// SPA-PUSH-001 — device registration for booking notifications.
// A tablet calls /register after sign-in with the token Firebase gave it, and
// /unregister on sign-out so a device that leaves the shop stops buzzing.
const express = require('express');
const { registerDevice, unregisterDevice, isConfigured, sendToAll } = require('../services/push');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/push/status — does this spa have push switched on?
router.get('/status', async (req, res) => {
  res.json({ configured: isConfigured() });
});

// POST /api/push/register  { token, platform?, label? }
router.post('/register', async (req, res) => {
  const { token, platform, label } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    await registerDevice({ token, platform: platform || 'android', staffId: req.staff?.id || null, label: label || null });
    res.json({ ok: true, configured: isConfigured() });
  } catch (err) {
    console.error('[push] register', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/push/unregister  { token }
router.post('/unregister', async (req, res) => {
  try {
    await unregisterDevice((req.body || {}).token);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/push/test — "does my tablet actually buzz?" for the owner.
router.post('/test', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const out = await sendToAll({
      title: '🔔 Test notification',
      body: 'If you can see this, booking alerts are working on this device.',
      data: { type: 'test' },
    });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message || 'server error' });
  }
});

module.exports = router;
