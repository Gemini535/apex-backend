import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';
import { emitToUser, getOnlineFriends } from './websocket/socket.js';
import { evaluateStreak } from '../modules/users/streak.service.js';
import { appEvents } from './events.js';
import { getUtcDayBoundary, resolveTimezone } from './tz.js';
import type { BrainTier } from '@prisma/client';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BrainStateUpdate {
  userId: string;
  date: string;
  tier: BrainTier;
  healthPercent: number;
  totalScreenTime: number;
  focusTime: number;
  streak: number;
}

// ─── Configuration ───────────────────────────────────────────────────────────

/** Categories that count as "focus" time. */
const FOCUS_CATEGORIES = ['PRODUCTIVITY', 'UTILITIES'];

/** Tier thresholds based on total daily screen time (hours). */
const TIER_THRESHOLDS = {
  PRISTINE: 4,  // up to 4 hours
  FOG: 6,       // 4-6 hours
  SLIME: 8,     // 6-8 hours
  // beyond 8 = GRAY_VOID
};

// ─── Brain State Engine ──────────────────────────────────────────────────────

/**
 * Recalculates brain state for a user based on today's screen time data.
 * Called whenever screen time entries are uploaded.
 */
export async function recalculateBrainState(userId: string): Promise<BrainStateUpdate | null> {
  // Compute the user's local "today" in UTC. A user in America/New_York
  // experiences midnight at 04:00 or 05:00 UTC depending on DST — if we used
  // raw UTC midnight we'd either miss or double-count screen time entries.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });

  const { dayStart, dayEnd } = getUtcDayBoundary(
    resolveTimezone(user?.timezone),
    new Date(),
  );

  // Gather today's screen time entries
  const entries = await prisma.screenTimeEntry.findMany({
    where: {
      userId,
      startedAt: { gte: dayStart, lte: dayEnd },
    },
  });

  const totalScreenTime = entries.reduce((sum, e) => sum + e.duration, 0);
  const focusTime = entries
    .filter((e) => FOCUS_CATEGORIES.includes(e.category))
    .reduce((sum, e) => sum + e.duration, 0);

  const tier = calculateTier(totalScreenTime);
  const healthPercent = calculateHealth(totalScreenTime, focusTime);

  // Persist under UTC midnight so BrainState.date stays consistent across
  // timezones and remains queriable by the canonical UTC day. The DB query
  // above uses the zoned boundaries so the right entries are aggregated.
  const canonicalDayStart = new Date(dayStart);
  canonicalDayStart.setUTCHours(0, 0, 0, 0);

  // Upsert brain state for today
  await prisma.brainState.upsert({
    where: { userId_date: { userId, date: canonicalDayStart } },
    create: {
      userId,
      date: canonicalDayStart,
      tier,
      healthPercent,
      totalScreenTime,
      focusTime,
      categoryBreakdown: buildCategoryBreakdown(entries),
    },
    update: {
      tier,
      healthPercent,
      totalScreenTime,
      focusTime,
      categoryBreakdown: buildCategoryBreakdown(entries),
    },
  });

  // Evaluate streak
  let streak = 0;
  try {
    const streakResult = await evaluateStreak(userId);
    streak = streakResult.currentStreak;
  } catch {
    // Streak not critical — don't fail brain state update
  }

  const update: BrainStateUpdate = {
    userId,
    date: dayStart.toISOString().slice(0, 10),
    tier,
    healthPercent,
    totalScreenTime,
    focusTime,
    streak,
  };

  // Side effects (WebSocket broadcast, streak evaluation, etc.) are driven by
  // listeners registered in src/shared/events.listeners.ts — this engine only
  // needs to emit the event.
  appEvents.emit('brain:updated', update);

  logger.debug(
    { userId, tier, healthPercent, totalScreenTime },
    'Brain state recalculated'
  );

  return update;
}

/**
 * Notifies friends about brain state changes (for visible status mode).
 * Exported so event listeners can call it; not part of the engine's core.
 */
export async function broadcastToFriends(
  userId: string,
  update: BrainStateUpdate
): Promise<void> {
  // Find this user's friends
  const friendships = await prisma.friendship.findMany({
    where: {
      OR: [{ userId }, { friendId: userId }],
    },
    select: { userId: true, friendId: true },
  });

  const friendIds = friendships.map((f) =>
    f.userId === userId ? f.friendId : f.userId
  );

  const onlineFriendIds = getOnlineFriends(friendIds);

  for (const friendId of onlineFriendIds) {
    emitToUser(friendId, 'friend:brain_update', {
      userId,
      tier: update.tier,
      healthPercent: update.healthPercent,
      brainHealth: update.healthPercent, // alias for client compatibility
    });
  }
}

/**
 * Gets the current brain expression for the avatar based on tier.
 */
export function getBrainExpression(tier: BrainTier): {
  expression: string;
  animation: string;
  color: string;
} {
  switch (tier) {
    case 'PRISTINE':
      return {
        expression: 'smile',
        animation: 'bounce',
        color: '#FF69B4', // vibrant pink
      };
    case 'FOG':
      return {
        expression: 'neutral',
        animation: 'slow_bounce',
        color: '#FFB6C1', // dulled pink
      };
    case 'SLIME':
      return {
        expression: 'dizzy',
        animation: 'slime_drip',
        color: '#90EE90', // green zombie spots
      };
    case 'GRAY_VOID':
      return {
        expression: 'dead',
        animation: 'flatline',
        color: '#808080', // monotone grey
      };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function calculateTier(totalSeconds: number): BrainTier {
  const hours = totalSeconds / 3600;
  if (hours <= TIER_THRESHOLDS.PRISTINE) return 'PRISTINE';
  if (hours <= TIER_THRESHOLDS.FOG) return 'FOG';
  if (hours <= TIER_THRESHOLDS.SLIME) return 'SLIME';
  return 'GRAY_VOID';
}

export function calculateHealth(totalSeconds: number, focusSeconds: number): number {
  const hours = totalSeconds / 3600;
  const focusRatio = totalSeconds > 0 ? focusSeconds / totalSeconds : 0;

  if (hours <= TIER_THRESHOLDS.PRISTINE) {
    return Math.min(100, Math.round(70 + focusRatio * 30));
  }
  if (hours <= TIER_THRESHOLDS.FOG) {
    return Math.round(70 - (hours - TIER_THRESHOLDS.PRISTINE) * 15);
  }
  if (hours <= TIER_THRESHOLDS.SLIME) {
    return Math.round(40 - (hours - TIER_THRESHOLDS.FOG) * 10);
  }
  return Math.max(0, Math.round(20 - (hours - TIER_THRESHOLDS.SLIME) * 5));
}

function buildCategoryBreakdown(
  entries: Array<{ category: string; duration: number }>
): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const entry of entries) {
    breakdown[entry.category] = (breakdown[entry.category] ?? 0) + entry.duration;
  }
  return breakdown;
}
