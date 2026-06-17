import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler.js';
import {
  getProfile,
  updateProfile,
  searchUsers,
  getBrainState,
  getAggregatedStats,
  getPublicProfile,
} from './users.service.js';

export async function getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await getProfile(req.user!.userId);
    res.json(user);
  } catch (err) {
    next(err);
  }
}

export async function updateMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { displayName, bio, avatarUrl, timezone } = req.body as {
      displayName?: string;
      bio?: string;
      avatarUrl?: string;
      timezone?: string;
    };
    const user = await updateProfile(req.user!.userId, { displayName, bio, avatarUrl, timezone });
    res.json(user);
  } catch (err) {
    next(err);
  }
}

export async function getUserByUsername(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { username } = req.params;
    if (!username) throw new AppError('Username is required', 400);
    const user = await getPublicProfile(username);
    res.json(user);
  } catch (err) {
    next(err);
  }
}

export async function searchUsersHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query.q as string | undefined;
    if (!query || query.trim().length === 0) throw new AppError('Query parameter "q" is required', 400);
    const limit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : 20;
    const users = await searchUsers(query.trim(), req.user!.userId, limit);
    res.json(users);
  } catch (err) {
    next(err);
  }
}

export async function getMyBrainState(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const brainState = await getBrainState(req.user!.userId);
    res.json(brainState);
  } catch (err) {
    next(err);
  }
}

export async function getMyStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const now = new Date();
    const defaultFrom = new Date(now);
    defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 6);
    defaultFrom.setUTCHours(0, 0, 0, 0);

    const from = req.query.from ? new Date(req.query.from as string) : defaultFrom;
    const to = req.query.to ? new Date(req.query.to as string) : now;

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new AppError('Invalid date format. Use ISO 8601 (YYYY-MM-DD).', 400);
    }
    if (from > to) throw new AppError('"from" date must be before "to" date.', 400);

    const stats = await getAggregatedStats(req.user!.userId, from, to);
    res.json(stats);
  } catch (err) {
    next(err);
  }
}
