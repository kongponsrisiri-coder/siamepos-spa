// SPA-TREATWELL-001 / SPA-BOOKING-INGEST — inbound marketplace booking EMAIL
// webhook + review queue. Handles BOTH Treatwell and Fresha (and is easy to
// extend to more).
//
// The venue auto-forwards its booking emails to a unique inbound address; an
// inbound-email-parse service (Brevo/Mailgun/etc.) POSTs the email here. We
// detect the marketplace (Treatwell | Fresha) from the sender/subject/body,
// parse Treatwell deterministically (Fresha via AI), tag the resulting
// appointment with the right `source`, and hand it to the shared ingest engine.
// Nothing is silently dropped — low-confidence/unparseable items land in
// `ingestion_log` as needs_review.
//
//   POST /api/treatwell-email/inbound   (public, gated by a secret header)
//   GET  /api/treatwell-email/review-queue            (staff auth)
//   POST /api/treatwell-email/review/:id/reprocess    (staff auth)
//   POST /api/treatwell-email/review/:id/resolve      (staff auth)
//
// New route file — does NOT touch Sam's src/routes/treatwell.js.

const express = require('express');
const { pool } = require('../db/dbAdapter');
const { requireAuth } = require('../middleware/auth');
const { parseTreatwellEmail } = require('../services/treatwellEmail');
const { extractBookingWithAI } = require('../services/treatwellAi');
const { ingestBooking } = require('../services/treatwellIngest');

const router = express.Router();

function inboundSecret() {
  return process.env.INBOUND_EMAIL_SECRET || process.env.TREATWELL_WEBHOOK_SECRET || null;
}

// Pull subject + plaintext + sender out of whatever inbound-parse provider posted.
function extractEmail(body) {
  const b = body || {};
  const subject = b.subject || b.Subject || (b.headers && b.headers.subject) || '';
  const text = b.text || b.plain || b['body-plain'] || b['stripped-text'] ||
               b.TextBody || b.plaintext || b.bodyPlain || '';
  const from = b.from || b.From || b.sender || b['from-email'] ||
               (b.headers && (b.headers.from || b.headers.From)) || '';
  return { subject: String(subject || ''), text: String(text || ''), from: String(from || '') };
}

// SPA-BOOKING-INGEST — which marketplace an inbound email is from. Scans the
// sender + subject + body for provider markers. Returns 'treatwell' | 'fresha',
// or null (not a recognised marketplace booking email → ignored, no AI spend).
function detectSource({ subject = '', text = '', from = '' } = {}) {
  const hay = `${from}\n${subject}\n${text}`.toLowerCase();
  if (/treatwell/.test(hay) || /\bT\d{8,}\b/.test(text)) return 'treatwell';
  if (/fresha/.test(hay)) return 'fresha';
  return null;
}

const FIELDS = ['action', 'ref', 'name', 'email', 'phone', 'treatment', 'durationMin',
                'date', 'time', 'startLocal', 'room', 'price', 'prepaid', 'cancelReason'];

// Deterministic first; AI only fills the gaps. Prefer deterministic values.
function recompute(p) {
  const missing = [];
  if (!p.startLocal) missing.push('start time');
  if (!p.treatment) missing.push('treatment');
  if (p.action === 'create') {
    if (!p.name) missing.push('name');
    if (!p.email && !p.phone) missing.push('contact (email/phone)');
  }
  p.missing = missing;
  return p;
}
function mergeParsed(det, ai) {
  if (det && det.ok && det.confidence === 'high') return det;        // no AI needed
  if (!ai || !ai.ok) return det && det.ok ? det : (det || ai);       // AI unavailable/failed
  if (!det || !det.ok) return ai;                                    // deterministic failed → AI
  const base = { ...det };
  for (const f of FIELDS) if (base[f] == null && ai[f] != null) base[f] = ai[f];
  base.via = 'deterministic+ai';
  recompute(base);
  base.confidence = base.missing.length === 0 ? 'medium' : 'low';
  return base;
}

// ── Inbound webhook (public, secret-gated) ───────────────────────────────────
router.post('/inbound', async (req, res) => {
  const secret = inboundSecret();
  if (!secret) return res.status(401).json({ error: 'inbound secret not configured' });
  const provided = req.get('x-inbound-secret') || (req.query && req.query.secret);
  if (provided !== secret) return res.status(401).json({ error: 'unauthorised' });

  const { subject, text, from } = extractEmail(req.body);
  if (!text) return res.status(400).json({ error: 'no email body' });

  try {
    const source = detectSource({ subject, text, from });
    let parsed;
    if (source === 'treatwell') {
      // Free deterministic parse; AI only fills gaps when there's a real booking
      // signal (a Treatwell order ref) but the parse wasn't fully confident.
      parsed = parseTreatwellEmail({ subject, text });
      if (parsed.ref && (!parsed.ok || parsed.confidence !== 'high')) {
        parsed = mergeParsed(parsed, await extractBookingWithAI({ subject, text, source }));
      }
    } else if (source === 'fresha') {
      // No deterministic parser for Fresha yet — the AI extractor handles it.
      parsed = await extractBookingWithAI({ subject, text, source });
    } else {
      // Not a recognised marketplace booking email (marketing / statements /
      // random mail) — ignore quietly, no AI spend, kept out of the review queue.
      return res.json({ ok: true, action: 'ignore', status: 'ignored', reason: 'not a Treatwell/Fresha booking email' });
    }
    const result = await ingestBooking(parsed, text, req.app.get('io'), { source });
    // Always 200 to the provider so it doesn't retry-storm; the real outcome is
    // in the body + ingestion_log.
    return res.json({ ok: true, ...result, source, ref: parsed && parsed.ref, confidence: parsed && parsed.confidence });
  } catch (err) {
    console.error('[treatwell-email] inbound error', err);
    return res.status(500).json({ error: 'server error' });
  }
});

// ── Review queue (staff) ─────────────────────────────────────────────────────
router.get('/review-queue', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, external_ref, action, status, confidence, parsed, appointment_id, error, created_at
       FROM ingestion_log
       WHERE status IN ('needs_review', 'error')
       ORDER BY created_at DESC LIMIT 100`);
    res.json({ items: rows.map((r) => ({ ...r, parsed: safeJson(r.parsed) })) });
  } catch (err) {
    console.error('[treatwell-email] review-queue', err);
    res.status(500).json({ error: 'server error' });
  }
});

// Re-run ingest on a stored email (e.g. after a transient error, or once
// therapists/treatments are set up). Uses the saved raw body.
router.post('/review/:id/reprocess', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query('SELECT raw FROM ingestion_log WHERE id = $1', [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    const text = r.rows[0].raw || '';
    const source = detectSource({ text }) || 'treatwell';
    let parsed;
    if (source === 'fresha') {
      parsed = await extractBookingWithAI({ text, source });
    } else {
      parsed = parseTreatwellEmail({ text });
      if (!parsed.ok || parsed.confidence !== 'high') {
        parsed = mergeParsed(parsed, await extractBookingWithAI({ text, source }));
      }
    }
    const result = await ingestBooking(parsed, text, req.app.get('io'), { source });
    res.json({ ok: true, ...result, source });
  } catch (err) {
    console.error('[treatwell-email] reprocess', err);
    res.status(500).json({ error: 'server error' });
  }
});

// Mark a review item handled (staff sorted it out manually).
router.post('/review/:id/resolve', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query(`UPDATE ingestion_log SET status = 'resolved' WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[treatwell-email] resolve', err);
    res.status(500).json({ error: 'server error' });
  }
});

function safeJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;            // PG jsonb already parsed
  try { return JSON.parse(v); } catch { return null; }   // SQLite text
}

module.exports = router;
