const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  try {
    const { pipelineId, limit = 20, offset = 0 } = req.query;
    let query = `
      SELECT r.*, p.repo_name, p.branch
      FROM runs r JOIN pipelines p ON r.pipeline_id = p.id
    `;
    const params = [];

    if (pipelineId) {
      query += ` WHERE r.pipeline_id = $1`;
      params.push(pipelineId);
    }

    query += ` ORDER BY r.triggered_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const run = await db.query(`
      SELECT r.*, p.repo_name FROM runs r
      JOIN pipelines p ON r.pipeline_id = p.id
      WHERE r.id = $1
    `, [req.params.id]);

    if (!run.rows.length) return res.status(404).json({ error: 'Not found' });

    const steps = await db.query(
      `SELECT * FROM steps WHERE run_id = $1 ORDER BY id`,
      [req.params.id]
    );

    res.json({ ...run.rows[0], steps: steps.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/logs', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT line, logged_at FROM logs WHERE run_id = $1 ORDER BY id`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
