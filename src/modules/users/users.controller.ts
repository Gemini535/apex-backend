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
import { assertValidRange } from '../../shared/dateRange.js';

/** Upper bound on the `limit` query param for user search — unbounded
 * previously allowed a client to request an arbitrarily large result set
 * in one query (CODE_REVIEW.md #21). */
const MAX_SEARCH_LIMIT = 50;

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

    let limit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : 20;
    if (Number.isNaN(limit) || limit < 1) {
      throw new AppError(`limit must be a positive integer (max ${MAX_SEARCH_LIMIT})`, 400);
    }
    limit = Math.min(limit, MAX_SEARCH_LIMIT);

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

    // Also caps the maximum from/to span — this endpoint used to build a
    // day-by-day array with no upper bound on the range, so a request like
    // `?from=0001-01-01&to=2100-01-01` could force the server to
    // synchronously build an array with hundreds of thousands of entries, a
    // trivial memory/CPU DoS (CODE_REVIEW.md #14).
    assertValidRange(from, to);

    const stats = await getAggregatedStats(req.user!.userId, from, to);
    res.json(stats);
  } catch (err) {
    next(err);
  }
}
