import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import { hashPassword } from './auth.service.js';
import {
  listSessions,
  revokeSession,
  revokeAllSessions,
  createPasswordResetToken,
  validatePasswordResetToken,
  consumePasswordResetToken,
  verifyEmail,
} from './session.service.js';
import { getProfile } from '../users/users.service.js';
import {
  createEmailVerificationToken,
} from './session.service.js';

// ─── Session Management ──────────────────────────────────────────────────────

export async function listSessionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const currentRefreshToken = req.body.refreshToken;
    const sessions = await listSessions(userId, currentRefreshToken);
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
}

export async function revokeSessionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { sessionId } = req.body;
    if (!sessionId) throw new AppError('sessionId is required', 400);

    const result = await revokeSession(userId, sessionId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function revokeAllSessionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const currentSessionId = req.body.currentSessionId;
    const result = await revokeAllSessions(userId, currentSessionId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ─── Password Reset ──────────────────────────────────────────────────────────

export async function forgotPasswordHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email } = req.body;
    const result = await createPasswordResetToken(email);

    // Always return 200 to prevent email enumeration
    // In production, the token would be emailed; for dev/testing, return it
    if (result) {
      res.json({
        message: 'If an account with that email exists, a password reset link has been sent.',
        // Only include token in development
        ...(process.env.NODE_ENV === 'development' && { token: result.token }),
      });
    } else {
      res.json({
        message: 'If an account with that email exists, a password reset link has been sent.',
      });
    }
  } catch (err) {
    next(err);
  }
}

export async function resetPasswordHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token, password } = req.body;

    const userId = await validatePasswordResetToken(token);
    if (!userId) {
      throw new AppError('Invalid or expired reset token', 400);
    }

    const passwordHash = await hashPassword(password);

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    // Consume the token
    await consumePasswordResetToken(token);

    // Invalidate all existing sessions for security
    await prisma.session.deleteMany({ where: { userId } });

    res.json({ message: 'Password has been reset successfully. All sessions have been invalidated.' });
  } catch (err) {
    next(err);
  }
}

// ─── Email Verification ─────────────────────────────────────────────────────

export async function sendVerificationEmailHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const token = await createEmailVerificationToken(userId);

    // In production, send email with verification link
    res.json({
      message: 'Verification email sent.',
      ...(process.env.NODE_ENV === 'development' && { token }),
    });
  } catch (err) {
    next(err);
  }
}

export async function verifyEmailHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token } = req.body;
    const result = await verifyEmail(token);

    if (!result) {
      throw new AppError('Invalid or expired verification token', 400);
    }

    const user = await getProfile(result.userId);
    res.json({ message: 'Email verified successfully.', user });
  } catch (err) {
    next(err);
  }
}
