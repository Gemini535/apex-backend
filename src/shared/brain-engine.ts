import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';
import { emitToUser, getOnlineFriends } from './websocket/socket.js';
import { evaluateStreak } from '../modules/users/streak.service.js';
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
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(now);
  dayEnd.setUTCHours(23, 59, 59, 999);

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

  // Upsert brain state for today
  await prisma.brainState.upsert({
    where: { userId_date: { userId, date: dayStart } },
    create: {
      userId,
      date: dayStart,
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

  // Broadcast to user's connected devices
  emitToUser(userId, 'brain:state_update', update);

  // Broadcast to online friends (visible status feature)
  await broadcastToFriends(userId, update);

  logger.debug(
    { userId, tier, healthPercent, totalScreenTime },
    'Brain state recalculated'
  );

  return update;
}

/**
 * Notifies friends about brain state changes (for visible status mode).
 */
async function broadcastToFriends(
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

function calculateTier(totalSeconds: number): BrainTier {
  const hours = totalSeconds / 3600;
  if (hours <= TIER_THRESHOLDS.PRISTINE) return 'PRISTINE';
  if (hours <= TIER_THRESHOLDS.FOG) return 'FOG';
  if (hours <= TIER_THRESHOLDS.SLIME) return 'SLIME';
  return 'GRAY_VOID';
}

function calculateHealth(totalSeconds: number, focusSeconds: number): number {
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
