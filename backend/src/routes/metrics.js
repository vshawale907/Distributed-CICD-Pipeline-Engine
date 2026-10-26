const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  try {
    const summaryRes = await db.query(`
      SELECT 
        COUNT(*) as "totalRuns",
        COUNT(*) FILTER (WHERE status = 'success') as "successCount",
        COUNT(*) FILTER (WHERE status = 'failed') as "failedCount",
        COUNT(*) FILTER (WHERE status IN ('pending', 'running')) as "pendingCount",
        COALESCE(ROUND((COUNT(*) FILTER (WHERE status = 'success')::numeric / NULLIF(COUNT(*) FILTER (WHERE status IN ('success', 'failed')), 0)) * 100, 1), 0) as "successRate",
        COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - triggered_at)))), 0) as "avgDurationSeconds"
      FROM runs
    `);

    const runsPerDayRes = await db.query(`
      WITH dates AS (
        SELECT generate_series(
          CURRENT_DATE - INTERVAL '29 days',
          CURRENT_DATE,
          '1 day'::interval
        )::date AS date
      )
      SELECT 
        TO_CHAR(d.date, 'YYYY-MM-DD') as date,
        COUNT(r.id)::int as total,
        COUNT(r.id) FILTER (WHERE r.status = 'success')::int as success,
        COUNT(r.id) FILTER (WHERE r.status = 'failed')::int as failed
      FROM dates d
      LEFT JOIN runs r ON r.triggered_at::date = d.date
      GROUP BY d.date
      ORDER BY d.date ASC
    `);

    const durationTrendRes = await db.query(`
      SELECT 
        TO_CHAR(triggered_at::date, 'YYYY-MM-DD') as date,
        ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - triggered_at))))::int as "avgSeconds"
      FROM runs
      WHERE status IN ('success', 'failed')
        AND triggered_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY triggered_at::date
      ORDER BY triggered_at::date ASC
    `);

    const topPipelinesRes = await db.query(`
      SELECT 
        p.id as "pipelineId",
        p.repo_name as "repoName",
        p.branch,
        COUNT(r.id)::int as "totalRuns",
        COALESCE(ROUND((COUNT(r.id) FILTER (WHERE r.status = 'success')::numeric / NULLIF(COUNT(r.id) FILTER (WHERE r.status IN ('success', 'failed')), 0)) * 100, 1), 0) as "successRate"
      FROM pipelines p
      LEFT JOIN runs r ON r.pipeline_id = p.id
      GROUP BY p.id, p.repo_name, p.branch
      ORDER BY "totalRuns" DESC
      LIMIT 5
    `);

    res.json({
      summary: {
        totalRuns: parseInt(summaryRes.rows[0].totalRuns || 0),
        successCount: parseInt(summaryRes.rows[0].successCount || 0),
        failedCount: parseInt(summaryRes.rows[0].failedCount || 0),
        pendingCount: parseInt(summaryRes.rows[0].pendingCount || 0),
        successRate: parseFloat(summaryRes.rows[0].successRate || 0),
        avgDurationSeconds: parseInt(summaryRes.rows[0].avgDurationSeconds || 0),
      },
      runsPerDay: runsPerDayRes.rows,
      durationTrend: durationTrendRes.rows,
      topPipelines: topPipelinesRes.rows,
    });

  } catch (err) {
    console.error('Metrics error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
