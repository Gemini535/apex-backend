/**
 * Brain state cache.
 *
 * Key: `brain:<userId>:<YYYY-MM-DD>` (one entry per user per calendar day).
 * Value: the prisma-shaped `BrainState` record.
 *
 * Write path: `recalculateBrainState` (called by the brain-recalc queue job)
 * updates the DB + writes through to this cache, so subsequent reads are O(1).
 *
 * Read path: `getBrainState` in users.service reads from cache first.
 *
 * The cache is invalidated by the queue handler after it finishes recalculating
 * and committing the DB upsert — see src/shared/queue/handlers.ts.
 */

import { CacheStore } from './store.js';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import type { BrainState } from '@prisma/client';

const PREFIX = 'brain';
const TTL_MS = Number(process.env.CACHE_TTL_BRAIN_STATE_MS ?? 5 * 60 * 1000);

const cache = new CacheStore<BrainState>({ ttlMs: TTL_MS });

if (process.env.CACHE_ENABLED === 'false') {
  cache.disable();
}

function makeKey(userId: string, date: Date): string {
  const day = date.toISOString().slice(0, 10);
  return `${PREFIX}:${userId}:${day}`;
}

export interface BrainStateLike {
  id: string;
  userId: string;
  date: Date;
  tier: string;
  healthPercent: number;
  totalScreenTime: number;
  focusTime: number;
  categoryBreakdown: unknown;
}

/** Write-through: persist to DB and update the cache. Called by the queue
 *  handler. Returns the upserted row. */
export async function setBrainState(
  userId: string,
  data: {
    tier: BrainState['tier'];
    healthPercent: number;
    totalScreenTime: number;
    focusTime: number;
    categoryBreakdown: Record<string, number> | null;
  },
  date: Date = new Date(),
): Promise<BrainState> {
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);

  const row = await prisma.brainState.upsert({
    where: { userId_date: { userId, date: dayStart } },
    create: {
      userId,
      date: dayStart,
      tier: data.tier,
      healthPercent: data.healthPercent,
      totalScreenTime: data.totalScreenTime,
      focusTime: data.focusTime,
      categoryBreakdown: (data.categoryBreakdown ?? undefined) as never,
    },
    update: {
      tier: data.tier,
      healthPercent: data.healthPercent,
      totalScreenTime: data.totalScreenTime,
      focusTime: data.focusTime,
      categoryBreakdown: (data.categoryBreakdown ?? undefined) as never,
    },
  });

  cache.set(makeKey(userId, dayStart), row);
  return row;
}

/** Read-through: return cached brain state if warm, otherwise undefined.
 *  Caller falls back to its own DB lookup and should not write-through (the
 *  queue handler owns write-through). */
export function getCachedBrainState(userId: string, date: Date = new Date()): BrainState | undefined {
  return cache.get(makeKey(userId, date));
}

/** @deprecated Use getCachedBrainState instead. */
export const getBrainState = getCachedBrainState;

/** Drops one day's cache entry for a user. */
export function invalidateBrainState(userId: string, date: Date = new Date()): void {
  cache.del(makeKey(userId, date));
}

/** Drops every day for a user. */
export function invalidateAllBrainState(userId: string): void {
  cache.delByPrefix(`${PREFIX}:${userId}:`);
}

export function clearBrainStateCache(): void {
  cache.clear();
}

export { cache as brainStateCache };
