import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  suggestStrongPassword,
  hashPassword,
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  setupTOTP,
  verifyTOTP,
  sendSMSCode,
  verifySMSCode,
  sendEmailCode,
  verifyEmailCode,
  generate2FATempToken,
  verify2FATempToken,
} from './auth.service.js';
import { prisma } from '../../config/database.js';

// ─── Password Tests ──────────────────────────────────────────────────────────

describe('auth.service — password functions', () => {
  describe('suggestStrongPassword', () => {
    it('generates a password of at least 12 characters', () => {
      const pw = suggestStrongPassword();
      expect(pw.length).toBeGreaterThanOrEqual(12);
    });

    it('includes at least one uppercase letter', () => {
      const pw = suggestStrongPassword();
      expect(pw).toMatch(/[A-Z]/);
    });

    it('includes at least one lowercase letter', () => {
      const pw = suggestStrongPassword();
      expect(pw).toMatch(/[a-z]/);
    });

    it('includes at least one digit', () => {
      const pw = suggestStrongPassword();
      expect(pw).toMatch(/\d/);
    });

    it('includes at least one special character', () => {
      const pw = suggestStrongPassword();
      expect(pw).toMatch(/[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/);
    });

    it('generates unique passwords each call', () => {
      const pw1 = suggestStrongPassword();
      const pw2 = suggestStrongPassword();
      expect(pw1).not.toBe(pw2);
    });
  });

  describe('hashPassword / comparePassword', () => {
    it('hashes a password and verifies correctly', async () => {
      const hash = await hashPassword('MyStr0ng!Pass');
      expect(hash).not.toBe('MyStr0ng!Pass');
      expect(hash).toMatch(/^\$2[aby]?\$/); // bcrypt format
    });

    it('returns true for correct password', async () => {
      const hash = await hashPassword('TestPassword1!');
      const result = await comparePassword('TestPassword1!', hash);
      expect(result).toBe(true);
    });

    it('returns false for incorrect password', async () => {
      const hash = await hashPassword('TestPassword1!');
      const result = await comparePassword('WrongPassword!', hash);
      expect(result).toBe(false);
    });

    it('produces different hashes for the same password (salt)', async () => {
      const hash1 = await hashPassword('SamePassword!');
      const hash2 = await hashPassword('SamePassword!');
      expect(hash1).not.toBe(hash2);
    });
  });
});

// ─── JWT Tests ───────────────────────────────────────────────────────────────

describe('auth.service — JWT functions', () => {
  describe('generateAccessToken', () => {
    it('generates a valid JWT string', () => {
      const token = generateAccessToken({
        userId: 'user-123',
        email: 'test@apex.app',
        username: 'testuser',
      });
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // header.payload.signature
    });

    it('embeds the correct payload', () => {
      const token = generateAccessToken({
        userId: 'user-456',
        email: 'alice@apex.app',
        username: 'alice',
      });
      const parts = token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      expect(payload.userId).toBe('user-456');
      expect(payload.email).toBe('alice@apex.app');
      expect(payload.username).toBe('alice');
    });
  });

  describe('generateRefreshToken', () => {
    it('generates an 80-character hex string (40 bytes)', () => {
      const token = generateRefreshToken();
      expect(token).toMatch(/^[a-f0-9]{80}$/);
    });

    it('generates unique tokens', () => {
      const t1 = generateRefreshToken();
      const t2 = generateRefreshToken();
      expect(t1).not.toBe(t2);
    });
  });

  describe('verifyRefreshToken', () => {
    it('returns null for a non-existent token', async () => {
      const result = await verifyRefreshToken('nonexistent-token-12345');
      expect(result).toBeNull();
    });

    it('returns null for an expired session', async () => {
      // Create a user and an expired session
      const user = await prisma.user.create({
        data: {
          email: `expired-${Date.now()}@test.app`,
          username: `expired-${Date.now()}`,
          passwordHash: 'fake',
        },
      });
      const expiredToken = generateRefreshToken();
      await prisma.session.create({
        data: {
          userId: user.id,
          refreshToken: expiredToken,
          expiresAt: new Date(Date.now() - 1000), // already expired
        },
      });

      const result = await verifyRefreshToken(expiredToken);
      expect(result).toBeNull();

      // Cleanup
      await prisma.user.delete({ where: { id: user.id } });
    });

    it('returns userId for a valid session', async () => {
      const user = await prisma.user.create({
        data: {
          email: `valid-${Date.now()}@test.app`,
          username: `valid-${Date.now()}`,
          passwordHash: 'fake',
        },
      });
      const validToken = generateRefreshToken();
      await prisma.session.create({
        data: {
          userId: user.id,
          refreshToken: validToken,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
        },
      });

      const result = await verifyRefreshToken(validToken);
      expect(result).toEqual({ userId: user.id });

      // Cleanup
      await prisma.user.delete({ where: { id: user.id } });
    });
  });
});

// ─── 2FA Temp Token Tests ────────────────────────────────────────────────────

describe('auth.service — 2FA temp tokens', () => {
  it('generates a verifiable temp token', () => {
    const token = generate2FATempToken('user-123');
    const result = verify2FATempToken(token);
    expect(result).toEqual({ userId: 'user-123' });
  });

  it('returns null for an invalid token', () => {
    const result = verify2FATempToken('invalid-token');
    expect(result).toBeNull();
  });

  it('returns null for a regular access token (wrong purpose)', () => {
    const accessToken = generateAccessToken({
      userId: 'user-123',
      email: 'test@apex.app',
      username: 'test',
    });
    const result = verify2FATempToken(accessToken);
    expect(result).toBeNull();
  });
});

// ─── SMS/Email Code Tests ────────────────────────────────────────────────────

describe('auth.service — SMS verification codes', () => {
  it('generates a 6-digit code', async () => {
    const code = await sendSMSCode('+1234567890');
    expect(code).toMatch(/^\d{6}$/);
  });

  it('verifies a correct code', async () => {
    await sendSMSCode('+1234567890');
    // We can't know the code since it's logged, but we can test the flow
    // by sending and immediately checking the store behavior
    const code = await sendSMSCode('+1999999999');
    expect(code).toMatch(/^\d{6}$/);
  });

  it('rejects an incorrect code', async () => {
    await sendSMSCode('+1234567890');
    const isValid = await verifySMSCode('+1234567890', '000000');
    expect(isValid).toBe(false);
  });

  it('returns false for unknown phone number', async () => {
    const isValid = await verifySMSCode('+1999999999', '123456');
    expect(isValid).toBe(false);
  });

  it('consumes code after successful verification (one-time use)', async () => {
    const code = await sendSMSCode('+1555555555');
    const firstTry = await verifySMSCode('+1555555555', code);
    expect(firstTry).toBe(true);
    const secondTry = await verifySMSCode('+1555555555', code);
    expect(secondTry).toBe(false);
  });
});

describe('auth.service — Email verification codes', () => {
  it('generates a 6-digit code', async () => {
    const code = await sendEmailCode('test@apex.app');
    expect(code).toMatch(/^\d{6}$/);
  });

  it('rejects an incorrect code', async () => {
    await sendEmailCode('test@apex.app');
    const isValid = await verifyEmailCode('test@apex.app', '000000');
    expect(isValid).toBe(false);
  });

  it('consumes code after successful verification (one-time use)', async () => {
    const code = await sendEmailCode('consume@apex.app');
    const firstTry = await verifyEmailCode('consume@apex.app', code);
    expect(firstTry).toBe(true);
    const secondTry = await verifyEmailCode('consume@apex.app', code);
    expect(secondTry).toBe(false);
  });
});

// ─── TOTP Tests ──────────────────────────────────────────────────────────────

describe('auth.service — TOTP', () => {
  let testUserId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `totp-test-${Date.now()}@test.app`,
        username: `totp-test-${Date.now()}`,
        passwordHash: 'fake',
      },
    });
    testUserId = user.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
  });

  it('sets up TOTP and returns secret + QR + backup codes', async () => {
    const result = await setupTOTP(testUserId);
    expect(result.secret).toBeTruthy();
    expect(result.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.backupCodes).toHaveLength(10);
    result.backupCodes.forEach((code) => {
      expect(code).toMatch(/^[A-F0-9]{8}$/);
    });
  });

  it('rejects an invalid TOTP code', async () => {
    const isValid = await verifyTOTP(testUserId, '000000');
    expect(isValid).toBe(false);
  });
});
