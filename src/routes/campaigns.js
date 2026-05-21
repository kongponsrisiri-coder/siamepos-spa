// SPA-CAMPAIGNS-001 — email campaigns to opted-in clients.
//
// Endpoints (all auth-protected via the requireAuth in server.js):
//   GET  /api/campaigns                       — recent history (50)
//   GET  /api/campaigns/recipient-count?seg=X — preview audience size
//   POST /api/campaigns/send                  — { subject, body, segment }
//
// Segments mirror the in-app ClientsSection so the operator picks the
// same group they're already looking at:
//   VIP / Regular / Lapsed / Treatwell / All
//
// New = 1 visit is intentionally excluded from the segment picker
// (don't bombard a first-time customer with promo emails before they've
// had their first reminder). Operators can still use "All" if needed.
//
// Recipient filtering is consent-aware: clients.marketing_consent must
// be TRUE AND clients.unsubscribed_at must be NULL. The frontend reflects
// this so the count = "Send to N opted-in customers in <segment>".

const express = require('express');
const { pool } = require('../db/database');
const { sendBrevoEmail, buildCampaignEmail } = require('../services/emailService');

const router = express.Router();

const today = () => new Date();
function statusFor(visits, spend, daysSinceLast) {
  if (daysSinceLast != null && daysSinceLast > 60) return 'Lapsed';
  if (visits >= 5 || spend >= 200) return 'VIP';
  if (visits >= 2)                 return 'Regular';
  return 'New';
}

// Pull every opted-in / not-unsubscribed client with the same aggregations
// the CRM uses, then filter to the chosen segment in memory. Returns the
// fields needed to send + personalise the email.
async function fetchClientsForSegment(segment) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.email,
            COUNT(a.id) FILTER (WHERE a.status NOT IN ('cancelled','no_show')) AS total_visits,
            MAX(a.starts_at) FILTER (WHERE a.status NOT IN ('cancelled','no_show')) AS last_visit,
            COALESCE(SUM(b.total) FILTER (WHERE b.payment_status = 'paid'), 0) AS total_spend,
            (
              SELECT a2.source FROM appointments a2
              WHERE a2.client_id = c.id AND a2.status NOT IN ('cancelled','no_show')
              ORDER BY a2.starts_at ASC NULLS LAST LIMIT 1
            ) AS acquisition_source
       FROM clients c
       LEFT JOIN appointments a ON a.client_id = c.id
       LEFT JOIN bills        b ON b.appointment_id = a.id
      WHERE c.marketing_consent = TRUE
        AND c.unsubscribed_at IS NULL
        AND c.email IS NOT NULL
        AND TRIM(c.email) <> ''
      GROUP BY c.id`,
  );
  const now = today();
  const decorated = rows.map((c) => {
    const visits = Number(c.total_visits || 0);
    const spend  = Number(c.total_spend  || 0);
    const days   = c.last_visit
      ? Math.floor((now - new Date(c.last_visit)) / 86400000)
      : null;
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      visits, spend, days_since_last: days,
      acquisition_source: c.acquisition_source,
      status: statusFor(visits, spend, days),
    };
  });
  if (segment === 'All') return decorated;
  if (segment === 'Treatwell') return decorated.filter((c) => c.acquisition_source === 'treatwell');
  return decorated.filter((c) => c.status === segment);
}

// GET /api/campaigns/recipient-count?segment=VIP
router.get('/recipient-count', async (req, res) => {
  try {
    const seg = req.query.segment || 'All';
    const list = await fetchClientsForSegment(seg);
    res.json({ count: list.length });
  } catch (err) {
    console.error('[campaigns] recipient-count', err);
    res.status(500).json({ error: err.message || 'server error' });
  }
});

// GET /api/campaigns
router.get('/', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, subject, segment, recipient_count, sent_count, failed_count, created_at
       FROM campaigns
       ORDER BY id DESC
       LIMIT 50`,
    );
    res.json({ campaigns: r.rows });
  } catch (err) {
    console.error('[campaigns] list', err);
    res.status(500).json({ error: err.message || 'server error' });
  }
});

// POST /api/campaigns/send  body: { subject, body, segment }
router.post('/send', async (req, res) => {
  const { subject, body, segment } = req.body || {};
  if (!subject || !subject.trim()) return res.status(400).json({ error: 'Subject is required' });
  if (!body    || !body.trim())    return res.status(400).json({ error: 'Body is required' });
  if (!process.env.BREVO_API_KEY)  return res.status(500).json({ error: 'BREVO_API_KEY is not set on the server' });

  const seg = segment || 'All';
  let recipients;
  try {
    recipients = await fetchClientsForSegment(seg);
  } catch (err) {
    console.error('[campaigns] segment lookup', err);
    return res.status(500).json({ error: err.message || 'server error' });
  }
  if (!recipients.length) return res.status(400).json({ error: 'No opted-in clients in this segment' });

  // Record the campaign up front so the row is there even if the send
  // crashes part-way through — counts are patched in at the end.
  let campaignId;
  try {
    const r = await pool.query(
      `INSERT INTO campaigns (subject, body, segment, recipient_count)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [subject.trim(), body, seg, recipients.length],
    );
    campaignId = r.rows[0].id;
  } catch (err) {
    console.error('[campaigns] insert row', err);
    return res.status(500).json({ error: err.message || 'server error' });
  }

  let sent = 0, failed = 0;
  for (const c of recipients) {
    const html = buildCampaignEmail({
      subject, body,
      client_name:  c.name,
      client_email: c.email,
    });
    try {
      const result = await sendBrevoEmail({
        to: [{ email: c.email, name: c.name }],
        subject,
        html,
      });
      if (result && result.ok === false) failed++; else sent++;
    } catch (err) {
      console.error('[campaigns] send failed for', c.email, err.message);
      failed++;
    }
  }

  await pool.query(
    `UPDATE campaigns SET sent_count = $1, failed_count = $2 WHERE id = $3`,
    [sent, failed, campaignId],
  );

  res.json({
    success: true,
    campaign_id: campaignId,
    recipient_count: recipients.length,
    sent,
    failed,
  });
});

module.exports = router;
