import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../middleware/errorHandler.js';
import type { Session } from '@prisma/client';
import {
  hashPassword,
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  setupTOTP,
  verifyTOTP,
  verifyBackupCode,
  sendSMSCode,
  sendEmailCode,
  verifySMSCode,
  verifyEmailCode,
  verifyAppleToken,
  verifyGoogleToken,
  generate2FATempToken,
  verify2FATempToken,
} from './auth.service.js';
import type { SafeUser } from '../../shared/types/auth.types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface UserWithTwoFactor {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  brainHealth: number;
  brainTier: string;
  currentStreak: number;
  createdAt: Date;
  twoFactor?: { totpEnabled: boolean; smsEnabled: boolean; emailEnabled: boolean } | null;
}

function toSafeUser(user: UserWithTwoFactor): SafeUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    brainHealth: user.brainHealth,
    brainTier: user.brainTier,
    currentStreak: user.currentStreak,
    createdAt: user.createdAt,
    requires2FA: is2FAEnabled(user.twoFactor),
  };
}

/** True if ANY 2FA method — TOTP, SMS, or email — is enabled for the user. */
function is2FAEnabled(twoFactor: UserWithTwoFactor['twoFactor']): boolean {
  return Boolean(twoFactor?.totpEnabled || twoFactor?.smsEnabled || twoFactor?.emailEnabled);
}

async function createSession(
  userId: string,
  refreshToken: string,
  req: Request
): Promise<Session> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

  return prisma.session.create({
    data: {
      userId,
      refreshToken,
      deviceInfo: req.headers['user-agent'] ?? null,
      ipAddress: req.ip ?? null,
      expiresAt,
    },
  });
}

/**
 * Creates a session and mints an access token bound to it in one step —
 * every login-shaped flow (register, login, 2FA login, OAuth, refresh) needs
 * exactly this pair, in this order, so the access token can carry the new
 * session's id (see generateAccessToken's docstring / CODE_REVIEW.md #6).
 */
async function issueTokens(
  user: { id: string; email: string; username: string },
  req: Request,
): Promise<{ accessToken: string; refreshToken: string }> {
  const refreshToken = generateRefreshToken();
  const session = await createSession(user.id, refreshToken, req);
  const accessToken = generateAccessToken(
    { userId: user.id, email: user.email, username: user.username },
    session.id,
  );
  return { accessToken, refreshToken };
}

/**
 * Verifies a 2FA code against whichever method is actually enabled for the
 * user, trying TOTP first (falling back to a one-time backup code), then
 * SMS, then email. Shared by `verify2FALogin` and `disable2FA` so both
 * endpoints work correctly regardless of which method the user set up —
 * previously both call sites hard-coded `verifyTOTP`, which meant SMS/Email
 * -only users were never actually challenged at login (CODE_REVIEW.md #4)
 * and could never disable their own 2FA (CODE_REVIEW.md #15).
 */
async function verifyAnyEnabled2FA(
  userId: string,
  email: string,
  code: string,
  twoFactor: { totpEnabled: boolean; smsEnabled: boolean; smsPhoneNumber: string | null; emailEnabled: boolean } | null,
): Promise<boolean> {
  if (!twoFactor) return false;

  if (twoFactor.totpEnabled) {
    return (await verifyTOTP(userId, code)) || (await verifyBackupCode(userId, code));
  }
  if (twoFactor.smsEnabled && twoFactor.smsPhoneNumber) {
    return verifySMSCode(twoFactor.smsPhoneNumber, code);
  }
  if (twoFactor.emailEnabled) {
    return verifyEmailCode(email, code);
  }
  return false;
}

// ─── Controllers ──────────────────────────────────────────────────────────────

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, username, password } = req.body as {
      email: string;
      username: string;
      password: string;
    };

    // Check for existing user
    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });

    if (existingUser) {
      if (existingUser.email === email) {
        throw new AppError('An account with this email already exists', 409);
      }
      throw new AppError('This username is already taken', 409);
    }

    const passwordHash = await hashPassword(password);

    let user;
    try {
      user = await prisma.user.create({
        data: {
          email,
          username,
          passwordHash,
          tokenWallet: {
            create: { balance: 0 },
          },
          twoFactor: {
            create: {},
          },
        },
        include: { twoFactor: true },
      });
    } catch (err) {
      // A concurrent request could win the race between our pre-check above
      // and this insert; the unique constraint on email/username is the
      // real guard. Surface that as a clean 409 instead of a raw 500.
      if (isUniqueConstraintError(err)) {
        throw new AppError('An account with this email or username already exists', 409);
      }
      throw err;
    }

    const { accessToken, refreshToken } = await issueTokens(user, req);

    logger.info({ userId: user.id }, 'User registered successfully');

    res.status(201).json({
      accessToken,
      refreshToken,
      user: toSafeUser(user),
    });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password } = req.body as { email: string; password: string };

    const user = await prisma.user.findUnique({
      where: { email },
      include: { twoFactor: true },
    });

    if (!user || !user.passwordHash) {
      throw new AppError('Invalid email or password', 401);
    }

    const isPasswordValid = await comparePassword(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new AppError('Invalid email or password', 401);
    }

    // Require the 2FA challenge if ANY method is enabled — not just TOTP.
    // Previously this only checked `totpEnabled`, so a user who enabled
    // SMS-only or Email-only 2FA was never actually challenged for it at
    // login; password alone was sufficient (CODE_REVIEW.md #4).
    if (is2FAEnabled(user.twoFactor)) {
      const tempToken = generate2FATempToken(user.id);
      res.json({
        requires2FA: true,
        tempToken,
      });
      return;
    }

    const { accessToken, refreshToken } = await issueTokens(user, req);

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    logger.info({ userId: user.id }, 'User logged in successfully');

    res.json({
      accessToken,
      refreshToken,
      user: toSafeUser(user),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * For SMS/Email 2FA, the client must request a code be sent before it can
 * submit one to `/auth/login/2fa`. TOTP needs no such step (the code comes
 * from the user's authenticator app), so this simply reports that.
 */
export async function send2FALoginCode(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { tempToken } = req.body as { tempToken: string };

    const payload = verify2FATempToken(tempToken);
    if (!payload) {
      throw new AppError('Invalid or expired 2FA session', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { twoFactor: true },
    });
    if (!user || !user.twoFactor) {
      throw new AppError('User not found', 404);
    }

    if (user.twoFactor.totpEnabled) {
      res.json({ method: 'totp' });
      return;
    }
    if (user.twoFactor.smsEnabled && user.twoFactor.smsPhoneNumber) {
      const code = await sendSMSCode(user.twoFactor.smsPhoneNumber);
      res.json({
        method: 'sms',
        message: 'Verification code sent to your phone',
        ...(process.env.NODE_ENV === 'development' && { code }),
      });
      return;
    }
    if (user.twoFactor.emailEnabled) {
      const code = await sendEmailCode(user.email);
      res.json({
        method: 'email',
        message: 'Verification code sent to your email',
        ...(process.env.NODE_ENV === 'development' && { code }),
      });
      return;
    }

    throw new AppError('No 2FA method is enabled for this account', 400);
  } catch (err) {
    next(err);
  }
}

export async function verify2FALogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { tempToken, code } = req.body as { tempToken: string; code: string };

    const payload = verify2FATempToken(tempToken);
    if (!payload) {
      throw new AppError('Invalid or expired 2FA session', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { twoFactor: true },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const isValid = await verifyAnyEnabled2FA(user.id, user.email, code, user.twoFactor);
    if (!isValid) {
      throw new AppError('Invalid 2FA code', 401);
    }

    const { accessToken, refreshToken } = await issueTokens(user, req);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    logger.info({ userId: user.id }, 'User completed 2FA login');

    res.json({
      accessToken,
      refreshToken,
      user: toSafeUser(user),
    });
  } catch (err) {
    next(err);
  }
}

export async function appleAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token } = req.body as { token: string };

    const { appleId, email } = await verifyAppleToken(token);

    let user = await prisma.user.findUnique({
      where: { appleId },
      include: { twoFactor: true },
    });

    if (!user) {
      // Try to find by email and link
      if (email) {
        user = await prisma.user.findUnique({
          where: { email },
          include: { twoFactor: true },
        });

        if (user) {
          // Link Apple ID to existing account
          user = await prisma.user.update({
            where: { id: user.id },
            data: { appleId },
            include: { twoFactor: true },
          });
        }
      }

      if (!user) {
        // Create new user
        const username = `user_${appleId.slice(0, 8)}`;
        user = await prisma.user.create({
          data: {
            email: email || `${appleId}@apple.oauth`,
            username,
            appleId,
            tokenWallet: {
              create: { balance: 0 },
            },
            twoFactor: {
              create: {},
            },
          },
          include: { twoFactor: true },
        });
      }
    }

    const { accessToken, refreshToken } = await issueTokens(user, req);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    logger.info({ userId: user.id }, 'Apple OAuth login successful');

    res.json({
      accessToken,
      refreshToken,
      user: toSafeUser(user),
    });
  } catch (err) {
    next(err);
  }
}

export async function googleAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token } = req.body as { token: string };

    const { googleId, email } = await verifyGoogleToken(token);

    let user = await prisma.user.findUnique({
      where: { googleId },
      include: { twoFactor: true },
    });

    if (!user) {
      // Try to find by email and link
      if (email) {
        user = await prisma.user.findUnique({
          where: { email },
          include: { twoFactor: true },
        });

        if (user) {
          // Link Google ID to existing account
          user = await prisma.user.update({
            where: { id: user.id },
            data: { googleId },
            include: { twoFactor: true },
          });
        }
      }

      if (!user) {
        // Create new user
        const username = `user_${googleId.slice(0, 8)}`;
        user = await prisma.user.create({
          data: {
            email: email || `${googleId}@google.oauth`,
            username,
            googleId,
            tokenWallet: {
              create: { balance: 0 },
            },
            twoFactor: {
              create: {},
            },
          },
          include: { twoFactor: true },
        });
      }
    }

    const { accessToken, refreshToken } = await issueTokens(user, req);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    logger.info({ userId: user.id }, 'Google OAuth login successful');

    res.json({
      accessToken,
      refreshToken,
      user: toSafeUser(user),
    });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { refreshToken } = req.body as { refreshToken: string };

    const result = await verifyRefreshToken(refreshToken);
    if (!result) {
      throw new AppError('Invalid or expired refresh token', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: result.userId },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const newRefreshToken = generateRefreshToken();
    const newSession = await createSession(user.id, newRefreshToken, req);

    // Rotate: mark the old session as revoked (rather than deleting it
    // outright) so a later replay of this exact refresh token is
    // detectable as reuse — see `verifyRefreshToken`'s docstring and
    // CODE_REVIEW.md #25.
    await prisma.session.update({
      where: { id: result.sessionId },
      data: { revokedAt: new Date(), replacedById: newSession.id },
    });

    const accessToken = generateAccessToken(
      { userId: user.id, email: user.email, username: user.username },
      newSession.id,
    );

    res.json({
      accessToken,
      refreshToken: newRefreshToken,
    });
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { refreshToken } = req.body as { refreshToken?: string };

    if (refreshToken) {
      // Delete specific session
      await prisma.session.deleteMany({
        where: { refreshToken, userId },
      });
      logger.info({ userId }, 'User logged out, session removed');
    } else {
      // Delete all sessions for this user (full logout)
      await prisma.session.deleteMany({
        where: { userId },
      });
      logger.info({ userId }, 'User logged out from all sessions');
    }

    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

export async function setup2FATotp(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId } = req.user!;

    const { secret, qrCodeDataUrl, backupCodes } = await setupTOTP(userId);

    logger.info({ userId }, 'TOTP setup initiated');

    res.json({
      secret,
      qrCodeDataUrl,
      backupCodes,
    });
  } catch (err) {
    next(err);
  }
}

export async function verifyAndEnable2FATotp(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId } = req.user!;
    const { code } = req.body as { code: string };

    const isValid = await verifyTOTP(userId, code);
    if (!isValid) {
      throw new AppError('Invalid TOTP code', 400);
    }

    await prisma.twoFactorSetting.update({
      where: { userId },
      data: { totpEnabled: true },
    });

    logger.info({ userId }, 'TOTP 2FA enabled');

    res.json({ message: 'TOTP 2FA enabled successfully' });
  } catch (err) {
    next(err);
  }
}

export async function setup2FASMS(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId } = req.user!;
    const { phoneNumber } = req.body as { phoneNumber: string };

    await sendSMSCode(phoneNumber);

    // Store phone number temporarily (not yet enabled)
    await prisma.twoFactorSetting.update({
      where: { userId },
      data: { smsPhoneNumber: phoneNumber },
    });

    logger.info({ userId }, 'SMS 2FA setup code sent');

    res.json({ message: 'Verification code sent to your phone' });
  } catch (err) {
    next(err);
  }
}

export async function verifyAndEnable2FASMS(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId } = req.user!;
    const { code } = req.body as { code: string };

    const twoFactor = await prisma.twoFactorSetting.findUnique({
      where: { userId },
    });

    if (!twoFactor?.smsPhoneNumber) {
      throw new AppError('No phone number set up for SMS 2FA', 400);
    }

    const isValid = await verifySMSCode(twoFactor.smsPhoneNumber, code);
    if (!isValid) {
      throw new AppError('Invalid or expired SMS code', 400);
    }

    await prisma.twoFactorSetting.update({
      where: { userId },
      data: { smsEnabled: true },
    });

    logger.info({ userId }, 'SMS 2FA enabled');

    res.json({ message: 'SMS 2FA enabled successfully' });
  } catch (err) {
    next(err);
  }
}

export async function setup2FAEmail(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { email } = req.user!;

    await sendEmailCode(email);

    logger.info({ email }, 'Email 2FA setup code sent');

    res.json({ message: 'Verification code sent to your email' });
  } catch (err) {
    next(err);
  }
}

export async function verifyAndEnable2FAEmail(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { email } = req.user!;
    const { code } = req.body as { code: string };

    const isValid = await verifyEmailCode(email, code);
    if (!isValid) {
      throw new AppError('Invalid or expired email code', 400);
    }

    await prisma.twoFactorSetting.update({
      where: { userId: req.user!.userId },
      data: { emailEnabled: true },
    });

    logger.info({ userId: req.user!.userId }, 'Email 2FA enabled');

    res.json({ message: 'Email 2FA enabled successfully' });
  } catch (err) {
    next(err);
  }
}

export async function disable2FA(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, email } = req.user!;
    const { code } = req.body as { code: string };

    const twoFactor = await prisma.twoFactorSetting.findUnique({ where: { userId } });
    if (!is2FAEnabled(twoFactor)) {
      throw new AppError('2FA is not enabled for this account', 400);
    }

    // Verify against whichever method is actually enabled — this used to
    // hard-code a TOTP check, so a user who only ever enabled SMS or Email
    // 2FA (and therefore has no `totpSecret`) could never disable their own
    // 2FA at all (CODE_REVIEW.md #15).
    const isValid = await verifyAnyEnabled2FA(userId, email, code, twoFactor);
    if (!isValid) {
      throw new AppError('Invalid 2FA code', 400);
    }

    await prisma.twoFactorSetting.update({
      where: { userId },
      data: {
        totpEnabled: false,
        totpSecret: null,
        smsEnabled: false,
        smsPhoneNumber: null,
        emailEnabled: false,
        backupCodes: [],
      },
    });

    // Invalidate all existing sessions for security
    await prisma.session.deleteMany({
      where: { userId },
    });

    logger.info({ userId }, 'All 2FA methods disabled');

    res.json({ message: '2FA has been disabled. All sessions have been invalidated.' });
  } catch (err) {
    next(err);
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/** True if `err` is a Prisma unique-constraint violation (P2002). */
function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
