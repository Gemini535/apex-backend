import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../../config/database.js';
import { createPool, joinPool, leavePool, settlePool, getPoolLedger } from './pools.service.js';
import { uploadBatch } from '../screentime/screentime.service.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    // winner (or winners, on a tie) is derived entirely from each
    // participant's real screen-time/focus data over the pool's active
    // window. Previously the caller (the pool creator) could name literally
    // anyone as the winner with zero verification (CODE_REVIEW.md #2).

    it('pays out to the participant with the higher focus score, derived from real activity data', async () => {
      const winner = await prisma.user.create({
        data: {
          email: `winner-${Date.now()}@test.app`,
          username: `winner-${Date.now()}`,
          passwordHash: 'fake',
        },
      });
      await prisma.tokenWallet.create({ data: { userId: winner.id, balance: 1000 } });

      // endsAt must be in the real future at creation time so the scoring
      // window (participant.joinedAt .. pool.endsAt) is non-empty; we then
      // wait for it to pass before settling. The 2s window gives the
      // create/join/upload round-trips above plenty of headroom to land
      // inside it.
      const endsAt = new Date(Date.now() + 2000);
      const pool = await createPool(creatorId, 'Settle Test', undefined, 100, 10, endsAt);
      await joinPool(pool.id, winner.id);

      // Give the winner two hours of PRODUCTIVITY (a focus category) —
      // enough to score 100 health for that day. The creator gets no
      // activity data at all (health 0), so the winner should win outright.
      await uploadBatch(winner.id, [
        {
          appName: 'Focus App',
          category: 'PRODUCTIVITY',
          duration: 2 * 60 * 60,
          startedAt: new Date(),
        },
      ]);

      await sleep(2500); // let endsAt pass

      const settled = await settlePool(pool.id);
      expect(settled.status).toBe('SETTLED');
      expect(settled.settledAt).toBeDefined();

      const winnerParticipant = settled.participants.find((p) => p.userId === winner.id);
      expect(winnerParticipant!.focusScore).toBeGreaterThan(0);

      // Winner should receive potTotal - 10% platform fee via transaction record
      const winTx = await prisma.tokenTransaction.findFirst({
        where: { wallet: { userId: winner.id }, type: 'POOL_WIN' },
        orderBy: { createdAt: 'desc' },
      });
      expect(winTx).toBeDefined();
      expect(winTx!.amount).toBe(180); // 200 - 10% = 180

      const ledger = await getPoolLedger(pool.id);
      const feeEntry = ledger.ledger.find((e) => e.type === 'PLATFORM_FEE');
      const payoutEntry = ledger.ledger.find((e) => e.type === 'WINNING_PAYOUT');
      expect(feeEntry?.amount).toBe(20); // 10% of 200
      expect(payoutEntry?.amount).toBe(180);
    });

    it('refunds every participant in full when nobody has any verifiable activity data', async () => {
      const other = await prisma.user.create({
        data: {
          email: `no-data-${Date.now()}@test.app`,
          username: `no-data-${Date.now()}`,
          passwordHash: 'fake',
        },
      });
      await prisma.tokenWallet.create({ data: { userId: other.id, balance: 1000 } });

      const endsAt = new Date(Date.now() + 2000);
      const pool = await createPool(creatorId, 'No Data Pool', undefined, 30, 10, endsAt);
      await joinPool(pool.id, other.id);

      await sleep(2500);

      const settled = await settlePool(pool.id);
      expect(settled.status).toBe('SETTLED');
      expect(settled.participants.every((p) => p.tokensWon === 0)).toBe(true);

      const ledger = await getPoolLedger(pool.id);
      expect(ledger.ledger.some((e) => e.type === 'PLATFORM_FEE')).toBe(false);
      expect(ledger.ledger.filter((e) => e.type === 'REFUND').length).toBeGreaterThanOrEqual(2);

      const refundTx = await prisma.tokenTransaction.findFirst({
        where: { wallet: { userId: other.id }, type: 'POOL_REFUND', referenceId: pool.id },
      });
      expect(refundTx).toBeDefined();
      expect(refundTx!.amount).toBe(30);

      await prisma.user.delete({ where: { id: other.id } }).catch(() => {});
    });

    it('prevents settling a pool that has not ended', async () => {
      const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // future
      const pool = await createPool(creatorId, 'Future Pool', undefined, 10, undefined, endsAt);
      await expect(settlePool(pool.id)).rejects.toThrow('Pool has not ended yet');
    });

    it('prevents settling the same pool twice', async () => {
      const endsAt = new Date(Date.now() + 2000);
      const pool = await createPool(creatorId, 'Double Settle Pool', undefined, 10, undefined, endsAt);
      await sleep(2500);

      await settlePool(pool.id);
      await expect(settlePool(pool.id)).rejects.toThrow(
        'Pool can only be settled from OPEN or ACTIVE status',
      );
    });
  });
});
