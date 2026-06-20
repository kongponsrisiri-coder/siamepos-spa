const express = require('express');
const { pool } = require('../db/dbAdapter');

const router = express.Router();

// GET /api/treatments
//   ?include_inactive=1 — admin view, returns hidden treatments too
//   ?with_booking_count=1 — adds booking_count + last_booked_at columns
//     so the admin can see whether a treatment is safe to hard-delete
router.get('/', async (req, res) => {
  const includeInactive   = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
  const withBookingCount  = req.query.with_booking_count === '1' || req.query.with_booking_count === 'true';
  const activeClause = includeInactive ? '' : 'WHERE t.active = TRUE';
  const bookingJoin = withBookingCount
    ? `LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS booking_count, MAX(a.starts_at) AS last_booked_at
         FROM appointments a WHERE a.treatment_id = t.id
       ) bk ON TRUE`
    : '';
  const bookingCols = withBookingCount ? ', bk.booking_count, bk.last_booked_at' : '';
  try {
    const treatments = await pool.query(`
      SELECT t.*, c.name AS category_name, c.sort_order AS category_sort${bookingCols}
      FROM treatments t
      LEFT JOIN treatment_categories c ON c.id = t.category_id
      ${bookingJoin}
      ${activeClause}
      ORDER BY c.sort_order NULLS LAST, c.name NULLS LAST, t.name
    `);
    res.json({ treatments: treatments.rows });
  } catch (err) {
    console.error('[treatments] list', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/treatments/categories
router.get('/categories', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM treatment_categories ORDER BY sort_order, name',
    );
    res.json({ categories: rows });
  } catch (err) {
    console.error('[treatments] categories', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/treatments
router.post('/', async (req, res) => {
  const { category_id, name, duration_minutes, price, description, online_bookable } = req.body || {};
  if (!name || !duration_minutes || price == null) {
    return res.status(400).json({ error: 'name, duration_minutes, price required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO treatments (category_id, name, duration_minutes, price, description, online_bookable)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, TRUE)) RETURNING *`,
      [category_id || null, name, duration_minutes, price, description || null, online_bookable],
    );
    res.status(201).json({ treatment: rows[0] });
  } catch (err) {
    console.error('[treatments] create', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/treatments/:id
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { category_id, name, duration_minutes, price, description, active, online_bookable } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE treatments SET
         category_id      = COALESCE($2, category_id),
         name             = COALESCE($3, name),
         duration_minutes = COALESCE($4, duration_minutes),
         price            = COALESCE($5, price),
         description      = COALESCE($6, description),
         active           = COALESCE($7, active),
         online_bookable  = COALESCE($8, online_bookable)
       WHERE id = $1 RETURNING *`,
      [id, category_id, name, duration_minutes, price, description, active, online_bookable],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ treatment: rows[0] });
  } catch (err) {
    console.error('[treatments] update', err);
    res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/treatments/:id
//   default          — soft delete (active=false). Preserves history.
//   ?hard=1          — permanent removal. Fails 409 if appointments
//                      reference the row (operator must use soft delete).
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const hard = req.query.hard === '1' || req.query.hard === 'true';
  try {
    if (hard) {
      const ref = await pool.query(
        'SELECT COUNT(*)::int AS n FROM appointments WHERE treatment_id = $1',
        [id],
      );
      const count = ref.rows[0]?.n || 0;
      if (count > 0) {
        return res.status(409).json({
          error: `Cannot delete — ${count} appointment${count === 1 ? '' : 's'} reference this treatment. Hide it instead so past bookings keep their record.`,
          booking_count: count,
        });
      }
      const { rowCount } = await pool.query('DELETE FROM treatments WHERE id = $1', [id]);
      if (!rowCount) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true, deleted: true });
    }
    const { rowCount } = await pool.query(
      'UPDATE treatments SET active = FALSE WHERE id = $1',
      [id],
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, hidden: true });
  } catch (err) {
    console.error('[treatments] delete', err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/treatments/categories
router.post('/categories', async (req, res) => {
  const { name, sort_order } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO treatment_categories (name, sort_order) VALUES ($1, $2) RETURNING *`,
      [name, sort_order || 0],
    );
    res.status(201).json({ category: rows[0] });
  } catch (err) {
    console.error('[treatments] create category', err);
    res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/treatments/categories/:id — rename / reorder a category
router.put('/categories/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { name, sort_order } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE treatment_categories
         SET name       = COALESCE($2, name),
             sort_order = COALESCE($3, sort_order)
         WHERE id = $1 RETURNING *`,
      [id, name ?? null, sort_order ?? null],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ category: rows[0] });
  } catch (err) {
    console.error('[treatments] update category', err);
    res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/treatments/categories/:id — removes the category and
// moves any treatments using it to category_id=NULL (uncategorised).
router.delete('/categories/:id', async (req, res) => {
  const id = Number(req.params.id);
  // Single pooled client so this is a real atomic transaction — running
  // BEGIN/COMMIT through pool.query() spreads the statements across
  // connections and can leak an open transaction onto the pool.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE treatments SET category_id = NULL WHERE category_id = $1', [id]);
    const { rowCount } = await client.query('DELETE FROM treatment_categories WHERE id = $1', [id]);
    await client.query('COMMIT');
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[treatments] delete category', err);
    res.status(500).json({ error: 'server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
