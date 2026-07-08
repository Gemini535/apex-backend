import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Exercises settlePool() under ATTESTATION_ENFORCEMENT=strict, where scoring
 * switches from all-data to VERIFIED-only + attested check-ins. This requires
 * setting env vars *before* config/env.ts is first evaluated, so every import
 * here is dynamic (see app.featureFlag.test.ts for the same pattern) — a
 * static top-level import would be hoisted ahead of the process.env writes.
 */
describe('pools.service — strict enforcement mode (attested-only scoring)', () => {
  let prisma: typeof import('../../config/database.js').prisma;
  let createPool: typeof import('./pools.service.js').createPool;
  let joinPool: typeof import('./pools.service.js').joinPool;
  let settlePool: typeof import('./pools.service.js').settlePool;

  const createdUserIds: string[] = [];
  let creatorId: string;

  const WINDOW_START = new Date('2020-03-01T00:00:00.000Z');
  const WINDOW_END = new Date('2020-03-04T20:00:00.000Z'); // 4 UTC days
  const DAY1 = new Date('2020-03-01T10:00:00.000Z');
  const DAY2 = new Date('2020-03-02T10:00:00.000Z');
  const DAY3 = new Date('2020-03-03T10:00:00.000Z');
  const DAY4 = new Date('2020-03-04T10:00:00.000Z');

  beforeAll(async () => {
    process.env.ATTESTATION_ENFORCEMENT = 'strict';
    process.env.APPLE_APP_ATTEST_BUNDLE_ID = 'com.test.bundle';
    process.env.APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || 'TESTTEAMID';
    vi.resetModules();

    ({ prisma } = await import('../../config/database.js'));
    ({ createPool, joinPool, settlePool } = await import('./pools.service.js'));

    const creator = await prisma.user.create({
      data: {
        email: `strict-creator-${Date.now()}@test.app`,
        username: `strict-creator-${Date.now()}`,
        passwordHash: 'fake',
      },
    });
    creatorId = creator.id;
    await prisma.tokenWallet.create({ data: { userId: creatorId, balance: 100_000 } });
  });

  afterAll(async () => {
    delete process.env.ATTESTATION_ENFORCEMENT;
    delete process.env.APPLE_APP_ATTEST_BUNDLE_ID;
    await prisma.user.deleteMany({ where: { id: { in: [...createdUserIds, creatorId] } } }).catch(() => {});
  });

  async function makeParticipant(label: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.app`,
        username: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        passwordHash: 'fake',
      },
    });
    await prisma.tokenWallet.create({ data: { userId: user.id, balance: 1000 } });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function attestCheckin(userId: string, verifiedAt: Date): Promise<string> {
    const device = await prisma.attestedDevice.upsert({
      where: { keyId: `test-key-${userId}` },
      create: { userId, keyId: `test-key-${userId}`, publicKeyPem: 'test', attestationStatus: 'VERIFIED' },
      update: {},
    });
    const verification = await prisma.attestationVerification.create({
      data: { userId, attestedDeviceId: device.id, signCount: 1, verifiedAt, entryCount: 0 },
    });
    return verification.id;
  }

  it('excludes unattested data entirely and counts attested zero-entry check-ins as covered', async () => {
    const consistent = await makeParticipant('attested-consistent');
    const unattestedHeavy = await makeParticipant('unattested-heavy');

    const pool = await createPool(creatorId, 'Strict Settle', undefined, 100, 10, new Date(Date.now() + 60_000));
    await joinPool(pool.id, consistent);
    await joinPool(pool.id, unattestedHeavy);
    await prisma.pool.update({ where: { id: pool.id }, data: { startedAt: WINDOW_START, endsAt: WINDOW_END } });

    // consistent: real (attested) usage on day 1 and 4, attested zero-entry
    // check-ins (no usage) on day 2 and 3 — all 4 days covered.
    for (const day of [DAY1, DAY4]) {
      const verificationId = await attestCheckin(consistent, day);
      await prisma.screenTimeEntry.create({
        data: {
          userId: consistent,
          appName: 'TestApp',
          category: 'PRODUCTIVITY',
          duration: 1800,
          startedAt: day,
          attestationStatus: 'VERIFIED',
          attestationVerificationId: verificationId,
        },
      });
    }
    await attestCheckin(consistent, DAY2);
    await attestCheckin(consistent, DAY3);

    // unattestedHeavy: heavy usage every day, but never attested — none of
    // it counts in strict mode, so this participant has zero coverage.
    for (const day of [DAY1, DAY2, DAY3, DAY4]) {
      await prisma.screenTimeEntry.create({
        data: {
          userId: unattestedHeavy,
          appName: 'TestApp',
          category: 'PRODUCTIVITY',
          duration: 3600,
          startedAt: day,
          // attestationStatus defaults to UNATTESTED
        },
      });
    }

    const settled = await settlePool(pool.id);
    expect(settled.status).toBe('SETTLED');

    const winTx = await prisma.tokenTransaction.findFirst({
      where: { wallet: { userId: consistent }, type: 'POOL_WIN' },
    });
    expect(winTx).toBeDefined();

    const loserTx = await prisma.tokenTransaction.findFirst({
      where: { wallet: { userId: unattestedHeavy }, type: 'POOL_WIN' },
    });
    expect(loserTx).toBeNull();
  });
});
