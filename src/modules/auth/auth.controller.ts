import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../middleware/errorHandler.js';
import {
  hashPassword,
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  setupTOTP,
  verifyTOTP,
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

function toSafeUser(user: {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  brainHealth: number;
  brainTier: string;
  currentStreak: number;
  createdAt: Date;
  twoFactor?: { totpEnabled: boolean } | null;
}): SafeUser {
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
    requires2FA: user.twoFactor?.totpEnabled ?? false,
  };
}

async function createSession(
  userId: string,
  refreshToken: string,
  req: Request
): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

  await prisma.session.create({
    data: {
      userId,
      refreshToken,
      deviceInfo: req.headers['user-agent'] ?? null,
      ipAddress: req.ip ?? null,
      expiresAt,
    },
  });
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

    const user = await prisma.user.create({
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

    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      username: user.username,
    });
    const refreshToken = generateRefreshToken();
    await createSession(user.id, refreshToken, req);

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

    // Check if 2FA is required
    if (user.twoFactor?.totpEnabled) {
      const tempToken = generate2FATempToken(user.id);
      res.json({
        requires2FA: true,
        tempToken,
      });
      return;
    }

    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      username: user.username,
    });
    const refreshToken = generateRefreshToken();
    await createSession(user.id, refreshToken, req);

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

export async function verify2FALogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { tempToken, code } = req.body as { tempToken: string; code: string };

    const payload = verify2FATempToken(tempToken);
    if (!payload) {
      throw new AppError('Invalid or expired 2FA session', 401);
    }

    const isValid = await verifyTOTP(payload.userId, code);
    if (!isValid) {
      throw new AppError('Invalid 2FA code', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { twoFactor: true },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      username: user.username,
    });
    const refreshToken = generateRefreshToken();
    await createSession(user.id, refreshToken, req);

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

    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      username: user.username,
    });
    const refreshToken = generateRefreshToken();
    await createSession(user.id, refreshToken, req);

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

    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      username: user.username,
    });
    const refreshToken = generateRefreshToken();
    await createSession(user.id, refreshToken, req);

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

    // Rotate: delete old session, create new one
    await prisma.session.delete({
      where: { refreshToken },
    });

    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      username: user.username,
    });
    const newRefreshToken = generateRefreshToken();
    await createSession(user.id, newRefreshToken, req);

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

    const isValid = verifySMSCode(twoFactor.smsPhoneNumber, code);
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

    const isValid = verifyEmailCode(email, code);
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
    const { userId } = req.user!;
    const { code } = req.body as { code: string };

    // Verify current 2FA code before disabling
    const isValid = await verifyTOTP(userId, code);
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
