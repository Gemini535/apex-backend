import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../../config/database.js';
import { createPool, joinPool, leavePool, settlePool, getPoolLedger } from './pools.service.js';

describe('pools.service', () => {
  let creatorId: string;
  let joinerId: string;

  beforeAll(async () => {
    const creator = await prisma.user.create({
      data: {
        email: `pool-creator-${Date.now()}@test.app`,
        username: `pool-creator-${Date.now()}`,
        passwordHash: 'fake',
      },
    });
    creatorId = creator.id;
    await prisma.tokenWallet.create({
      data: { userId: creatorId, balance: 1000 },
    });

    const joiner = await prisma.user.create({
      data: {
        email: `pool-joiner-${Date.now()}@test.app`,
        username: `pool-joiner-${Date.now()}`,
        passwordHash: 'fake',
      },
    });
    joinerId = joiner.id;
    await prisma.tokenWallet.create({
      data: { userId: joinerId, balance: 1000 },
    });
  });

  afterAll(async () => {
    // Cleanup all pool-related data
    await prisma.poolLedger.deleteMany();
    await prisma.poolParticipant.deleteMany();
    await prisma.pool.deleteMany();
    await prisma.tokenTransaction.deleteMany();
    await prisma.tokenWallet.deleteMany();
    await prisma.user.deleteMany({
      where: { id: { in: [creatorId, joinerId] } },
    }).catch(() => {});
  });

  describe('createPool', () => {
    it('creates a pool with the creator as first participant', async () => {
      const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow
      const pool = await createPool(creatorId, 'Test Pool', 'A test pool', 50, 10, endsAt);

      expect(pool).toBeDefined();
      expect(pool.name).toBe('Test Pool');
      expect(pool.entryFee).toBe(50);
      expect(pool.status).toBe('OPEN');
      expect(pool.potTotal).toBe(50);
      expect(pool.participantCount).toBe(1);
    });

    it('deducts entry fee from creator wallet', async () => {
      const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await createPool(creatorId, 'Fee Test', undefined, 10, undefined, endsAt);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: creatorId } });
      // Started with 1000, minus 50 from previous test, minus 10 from this one
      expect(wallet!.balance).toBe(940);
    });

    it('creates a ledger entry for the creator joining', async () => {
      const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const pool = await createPool(creatorId, 'Ledger Test', undefined, 25, undefined, endsAt);

      const ledger = await prisma.poolLedger.findMany({
        where: { poolId: pool.id },
      });
      expect(ledger.length).toBeGreaterThanOrEqual(1);
      expect(ledger[0].type).toBe('ENTRY_FEE');
      expect(ledger[0].amount).toBe(25);
    });
  });

  describe('joinPool', () => {
    let poolId: string;
    let currentJoinerId: string;

    beforeEach(async () => {
      // Create a fresh joiner with 1000 tokens for each test to avoid cumulative balance issues
      const joiner = await prisma.user.create({
        data: {
          email: `joiner-${Date.now()}-${Math.random().toString(36).slice(2)}@test.app`,
          username: `joiner-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          passwordHash: 'fake',
        },
      });
      currentJoinerId = joiner.id;
      await prisma.tokenWallet.create({
        data: { userId: currentJoinerId, balance: 1000 },
      });

      const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const pool = await createPool(creatorId, 'Join Test', undefined, 50, 10, endsAt);
      poolId = pool.id;
    });

    it('allows a second user to join', async () => {
      const pool = await joinPool(poolId, currentJoinerId);
      expect(pool.participantCount).toBe(2);
      expect(pool.potTotal).toBe(100); // 50 creator + 50 joiner
    });

    it('deducts entry fee from joiner wallet', async () => {
      await joinPool(poolId, currentJoinerId);
      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: currentJoinerId } });
      expect(wallet!.balance).toBe(950); // 1000 - 50
    });

    it('prevents double-joining', async () => {
      await joinPool(poolId, currentJoinerId);
      await expect(joinPool(poolId, currentJoinerId)).rejects.toThrow('already a participant');
    });

    it('prevents creator from joining their own pool again', async () => {
      await expect(joinPool(poolId, creatorId)).rejects.toThrow('Creator is already a participant');
    });

    it('prevents joining a non-existent pool', async () => {
      await expect(joinPool('00000000-0000-0000-0000-000000000000', currentJoinerId)).rejects.toThrow('Pool not found');
    });

    it('prevents joining when pool is full', async () => {
      const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const smallPool = await createPool(creatorId, 'Small Pool', undefined, 10, 2, endsAt);

      // currentJoinerId fills the last slot
      await joinPool(smallPool.id, currentJoinerId);

      // Create a third user who should be rejected
      const third = await prisma.user.create({
        data: {
          email: `third-${Date.now()}@test.app`,
          username: `third-${Date.now()}`,
          passwordHash: 'fake',
        },
      });
      await prisma.tokenWallet.create({ data: { userId: third.id, balance: 500 } });
      await expect(joinPool(smallPool.id, third.id)).rejects.toThrow('Pool is full');

      await prisma.user.delete({ where: { id: third.id } }).catch(() => {});
    });

    it('prevents joining once the pool has started (past the join grace period)', async () => {
      const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const pool = await createPool(creatorId, 'Started Pool', undefined, 10, undefined, endsAt);
      // Backdate startedAt beyond the join grace window without waiting for it.
      await prisma.pool.update({
        where: { id: pool.id },
        data: { startedAt: new Date(Date.now() - 60 * 60 * 1000) }, // 1 hour ago
      });

      await expect(joinPool(pool.id, currentJoinerId)).rejects.toThrow('already started');
    });
  });

  describe('leavePool', () => {
    let poolId: string;
    let leaverId: string;

    beforeEach(async () => {
      const leaver = await prisma.user.create({
        data: {
          email: `leaver-${Date.now()}-${Math.random().toString(36).slice(2)}@test.app`,
          username: `leaver-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          passwordHash: 'fake',
        },
      });
      leaverId = leaver.id;
      await prisma.tokenWallet.create({
        data: { userId: leaverId, balance: 1000 },
      });

      const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const pool = await createPool(creatorId, 'Leave Test', undefined, 50, 10, endsAt);
      poolId = pool.id;
      await joinPool(poolId, leaverId);
    });

    it('allows a non-creator to leave', async () => {
      const pool = await leavePool(poolId, leaverId);
      expect(pool.potTotal).toBe(50); // back to just creator's fee
    });

    it('refunds the entry fee', async () => {
      const before = await prisma.tokenWallet.findUnique({ where: { userId: leaverId } });
      await leavePool(poolId, leaverId);
      const after = await prisma.tokenWallet.findUnique({ where: { userId: leaverId } });
      expect(after!.balance).toBe(before!.balance + 50);
    });

    it('prevents the creator from leaving', async () => {
      await expect(leavePool(poolId, creatorId)).rejects.toThrow('Creator cannot leave');
    });

    it('prevents a non-participant from leaving', async () => {
      const other = await prisma.user.create({
        data: {
          email: `other-${Date.now()}@test.app`,
          username: `other-${Date.now()}`,
          passwordHash: 'fake',
        },
      });
      await expect(leavePool(poolId, other.id)).rejects.toThrow('not a participant');
      await prisma.user.delete({ where: { id: other.id } }).catch(() => {});
    });
  });

  describe('settlePool', () => {
    // settlePool no longer accepts a client-supplied `winnerUserId` — the
    // winner is derived entirely from each participant's real screen-time/
    // focus data over the pool's shared settlement window. Previously the
    // caller (the pool creator) could name literally anyone as the winner
    // with zero verification (CODE_REVIEW.md #2).

    const createdUserIds: string[] = [];

    beforeEach(async () => {
      // Earlier describe blocks in this file spend down creatorId's shared
      // wallet — top it up so entryFee=100 pools never fail for balance
      // reasons unrelated to what each test is actually checking.
      await prisma.tokenWallet.update({ where: { userId: creatorId }, data: { balance: 100_000 } });
    });

    afterAll(async () => {
      // Cascades away wallets, transactions, participants, and screen-time
      // entries created for these temp participants (all FKs onDelete: Cascade).
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    });

    // Fixed historical dates so entry/window bucketing is fully deterministic
    // regardless of when the suite runs (no UTC-day-boundary flakiness).
    const TWO_DAY_START = new Date('2020-01-01T00:00:00.000Z');
    const TWO_DAY_END = new Date('2020-01-02T20:00:00.000Z'); // spans 2 UTC days
    const DAY1 = new Date('2020-01-01T10:00:00.000Z');
    const DAY2 = new Date('2020-01-02T10:00:00.000Z');

    const FOUR_DAY_START = new Date('2020-02-01T00:00:00.000Z');
    const FOUR_DAY_END = new Date('2020-02-04T20:00:00.000Z'); // spans 4 UTC days
    const F_DAY1 = new Date('2020-02-01T10:00:00.000Z');
    const F_DAY2 = new Date('2020-02-02T10:00:00.000Z');
    const F_DAY3 = new Date('2020-02-03T10:00:00.000Z');
    const F_DAY4 = new Date('2020-02-04T10:00:00.000Z');

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

    async function seedEntry(userId: string, startedAt: Date, category: 'PRODUCTIVITY' | 'OTHER', duration: number) {
      await prisma.screenTimeEntry.create({
        data: { userId, appName: 'TestApp', category, duration, startedAt },
      });
    }

    async function backdateWindow(poolId: string, startedAt: Date, endsAt: Date) {
      await prisma.pool.update({ where: { id: poolId }, data: { startedAt, endsAt } });
    }

    it('picks the higher screen-time-health participant as winner (not a random/creator-supplied value)', async () => {
      const healthy = await makeParticipant('healthy');
      const unhealthy = await makeParticipant('unhealthy');

      const pool = await createPool(creatorId, 'Health Settle', undefined, 100, 10, new Date(Date.now() + 60_000));
      await joinPool(pool.id, healthy);
      await joinPool(pool.id, unhealthy);
      await backdateWindow(pool.id, TWO_DAY_START, TWO_DAY_END);

      // healthy: 30 min of focus time each day -> health 100 both days.
      await seedEntry(healthy, DAY1, 'PRODUCTIVITY', 1800);
      await seedEntry(healthy, DAY2, 'PRODUCTIVITY', 1800);
      // unhealthy: 7h of non-focus time each day -> health 30 both days.
      await seedEntry(unhealthy, DAY1, 'OTHER', 7 * 3600);
      await seedEntry(unhealthy, DAY2, 'OTHER', 7 * 3600);

      const settled = await settlePool(pool.id);
      expect(settled.status).toBe('SETTLED');
      expect(settled.settledAt).toBeDefined();

      const winnerParticipant = settled.participants.find((p) => p.userId === healthy);
      expect(winnerParticipant!.focusScore).toBeGreaterThan(0);

      const winTx = await prisma.tokenTransaction.findFirst({
        where: { wallet: { userId: healthy }, type: 'POOL_WIN' },
        orderBy: { createdAt: 'desc' },
      });
      expect(winTx).toBeDefined();
      expect(winTx!.amount).toBe(270); // 300 pot - 10% platform fee

      const loserTx = await prisma.tokenTransaction.findFirst({
        where: { wallet: { userId: unhealthy }, type: 'POOL_WIN' },
      });
      expect(loserTx).toBeNull();
    });

    it('prevents settling a pool that has not ended', async () => {
      const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // future
      const pool = await createPool(creatorId, 'Future Pool', undefined, 10, undefined, endsAt);
      await expect(settlePool(pool.id)).rejects.toThrow('Pool has not ended yet');
    });

    it('prevents settling the same pool twice (sequential, after it has already settled)', async () => {
      const winner = await makeParticipant('double-settle-winner');
      const pool = await createPool(creatorId, 'Double Settle Pool', undefined, 10, undefined, new Date(Date.now() + 60_000));
      await joinPool(pool.id, winner);
      await backdateWindow(pool.id, TWO_DAY_START, TWO_DAY_END);
      await seedEntry(winner, DAY1, 'PRODUCTIVITY', 1800);
      await seedEntry(winner, DAY2, 'PRODUCTIVITY', 1800);

      await settlePool(pool.id);
      await expect(settlePool(pool.id)).rejects.toThrow(
        'Pool can only be settled from OPEN or ACTIVE status',
      );
    });

    it('no longer trusts a client-supplied winner — settlePool takes only a poolId', async () => {
      // The old (poolId, winnerUserId) signature is gone; settlePool always
      // computes the winner itself from screen-time health data.
      expect(settlePool.length).toBe(1);
    });

    it('creates platform fee and payout ledger entries', async () => {
      const winner = await makeParticipant('ledger-winner');
      const pool = await createPool(creatorId, 'Ledger Settle', undefined, 100, 10, new Date(Date.now() + 60_000));
      await joinPool(pool.id, winner);
      await backdateWindow(pool.id, TWO_DAY_START, TWO_DAY_END);
      await seedEntry(winner, DAY1, 'PRODUCTIVITY', 1800);
      await seedEntry(winner, DAY2, 'PRODUCTIVITY', 1800);
      // Creator has no screen-time data at all, so winner is unambiguous.

      await settlePool(pool.id);

      const ledger = await getPoolLedger(pool.id);
      const feeEntry = ledger.ledger.find((e) => e.type === 'PLATFORM_FEE');
      const payoutEntry = ledger.ledger.find((e) => e.type === 'WINNING_PAYOUT');

      expect(feeEntry).toBeDefined();
      expect(feeEntry!.amount).toBe(20); // 10% of 200
      expect(payoutEntry).toBeDefined();
      expect(payoutEntry!.amount).toBe(180);
    });

    it('a single report inside an otherwise-unreported multi-day window does not win (coverage floor)', async () => {
      const consistent = await makeParticipant('consistent');
      const cherryPicked = await makeParticipant('cherry-picked');

      const pool = await createPool(creatorId, 'Coverage Floor', undefined, 100, 10, new Date(Date.now() + 60_000));
      await joinPool(pool.id, consistent);
      await joinPool(pool.id, cherryPicked);
      await backdateWindow(pool.id, FOUR_DAY_START, FOUR_DAY_END);

      // consistent: real coverage on all 4 days (moderate scores each day).
      for (const day of [F_DAY1, F_DAY2, F_DAY3, F_DAY4]) {
        await seedEntry(consistent, day, 'PRODUCTIVITY', 1800);
      }
      // cherryPicked: a single, very-high-scoring report on only 1 of 4 days
      // (coverage ratio 0.25 < 0.5) — must not win despite the high raw score.
      await seedEntry(cherryPicked, F_DAY1, 'PRODUCTIVITY', 60);

      const settled = await settlePool(pool.id);
      expect(settled.status).toBe('SETTLED');

      const winTx = await prisma.tokenTransaction.findFirst({
        where: { wallet: { userId: consistent }, type: 'POOL_WIN' },
      });
      expect(winTx).toBeDefined();

      const cherryTx = await prisma.tokenTransaction.findFirst({
        where: { wallet: { userId: cherryPicked }, type: 'POOL_WIN' },
      });
      expect(cherryTx).toBeNull();
    });

    it('refunds everyone and cancels the pool when nobody clears the coverage floor', async () => {
      const a = await makeParticipant('nodata-a');
      const b = await makeParticipant('nodata-b');

      const pool = await createPool(creatorId, 'No Data Pool', undefined, 100, 10, new Date(Date.now() + 60_000));
      await joinPool(pool.id, a);
      await joinPool(pool.id, b);
      await backdateWindow(pool.id, FOUR_DAY_START, FOUR_DAY_END);
      // Both participants only report on 1 of 4 days — below the coverage floor for both.
      await seedEntry(a, F_DAY1, 'PRODUCTIVITY', 1800);
      await seedEntry(b, F_DAY1, 'PRODUCTIVITY', 1800);

      const balanceBeforeA = (await prisma.tokenWallet.findUnique({ where: { userId: a } }))!.balance;
      const balanceBeforeB = (await prisma.tokenWallet.findUnique({ where: { userId: b } }))!.balance;

      const settled = await settlePool(pool.id);
      expect(settled.status).toBe('CANCELLED');

      const balanceAfterA = (await prisma.tokenWallet.findUnique({ where: { userId: a } }))!.balance;
      const balanceAfterB = (await prisma.tokenWallet.findUnique({ where: { userId: b } }))!.balance;
      expect(balanceAfterA).toBe(balanceBeforeA + 100);
      expect(balanceAfterB).toBe(balanceBeforeB + 100);

      const ledger = await getPoolLedger(pool.id);
      const refunds = ledger.ledger.filter((e) => e.type === 'REFUND');
      // Refunds go to every participant, including the creator (who also has no data).
      expect(refunds.length).toBe(3);
    });

    it('rejects a concurrent double-settle attempt (TOCTOU lock)', async () => {
      const winner = await makeParticipant('concurrent-winner');
      const pool = await createPool(creatorId, 'Concurrent Settle', undefined, 100, 10, new Date(Date.now() + 60_000));
      await joinPool(pool.id, winner);
      await backdateWindow(pool.id, TWO_DAY_START, TWO_DAY_END);
      await seedEntry(winner, DAY1, 'PRODUCTIVITY', 1800);
      await seedEntry(winner, DAY2, 'PRODUCTIVITY', 1800);

      const results = await Promise.allSettled([settlePool(pool.id), settlePool(pool.id)]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already being settled/);
    });
  });
});
