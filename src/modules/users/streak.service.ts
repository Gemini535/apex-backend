import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import type { BrainTier } from '@prisma/client';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StreakResult {
  currentStreak: number;
  longestStreak: number;
  todayStatus: 'active' | 'broken' | 'pending';
  lastActiveDate: string | null;
  message: string;
}

// ─── Configuration ───────────────────────────────────────────────────────────

/** Tiers that preserve the streak. SLIME and GRAY_VOID break it. */
const STREAK_PRESERVING_TIERS: BrainTier[] = ['PRISTINE', 'FOG'];

/** Minimum focus seconds required to count as an "active" day (default 2 hours). */
const DEFAULT_FOCUS_TARGET_SECONDS = 2 * 60 * 60;

// ─── Core Streak Logic ───────────────────────────────────────────────────────

/**
 * Evaluates a user's streak status based on their brain state history.
 */
export async function evaluateStreak(userId: string): Promise<StreakResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currentStreak: true, longestStreak: true },
  });

  if (!user) {
    throw Object.assign(new Error('User not found'), { statusCode: 404 });
  }

  // Get brain states for the last 30 days, ordered most-recent first
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
  thirtyDaysAgo.setUTCHours(0, 0, 0, 0);

  const brainStates = await prisma.brainState.findMany({
    where: { userId, date: { gte: thirtyDaysAgo } },
    orderBy: { date: 'desc' },
  });

  if (brainStates.length === 0) {
    return {
      currentStreak: 0,
      longestStreak: user.longestStreak,
      todayStatus: 'pending',
      lastActiveDate: null,
      message: 'No activity data yet. Start tracking to build your streak!',
    };
  }

  let currentStreak = 0;
  let lastActiveDate: string | null = null;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayKey = today.toISOString().slice(0, 10);

  const todayState = brainStates.find(
    (s) => s.date.toISOString().slice(0, 10) === todayKey,
  );

  let todayStatus: 'active' | 'broken' | 'pending' = 'pending';

  if (todayState && STREAK_PRESERVING_TIERS.includes(todayState.tier)) {
    todayStatus = 'active';
    currentStreak = 1;
    lastActiveDate = todayKey;
  } else if (todayState && !STREAK_PRESERVING_TIERS.includes(todayState.tier)) {
    todayStatus = 'broken';
  } else {
    // No data for today yet — check if yesterday was active
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayKey = yesterday.toISOString().slice(0, 10);
    const yesterdayState = brainStates.find(
      (s) => s.date.toISOString().slice(0, 10) === yesterdayKey,
    );
    if (!yesterdayState || !STREAK_PRESERVING_TIERS.includes(yesterdayState.tier)) {
      return {
        currentStreak: user.currentStreak,
        longestStreak: user.longestStreak,
        todayStatus: 'pending',
        lastActiveDate: yesterdayState?.date.toISOString().slice(0, 10) ?? null,
        message: 'Complete your daily focus target to maintain your streak!',
      };
    }
    currentStreak = 1;
    lastActiveDate = yesterdayKey;
  }

  // Walk backwards from yesterday to count consecutive active days
  const checkDate = new Date(today);
  checkDate.setUTCDate(checkDate.getUTCDate() - 1);

  for (let i = 1; i < 30; i++) {
    const checkKey = checkDate.toISOString().slice(0, 10);
    const state = brainStates.find(
      (s) => s.date.toISOString().slice(0, 10) === checkKey,
    );

    if (state && STREAK_PRESERVING_TIERS.includes(state.tier)) {
      currentStreak++;
      if (!lastActiveDate) {
        lastActiveDate = checkKey;
      }
      checkDate.setUTCDate(checkDate.getUTCDate() - 1);
    } else {
      break;
    }
  }

  const longestStreak = Math.max(user.longestStreak, currentStreak);

  await prisma.user.update({
    where: { id: userId },
    data: { currentStreak, longestStreak },
  });

  const message = buildStreakMessage(currentStreak, todayStatus);

  return { currentStreak, longestStreak, todayStatus, lastActiveDate, message };
}

/**
 * Records daily activity for streak tracking.
 */
export async function recordDailyActivity(
  userId: string,
  date: Date,
  focusSeconds: number,
  tier: BrainTier,
): Promise<{ streakMaintained: boolean; currentStreak: number }> {
  const isStreakDay =
    STREAK_PRESERVING_TIERS.includes(tier) &&
    focusSeconds >= DEFAULT_FOCUS_TARGET_SECONDS;

  const dateUtc = new Date(date);
  dateUtc.setUTCHours(0, 0, 0, 0);

  await prisma.brainState.upsert({
    where: { userId_date: { userId, date: dateUtc } },
    create: {
      userId,
      date: dateUtc,
      tier,
      healthPercent: calculateHealthPercent(focusSeconds),
      totalScreenTime: focusSeconds,
      focusTime: focusSeconds,
    },
    update: {
      tier,
      healthPercent: calculateHealthPercent(focusSeconds),
      focusTime: focusSeconds,
    },
  });

  if (!isStreakDay) {
    return { streakMaintained: false, currentStreak: 0 };
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { currentStreak: { increment: 1 } },
    select: { currentStreak: true, longestStreak: true },
  });

  const longestStreak = Math.max(user.longestStreak, user.currentStreak);
  await prisma.user.update({
    where: { id: userId },
    data: { longestStreak },
  });

  logger.info(
    { userId, currentStreak: user.currentStreak, longestStreak },
    'Streak updated',
  );

  return { streakMaintained: true, currentStreak: user.currentStreak };
}

/**
 * Resets a user's streak to 0.
 */
export async function resetStreak(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { currentStreak: 0 },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calculateHealthPercent(focusSeconds: number): number {
  const hours = focusSeconds / 3600;
  if (hours >= 4) return 100;
  if (hours >= 2) return Math.round(50 + (hours - 2) * 25);
  return Math.round(hours * 25);
}

function buildStreakMessage(currentStreak: number, todayStatus: string): string {
  if (currentStreak === 0) {
    return 'Start a new streak today! Stay within your screen time limits.';
  }
  if (currentStreak === 1) {
    return 'Great start! Keep it up tomorrow to build your streak.';
  }
  if (currentStreak < 7) {
    return `${currentStreak} day streak! Keep going to hit a full week!`;
  }
  if (currentStreak < 30) {
    return `🔥 ${currentStreak} day streak! You're on fire!`;
  }
  return `🔥 Incredible ${currentStreak} day streak! You're a focus master!`;
}
