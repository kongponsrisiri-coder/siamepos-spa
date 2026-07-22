// SPA-WEBCHAT-AI-001 — Admin surface for concierge conversations.
// Staff (requireAuth at mount) read every AI chat — website (`web:…`) and
// WhatsApp (phone-keyed) — and can toggle human-handoff per thread: handoff ON
// silences the bot (see conciergeOrchestrator.handleInboundMessage), handoff
// OFF hands the thread back to the AI.
// Built by Krit at Korakot's request 2026-07-21 — flagged to Sam on the board.

const express = require('express');
const { pool } = require('../db/dbAdapter');

const router = express.Router();

// Flatten an orchestrator message into displayable text (or null to hide).
// Assistant content can be an array of blocks (text + tool_use); user content
// can be an array of tool_result blocks (hidden from staff view).
function displayText(m) {
  if (!m) return null;
  if (typeof m.content === 'string') return m.content.trim() || null;
  if (Array.isArray(m.content)) {
    const text = m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
    return text || null;
  }
  return null;
}
function parseMessages(raw) {
  try { return Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); } catch { return []; }
}

// GET /api/concierge-admin/conversations
router.get('/conversations', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT phone, customer_name, messages, handoff, updated_at
         FROM concierge_conversations ORDER BY updated_at DESC LIMIT 100`);
    res.json({
      conversations: rows.map((r) => {
        const msgs = parseMessages(r.messages);
        let preview = '';
        for (let i = msgs.length - 1; i >= 0; i--) {
          const t = displayText(msgs[i]);
          if (t) { preview = t.slice(0, 120); break; }
        }
        return {
          phone: r.phone,
          customer_name: r.customer_name,
          channel: String(r.phone).startsWith('web:') ? 'web' : 'whatsapp',
          handoff: !!r.handoff,
          updated_at: r.updated_at,
          preview,
          turns: msgs.filter((m) => displayText(m)).length,
        };
      }),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/concierge-admin/conversations/:phone  (phone is URL-encoded)
router.get('/conversations/:phone', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT phone, customer_name, messages, handoff, updated_at
         FROM concierge_conversations WHERE phone = $1`, [req.params.phone]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    const msgs = parseMessages(rows[0].messages)
      .map((m) => ({ role: m.role, text: displayText(m) }))
      .filter((m) => m.text && (m.role === 'user' || m.role === 'assistant'));
    res.json({
      phone: rows[0].phone,
      customer_name: rows[0].customer_name,
      handoff: !!rows[0].handoff,
      updated_at: rows[0].updated_at,
      messages: msgs,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SPA-CHAT-REPLY-001 — POST /api/concierge-admin/conversations/:phone/reply { text }
// Staff send a message INTO the thread. Sending auto-enables handoff (the AI
// must not talk over a human). Delivery: web threads are picked up by the
// widget's poll endpoint; WhatsApp threads go out via Twilio when configured.
router.post('/conversations/:phone/reply', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    if (text.length > 2000) return res.status(400).json({ error: 'message too long' });
    const phone = req.params.phone;
    const { rows } = await pool.query(
      'SELECT phone, messages, handoff FROM concierge_conversations WHERE phone = $1', [phone]);
    if (!rows[0]) return res.status(404).json({ error: 'conversation not found' });
    const msgs = parseMessages(rows[0].messages);
    msgs.push({ role: 'assistant', content: text, operator: true, ts: new Date().toISOString() });
    await pool.query(
      'UPDATE concierge_conversations SET messages = $2, handoff = TRUE, updated_at = now() WHERE phone = $1',
      [phone, JSON.stringify(msgs)]);
    // WhatsApp threads: push the reply out on WhatsApp too.
    if (!phone.startsWith('web:')) {
      try {
        const twilio = require('../services/twilioWhatsapp');
        if (twilio.isConfigured()) await twilio.sendWhatsApp(phone, text);
      } catch (e) { console.error('[concierge-admin] whatsapp reply send', e.message); }
    }
    res.json({ ok: true, handoff: true });
  } catch (err) {
    console.error('[concierge-admin] reply', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/concierge-admin/conversations/:phone/handoff  { handoff: true|false }
router.post('/conversations/:phone/handoff', async (req, res) => {
  try {
    const on = !!(req.body && req.body.handoff);
    const { rowCount } = await pool.query(
      `UPDATE concierge_conversations SET handoff = $2, updated_at = now() WHERE phone = $1`,
      [req.params.phone, on]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, handoff: on });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
