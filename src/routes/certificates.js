// SPA-CERTS-001 — qualification certificates.
// The spa's credentials (massage qualifications, insurance certificates,
// hygiene ratings…) live in Admin so any staff member can pull one up
// full-screen the moment a customer asks — no digging through the website
// or a drawer of paperwork. Requested by the spa client (Jinta) 22 Jul 2026.
//
// Storage: base64 in the DB (a handful of images/PDFs — same trade-off as
// ops transaction_attachments). 5 MB per file cap. Any logged-in staff can
// VIEW; only admin/manager can add or remove.

const express = require('express');
const { pool } = require('../db/dbAdapter');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

// GET /api/certificates — list (metadata only, never the file blobs)
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, holder, filename, mimetype, uploaded_at FROM certificates ORDER BY uploaded_at DESC');
    res.json({ certificates: rows });
  } catch (err) {
    console.error('[certificates] list', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/certificates/:id/file — the document itself (inline display)
router.get('/:id/file', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT filename, mimetype, file_data FROM certificates WHERE id = $1', [Number(req.params.id)]);
    const c = rows[0];
    if (!c) return res.status(404).json({ error: 'not found' });
    const buf = Buffer.from(c.file_data, 'base64');
    res.set('Content-Type', c.mimetype || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${(c.filename || 'certificate').replace(/[^\w.\- ]/g, '')}"`);
    res.set('Cache-Control', 'private, max-age=300');
    res.send(buf);
  } catch (err) {
    console.error('[certificates] file', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/certificates  { title, holder?, filename, mimetype, data(base64) }
router.post('/', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { title, holder, filename, mimetype, data } = req.body || {};
    if (!String(title || '').trim()) return res.status(400).json({ error: 'Title is required' });
    if (!ALLOWED.includes(mimetype)) return res.status(400).json({ error: 'File must be a JPG, PNG, WebP or PDF' });
    const b64 = String(data || '');
    const approxBytes = Math.floor(b64.length * 3 / 4);
    if (!b64) return res.status(400).json({ error: 'File data missing' });
    if (approxBytes > MAX_BYTES) return res.status(400).json({ error: 'File too large (5 MB max)' });
    const { rows } = await pool.query(
      `INSERT INTO certificates (title, holder, filename, mimetype, file_data)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, title, holder, filename, mimetype, uploaded_at`,
      [String(title).trim().slice(0, 200), String(holder || '').trim().slice(0, 200) || null,
       String(filename || 'certificate').slice(0, 200), mimetype, b64]);
    res.status(201).json({ certificate: rows[0] });
  } catch (err) {
    console.error('[certificates] upload', err);
    res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/certificates/:id
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM certificates WHERE id = $1 RETURNING id', [Number(req.params.id)]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[certificates] delete', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
