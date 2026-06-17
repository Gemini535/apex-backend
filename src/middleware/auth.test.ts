import { describe, it, expect, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { authenticateToken } from './auth.js';

// Helper to create a mock Express request/response/next
function createMocks() {
  const headers: Record<string, string> = {};
  const res: any = {
    status: function (code: number) { this._status = code; return this; },
    json: function (body: any) { this._body = body; return this; },
    _status: 200,
    _body: undefined as any,
  };
  const next: any = (_err?: any) => { next._nextArg = _err; };
  next._nextArg = undefined;
  return { headers, res, next };
}

describe('authenticateToken middleware', () => {
  let testUserId: string;
  let validToken: string;

  beforeEach(async () => {
    // Clean up sessions from previous tests
    await prisma.session.deleteMany({ where: { user: { email: { contains: 'auth-mw-test' } } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'auth-mw-test' } } });

    const user = await prisma.user.create({
      data: {
        email: `auth-mw-test-${Date.now()}@test.app`,
        username: `auth-mw-test-${Date.now()}`,
        passwordHash: 'fake',
      },
    });
    testUserId = user.id;

    validToken = jwt.sign(
      { userId: user.id, email: user.email, username: user.username },
      env.jwt.secret,
      { expiresIn: '15m' },
    );

    // Create a valid session
    await prisma.session.create({
      data: {
        userId: user.id,
        refreshToken: 'test-refresh-token',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
  });

  it('rejects requests with no authorization header', async () => {
    const { headers, res, next } = createMocks();
    const req: any = { headers, ip: '127.0.0.1' };
    await authenticateToken(req, res, next);
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('Access token required');
  });

  it('rejects requests with malformed authorization header', async () => {
    const { res, next } = createMocks();
    const req: any = { headers: { authorization: 'NotBearer token123' }, ip: '127.0.0.1' };
    await authenticateToken(req, res, next);
    expect(res._status).toBe(401);
  });

  it('rejects expired tokens', async () => {
    const expiredToken = jwt.sign(
      { userId: testUserId, email: 'test@test.com', username: 'test' },
      env.jwt.secret,
      { expiresIn: '0s' },
    );
    const { res, next } = createMocks();
    const req: any = { headers: { authorization: `Bearer ${expiredToken}` }, ip: '127.0.0.1' };
    await authenticateToken(req, res, next);
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('Token expired');
  });

  it('rejects tokens with invalid signature', async () => {
    const badToken = jwt.sign(
      { userId: testUserId, email: 'test@test.com', username: 'test' },
      'wrong-secret',
      { expiresIn: '15m' },
    );
    const { res, next } = createMocks();
    const req: any = { headers: { authorization: `Bearer ${badToken}` }, ip: '127.0.0.1' };
    await authenticateToken(req, res, next);
    expect(res._status).toBe(403);
    expect(res._body.error).toBe('Invalid token');
  });

  it('rejects valid tokens for users with no active session', async () => {
    // Delete all sessions for this user
    await prisma.session.deleteMany({ where: { userId: testUserId } });

    const { res, next } = createMocks();
    const req: any = { headers: { authorization: `Bearer ${validToken}` }, ip: '127.0.0.1' };
    await authenticateToken(req, res, next);
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('Session expired or invalidated');
  });

  it('sets req.user and calls next() for valid token + active session', async () => {
    const { res, next } = createMocks();
    const req: any = { headers: { authorization: `Bearer ${validToken}` }, ip: '127.0.0.1' };
    await authenticateToken(req, res, next);
    expect(next._nextArg).toBeUndefined();
    expect(req.user).toBeDefined();
    expect(req.user.userId).toBe(testUserId);
  });
});
