const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('./db');
const pipelineQueue = require('./queue');

async function verifySignature(req) {
  const signature = req?.headers?.['x-hub-signature-256'];
  if (!signature) return false;

  const payload = JSON.stringify(req.body || {});
  const repoGithubId = req.body?.repository?.id;

  if (repoGithubId && db && typeof db.query === 'function') {
    try {
      const result = await db.query(
        `SELECT webhook_secret, user_id, pipeline_id
         FROM github_repositories
         WHERE github_repo_id = $1`,
        [repoGithubId]
      );

      if (result.rows.length) {
        const { webhook_secret, user_id, pipeline_id } = result.rows[0];
        const expected = `sha256=${crypto
          .createHmac('sha256', webhook_secret)
          .update(payload)
          .digest('hex')}`;

        try {
          const isValid = crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expected)
          );
          if (isValid) {
            req.repoUserId = user_id;
            req.repoPipelineId = pipeline_id;
            return true;
          }
          return false;
        } catch {
          return false;
        }
      }
    } catch (dbErr) {
    }
  }

  const globalSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!globalSecret) return false;

  const expected = `sha256=${crypto
    .createHmac('sha256', globalSecret)
    .update(payload)
    .digest('hex')}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

router.post('/github', async (req, res) => {
  const isValid = await verifySignature(req);

  if (!isValid) {
    console.warn('⚠️  Invalid webhook signature — rejected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.headers['x-github-event'];
  if (event !== 'push') {
    return res.status(200).json({ message: `Ignored event: ${event}` });
  }

  const { repository, ref, after: commitSha, pusher } = req.body;
  const branch = ref ? ref.replace('refs/heads/', '') : 'main';
  const repoUrl = repository?.clone_url;
  const repoName = repository?.full_name;

  console.log(`📨 Push to ${repoName}/${branch} by ${pusher?.name}`);

  try {
    let pipelineId = req.repoPipelineId || null;
    const userId = req.repoUserId || null;

    if (!pipelineId) {
      let result = await db.query(
        `SELECT id FROM pipelines WHERE repo_url = $1 AND branch = $2`,
        [repoUrl, branch]
      );

      if (result.rows.length === 0) {
        const newPipeline = await db.query(
          `INSERT INTO pipelines (user_id, repo_url, repo_name, branch)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [userId, repoUrl, repoName, branch]
        );
        pipelineId = newPipeline.rows[0].id;
      } else {
        pipelineId = result.rows[0].id;
      }
    }

    const run = await db.query(
      `INSERT INTO runs (pipeline_id, commit_sha, status, triggered_by)
       VALUES ($1, $2, 'pending', $3) RETURNING id`,
      [pipelineId, commitSha, pusher?.name || 'github']
    );
    const runId = run.rows[0].id;

    await pipelineQueue.add(
      { runId, pipelineId, repoUrl, branch, commitSha, triggeredBy: pusher?.name || 'github' },
      { attempts: 3, backoff: 5000 }
    );

    console.log(`✅ Queued run ${runId} for pipeline ${pipelineId}`);
    res.status(202).json({ message: 'Pipeline queued', runId, pipelineId });

  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = { router, verifySignature };
