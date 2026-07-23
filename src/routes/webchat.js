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
  'https://highbury-sandy.netlify.app',
  'https://true-thai-sandy.netlify.app', // prospect pitch demo → shared demo till (spa-api)
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

// SPA-CHAT-REPLY-001 — GET /api/webchat/poll?session_id=…&after=N
// The widget polls while open so staff replies (sent from Admin AI Chats)
// reach the visitor. `after` = how many messages the widget has already
// rendered from THIS endpoint's numbering (assistant-visible messages only).
// Same CORS whitelist; polling has its own (gentler) rate budget.
const pollHits = new Map();
function allowPoll(ip) {
  const now = Date.now();
  const arr = (pollHits.get(ip) || []).filter((t) => now - t < 60_000);
  if (arr.length >= 30) { pollHits.set(ip, arr); return false; }
  arr.push(now); pollHits.set(ip, arr);
  if (pollHits.size > 5000) pollHits.clear();
  return true;
}

function visibleText(m) {
  if (!m) return null;
  if (typeof m.content === 'string') return m.content.trim() || null;
  if (Array.isArray(m.content)) {
    const t = m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
    return t || null;
  }
  return null;
}

router.get('/poll', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    if (!allowPoll(ip)) return res.status(429).json({ error: 'too fast' });
    const sid = String(req.query.session_id || '');
    if (!/^[a-z0-9-]{8,64}$/i.test(sid)) return res.status(400).json({ error: 'invalid session' });
    const after = Math.max(0, parseInt(req.query.after, 10) || 0);
    const { rows } = await pool.query(
      'SELECT messages, handoff FROM concierge_conversations WHERE phone = $1', ['web:' + sid]);
    if (!rows[0]) return res.json({ messages: [], handoff: false, total: 0 });
    let msgs;
    try { msgs = Array.isArray(rows[0].messages) ? rows[0].messages : JSON.parse(rows[0].messages || '[]'); }
    catch { msgs = []; }
    // Number ONLY assistant-visible messages so the widget's `after` cursor
    // is stable regardless of hidden tool traffic.
    const visible = msgs
      .filter((m) => m.role === 'assistant')
      .map((m) => visibleText(m))
      .filter(Boolean);
    res.json({
      total: visible.length,
      messages: visible.slice(after),
      handoff: !!rows[0].handoff,
    });
  } catch (err) {
    console.error('[webchat] poll error:', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
