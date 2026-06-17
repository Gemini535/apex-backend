import { prisma } from '../../config/database.js';
import type { BrainTier, AppCategory } from '@prisma/client';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SafeUser {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  timezone: string;
  brainHealth: number;
  brainTier: BrainTier;
  currentStreak: number;
  longestStreak: number;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

export interface UserSearchResult {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  brainHealth: number;
  brainTier: BrainTier;
}

export interface BrainStateResult {
  id: string;
  userId: string;
  date: Date;
  tier: BrainTier;
  healthPercent: number;
  totalScreenTime: number;
  focusTime: number;
  categoryBreakdown: Record<AppCategory, number> | null;
}

export interface DailyStats {
  date: string;
  totalScreenTime: number;
  focusTime: number;
  categoryBreakdown: Record<string, number>;
  entryCount: number;
}

export interface AggregatedStats {
  from: string;
  to: string;
  days: DailyStats[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toSafeUser(user: {
  id: string;
  email: string;
  username: string;
  passwordHash: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  timezone: string;
  brainHealth: number;
  brainTier: BrainTier;
  currentStreak: number;
  longestStreak: number;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}): SafeUser {
  const { passwordHash: _passwordHash, ...safe } = user;
  void _passwordHash;
  return safe;
}

// ─── Service Functions ───────────────────────────────────────────────────────

export async function getProfile(userId: string): Promise<SafeUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw Object.assign(new Error('User not found'), { statusCode: 404 });
  }

  return toSafeUser(user);
}

export async function updateProfile(
  userId: string,
  data: {
    displayName?: string;
    bio?: string;
    avatarUrl?: string;
    timezone?: string;
  }
): Promise<SafeUser> {
  const user = await prisma.user.update({
    where: { id: userId },
    data,
  });

  return toSafeUser(user);
}

export async function searchUsers(
  query: string,
  currentUserId: string,
  limit = 20
): Promise<UserSearchResult[]> {
  const users = await prisma.user.findMany({
    where: {
      username: {
        contains: query,
        mode: 'insensitive',
      },
      id: {
        not: currentUserId,
      },
    },
    take: limit,
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      brainHealth: true,
      brainTier: true,
    },
  });

  return users;
}

export async function getBrainState(userId: string): Promise<BrainStateResult> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const brainState = await prisma.brainState.findUnique({
    where: {
      userId_date: {
        userId,
        date: today,
      },
    },
  });

  if (!brainState) {
    return {
      id: '',
      userId,
      date: today,
      tier: 'PRISTINE' as BrainTier,
      healthPercent: 100,
      totalScreenTime: 0,
      focusTime: 0,
      categoryBreakdown: null,
    };
  }

  return brainState as unknown as BrainStateResult;
}

export async function getAggregatedStats(
  userId: string,
  from: Date,
  to: Date
): Promise<AggregatedStats> {
  const entries = await prisma.screenTimeEntry.findMany({
    where: {
      userId,
      startedAt: {
        gte: from,
        lte: to,
      },
    },
    orderBy: {
      startedAt: 'asc',
    },
  });

  const dailyMap = new Map<
    string,
    {
      totalScreenTime: number;
      focusTime: number;
      categoryBreakdown: Record<string, number>;
      entryCount: number;
    }
  >();

  for (const entry of entries) {
    const dateKey = entry.startedAt.toISOString().slice(0, 10);

    if (!dailyMap.has(dateKey)) {
      dailyMap.set(dateKey, {
        totalScreenTime: 0,
        focusTime: 0,
        categoryBreakdown: {},
        entryCount: 0,
      });
    }

    const day = dailyMap.get(dateKey)!;
    day.totalScreenTime += entry.duration;
    day.entryCount += 1;

    // Track per-category duration
    const cat = entry.category;
    day.categoryBreakdown[cat] = (day.categoryBreakdown[cat] ?? 0) + entry.duration;
  }

  // Build daily breakdowns, including days with no entries
  const days: DailyStats[] = [];
  const current = new Date(from);

  while (current <= to) {
    const dateKey = current.toISOString().slice(0, 10);
    const dayData = dailyMap.get(dateKey);

    days.push({
      date: dateKey,
      totalScreenTime: dayData?.totalScreenTime ?? 0,
      focusTime: dayData?.focusTime ?? 0,
      categoryBreakdown: dayData?.categoryBreakdown ?? {},
      entryCount: dayData?.entryCount ?? 0,
    });

    current.setUTCDate(current.getUTCDate() + 1);
  }

  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    days,
  };
}

// ─── Public Profile (used by getByUsername) ─────────────────────────────────

export async function getPublicProfile(username: string): Promise<SafeUser> {
  const user = await prisma.user.findUnique({
    where: { username },
  });

  if (!user) {
    throw Object.assign(new Error('User not found'), { statusCode: 404 });
  }

  return toSafeUser(user);
}
