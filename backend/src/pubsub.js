const Redis = require('ioredis');
require('dotenv').config();

const redisUrl = process.env.REDIS_URL;
const isTls = redisUrl && (redisUrl.startsWith('rediss://') || redisUrl.includes('upstash.io'));

const redisOptions = {
  family: 0,
  connectTimeout: 30000,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  keepAlive: 30000,
};

if (isTls) redisOptions.tls = { rejectUnauthorized: false };

const publisher = new Redis(redisUrl, redisOptions);
const subscriber = new Redis(redisUrl, redisOptions);

publisher.on('connect', () => console.log('✅ Redis publisher connected'));
subscriber.on('connect', () => console.log('✅ Redis subscriber connected'));

function publishLog(runId, line) {
  const channel = `run:${runId}:logs`;
  publisher.publish(channel, JSON.stringify({
    runId,
    line,
    timestamp: new Date().toISOString(),
  }));
}

function subscribeToRun(runId, callback) {
  const channel = `run:${runId}:logs`;
  subscriber.subscribe(channel);
  subscriber.on('message', (ch, message) => {
    if (ch === channel) {
      callback(JSON.parse(message));
    }
  });
}

function unsubscribeFromRun(runId) {
  subscriber.unsubscribe(`run:${runId}:logs`);
}

module.exports = { publishLog, subscribeToRun, unsubscribeFromRun };
