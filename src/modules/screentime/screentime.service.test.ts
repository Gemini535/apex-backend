import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../config/database.js';
import type { AppCategory } from '@prisma/client';
import { clearAllCaches } from '../../shared/cache/index.js';
import {
  uploadBatch,
  getTodaySummary,
  getRangeData,
  getAppsBreakdown,
  getCategoriesBreakdown,
  getActiveSession,
  updateBrainState,
} from './screentime.service.js';

describe('screentime.service', () => {
  let testUserId: string;

  beforeEach(async () => {
    clearAllCaches();
    const user = await prisma.user.create({
      data: {
        email: `st-${Date.now()}-${Math.random().toString(36).slice(2)}@test.app`,
        username: `st-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        passwordHash: 'fake',
      },
    });
    testUserId = user.id;
  });

  afterEach(async () => {
    await prisma.brainState.deleteMany({ where: { userId: testUserId } });
    await prisma.screenTimeEntry.deleteMany({ where: { userId: testUserId } });
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
  });

  describe('uploadBatch', () => {
    it('uploads a batch of screen time entries', async () => {
      const entries = [
        {
          appName: 'Instagram',
          appBundleId: 'com.burbn.instagram',
          category: 'SOCIAL' as AppCategory,
          duration: 1800,
          startedAt: new Date(),
          isBlacklisted: true,
        },
        {
          appName: 'Safari',
          category: 'PRODUCTIVITY' as AppCategory,
          duration: 3600,
          startedAt: new Date(),
        },
      ];

      const result = await uploadBatch(testUserId, entries);
      expect(result.count).toBe(2);
    });

    it('returns 0 for empty batch', async () => {
      const result = await uploadBatch(testUserId, []);
      expect(result.count).toBe(0);
    });
  });

  describe('getTodaySummary', () => {
    it('returns today screen time summary with data', async () => {
      // Upload entries first
      await uploadBatch(testUserId, [
        {
          appName: 'Instagram',
          category: 'SOCIAL' as AppCategory,
          duration: 1800,
          startedAt: new Date(),
        },
        {
          appName: 'Safari',
          category: 'PRODUCTIVITY' as AppCategory,
          duration: 3600,
          startedAt: new Date(),
        },
      ]);

      const summary = await getTodaySummary(testUserId);
      expect(summary.totalSeconds).toBe(5400);
      expect(summary.brainTier).toBe('PRISTINE');
      expect(summary.brainHealth).toBe(90);
      expect(summary.categories.length).toBe(2);
      expect(summary.topApps.length).toBe(2);
    });

    it('returns empty summary when no entries', async () => {
      const summary = await getTodaySummary(testUserId);
      expect(summary.totalSeconds).toBe(0);
      expect(summary.brainTier).toBe('PRISTINE');
      // zero-length session => 70 baseline (no focus-ratio bonus)
      expect(summary.brainHealth).toBe(70);
    });

    it('categorizes focus time correctly', async () => {
      await uploadBatch(testUserId, [
        {
          appName: 'Safari',
          category: 'PRODUCTIVITY' as AppCategory,
          duration: 3600,
          startedAt: new Date(),
        },
      ]);

      const summary = await getTodaySummary(testUserId);
      expect(summary.focusSeconds).toBe(3600);
    });

    it('returns FOG tier for >4 hours', async () => {
      const entries = Array.from({ length: 5 }, (_, i) => ({
        appName: `App${i}`,
        category: 'SOCIAL' as AppCategory,
        duration: 3600, // 1 hour each × 5 = 5 hours
        startedAt: new Date(),
      }));
      await uploadBatch(testUserId, entries);

      const summary = await getTodaySummary(testUserId);
      expect(summary.brainTier).toBe('FOG');
    });

    it('returns SLIME tier for >6 hours', async () => {
      const entries = Array.from({ length: 7 }, (_, i) => ({
        appName: `App${i}`,
        category: 'SOCIAL' as AppCategory,
        duration: 3600, // 1 hour each × 7 = 7 hours
        startedAt: new Date(),
      }));
      await uploadBatch(testUserId, entries);

      const summary = await getTodaySummary(testUserId);
      expect(summary.brainTier).toBe('SLIME');
    });

    it('returns GRAY_VOID tier for >8 hours', async () => {
      const entries = Array.from({ length: 9 }, (_, i) => ({
        appName: `App${i}`,
        category: 'SOCIAL' as AppCategory,
        duration: 3600, // 1 hour each × 9 = 9 hours
        startedAt: new Date(),
      }));
      await uploadBatch(testUserId, entries);

      const summary = await getTodaySummary(testUserId);
      expect(summary.brainTier).toBe('GRAY_VOID');
    });
  });

  describe('getRangeData', () => {
    it('returns daily summaries for date range', async () => {
      await uploadBatch(testUserId, [
        {
          appName: 'Instagram',
          category: 'SOCIAL' as AppCategory,
          duration: 1800,
          startedAt: new Date(),
        },
      ]);

      const now = new Date();
      const from = new Date(now);
      from.setDate(from.getDate() - 7);

      const data = await getRangeData(testUserId, from, now);
      expect(data.length).toBeGreaterThan(0);
      expect(data[0].date).toBeDefined();
      expect(data[0].totalSeconds).toBeGreaterThanOrEqual(1800);
      expect(data[0].brainTier).toBeDefined();
    });

    it('returns empty for future date range', async () => {
      const future = new Date();
      future.setFullYear(future.getFullYear() + 1);
      const data = await getRangeData(testUserId, future, future);
      expect(data).toHaveLength(0);
    });
  });

  describe('getAppsBreakdown', () => {
    it('returns per-app breakdown sorted by duration', async () => {
      await uploadBatch(testUserId, [
        { appName: 'Instagram', category: 'SOCIAL' as AppCategory, duration: 3600, startedAt: new Date() },
        { appName: 'Safari', category: 'PRODUCTIVITY' as AppCategory, duration: 1800, startedAt: new Date() },
      ]);

      const now = new Date();
      const from = new Date(now);
      from.setDate(from.getDate() - 7);

      const apps = await getAppsBreakdown(testUserId, from, now);
      expect(apps).toHaveLength(2);
      expect(apps[0].appName).toBe('Instagram'); // longer duration first
      expect(apps[0].seconds).toBe(3600);
      expect(apps[1].seconds).toBe(1800);
    });
  });

  describe('getCategoriesBreakdown', () => {
    it('returns per-category breakdown', async () => {
      await uploadBatch(testUserId, [
        { appName: 'Instagram', category: 'SOCIAL' as AppCategory, duration: 3600, startedAt: new Date() },
        { appName: 'Safari', category: 'PRODUCTIVITY' as AppCategory, duration: 1800, startedAt: new Date() },
      ]);

      const now = new Date();
      const from = new Date(now);
      from.setDate(from.getDate() - 7);

      const categories = await getCategoriesBreakdown(testUserId, from, now);
      expect(categories).toHaveLength(2);
      const names = categories.map((c) => c.category);
      expect(names).toContain('SOCIAL');
      expect(names).toContain('PRODUCTIVITY');
    });
  });

  describe('getActiveSession', () => {
    it('returns null when no active session', async () => {
      const session = await getActiveSession(testUserId);
      expect(session).toBeNull();
    });

    it('returns active session for entry without endedAt', async () => {
      await prisma.screenTimeEntry.create({
        data: {
          userId: testUserId,
          appName: 'TikTok',
          category: 'SOCIAL',
          duration: 0,
          startedAt: new Date(),
          endedAt: null,
        },
      });

      const session = await getActiveSession(testUserId);
      expect(session).not.toBeNull();
      expect(session!.appName).toBe('TikTok');
      expect(session!.category).toBe('SOCIAL');
      expect(session!.durationSoFar).toBeGreaterThanOrEqual(0);
    });
  });

  describe('updateBrainState', () => {
    it('creates brain state for today', async () => {
      await uploadBatch(testUserId, [
        { appName: 'Instagram', category: 'SOCIAL' as AppCategory, duration: 3600, startedAt: new Date() },
      ]);

      const result = await updateBrainState(testUserId, new Date());
      expect(result.tier).toBeDefined();
      expect(result.healthPercent).toBeGreaterThanOrEqual(0);
      expect(result.healthPercent).toBeLessThanOrEqual(100);
      expect(result.totalScreenTime).toBe(3600);
      expect(result.focusTime).toBe(0);
      expect(result.categoryBreakdown).toBeDefined();
    });

    it('updates existing brain state on second call', async () => {
      const first = await updateBrainState(testUserId, new Date());
      const second = await updateBrainState(testUserId, new Date());
      expect(second.totalScreenTime).toBe(first.totalScreenTime);
    });
  });
});
