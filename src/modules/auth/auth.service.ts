import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import AppleAuth from 'apple-signin-auth';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

// ─── In-memory SMS/Email code store (replace with Redis in production) ────────

interface CodeEntry {
  code: string;
  expiresAt: number;
}

const smsCodeStore = new Map<string, CodeEntry>();
const emailCodeStore = new Map<string, CodeEntry>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const googleClient = new OAuth2Client(env.google.clientId);

// ─── Exported service functions ───────────────────────────────────────────────

/**
 * Generates a random strong password suggestion.
 * 12+ characters with uppercase, lowercase, digits, and symbols.
 */
export function suggestStrongPassword(): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';
  const all = upper + lower + digits + symbols;

  // Guarantee at least one character from each category
  const guaranteed = [
    upper[crypto.randomInt(upper.length)],
    lower[crypto.randomInt(lower.length)],
    digits[crypto.randomInt(digits.length)],
    symbols[crypto.randomInt(symbols.length)],
  ];

  // Fill remaining length (at least 12 total)
  const length = 16;
  const remaining: string[] = [];
  for (let i = guaranteed.length; i < length; i++) {
    remaining.push(all[crypto.randomInt(all.length)]);
  }

  // Shuffle the combined array
  const passwordChars = [...guaranteed, ...remaining];
  for (let i = passwordChars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [passwordChars[i], passwordChars[j]] = [passwordChars[j], passwordChars[i]];
  }

  return passwordChars.join('');
}

/**
 * Hash a password using bcrypt with 12 rounds.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * Compare a plaintext password against a bcrypt hash.
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a short-lived access JWT.
 */
export function generateAccessToken(payload: {
  userId: string;
  email: string;
  username: string;
}): string {
  return jwt.sign(payload, env.jwt.secret, {
    expiresIn: env.jwt.accessExpiry,
  } as jwt.SignOptions);
}

/**
 * Generate a refresh JWT (uses separate secret from access tokens).
 */
export function generateRefreshAccessToken(payload: {
  userId: string;
  email: string;
  username: string;
}): string {
  return jwt.sign(payload, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpiry,
  } as jwt.SignOptions);
}

/**
 * Generate a cryptographically random refresh token (hex string).
 */
export function generateRefreshToken(): string {
  return crypto.randomBytes(40).toString('hex');
}

/**
 * Look up a session by refresh token and verify it has not expired.
 * The refresh token is an opaque random string stored in the DB.
 * The access JWT (signed with JWT_SECRET) proves identity;
 * the refresh token (stored in DB, never exposed in JWT) proves session validity.
 * JWT_REFRESH_SECRET is used to sign an additional session token layer.
 */
export async function verifyRefreshToken(
  token: string
): Promise<{ userId: string } | null> {
  const session = await prisma.session.findUnique({
    where: { refreshToken: token },
  });

  if (!session) {
    return null;
  }

  if (session.expiresAt < new Date()) {
    // Clean up expired session
    await prisma.session.delete({ where: { id: session.id } });
    return null;
  }

  return { userId: session.userId };
}

/**
 * Set up TOTP for a user: generate a secret, produce a QR code data URL,
 * and create 10 hashed backup codes.
 */
export async function setupTOTP(userId: string): Promise<{
  secret: string;
  qrCodeDataUrl: string;
  backupCodes: string[];
}> {
  const secret = speakeasy.generateSecret({
    name: `${env.totp.issuer}:${userId}`,
    issuer: env.totp.issuer,
    length: 32,
  });

  const qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url ?? '');

  // Generate 10 backup codes (8-char alphanumeric each)
  const backupCodes: string[] = [];
  const hashedBackupCodes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    backupCodes.push(code);
    hashedBackupCodes.push(await bcrypt.hash(code, 10));
  }

  // Store secret (unencrypted for speakeasy verify) and hashed backup codes
  await prisma.twoFactorSetting.upsert({
    where: { userId },
    update: {
      totpSecret: secret.base32,
    },
    create: {
      userId,
      totpSecret: secret.base32,
      backupCodes: hashedBackupCodes,
    },
  });

  return {
    secret: secret.base32,
    qrCodeDataUrl,
    backupCodes,
  };
}

/**
 * Verify a TOTP code against the user's stored secret.
 */
export async function verifyTOTP(userId: string, code: string): Promise<boolean> {
  const twoFactor = await prisma.twoFactorSetting.findUnique({
    where: { userId },
  });

  if (!twoFactor?.totpSecret) {
    return false;
  }

  return speakeasy.totp.verify({
    secret: twoFactor.totpSecret,
    encoding: 'base32',
    token: code,
    window: 1,
  });
}

/**
 * Generate and store a 6-digit SMS verification code for the given phone number.
 * Returns the plaintext code (in production this would be sent via Twilio).
 */
export async function sendSMSCode(phoneNumber: string): Promise<string> {
  const code = String(crypto.randomInt(100000, 1000000));

  smsCodeStore.set(phoneNumber, {
    code,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
  });

  // TODO: Integrate Twilio SMS
  logger.info('[SMS] Verification code for %s: %s', phoneNumber, code);

  return code;
}

/**
 * Generate and store a 6-digit email verification code.
 * Returns the plaintext code (in production this would be sent via nodemailer).
 */
export async function sendEmailCode(email: string): Promise<string> {
  const code = String(crypto.randomInt(100000, 1000000));

  emailCodeStore.set(email, {
    code,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
  });

  // TODO: Integrate nodemailer
  logger.info('[Email] Verification code for %s: %s', email, code);

  return code;
}

/**
 * Verify a stored SMS code against a phone number.
 */
export function verifySMSCode(phoneNumber: string, code: string): boolean {
  const entry = smsCodeStore.get(phoneNumber);
  if (!entry) {
    return false;
  }
  if (Date.now() > entry.expiresAt) {
    smsCodeStore.delete(phoneNumber);
    return false;
  }
  const valid = entry.code === code;
  if (valid) {
    smsCodeStore.delete(phoneNumber);
  }
  return valid;
}

/**
 * Verify a stored email code against an email address.
 */
export function verifyEmailCode(email: string, code: string): boolean {
  const entry = emailCodeStore.get(email);
  if (!entry) {
    return false;
  }
  if (Date.now() > entry.expiresAt) {
    emailCodeStore.delete(email);
    return false;
  }
  const valid = entry.code === code;
  if (valid) {
    emailCodeStore.delete(email);
  }
  return valid;
}

/**
 * Verify an Apple ID token and return the Apple user ID and email.
 */
export async function verifyAppleToken(
  token: string
): Promise<{ appleId: string; email: string }> {
  const { sub, email } = await AppleAuth.verifyIdToken(token, {
    audience: env.apple.clientId,
  });

  return {
    appleId: sub,
    email: email ?? '',
  };
}

/**
 * Verify a Google ID token and return the Google user ID and email.
 */
export async function verifyGoogleToken(
  token: string
): Promise<{ googleId: string; email: string }> {
  const ticket = await googleClient.verifyIdToken({
    idToken: token,
    audience: env.google.clientId,
  });

  const payload = ticket.getPayload();
  if (!payload || !payload.sub) {
    throw new Error('Invalid Google token payload');
  }

  return {
    googleId: payload.sub,
    email: payload.email ?? '',
  };
}

/**
 * Generate a short-lived JWT for the intermediate 2FA pending step.
 */
export function generate2FATempToken(userId: string): string {
  return jwt.sign({ userId, purpose: '2fa_pending' } as Record<string, unknown>, env.jwt.secret, {
    expiresIn: '5m',
  });
}

/**
 * Verify a 2FA temp token and return the userId if valid.
 */
export function verify2FATempToken(token: string): { userId: string } | null {
  try {
    const payload = jwt.verify(token, env.jwt.secret) as Record<string, unknown>;
    if (payload.purpose !== '2fa_pending' || typeof payload.userId !== 'string') {
      return null;
    }
    return { userId: payload.userId };
  } catch {
    return null;
  }
}
