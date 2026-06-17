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
    const payload = jwt.verify(token, env.jwt.secret) as AuthPayload;

    // Verify user still exists and session is valid
    const session = await prisma.session.findFirst({
      where: {
        userId: payload.userId,
        expiresAt: { gt: new Date() },
      },
    });

    if (!session) {
      res.status(401).json({ error: 'Session expired or invalidated' });
      return;
    }

    req.user = payload;
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
