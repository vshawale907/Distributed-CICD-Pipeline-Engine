const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

async function githubApi(path, accessToken, options = {}) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${accessToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  return res;
}

function generateStateToken(userId) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not set');
  return jwt.sign(
    { sub: userId, nonce: crypto.randomBytes(16).toString('hex'), purpose: 'github_oauth' },
    secret,
    { expiresIn: '10m' }
  );
}

function verifyStateToken(state) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not set');
  const payload = jwt.verify(state, secret);
  if (payload.purpose !== 'github_oauth') throw new Error('Invalid state purpose');
  return payload;
}

router.get('/auth-url', requireAuth, (req, res) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: 'GITHUB_CLIENT_ID is not configured on the server.' });
  }

  try {
    const state = generateStateToken(req.user.id);
    const params = new URLSearchParams({
      client_id: clientId,
      scope: 'repo,admin:repo_hook',
      state,
      allow_signup: 'false',
    });
    res.json({ url: `https://github.com/login/oauth/authorize?${params}` });
  } catch (err) {
    console.error('GitHub auth-url error:', err);
    res.status(500).json({ error: 'Failed to generate OAuth URL' });
  }
});

router.get('/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const redirect = (params) => res.redirect(`${frontendUrl}/github/callback?${new URLSearchParams(params)}`);

  if (oauthError) {
    return redirect({ error: oauthError });
  }

  if (!code || !state) {
    return redirect({ error: 'missing_params' });
  }

  let userId;
  try {
    const payload = verifyStateToken(state);
    userId = payload.sub;
  } catch (err) {
    console.warn('Invalid OAuth state:', err.message);
    return redirect({ error: 'invalid_state' });
  }

  let accessToken;
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error || !tokenData.access_token) {
      console.error('GitHub token exchange failed:', tokenData);
      return redirect({ error: tokenData.error || 'token_exchange_failed' });
    }

    accessToken = tokenData.access_token;
  } catch (err) {
    console.error('GitHub token exchange error:', err);
    return redirect({ error: 'token_exchange_failed' });
  }

  let githubUser;
  try {
    const userRes = await githubApi('/user', accessToken);
    if (!userRes.ok) {
      return redirect({ error: 'github_api_failed' });
    }
    githubUser = await userRes.json();
  } catch (err) {
    console.error('GitHub user fetch error:', err);
    return redirect({ error: 'github_api_failed' });
  }

  try {
    await db.query(
      `INSERT INTO github_integrations
         (user_id, github_user_id, github_login, github_name, github_avatar_url, access_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         github_user_id    = EXCLUDED.github_user_id,
         github_login      = EXCLUDED.github_login,
         github_name       = EXCLUDED.github_name,
         github_avatar_url = EXCLUDED.github_avatar_url,
         access_token      = EXCLUDED.access_token,
         updated_at        = NOW()`,
      [userId, githubUser.id, githubUser.login, githubUser.name, githubUser.avatar_url, accessToken]
    );

    console.log(`✅ GitHub integration saved for user ${userId} (${githubUser.login})`);
    return redirect({ success: 'true' });
  } catch (err) {
    console.error('DB upsert github_integrations error:', err);
    return redirect({ error: 'db_error' });
  }
});

router.get('/status', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT github_login, github_name, github_avatar_url, created_at, updated_at
       FROM github_integrations WHERE user_id = $1`,
      [req.user.id]
    );

    if (!result.rows.length) {
      return res.json({ connected: false });
    }

    return res.json({ connected: true, ...result.rows[0] });
  } catch (err) {
    console.error('GitHub status error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/disconnect', requireAuth, async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT gi.access_token, gr.webhook_id, gr.owner, gr.name
       FROM github_integrations gi
       LEFT JOIN github_repositories gr ON gr.github_integration_id = gi.id
       WHERE gi.user_id = $1`,
      [req.user.id]
    );

    const accessToken = rows.rows[0]?.access_token;
    if (accessToken) {
      for (const row of rows.rows) {
        if (row.webhook_id && row.owner && row.name) {
          try {
            await githubApi(`/repos/${row.owner}/${row.name}/hooks/${row.webhook_id}`, accessToken, {
              method: 'DELETE',
            });
          } catch (e) {}
        }
      }
    }

    await db.query(`DELETE FROM github_integrations WHERE user_id = $1`, [req.user.id]);

    res.json({ message: 'GitHub disconnected successfully' });
  } catch (err) {
    console.error('GitHub disconnect error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/repos', requireAuth, async (req, res) => {
  try {
    const integResult = await db.query(
      `SELECT access_token FROM github_integrations WHERE user_id = $1`,
      [req.user.id]
    );

    if (!integResult.rows.length) {
      return res.status(400).json({ error: 'GitHub not connected' });
    }

    const accessToken = integResult.rows[0].access_token;

    let allRepos = [];
    let page = 1;
    while (true) {
      const apiRes = await githubApi(
        `/user/repos?per_page=100&page=${page}&sort=updated&type=all`,
        accessToken
      );

      if (!apiRes.ok) {
        if (apiRes.status === 401) {
          await db.query(`DELETE FROM github_integrations WHERE user_id = $1`, [req.user.id]);
          return res.status(401).json({ error: 'GitHub token revoked. Please reconnect your GitHub account.' });
        }
        const errBody = await apiRes.text();
        console.error('GitHub repos API error:', apiRes.status, errBody);
        break;
      }

      const repos = await apiRes.json();
      if (!Array.isArray(repos) || !repos.length) break;
      allRepos = allRepos.concat(repos);
      if (repos.length < 100) break;
      page++;
    }

    const connectedResult = await db.query(
      `SELECT github_repo_id FROM github_repositories WHERE user_id = $1`,
      [req.user.id]
    );
    const connectedIds = new Set(connectedResult.rows.map(r => String(r.github_repo_id)));

    const repoList = allRepos.map(r => ({
      id: r.id,
      name: r.name,
      full_name: r.full_name,
      owner: r.owner?.login,
      clone_url: r.clone_url,
      private: r.private,
      default_branch: r.default_branch || 'main',
      description: r.description,
      updated_at: r.updated_at,
      connected: connectedIds.has(String(r.id)),
    }));

    res.json(repoList);
  } catch (err) {
    console.error('GitHub repos error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/connected-repos', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         gr.id, gr.github_repo_id, gr.full_name, gr.owner, gr.name,
         gr.default_branch, gr.private, gr.webhook_id, gr.connected_at,
         gr.pipeline_id,
         (SELECT status      FROM runs WHERE pipeline_id = gr.pipeline_id ORDER BY triggered_at DESC LIMIT 1) AS last_status,
         (SELECT triggered_at FROM runs WHERE pipeline_id = gr.pipeline_id ORDER BY triggered_at DESC LIMIT 1) AS last_run_at,
         (SELECT id           FROM runs WHERE pipeline_id = gr.pipeline_id ORDER BY triggered_at DESC LIMIT 1) AS last_run_id
       FROM github_repositories gr
       WHERE gr.user_id = $1
       ORDER BY gr.connected_at DESC`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Connected repos error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/repos/:repoId/connect', requireAuth, async (req, res) => {
  const { repoId } = req.params;
  const {
    owner, name, full_name, clone_url,
    default_branch = 'main',
    private: isPrivate = false,
  } = req.body;

  if (!owner || !name || !full_name || !clone_url) {
    return res.status(400).json({ error: 'owner, name, full_name, and clone_url are required' });
  }

  try {
    const integResult = await db.query(
      `SELECT id, access_token FROM github_integrations WHERE user_id = $1`,
      [req.user.id]
    );
    if (!integResult.rows.length) {
      return res.status(400).json({ error: 'GitHub account not connected' });
    }
    const { id: integrationId, access_token: accessToken } = integResult.rows[0];

    const existing = await db.query(
      `SELECT id FROM github_repositories WHERE user_id = $1 AND github_repo_id = $2`,
      [req.user.id, repoId]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Repository already connected' });
    }

    const webhookSecret = crypto.randomBytes(32).toString('hex');

    const backendUrl = process.env.BACKEND_URL ||
      `http://localhost:${process.env.PORT || 3000}`;
    const webhookUrl = `${backendUrl}/webhook/github`;

    let webhookId = null;
    try {
      const hookRes = await githubApi(`/repos/${owner}/${name}/hooks`, accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'web',
          active: true,
          events: ['push'],
          config: {
            url: webhookUrl,
            content_type: 'json',
            secret: webhookSecret,
            insecure_ssl: '0',
          },
        }),
      });

      if (hookRes.ok) {
        const hookData = await hookRes.json();
        webhookId = hookData.id;
        console.log(`✅ Webhook ${webhookId} created for ${full_name}`);
      } else {
        const errBody = await hookRes.json();
        console.warn(`⚠️  Webhook creation failed for ${full_name}:`, errBody.message);
      }
    } catch (hookErr) {
      console.warn(`⚠️  Webhook creation error for ${full_name}:`, hookErr.message);
    }

    let pipelineId = null;
    const existingPipeline = await db.query(
      `SELECT id FROM pipelines WHERE repo_url = $1 AND branch = $2`,
      [clone_url, default_branch]
    );

    if (existingPipeline.rows.length) {
      pipelineId = existingPipeline.rows[0].id;
      await db.query(
        `UPDATE pipelines SET user_id = $1 WHERE id = $2 AND user_id IS NULL`,
        [req.user.id, pipelineId]
      );
    } else {
      const pipelineResult = await db.query(
        `INSERT INTO pipelines (user_id, repo_url, repo_name, branch)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.user.id, clone_url, full_name, default_branch]
      );
      pipelineId = pipelineResult.rows[0].id;
    }

    const repoResult = await db.query(
      `INSERT INTO github_repositories
         (user_id, github_integration_id, github_repo_id, owner, name, full_name,
          clone_url, default_branch, private, webhook_id, webhook_secret, pipeline_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        req.user.id, integrationId, repoId,
        owner, name, full_name, clone_url, default_branch,
        isPrivate, webhookId, webhookSecret, pipelineId,
      ]
    );

    console.log(`✅ Repository ${full_name} connected (pipeline: ${pipelineId})`);

    res.status(201).json({
      message: 'Repository connected successfully',
      repoDbId: repoResult.rows[0].id,
      pipelineId,
      webhookConfigured: webhookId !== null,
      webhookWarning: webhookId === null
        ? 'Webhook could not be auto-configured. You may need repo admin access or check BACKEND_URL.'
        : null,
    });
  } catch (err) {
    console.error('Connect repo error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/repos/:repoId/disconnect', requireAuth, async (req, res) => {
  const { repoId } = req.params;

  try {
    const result = await db.query(
      `SELECT gr.id AS gr_id, gr.webhook_id, gr.owner, gr.name, gi.access_token
       FROM github_repositories gr
       JOIN github_integrations gi ON gi.id = gr.github_integration_id
       WHERE gr.user_id = $1 AND gr.github_repo_id = $2`,
      [req.user.id, repoId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    const { gr_id, webhook_id, owner, name, access_token } = result.rows[0];

    if (webhook_id) {
      try {
        await githubApi(`/repos/${owner}/${name}/hooks/${webhook_id}`, access_token, {
          method: 'DELETE',
        });
        console.log(`🗑️  Webhook ${webhook_id} removed from ${owner}/${name}`);
      } catch (e) {
        console.warn(`⚠️  Webhook removal failed for ${owner}/${name}:`, e.message);
      }
    }

    await db.query(`DELETE FROM github_repositories WHERE id = $1`, [gr_id]);

    res.json({ message: 'Repository disconnected' });
  } catch (err) {
    console.error('Disconnect repo error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
