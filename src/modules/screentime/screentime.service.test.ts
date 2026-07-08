import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../config/database.js';
import type { AppCategory } from '@prisma/client';
import { clearAllCaches } from '../../shared/cache/index.js';
import { getUtcDayBoundary } from '../../shared/tz.js';
import {
  uploadBatch,
  getTodaySummary,
  getRangeData,
  getAppsBreakdown,
  getCategoriesBreakdown,
  getActiveSession,
  updateBrainState,
  getWindowHealth,
  getAttestedWindowHealth,
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

  describe('getWindowHealth / getAttestedWindowHealth (pool settlement coverage floor)', () => {
    // Fixed historical dates for deterministic day-bucketing regardless of
    // when the suite runs.
    const START = new Date('2021-06-01T00:00:00.000Z');
    const END = new Date('2021-06-04T20:00:00.000Z'); // spans 4 UTC days
    const D1 = new Date('2021-06-01T10:00:00.000Z');
    const D2 = new Date('2021-06-02T10:00:00.000Z');
    const D3 = new Date('2021-06-03T10:00:00.000Z');
    const D4 = new Date('2021-06-04T10:00:00.000Z');

    it('a single report on 1 of 4 days does not clear the coverage floor', async () => {
      await prisma.screenTimeEntry.create({
        data: { userId: testUserId, appName: 'App', category: 'PRODUCTIVITY', duration: 60, startedAt: D1 },
      });

      const result = await getWindowHealth(testUserId, START, END);
      expect(result.hasData).toBe(false);
      expect(result.coveredDays).toBe(1);
      expect(result.windowDays).toBe(4);
    });

    it('light usage reported every day still scores well (not penalized for low volume)', async () => {
      for (const day of [D1, D2, D3, D4]) {
        await prisma.screenTimeEntry.create({
          data: { userId: testUserId, appName: 'App', category: 'PRODUCTIVITY', duration: 60, startedAt: day },
        });
      }

      const result = await getWindowHealth(testUserId, START, END);
      expect(result.hasData).toBe(true);
      expect(result.coveredDays).toBe(4);
      expect(result.healthPercent).toBe(100); // 60s of pure focus time each day
    });

    it('a day with no report at all contributes 0 to the average, even inside an otherwise-covered window', async () => {
      // Covered on 3 of 4 days (>= 0.5 ratio), day D2 has nothing.
      for (const day of [D1, D3, D4]) {
        await prisma.screenTimeEntry.create({
          data: { userId: testUserId, appName: 'App', category: 'PRODUCTIVITY', duration: 60, startedAt: day },
        });
      }

      const result = await getWindowHealth(testUserId, START, END);
      expect(result.hasData).toBe(true);
      expect(result.coveredDays).toBe(3);
      // 3 covered days score 100 each, 1 uncovered day scores 0: (100*3+0)/4 = 75.
      expect(result.healthPercent).toBe(75);
    });

    it('getAttestedWindowHealth ignores UNATTESTED and FAILED entries entirely', async () => {
      await prisma.screenTimeEntry.create({
        data: { userId: testUserId, appName: 'App', category: 'PRODUCTIVITY', duration: 3600, startedAt: D1, attestationStatus: 'UNATTESTED' },
      });
      await prisma.screenTimeEntry.create({
        data: { userId: testUserId, appName: 'App', category: 'PRODUCTIVITY', duration: 3600, startedAt: D2, attestationStatus: 'FAILED' },
      });

      const result = await getAttestedWindowHealth(testUserId, START, END);
      expect(result.hasData).toBe(false);
      expect(result.coveredDays).toBe(0);
    });

    it('getAttestedWindowHealth counts an attested zero-entry check-in as covered', async () => {
      const device = await prisma.attestedDevice.create({
        data: { userId: testUserId, keyId: `key-${testUserId}`, publicKeyPem: 'test', attestationStatus: 'VERIFIED' },
      });
      // Two attested check-ins with zero screen-time entries (quiet days),
      // and two days of real VERIFIED usage — all 4 days covered.
      await prisma.attestationVerification.create({
        data: { userId: testUserId, attestedDeviceId: device.id, signCount: 1, verifiedAt: D2, entryCount: 0 },
      });
      await prisma.attestationVerification.create({
        data: { userId: testUserId, attestedDeviceId: device.id, signCount: 2, verifiedAt: D3, entryCount: 0 },
      });
      const v1 = await prisma.attestationVerification.create({
        data: { userId: testUserId, attestedDeviceId: device.id, signCount: 3, verifiedAt: D1, entryCount: 1 },
      });
      await prisma.screenTimeEntry.create({
        data: {
          userId: testUserId, appName: 'App', category: 'PRODUCTIVITY', duration: 60, startedAt: D1,
          attestationStatus: 'VERIFIED', attestationVerificationId: v1.id,
        },
      });
      const v4 = await prisma.attestationVerification.create({
        data: { userId: testUserId, attestedDeviceId: device.id, signCount: 4, verifiedAt: D4, entryCount: 1 },
      });
      await prisma.screenTimeEntry.create({
        data: {
          userId: testUserId, appName: 'App', category: 'PRODUCTIVITY', duration: 60, startedAt: D4,
          attestationStatus: 'VERIFIED', attestationVerificationId: v4.id,
        },
      });

      const result = await getAttestedWindowHealth(testUserId, START, END);
      expect(result.hasData).toBe(true);
      expect(result.coveredDays).toBe(4);
      // Quiet checked-in days score calculateHealth(0,0)=70, usage days score 100:
      // (100 + 70 + 70 + 100) / 4 = 85.
      expect(result.healthPercent).toBe(85);
    });

    it('buckets by the user\'s local day, not UTC, for a non-UTC timezone', async () => {
      const tz = 'Pacific/Kiritimati'; // UTC+14 — furthest-ahead real timezone
      const nonUtcUser = await prisma.user.create({
        data: {
          email: `st-tz-${Date.now()}@test.app`,
          username: `st-tz-${Date.now()}`,
          passwordHash: 'fake',
          timezone: tz,
        },
      });
      try {
        // A window that is exactly one local calendar day in `tz`. In UTC
        // this spans parts of two different UTC calendar days (UTC+14 pushes
        // local midnight back by 14 hours) — so a naive UTC-day bucketing
        // would disagree with correct local-day bucketing on which entries
        // fall inside it. 2021-06-02T12:00:00Z is 2021-06-03T02:00 local, so
        // this window covers local day 2021-06-03.
        const { dayStart, dayEnd } = getUtcDayBoundary(tz, new Date('2021-06-02T12:00:00.000Z'));

        // This entry's UTC instant falls on UTC calendar day 2021-06-02, but
        // its *local* day in `tz` is 2021-06-03 — matching the window above.
        const crossesUtcMidnight = new Date('2021-06-02T20:00:00.000Z');
        expect(crossesUtcMidnight.toISOString().slice(0, 10)).toBe('2021-06-02'); // naive UTC day would be wrong
        await prisma.screenTimeEntry.create({
          data: { userId: nonUtcUser.id, appName: 'App', category: 'PRODUCTIVITY', duration: 60, startedAt: crossesUtcMidnight },
        });

        const result = await getWindowHealth(nonUtcUser.id, dayStart, dayEnd);
        expect(result.windowDays).toBe(1);
        expect(result.coveredDays).toBe(1); // correctly recognized as covering this local day
        expect(result.hasData).toBe(true);
      } finally {
        await prisma.screenTimeEntry.deleteMany({ where: { userId: nonUtcUser.id } });
        await prisma.user.delete({ where: { id: nonUtcUser.id } }).catch(() => {});
      }
    });
  });
});
