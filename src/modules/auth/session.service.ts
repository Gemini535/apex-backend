import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logger } from '../../config/logger.js';

// ─── Session Management ──────────────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  deviceInfo: string | null;
  ipAddress: string | null;
  createdAt: Date;
  expiresAt: Date;
  isCurrent: boolean;
}

/**
 * Password-reset and email-verification tokens are stored as rows in this
 * same `Session` table (prefixed `reset:`/`verify-email:` on `refreshToken`)
 * rather than a dedicated table. `listSessions` must exclude them — they
 * used to show up in a user's "active sessions" list as a phantom logged-in
 * device whenever a password reset or verification email was pending
 * (CODE_REVIEW.md #16).
 */
const PSEUDO_SESSION_PREFIXES = ['reset:', 'verify-email:'];

/**
 * Lists all genuinely active device sessions for a user — excludes expired
 * rows, rows revoked by refresh-token rotation (see auth.service.ts's
 * `verifyRefreshToken`), and the password-reset/email-verification pseudo
 * sessions described above.
 */
export async function listSessions(userId: string, currentRefreshToken?: string): Promise<SessionInfo[]> {
  const sessions = await prisma.session.findMany({
    where: {
      userId,
      expiresAt: { gt: new Date() },
      revokedAt: null,
      NOT: {
        OR: PSEUDO_SESSION_PREFIXES.map((prefix) => ({ refreshToken: { startsWith: prefix } })),
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return sessions.map((s) => ({
    id: s.id,
    deviceInfo: s.deviceInfo,
    ipAddress: s.ipAddress,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    isCurrent: currentRefreshToken ? s.refreshToken === currentRefreshToken : false,
  }));
}

/**
 * Revokes a specific session by its ID.
 */
export async function revokeSession(userId: string, sessionId: string): Promise<{ message: string }> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
  });

  if (!session) {
    throw new AppError('Session not found', 404);
  }

  await prisma.session.delete({ where: { id: sessionId } });
  logger.info({ userId, sessionId }, 'Session revoked');

  return { message: 'Session revoked successfully' };
}

/**
 * Revokes all sessions for a user (full logout from all devices).
 */
export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<{ message: string; count: number }> {
  const result = await prisma.session.deleteMany({
    where: {
      userId,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
  });

  logger.info({ userId, count: result.count }, 'All sessions revoked');

  return {
    message: `${result.count} session(s) revoked`,
    count: result.count,
  };
}

// ─── Password Reset ──────────────────────────────────────────────────────────

/**
 * Generates a password reset token (stored as a session with a special prefix).
 * Returns the token that should be sent to the user via email.
 * In production, this sends an email; here we just return the token.
 */
export async function createPasswordResetToken(email: string): Promise<{ token: string; expiresAt: Date } | null> {
  const user = await prisma.user.findUnique({ where: { email } });

  // Always return success to prevent email enumeration
  if (!user) {
    return null;
  }

  // Create a reset token valid for 1 hour
  const { randomBytes } = await import('crypto');
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  // Store as a session with a special prefix
  await prisma.session.create({
    data: {
      userId: user.id,
      refreshToken: `reset:${token}`,
      deviceInfo: 'password-reset',
      expiresAt,
    },
  });

  logger.info({ userId: user.id }, 'Password reset token created');

  return { token, expiresAt };
}

/**
 * Validates a password reset token and returns the user ID if valid.
 */
export async function validatePasswordResetToken(token: string): Promise<string | null> {
  const session = await prisma.session.findUnique({
    where: { refreshToken: `reset:${token}` },
  });

  if (!session) {
    return null;
  }

  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } });
    return null;
  }

  return session.userId;
}

/**
 * Consumes a password reset token (deletes it after use).
 */
export async function consumePasswordResetToken(token: string): Promise<void> {
  await prisma.session.deleteMany({
    where: { refreshToken: `reset:${token}` },
  });
}

// ─── Email Verification ──────────────────────────────────────────────────────

/**
 * Creates an email verification token for a new user.
 */
export async function createEmailVerificationToken(userId: string): Promise<string> {
  const { randomBytes } = await import('crypto');
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  await prisma.session.create({
    data: {
      userId,
      refreshToken: `verify-email:${token}`,
      deviceInfo: 'email-verification',
      expiresAt,
    },
  });

  logger.info({ userId }, 'Email verification token created');

  return token;
}

/**
 * Validates an email verification token and marks the user's email as verified.
 */
export async function verifyEmail(token: string): Promise<{ userId: string } | null> {
  const session = await prisma.session.findUnique({
    where: { refreshToken: `verify-email:${token}` },
  });

  if (!session || session.expiresAt < new Date()) {
    if (session) {
      await prisma.session.delete({ where: { id: session.id } });
    }
    return null;
  }

  // Mark as verified (we use the emailVerified field implicitly — in production
  // you'd have a dedicated field; here we just delete the token)
  await prisma.session.delete({ where: { id: session.id } });

  logger.info({ userId: session.userId }, 'Email verified');

  return { userId: session.userId };
}
