const crypto = require('crypto');
const { verifySignature } = require('../webhook');

process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';

describe('verifySignature', () => {
  const payload = { test: 'data' };
  const payloadString = JSON.stringify(payload);

  const generateSignature = (secret, bodyString) => {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(bodyString).digest('hex');
  };

  test('valid signature returns true', async () => {
    const signature = generateSignature(process.env.GITHUB_WEBHOOK_SECRET, payloadString);
    const req = {
      headers: { 'x-hub-signature-256': signature },
      body: payload
    };
    expect(await verifySignature(req)).toBe(true);
  });

  test('wrong secret returns false', async () => {
    const wrongSignature = generateSignature('wrong-secret', payloadString);
    const req = {
      headers: { 'x-hub-signature-256': wrongSignature },
      body: payload
    };
    expect(await verifySignature(req)).toBe(false);
  });

  test('missing signature header returns false', async () => {
    const req = {
      headers: {},
      body: payload
    };
    expect(await verifySignature(req)).toBe(false);
  });

  test('empty body with valid signature returns true', async () => {
    const emptyPayloadString = JSON.stringify({});
    const signature = generateSignature(process.env.GITHUB_WEBHOOK_SECRET, emptyPayloadString);
    const req = {
      headers: { 'x-hub-signature-256': signature },
      body: {}
    };
    expect(await verifySignature(req)).toBe(true);
  });
});
