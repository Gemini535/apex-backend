import { prisma } from '../../config/database.js';
import type { AppCategory, BrainTier } from '@prisma/client';
import { calculateTier, calculateHealth } from '../../shared/brain-engine.js';
import { logger } from '../../config/logger.js';
import { enqueue } from '../../shared/queue/boss.js';
import { JOBS } from '../../shared/queue/jobs.js';
import { getUtcDayBoundary, resolveTimezone } from '../../shared/tz.js';
import { appEvents } from '../../shared/events.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ScreenTimeEntryInput {
  appName: string;
  appBundleId?: string;
  category: AppCategory;
  duration: number;
  startedAt: Date;
  endedAt?: Date;
  isBlacklisted?: boolean;
}

interface CategoryBreakdown {
  category: string;
  seconds: number;
  percentage: number;
}

interface AppBreakdown {
  appName: string;
  category: string;
  seconds: number;
  percentage: number;
}

interface TodaySummary {
  totalSeconds: number;
  focusSeconds: number;
  brainHealth: number;
  brainTier: BrainTier;
  categories: CategoryBreakdown[];
  topApps: AppBreakdown[];
}

interface DailySummary {
  date: string;
  totalSeconds: number;
  focusSeconds: number;
  brainHealth: number;
  brainTier: BrainTier;
  categories: CategoryBreakdown[];
}

interface AppsBreakdownItem {
  appName: string;
  category: AppCategory;
  seconds: number;
  percentage: number;
}

interface CategoriesBreakdownItem {
  category: AppCategory;
  seconds: number;
  percentage: number;
}

interface ActiveSession {
  appName: string;
  category: AppCategory;
  startedAt: Date;
  durationSoFar: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FOCUS_CATEGORIES: AppCategory[] = ['PRODUCTIVITY', 'UTILITIES'];

function buildCategoryBreakdown(
  entries: Array<{ category: AppCategory; duration: number }>,
  totalSeconds: number
): CategoryBreakdown[] {
  const map = new Map<string, number>();
  for (const entry of entries) {
    const current = map.get(entry.category) ?? 0;
    map.set(entry.category, current + entry.duration);
  }
  const breakdown: CategoryBreakdown[] = [];
  for (const [category, seconds] of map.entries()) {
    breakdown.push({
      category,
      seconds,
      percentage: totalSeconds > 0 ? Math.round((seconds / totalSeconds) * 10000) / 100 : 0,
    });
  }
  return breakdown.sort((a, b) => b.seconds - a.seconds);
}

function getStartOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getEndOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

// ─── Service Functions ───────────────────────────────────────────────────────

export async function uploadBatch(
  userId: string,
  entries: Array<ScreenTimeEntryInput>
): Promise<{ count: number }> {
  const data = entries.map((entry) => ({
    userId,
    appName: entry.appName,
    appBundleId: entry.appBundleId ?? null,
    category: entry.category,
    duration: entry.duration,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt ?? null,
    isBlacklisted: entry.isBlacklisted ?? false,
  }));

  const result = await prisma.screenTimeEntry.createMany({ data });

  // Recalculate brain state after new data (fire and forget via queue)
  await enqueue(JOBS.BRAIN_RECALC, { userId });

  // Detect threshold breach: if the new entries push the user into SLIME or
  // GRAY_VOID, emit a threshold event so push notifications fire.
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const { dayStart, dayEnd } = getUtcDayBoundary(
      resolveTimezone(user?.timezone),
      new Date(),
    );
    const todaysEntries = await prisma.screenTimeEntry.findMany({
      where: { userId, startedAt: { gte: dayStart, lte: dayEnd } },
    });
    const totalSeconds = todaysEntries.reduce((sum, e) => sum + e.duration, 0);
    const tier = calculateTier(totalSeconds);

    // Threshold = SLIME or worse. PRISTINE and FOG are "healthy" tiers.
    if (tier === 'SLIME' || tier === 'GRAY_VOID') {
      // Find the most-used category for context.
      const categoryMap = new Map<string, number>();
      for (const e of todaysEntries) {
        categoryMap.set(e.category, (categoryMap.get(e.category) ?? 0) + e.duration);
      }
      const topCategory = [...categoryMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'UNKNOWN';

      appEvents.emit('screentime:threshold', {
        userId,
        tier,
        category: topCategory,
        percentUsed: Math.min(100, Math.round((totalSeconds / (8 * 3600)) * 100)),
      });
    }
  } catch (err) {
    // Threshold detection must never break the upload response.
    logger.error({ err, userId }, 'Threshold detection failed');
  }

  return { count: result.count };
}

export async function getTodaySummary(userId: string): Promise<TodaySummary> {
  // Compute the user's local today in UTC. A user in Tokyo aggregating "now"
  // (which was yesterday in UTC) needs to see their last Tokyo-day entries,
  // not the UTC-day entries falling outside it.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const { dayStart, dayEnd } = getUtcDayBoundary(
    resolveTimezone(user?.timezone),
    new Date(),
  );

  const entries = await prisma.screenTimeEntry.findMany({
    where: {
      userId,
      startedAt: { gte: dayStart, lte: dayEnd },
    },
  });

  const totalSeconds = entries.reduce((sum, e) => sum + e.duration, 0);
  const focusSeconds = entries
    .filter((e) => FOCUS_CATEGORIES.includes(e.category))
    .reduce((sum, e) => sum + e.duration, 0);

  const brainTier = calculateTier(totalSeconds);
  const brainHealth = calculateHealth(totalSeconds, focusSeconds);

  const categories = buildCategoryBreakdown(entries, totalSeconds);

  // Top 5 apps
  const appMap = new Map<string, { category: AppCategory; seconds: number }>();
  for (const entry of entries) {
    const existing = appMap.get(entry.appName);
    if (existing) {
      existing.seconds += entry.duration;
    } else {
      appMap.set(entry.appName, { category: entry.category, seconds: entry.duration });
    }
  }
  const topApps: AppBreakdown[] = [...appMap.entries()]
    .map(([appName, data]) => ({
      appName,
      category: data.category,
      seconds: data.seconds,
      percentage: totalSeconds > 0 ? Math.round((data.seconds / totalSeconds) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 5);

  return {
    totalSeconds,
    focusSeconds,
    brainHealth,
    brainTier,
    categories,
    topApps,
  };
}

export async function getRangeData(
  userId: string,
  from: Date,
  to: Date
): Promise<DailySummary[]> {
  const entries = await prisma.screenTimeEntry.findMany({
    where: {
      userId,
      startedAt: { gte: from, lte: to },
    },
    orderBy: { startedAt: 'asc' },
  });

  // Group entries by day
  const dayMap = new Map<string, typeof entries>();
  for (const entry of entries) {
    const dayKey = entry.startedAt.toISOString().slice(0, 10);
    const existing = dayMap.get(dayKey);
    if (existing) {
      existing.push(entry);
    } else {
      dayMap.set(dayKey, [entry]);
    }
  }

  const summaries: DailySummary[] = [];
  for (const [date, dayEntries] of dayMap.entries()) {
    const totalSeconds = dayEntries.reduce((sum, e) => sum + e.duration, 0);
    const focusSeconds = dayEntries
      .filter((e) => FOCUS_CATEGORIES.includes(e.category))
      .reduce((sum, e) => sum + e.duration, 0);
    const brainTier = calculateTier(totalSeconds);
    const brainHealth = calculateHealth(totalSeconds, focusSeconds);
    const categories = buildCategoryBreakdown(dayEntries, totalSeconds);

    summaries.push({
      date,
      totalSeconds,
      focusSeconds,
      brainHealth,
      brainTier,
      categories,
    });
  }

  return summaries.sort((a, b) => a.date.localeCompare(b.date));
}

export async function getAppsBreakdown(
  userId: string,
  from: Date,
  to: Date
): Promise<AppsBreakdownItem[]> {
  const entries = await prisma.screenTimeEntry.findMany({
    where: {
      userId,
      startedAt: { gte: from, lte: to },
    },
  });

  const totalSeconds = entries.reduce((sum, e) => sum + e.duration, 0);

  const appMap = new Map<string, { category: AppCategory; seconds: number }>();
  for (const entry of entries) {
    const existing = appMap.get(entry.appName);
    if (existing) {
      existing.seconds += entry.duration;
    } else {
      appMap.set(entry.appName, { category: entry.category, seconds: entry.duration });
    }
  }

  const breakdown: AppsBreakdownItem[] = [...appMap.entries()]
    .map(([appName, data]) => ({
      appName,
      category: data.category,
      seconds: data.seconds,
      percentage: totalSeconds > 0 ? Math.round((data.seconds / totalSeconds) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.seconds - a.seconds);

  return breakdown;
}

export async function getCategoriesBreakdown(
  userId: string,
  from: Date,
  to: Date
): Promise<CategoriesBreakdownItem[]> {
  const entries = await prisma.screenTimeEntry.findMany({
    where: {
      userId,
      startedAt: { gte: from, lte: to },
    },
  });

  const totalSeconds = entries.reduce((sum, e) => sum + e.duration, 0);

  const map = new Map<AppCategory, number>();
  for (const entry of entries) {
    const current = map.get(entry.category) ?? 0;
    map.set(entry.category, current + entry.duration);
  }

  const breakdown: CategoriesBreakdownItem[] = [...map.entries()]
    .map(([category, seconds]) => ({
      category,
      seconds,
      percentage: totalSeconds > 0 ? Math.round((seconds / totalSeconds) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.seconds - a.seconds);

  return breakdown;
}

export async function getActiveSession(
  userId: string
): Promise<ActiveSession | null> {
  const entry = await prisma.screenTimeEntry.findFirst({
    where: {
      userId,
      endedAt: null,
    },
    orderBy: { startedAt: 'desc' },
  });

  if (!entry) return null;

  const now = new Date();
  const durationSoFar = Math.round(
    (now.getTime() - entry.startedAt.getTime()) / 1000
  );

  return {
    appName: entry.appName,
    category: entry.category,
    startedAt: entry.startedAt,
    durationSoFar,
  };
}

export async function updateBrainState(
  userId: string,
  date: Date
): Promise<{
  date: Date;
  tier: BrainTier;
  healthPercent: number;
  totalScreenTime: number;
  focusTime: number;
  categoryBreakdown: Record<string, number>;
}> {
  // Convert the requested date to a UTC day boundary in the user's zone so
  // that "2026-01-02 in America/New_York" aggregates entries from the right
  // UTC hours even when the date itself is UTC-encoded.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const { dayStart, dayEnd } = getUtcDayBoundary(resolveTimezone(user?.timezone), date);

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

  const categoryBreakdown: Record<string, number> = {};
  for (const entry of entries) {
    const current = categoryBreakdown[entry.category] ?? 0;
    categoryBreakdown[entry.category] = current + entry.duration;
  }

  // Persist under UTC midnight so BrainState.date stays consistent across
  // timezones. The query above uses the zoned boundaries.
  const canonicalDayStart = new Date(dayStart);
  canonicalDayStart.setUTCHours(0, 0, 0, 0);

  const brainState = await prisma.brainState.upsert({
    where: {
      userId_date: {
        userId,
        date: canonicalDayStart,
      },
    },
    create: {
      userId,
      date: canonicalDayStart,
      tier,
      healthPercent,
      totalScreenTime,
      focusTime,
      categoryBreakdown,
    },
    update: {
      tier,
      healthPercent,
      totalScreenTime,
      focusTime,
      categoryBreakdown,
    },
  });

  return {
    date: brainState.date,
    tier: brainState.tier,
    healthPercent: brainState.healthPercent,
    totalScreenTime: brainState.totalScreenTime,
    focusTime: brainState.focusTime,
    categoryBreakdown: (brainState.categoryBreakdown as Record<string, number>) ?? {},
  };
}
