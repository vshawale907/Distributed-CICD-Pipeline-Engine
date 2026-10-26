const jwt = require('jsonwebtoken');
const { hashPassword, comparePassword, generateToken, verifyToken } = require('../auth');

process.env.JWT_SECRET = 'test-secret';

describe('hashPassword / comparePassword', () => {
  test('hashed password matches original', async () => {
    const password = 'mySecretPassword123';
    const hash = await hashPassword(password);
    const isValid = await comparePassword(password, hash);
    expect(isValid).toBe(true);
  });

  test('wrong password does not match', async () => {
    const hash = await hashPassword('correctPassword');
    const isValid = await comparePassword('wrongPassword', hash);
    expect(isValid).toBe(false);
  });

  test('two hashes of same password are different (salt)', async () => {
    const password = 'samePassword';
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);
    expect(hash1).not.toBe(hash2);
    expect(await comparePassword(password, hash1)).toBe(true);
    expect(await comparePassword(password, hash2)).toBe(true);
  });
});

describe('generateToken / verifyToken', () => {
  const user = { id: 1, email: 'test@example.com', role: 'admin' };

  test('token contains correct id, email, role', () => {
    const token = generateToken(user);
    const decoded = verifyToken(token);
    expect(decoded.id).toBe(user.id);
    expect(decoded.email).toBe(user.email);
    expect(decoded.role).toBe(user.role);
    expect(decoded.iat).toBeDefined();
    expect(decoded.exp).toBeDefined();
  });

  test('token is verifiable', () => {
    const token = generateToken(user);
    expect(() => verifyToken(token)).not.toThrow();
  });

  test('expired token throws', (done) => {
    const shortLivedToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '1ms' }
    );
    
    setTimeout(() => {
      expect(() => verifyToken(shortLivedToken)).toThrow('jwt expired');
      done();
    }, 10);
  });

  test('tampered token throws', () => {
    const token = generateToken(user);
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(() => verifyToken(tampered)).toThrow();
  });
});
