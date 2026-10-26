const request = require('supertest');
const express = require('express');
const githubRouter = require('../routes/github');
const { generateToken } = require('../auth');

process.env.JWT_SECRET = 'test_jwt_secret_key_12345678901234567890';
process.env.GITHUB_CLIENT_ID = 'test_client_id';
process.env.GITHUB_CLIENT_SECRET = 'test_client_secret';
process.env.GITHUB_CALLBACK_URL = 'http://localhost:3000/api/github/callback';

const app = express();
app.use(express.json());
app.use('/api/github', githubRouter);

describe('GitHub Router', () => {
  const user = { id: 1, email: 'test@example.com', role: 'admin' };
  const token = generateToken(user);

  test('GET /api/github/auth-url requires authentication', async () => {
    const res = await request(app).get('/api/github/auth-url');
    expect(res.statusCode).toBe(401);
  });

  test('GET /api/github/auth-url returns GitHub OAuth URL when authenticated', async () => {
    const res = await request(app)
      .get('/api/github/auth-url')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.url).toContain('https://github.com/login/oauth/authorize');
    expect(res.body.url).toContain('client_id=test_client_id');
    expect(res.body.url).toContain('scope=repo%2Cadmin%3Arepo_hook');
  });

  test('GET /api/github/callback handles missing params', async () => {
    const res = await request(app).get('/api/github/callback');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error=missing_params');
  });

  test('GET /api/github/callback handles invalid state token', async () => {
    const res = await request(app).get('/api/github/callback?code=12345&state=invalid_state');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error=invalid_state');
  });

  test('GET /api/github/callback handles OAuth error parameter', async () => {
    const res = await request(app).get('/api/github/callback?error=access_denied');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error=access_denied');
  });
});
