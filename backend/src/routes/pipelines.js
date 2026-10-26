const express = require('express');
const router = express.Router();
const db = require('../db');
const pipelineQueue = require('../queue');

router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT p.*,
        COUNT(r.id) as total_runs,
        (SELECT status FROM runs WHERE pipeline_id = p.id ORDER BY triggered_at DESC LIMIT 1) as last_status,
        (SELECT triggered_at FROM runs WHERE pipeline_id = p.id ORDER BY triggered_at DESC LIMIT 1) as last_run_at
      FROM pipelines p
      LEFT JOIN runs r ON r.pipeline_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM pipelines WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/trigger', async (req, res) => {
  try {
    const p = await db.query(`SELECT * FROM pipelines WHERE id = $1`, [req.params.id]);
    if (!p.rows.length) return res.status(404).json({ error: 'Not found' });

    const { id, repo_url, branch } = p.rows[0];

    const run = await db.query(
      `INSERT INTO runs (pipeline_id, commit_sha, status, triggered_by)
       VALUES ($1, 'manual', 'pending', 'manual') RETURNING id`,
      [id]
    );
    const runId = run.rows[0].id;

    await pipelineQueue.add(
      { runId, pipelineId: id, repoUrl: repo_url, branch, commitSha: 'manual' },
      { attempts: 3, backoff: 5000 }
    );

    res.json({ message: 'Triggered', runId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
