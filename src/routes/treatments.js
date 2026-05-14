const express = require('express');
const { pool } = require('../db/database');

const router = express.Router();

// GET /api/treatments  — active treatments grouped by category
router.get('/', async (_req, res) => {
  try {
    const treatments = await pool.query(`
      SELECT t.*, c.name AS category_name, c.sort_order AS category_sort
      FROM treatments t
      LEFT JOIN treatment_categories c ON c.id = t.category_id
      WHERE t.active = TRUE
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
  const { category_id, name, duration_minutes, price, description } = req.body || {};
  if (!name || !duration_minutes || price == null) {
    return res.status(400).json({ error: 'name, duration_minutes, price required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO treatments (category_id, name, duration_minutes, price, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [category_id || null, name, duration_minutes, price, description || null],
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
  const { category_id, name, duration_minutes, price, description, active } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE treatments SET
         category_id      = COALESCE($2, category_id),
         name             = COALESCE($3, name),
         duration_minutes = COALESCE($4, duration_minutes),
         price            = COALESCE($5, price),
         description      = COALESCE($6, description),
         active           = COALESCE($7, active)
       WHERE id = $1 RETURNING *`,
      [id, category_id, name, duration_minutes, price, description, active],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ treatment: rows[0] });
  } catch (err) {
    console.error('[treatments] update', err);
    res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/treatments/:id  — soft delete (active=false)
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rowCount } = await pool.query(
      'UPDATE treatments SET active = FALSE WHERE id = $1',
      [id],
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
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

module.exports = router;
