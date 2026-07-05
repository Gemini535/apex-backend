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

/** Signs a token exactly like `generateAccessToken` does — `type: 'access'`
 * plus a `sid` binding it to a specific Session row. */
function signAccessToken(
  payload: { userId: string; email: string; username: string },
  sessionId: string | undefined,
  options: jwt.SignOptions = { expiresIn: '15m' },
): string {
  return jwt.sign({ ...payload, type: 'access', sid: sessionId }, env.jwt.secret, options);
}

describe('authenticateToken middleware', () => {
  let testUserId: string;
  let testEmail: string;
  let testUsername: string;
  let sessionId: string;
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
    testEmail = user.email;
    testUsername = user.username;

    // Create a valid session first so we can bind the token to its id —
    // mirrors auth.controller.ts's real issueTokens() ordering.
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        refreshToken: `test-refresh-token-${Date.now()}`,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    sessionId = session.id;

    validToken = signAccessToken({ userId: user.id, email: user.email, username: user.username }, sessionId);
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
    const expiredToken = signAccessToken(
      { userId: testUserId, email: 'test@test.com', username: 'test' },
      sessionId,
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
      { userId: testUserId, email: 'test@test.com', username: 'test', type: 'access', sid: sessionId },
      'wrong-secret',
      { expiresIn: '15m' },
    );
    const { res, next } = createMocks();
    const req: any = { headers: { authorization: `Bearer ${badToken}` }, ip: '127.0.0.1' };
    await authenticateToken(req, res, next);
    expect(res._status).toBe(403);
    expect(res._body.error).toBe('Invalid token');
  });

  it('rejects tokens missing the type/sid claims (e.g. a 2FA temp token, or a pre-session-binding token)', async () => {
    const bareToken = jwt.sign(
      { userId: testUserId, email: testEmail, username: testUsername },
      env.jwt.secret,
      { expiresIn: '15m' },
    );
    const { res, next } = createMocks();
    const req: any = { headers: { authorization: `Bearer ${bareToken}` }, ip: '127.0.0.1' };
    await authenticateToken(req, res, next);
    expect(res._status).toBe(403);
    expect(res._body.error).toBe('Invalid token');
  });

  it('rejects a token whose session has been revoked (rotated away)', async () => {
    await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });

    const { res, next } = createMocks();
    const req: any = { headers: { authorization: `Bearer ${validToken}` }, ip: '127.0.0.1' };
    await authenticateToken(req, res, next);
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('Session expired or invalidated');
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
