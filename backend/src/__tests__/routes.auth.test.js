const request = require('supertest');
const express = require('express');
const authRouter = require('../routes/auth');
const db = require('../db');
const { hashPassword } = require('../auth');

jest.mock('../db');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);

process.env.JWT_SECRET = 'test-secret';

describe('POST /api/auth/register', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 201 with token and user on valid input', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, email: 'new@example.com', role: 'viewer', created_at: new Date() }]
    });

    const res = await request(app).post('/api/auth/register').send({
      email: 'new@example.com',
      password: 'password123'
    });

    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user).toMatchObject({ id: 1, email: 'new@example.com', role: 'viewer' });
  });

  test('returns 400 if email is missing', async () => {
    const res = await request(app).post('/api/auth/register').send({
      password: 'password123'
    });

    expect(res.statusCode).toBe(400);
  });

  test('returns 400 if password is missing', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'new@example.com'
    });

    expect(res.statusCode).toBe(400);
  });

  test('returns 409 if email already exists', async () => {
    const error = new Error('duplicate key param');
    error.code = '23505';
    db.query.mockRejectedValueOnce(error);

    const res = await request(app).post('/api/auth/register').send({
      email: 'existing@example.com',
      password: 'password123'
    });

    expect(res.statusCode).toBe(409);
    expect(res.body).toHaveProperty('error', 'Email already registered');
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 200 with token on valid credentials', async () => {
    const pwdHash = await hashPassword('correctpwd');
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, email: 'login@example.com', role: 'viewer', password_hash: pwdHash }]
    });

    const res = await request(app).post('/api/auth/login').send({
      email: 'login@example.com',
      password: 'correctpwd'
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user).toMatchObject({ id: 1, email: 'login@example.com', role: 'viewer' });
  });

  test('returns 401 if user not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post('/api/auth/login').send({
      email: 'notfound@example.com',
      password: 'correctpwd'
    });

    expect(res.statusCode).toBe(401);
  });

  test('returns 401 if password is wrong', async () => {
    const pwdHash = await hashPassword('correctpwd');
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, email: 'login@example.com', role: 'viewer', password_hash: pwdHash }]
    });

    const res = await request(app).post('/api/auth/login').send({
      email: 'login@example.com',
      password: 'wrongpwd'
    });

    expect(res.statusCode).toBe(401);
  });
});
