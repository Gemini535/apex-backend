import type { AppCategory } from '@prisma/client';

export interface ScreenTimeBatchBody {
  entries: ScreenTimeEntryInput[];
}

export interface ScreenTimeEntryInput {
  appName: string;
  appBundleId?: string;
  category: AppCategory;
  duration: number;     // in seconds
  startedAt: string;    // ISO date
  endedAt?: string;     // ISO date
  isBlacklisted?: boolean;
}

export interface DateRangeQuery {
  from: string;  // ISO date
  to: string;    // ISO date
}

export interface ScreenTimeTodayResponse {
  totalSeconds: number;
  focusSeconds: number;
  brainHealth: number;
  brainTier: string;
  categories: CategoryBreakdown[];
  topApps: AppBreakdown[];
}

export interface CategoryBreakdown {
  category: string;
  seconds: number;
  percentage: number;
}

export interface AppBreakdown {
  appName: string;
  category: string;
  seconds: number;
  percentage: number;
}

export interface ScreenTimeRangeResponse {
  date: string;
  totalSeconds: number;
  focusSeconds: number;
  brainHealth: number;
  brainTier: string;
  categories: CategoryBreakdown[];
}

export interface ActiveAppResponse {
  appName: string;
  category: string;
  startedAt: string;
  durationSoFar: number; // seconds
}
