// SPA-WEBCHAT-AI-001 — public web-chat surface for the concierge.
//
// The SAME orchestrator that answers WhatsApp (conciergeOrchestrator) drives
// website chat widgets: a visitor session is keyed as `web:<session_id>` in
// concierge_conversations, so staff see web + WhatsApp threads in one Admin
// inbox and the human-handoff flag works identically.
//
// Public + CORS-locked to known widget origins + per-IP rate limited. Dormant
// in effect without ANTHROPIC_API_KEY (orchestrator skips; we reply politely).
// Built by Krit at Korakot's request 2026-07-21 — flagged to Sam on the board.

const express = require('express');
const { pool } = require('../db/dbAdapter');
const orchestrator = require('../services/conciergeOrchestrator');

const router = express.Router();

// Origins allowed to embed the chat widget. Extend per client site.
const ORIGIN_WHITELIST = [
  'https://jinta-massage.netlify.app',
  'http://localhost:8888',
];

router.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ORIGIN_WHITELIST.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Small per-IP limiter — this is an unauthenticated AI endpoint.
const hits = new Map(); // ip -> [timestamps]
function allow(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 5 * 60 * 1000);
  if (arr.length >= 25) { hits.set(ip, arr); return false; }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return true;
}

// POST /api/webchat/message  { session_id, message }
router.post('/message', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    if (!allow(ip)) return res.status(429).json({ error: 'slow down a little — try again in a few minutes' });

    const { session_id, message } = req.body || {};
    if (typeof session_id !== 'string' || !/^[a-z0-9-]{8,64}$/i.test(session_id)) {
      return res.status(400).json({ error: 'invalid session' });
    }
    const text = String(message || '').trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'empty message' });

    const key = 'web:' + session_id;
    const out = await orchestrator.handleInboundMessage({ from: key, body: text });

    if (out.skipped && out.reason === 'handoff') {
      // A human owns this thread — still record what the visitor said so staff
      // see it in the Admin inbox, then hold the AI back.
      try {
        await pool.query(
          `UPDATE concierge_conversations
              SET messages = messages || $2::jsonb, updated_at = now()
            WHERE phone = $1`,
          [key, JSON.stringify([{ role: 'user', content: text }])],
        );
      } catch (e) { console.error('[webchat] handoff append failed:', e.message); }
      return res.json({ reply: 'Thank you — a member of the team has this conversation now and will reply to you right here. 🙏', handoff: true });
    }
    if (out.skipped) {
      console.error('[webchat] orchestrator skipped:', out.reason);
      return res.json({ reply: "Sorry — the assistant isn't available just now. Please try again shortly." });
    }
    res.json({ reply: out.reply, handoff: !!out.handoff });
  } catch (err) {
    console.error('[webchat] error:', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
