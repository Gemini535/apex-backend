import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';

export interface AuthPayload {
  userId: string;
  email: string;
  username: string;
}

/**
 * Raw shape of a decoded access-token JWT, before we narrow it down to the
 * public `AuthPayload` assigned to `req.user`. `type` and `sid` are checked
 * here but intentionally not part of `AuthPayload` — they're an
 * implementation detail of session binding, not something route handlers
 * should read.
 */
interface AccessTokenClaims {
  userId: string;
  email: string;
  username: string;
  type?: string;
  sid?: string;
}

export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Access token required' });
    return;
  }

  try {
    // Pin the algorithm explicitly rather than trusting whatever the token
    // header claims — defense against algorithm-confusion attacks. Every
    // access token this codebase issues is HS256; nothing else should ever
    // verify.
    const payload = jwt.verify(token, env.jwt.secret, { algorithms: ['HS256'] }) as AccessTokenClaims;

    // Reject anything that isn't a genuine access token. The 2FA temp token
    // (`generate2FATempToken`) is now signed with an entirely different
    // secret (JWT_REFRESH_SECRET) specifically so it can never verify here
    // at all, but we also check `type` as defense in depth in case another
    // short-lived, narrow-purpose token is ever added that reuses this
    // secret (CODE_REVIEW.md #5).
    if (payload.type !== 'access' || !payload.sid) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    // Verify THIS SPECIFIC session — the one this token was minted for — is
    // still active, rather than "does the user have any active session
    // anywhere". The old check meant revoking one device's session (or even
    // "log out everywhere") didn't actually invalidate that device's
    // still-live access token as long as the user had any other session
    // open, which undermined every "this session/all sessions have been
    // invalidated" response message in the auth API (CODE_REVIEW.md #6).
    const session = await prisma.session.findFirst({
      where: {
        id: payload.sid,
        userId: payload.userId,
        expiresAt: { gt: new Date() },
        revokedAt: null,
      },
    });

    if (!session) {
      res.status(401).json({ error: 'Session expired or invalidated' });
      return;
    }

    req.user = {
      userId: payload.userId,
      email: payload.email,
      username: payload.username,
    };
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Token expired' });
      return;
    }
    logger.debug({ err }, 'JWT verification failed');
    res.status(403).json({ error: 'Invalid token' });
  }
}
