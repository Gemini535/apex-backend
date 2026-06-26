import { prisma } from '../../config/database.js';
import type { AppCategory, BrainTier } from '@prisma/client';
import { calculateTier, calculateHealth } from '../../shared/brain-engine.js';

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

  // Recalculate brain state after new data (fire and forget)
  import('../../shared/brain-engine.js')
    .then(({ recalculateBrainState }) => recalculateBrainState(userId))
    .catch(() => {
      // Non-critical — brain state will be recalculated on next read
    });

  return { count: result.count };
}

export async function getTodaySummary(userId: string): Promise<TodaySummary> {
  const now = new Date();
  const dayStart = getStartOfDay(now);
  const dayEnd = getEndOfDay(now);

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
  const dayStart = getStartOfDay(date);
  const dayEnd = getEndOfDay(date);

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

  const brainState = await prisma.brainState.upsert({
    where: {
      userId_date: {
        userId,
        date: dayStart,
      },
    },
    create: {
      userId,
      date: dayStart,
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
