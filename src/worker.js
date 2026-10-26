const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs');
const os = require('os');
const yaml = require('js-yaml');

const envFile =
  process.env.NODE_ENV === 'production' ? '.env.production' :
  process.env.NODE_ENV === 'test'       ? '.env.test' :
                                          '.env.development';

require('dotenv').config({ path: path.resolve(process.cwd(), envFile) });
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const pipelineQueue = require('./queue');
const db = require('./db');
const { runStep } = require('./docker-runner');
const { publishLog } = require('./pubsub');
const { notifySlack } = require('./notifications');

pipelineQueue.process(2, async (job) => {
  const { runId, pipelineId, repoUrl, branch, commitSha } = job.data;
  const triggeredBy = job.data.triggeredBy || 'unknown';
  const tmpDir = path.join(os.tmpdir(), `cicd-run-${runId}`);
  const startTime = Date.now();

  console.log(`\n🚀 Processing run ${runId} for ${repoUrl}`);

  let finalStatus = 'failed';

  const writeLog = async (text, stepId = null) => {
    publishLog(runId, text);
    try {
      await db.query(
        `INSERT INTO logs (run_id, step_id, line) VALUES ($1, $2, $3)`,
        [runId, stepId, text]
      );
    } catch (e) {}
  };

  try {
    await db.query(`UPDATE runs SET status = 'running' WHERE id = $1`, [runId]);
    await writeLog(`🚀 Pipeline started for commit ${commitSha}`);

    await writeLog(`📦 Cloning ${repoUrl} (branch: ${branch})...`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const git = simpleGit();
    await git.clone(repoUrl, tmpDir, ['--branch', branch, '--depth', '1']);
    await writeLog(`✅ Repository cloned`);

    let config;
    const ymlPath  = path.join(tmpDir, '.pipeline.yml');
    const yamlPath = path.join(tmpDir, '.pipeline.yaml');
    const jsonPath = path.join(tmpDir, '.pipeline.json');

    if (fs.existsSync(ymlPath)) {
      config = yaml.load(fs.readFileSync(ymlPath, 'utf8'));
      await writeLog(`📋 Using config from .pipeline.yml`);
    } else if (fs.existsSync(yamlPath)) {
      config = yaml.load(fs.readFileSync(yamlPath, 'utf8'));
      await writeLog(`📋 Using config from .pipeline.yaml`);
    } else if (fs.existsSync(jsonPath)) {
      config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      await writeLog(`📋 Using config from .pipeline.json`);
    } else {
      throw new Error('No pipeline config found. Please add a .pipeline.json (or .pipeline.yml) to your repository.');
    }

    const steps = config.steps || [];
    await writeLog(`📋 Found ${steps.length} step(s) to run`);

    let allPassed = true;

    async function executeStep(step, isParallel = false) {
      const image = step.image || 'node:18-alpine';
      const prefix = isParallel ? `[${step.name}] ` : '';
      publishLog(runId, `\n▶️ ${prefix}Step: ${step.name}  [${image}]`);
      publishLog(runId, `   ${prefix}Command: ${step.command}`);

      const stepRes = await db.query(
        `INSERT INTO steps (run_id, name, command, status, started_at)
         VALUES ($1, $2, $3, 'running', NOW()) RETURNING id`,
        [runId, step.name, step.command]
      );
      const stepId = stepRes.rows[0].id;

      try {
        const { exitCode } = await runStep(tmpDir, step.command, (line) => {
          publishLog(runId, `  ${prefix}${line}`);
          db.query(
            `INSERT INTO logs (run_id, step_id, line) VALUES ($1, $2, $3)`,
            [runId, stepId, line]
          );
        }, image);

        const stepStatus = exitCode === 0 ? 'success' : 'failed';
        await db.query(
          `UPDATE steps SET status = $1, exit_code = $2, completed_at = NOW() WHERE id = $3`,
          [stepStatus, exitCode, stepId]
        );

        if (exitCode === 0) {
          publishLog(runId, `✅ ${prefix}"${step.name}" passed`);
          return true;
        } else {
          publishLog(runId, `❌ ${prefix}"${step.name}" failed (exit code: ${exitCode})`);
          return false;
        }
      } catch (stepErr) {
        await db.query(
          `UPDATE steps SET status = 'failed', completed_at = NOW() WHERE id = $1`,
          [stepId]
        );
        publishLog(runId, `❌ ${prefix}"${step.name}" errored: ${stepErr.message}`);
        return false;
      }
    }

    for (const step of steps) {
      if (step.parallel) {
        publishLog(runId, `\n⚡ Starting ${step.parallel.length} parallel steps...`);
        const results = await Promise.all(step.parallel.map(s => executeStep(s, true)));
        if (results.some(passed => !passed)) {
          allPassed = false;
          publishLog(runId, `❌ Parallel group failed.`);
          break;
        }
      } else {
        const passed = await executeStep(step, false);
        if (!passed) {
          allPassed = false;
          break;
        }
      }
    }

    finalStatus = allPassed ? 'success' : 'failed';
    await db.query(
      `UPDATE runs SET status = $1, completed_at = NOW() WHERE id = $2`,
      [finalStatus, runId]
    );

    publishLog(runId, `\n${allPassed ? '🎉 Pipeline PASSED' : '💥 Pipeline FAILED'}`);
    publishLog(runId, `__PIPELINE_DONE__`);

    try {
      const pipelineRow = await db.query(
        `SELECT repo_name, branch FROM pipelines WHERE id = $1`,
        [pipelineId]
      );
      const repoName = pipelineRow.rows[0]?.repo_name || repoUrl;
      const pipelineBranch = pipelineRow.rows[0]?.branch || branch;

      await notifySlack({
        status: finalStatus,
        runId,
        pipelineId,
        repoName,
        branch: pipelineBranch,
        commitSha,
        triggeredBy,
        durationSeconds: Math.round((Date.now() - startTime) / 1000),
      });
    } catch (slackErr) {
      console.warn(`⚠️  Slack notification error: ${slackErr.message}`);
    }

    return { status: finalStatus };

  } catch (err) {
    console.error(`❌ Run ${runId} crashed:`, err);
    await db.query(
      `UPDATE runs SET status = 'failed', completed_at = NOW() WHERE id = $1`,
      [runId]
    );
    await writeLog(`❌ Fatal error: ${err.message}`);
    publishLog(runId, `__PIPELINE_DONE__`);

    try {
      const pipelineRow = await db.query(
        `SELECT repo_name, branch FROM pipelines WHERE id = $1`,
        [pipelineId]
      );
      await notifySlack({
        status: 'failed',
        runId,
        pipelineId,
        repoName: pipelineRow.rows[0]?.repo_name || repoUrl,
        branch:   pipelineRow.rows[0]?.branch    || branch,
        commitSha,
        triggeredBy,
        durationSeconds: Math.round((Date.now() - startTime) / 1000),
      });
    } catch (slackErr) {
      console.warn(`⚠️  Slack notification error: ${slackErr.message}`);
    }

    throw err;

  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
});

async function recoverStuckJobs() {
  const result = await db.query(`
    SELECT r.id as run_id, r.pipeline_id, r.commit_sha, p.repo_url, p.branch
    FROM runs r
    JOIN pipelines p ON r.pipeline_id = p.id
    WHERE r.status = 'running'
  `);

  if (result.rows.length > 0) {
    console.log(`🔄 Recovering ${result.rows.length} stuck job(s)...`);
    for (const row of result.rows) {
      await db.query(`UPDATE runs SET status = 'pending' WHERE id = $1`, [row.run_id]);
      await pipelineQueue.add({
        runId: row.run_id,
        pipelineId: row.pipeline_id,
        repoUrl: row.repo_url,
        branch: row.branch,
        commitSha: row.commit_sha || 'unknown',
      });
    }
  }
}

recoverStuckJobs().catch(console.error);
console.log('👷 Worker started, listening for jobs...');
