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
import nodemailer from 'nodemailer';
import { cacheSet, cacheGet, cacheDel } from '../../shared/cache/durable.js';

// ─── Durable cache for SMS/email codes (Postgres-backed) ──────────────────────

interface CodeEntry {
  code: string;
  expiresAt: number;
}

// Prefixes keep the two namespaces collision-free in the cache_entries table.
const SMS_PREFIX = 'sms:';
const EMAIL_PREFIX = 'email:';

// ─── Twilio client (lazy, only constructed if credentials are present) ────────

// Type-only import — erased at compile time, so it doesn't pull the package
// into the runtime module graph until actually needed.
type TwilioClient = import('twilio').Twilio;

let twilioClient: TwilioClient | null = null;

async function getTwilioClient(): Promise<TwilioClient> {
  if (twilioClient) return twilioClient;

  const { accountSid, authToken, phoneNumber } = env.twilio;
  if (!accountSid || !authToken || !phoneNumber) {
    throw new Error(
      'Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER.',
    );
  }

  // This package is pure ESM (`"type": "module"` in package.json, NodeNext
  // module resolution), so `require('twilio')` throws `ReferenceError:
  // require is not defined` every time — which was previously swallowed by
  // the caller's try/catch and logged at `debug`, meaning SMS 2FA silently
  // never sent a real text message even with fully valid credentials in
  // production (CODE_REVIEW.md #8). A dynamic `import()` is the correct ESM
  // equivalent of a lazy `require()`.
  const { default: twilio } = await import('twilio');
  twilioClient = twilio(accountSid, authToken);
  return twilioClient;
}

// ─── SMTP transporter (lazy, only constructed if credentials are present) ──────

let smtpTransport: ReturnType<typeof nodemailer.createTransport> | null = null;

function getSmtpTransport() {
  if (smtpTransport) return smtpTransport;

  const { host, port, user, pass } = env.smtp;
  if (!host) {
    throw new Error('SMTP is not configured. Set SMTP_HOST.');
  }

  smtpTransport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
  });
  return smtpTransport;
}

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
 *
 * Carries `type: 'access'` and (when provided) `sid`, the id of the Session
 * row this token was minted for. `authenticateToken` checks both: the
 * `type` claim prevents any other kind of token this codebase signs (e.g.
 * the 2FA temp token) from being replayed as an access token, and `sid`
 * lets us verify that THIS SPECIFIC session is still active rather than
 * merely "the user has some active session somewhere" — the previous
 * behavior meant revoking one device's session didn't actually invalidate
 * that device's still-live access token as long as the user had any other
 * session open elsewhere (CODE_REVIEW.md #5, #6).
 */
export function generateAccessToken(
  payload: {
    userId: string;
    email: string;
    username: string;
  },
  sessionId?: string,
): string {
  return jwt.sign(
    { ...payload, type: 'access' as const, sid: sessionId },
    env.jwt.secret,
    {
      expiresIn: env.jwt.accessExpiry,
      algorithm: 'HS256',
    } as jwt.SignOptions,
  );
}

/**
 * Generate a cryptographically random refresh token (hex string).
 */
export function generateRefreshToken(): string {
  return crypto.randomBytes(40).toString('hex');
}

export interface RefreshTokenResult {
  userId: string;
  sessionId: string;
}

/**
 * Look up a session by refresh token and verify it is still valid.
 *
 * The refresh token is an opaque random string stored in the DB (not a
 * JWT) — the access JWT (signed with JWT_SECRET) proves identity for API
 * calls, and this opaque token (never embedded in any JWT) proves session
 * validity across the rotation described below.
 *
 * Refresh-token reuse detection: on rotation (see `refresh` in
 * auth.controller.ts), the OLD session row is marked `revokedAt` rather
 * than deleted outright. If a request ever presents a refresh token whose
 * session already has `revokedAt` set, that's a replay of an
 * already-rotated token — the standard signal that a refresh token was
 * stolen. We respond by revoking every session belonging to that user,
 * logging both the legitimate holder of the newest token and the attacker
 * out, rather than quietly returning 401 and letting the attacker keep
 * trying (CODE_REVIEW.md #25).
 */
export async function verifyRefreshToken(
  token: string
): Promise<RefreshTokenResult | null> {
  const session = await prisma.session.findUnique({
    where: { refreshToken: token },
  });

  if (!session) {
    return null;
  }

  if (session.revokedAt) {
    logger.warn(
      { userId: session.userId, sessionId: session.id },
      'Refresh token reuse detected — revoking all sessions for this user',
    );
    await prisma.session.deleteMany({ where: { userId: session.userId } });
    return null;
  }

  if (session.expiresAt < new Date()) {
    // Clean up expired session
    await prisma.session.delete({ where: { id: session.id } });
    return null;
  }

  return { userId: session.userId, sessionId: session.id };
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

  // Store secret (unencrypted for speakeasy verify) and hashed backup codes.
  //
  // The `update` branch here used to omit `backupCodes` entirely. Every
  // user gets an empty TwoFactorSetting row created at registration/OAuth
  // signup (`twoFactor: { create: {} }`), so in practice this upsert took
  // the `update` branch for essentially every real account — meaning the
  // backup codes handed back to the client below were silently never
  // persisted at all. Combined with nothing ever calling
  // `verifyBackupCode`, this made backup codes a purely cosmetic feature
  // with no working recovery path whatsoever (CODE_REVIEW.md #7).
  await prisma.twoFactorSetting.upsert({
    where: { userId },
    update: {
      totpSecret: secret.base32,
      backupCodes: hashedBackupCodes,
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
 * Verify a one-time backup code and, if valid, consume it (backup codes are
 * single-use). `setupTOTP` generates and bcrypt-hashes 10 of these, but
 * nothing previously ever checked them at login or account-recovery time —
 * a user who lost their authenticator device had no working recovery path
 * despite the API handing back backup codes as if they were usable
 * (CODE_REVIEW.md #7). This is the missing verification half of that
 * feature; callers should try `verifyTOTP` first and fall back to this.
 */
export async function verifyBackupCode(userId: string, code: string): Promise<boolean> {
  const twoFactor = await prisma.twoFactorSetting.findUnique({ where: { userId } });
  if (!twoFactor || twoFactor.backupCodes.length === 0) {
    return false;
  }

  const normalized = code.trim().toUpperCase();

  for (const hashed of twoFactor.backupCodes) {
    // eslint-disable-next-line no-await-in-loop -- backup codes are few (10) and this only runs on the rare recovery path
    if (await bcrypt.compare(normalized, hashed)) {
      const remaining = twoFactor.backupCodes.filter((c) => c !== hashed);
      await prisma.twoFactorSetting.update({
        where: { userId },
        data: { backupCodes: remaining },
      });
      return true;
    }
  }

  return false;
}

/**
 * Generate and store a 6-digit SMS verification code for the given phone number.
 * Returns the plaintext code. Persists to the Postgres-backed cache so the
 * code survives restarts and works across horizontally scaled instances.
 */
export async function sendSMSCode(phoneNumber: string): Promise<string> {
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 min TTL

  await cacheSet(`${SMS_PREFIX}${phoneNumber}`, { code, expiresAt }, 5 * 60 * 1000);

  // Send via Twilio when configured. In dev (no credentials) we fall back to
  // logging only — the durable cache still works for verification.
  try {
    const client = await getTwilioClient();
    await client.messages.create({
      body: `Your Apex verification code: ${code}. It expires in 5 minutes.`,
      from: env.twilio.phoneNumber,
      to: phoneNumber,
    });
    logger.info({ phoneNumber }, 'SMS verification code sent via Twilio');
  } catch (err) {
    // Twilio not configured or network failure — log at debug so tests don't
    // spam, but the code is still usable via the durable cache.
    logger.debug({ err, phoneNumber }, 'SMS send failed (falling back to cache)');
  }

  return code;
}

/**
 * Generate and store a 6-digit email verification code.
 * Returns the plaintext code. Persists to the Postgres-backed cache.
 */
export async function sendEmailCode(email: string): Promise<string> {
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 min TTL

  await cacheSet(`${EMAIL_PREFIX}${email}`, { code, expiresAt }, 5 * 60 * 1000);

  // Send via nodemailer when SMTP is configured. In dev we fall back to
  // logging only — the durable cache still works for verification.
  try {
    const transport = getSmtpTransport();
    await transport.sendMail({
      from: env.smtp.from,
      to: email,
      subject: 'Your Apex verification code',
      text: `Your Apex verification code is: ${code}\n\nIt expires in 5 minutes.`,
      html: `<p>Your Apex verification code is: <strong>${code}</strong></p><p>It expires in 5 minutes.</p>`,
    });
    logger.info({ email }, 'Email verification code sent via SMTP');
  } catch (err) {
    logger.debug({ err, email }, 'Email send failed (falling back to store)');
  }

  return code;
}

/**
 * Verify a stored SMS code against a phone number.
 * Reads from the Postgres-backed cache (survives restarts).
 */
export async function verifySMSCode(phoneNumber: string, code: string): Promise<boolean> {
  const entry = await cacheGet<CodeEntry>(`${SMS_PREFIX}${phoneNumber}`);
  if (!entry) {
    return false;
  }
  if (Date.now() > entry.expiresAt) {
    await cacheDel(`${SMS_PREFIX}${phoneNumber}`);
    return false;
  }
  if (entry.code === code) {
    await cacheDel(`${SMS_PREFIX}${phoneNumber}`);
    return true;
  }
  return false;
}

/**
 * Verify a stored email code against an email address.
 * Reads from the Postgres-backed cache (survives restarts).
 */
export async function verifyEmailCode(email: string, code: string): Promise<boolean> {
  const entry = await cacheGet<CodeEntry>(`${EMAIL_PREFIX}${email}`);
  if (!entry) {
    return false;
  }
  if (Date.now() > entry.expiresAt) {
    await cacheDel(`${EMAIL_PREFIX}${email}`);
    return false;
  }
  if (entry.code === code) {
    await cacheDel(`${EMAIL_PREFIX}${email}`);
    return true;
  }
  return false;
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
 *
 * Signed with `JWT_REFRESH_SECRET` — a *different* secret than access
 * tokens (`JWT_SECRET`) — rather than reusing the access-token secret. This
 * used to be the same secret with only a `purpose` claim telling temp
 * tokens and access tokens apart, and `authenticateToken` never actually
 * checked that claim: it just verified the signature and trusted any
 * payload with a `userId`. Since the temp token is issued from `/auth/login`
 * before the 2FA code is checked, an attacker who has only the victim's
 * password (enough to receive a temp token) could use it directly as a
 * Bearer access token against every protected endpoint as long as the
 * victim had any other active session — a full 2FA bypass
 * (CODE_REVIEW.md #5). Using a distinct signing secret means a temp token
 * fails signature verification outright if ever presented to
 * `authenticateToken` (which only ever verifies with `JWT_SECRET`), on top
 * of the `type`/`purpose` claim check now enforced there as defense in depth.
 */
export function generate2FATempToken(userId: string): string {
  return jwt.sign(
    { userId, purpose: '2fa_pending' } as Record<string, unknown>,
    env.jwt.refreshSecret,
    { expiresIn: '5m', algorithm: 'HS256' },
  );
}

/**
 * Verify a 2FA temp token and return the userId if valid.
 */
export function verify2FATempToken(token: string): { userId: string } | null {
  try {
    const payload = jwt.verify(token, env.jwt.refreshSecret, { algorithms: ['HS256'] }) as Record<string, unknown>;
    if (payload.purpose !== '2fa_pending' || typeof payload.userId !== 'string') {
      return null;
    }
    return { userId: payload.userId };
  } catch {
    return null;
  }
}
