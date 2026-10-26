const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

async function notifySlack({ status, runId, pipelineId, repoName, branch, commitSha, triggeredBy, durationSeconds }) {
  if (status !== 'failed') return;

  if (!SLACK_WEBHOOK_URL) {
    console.log('ℹ️  SLACK_WEBHOOK_URL not set — skipping Slack notification');
    return;
  }

  const shortSha = (commitSha || 'unknown').slice(0, 7);
  const logsUrl = `${FRONTEND_URL}/runs/${runId}`;

  const payload = {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '❌ Pipeline Failed', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Repo:*\n${repoName}` },
          { type: 'mrkdwn', text: `*Branch:*\n${branch}` },
          { type: 'mrkdwn', text: `*Commit:*\n\`${shortSha}\`` },
          { type: 'mrkdwn', text: `*Triggered by:*\n${triggeredBy}` },
          { type: 'mrkdwn', text: `*Run ID:*\n#${runId}` },
          { type: 'mrkdwn', text: `*Duration:*\n${durationSeconds}s` },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '🔍 View Logs', emoji: true },
            url: logsUrl,
            style: 'danger',
          },
        ],
      },
      { type: 'divider' },
    ],
  };

  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.warn(`⚠️  Slack notification failed: HTTP ${res.status}`);
    } else {
      console.log(`📣 Slack notified: run #${runId} failed`);
    }
  } catch (err) {
    console.warn(`⚠️  Slack notification error: ${err.message}`);
  }
}

module.exports = { notifySlack };
