const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const envFile =
  process.env.NODE_ENV === 'production' ? '.env.production' :
  process.env.NODE_ENV === 'test'       ? '.env.test' :
                                          '.env.development';

require('dotenv').config({ path: path.resolve(process.cwd(), envFile) });
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const { router: webhookRouter } = require('./webhook');
const pipelinesRouter = require('./routes/pipelines');
const runsRouter = require('./routes/runs');
const authRouter = require('./routes/auth');
const metricsRouter = require('./routes/metrics');
const githubRouter = require('./routes/github');
const { subscribeToRun, unsubscribeFromRun } = require('./pubsub');
const { requireAuth, requireAdmin } = require('./middleware/auth');
const { verifyToken } = require('./auth');
require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json());

app.use('/webhook', webhookRouter);
app.use('/api/auth', authRouter);
app.use('/api/github', githubRouter);
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/metrics', requireAuth, metricsRouter);

const securePipelinesRouter = express.Router();
securePipelinesRouter.get('/', requireAuth, (req, res, next) => pipelinesRouter(req, res, next));
securePipelinesRouter.get('/:id', requireAuth, (req, res, next) => pipelinesRouter(req, res, next));
securePipelinesRouter.post('/:id/trigger', requireAdmin, (req, res, next) => pipelinesRouter(req, res, next));
app.use('/api/pipelines', securePipelinesRouter);

app.use('/api/runs', requireAuth, runsRouter);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(1008, 'Missing token');
    return;
  }

  try {
    verifyToken(token);
  } catch {
    ws.close(1008, 'Invalid or expired token');
    return;
  }

  console.log('🔌 WebSocket client connected');
  let currentRunId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'subscribe') {
        if (currentRunId) unsubscribeFromRun(currentRunId);
        currentRunId = data.runId;
        console.log(`📡 Client subscribed to run ${currentRunId}`);

        subscribeToRun(currentRunId, (logData) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(logData));
          }
        });

        ws.send(JSON.stringify({ type: 'subscribed', runId: currentRunId }));
      }
    } catch (err) {
      console.error('WS parse error:', err);
    }
  });

  ws.on('close', () => {
    console.log('🔌 Client disconnected');
    if (currentRunId) unsubscribeFromRun(currentRunId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket on ws://localhost:${PORT}/ws`);
  console.log(`❤️  Health: http://localhost:${PORT}/health\n`);
});
