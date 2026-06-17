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
        tokenWallet: { create: { balance: 1000 } },
      },
    });
    creatorId = creator.id;

    const joiner = await prisma.user.create({
      data: {
        email: `pool-joiner-${Date.now()}@test.app`,
        username: `pool-joiner-${Date.now()}`,
        passwordHash: 'fake',
        tokenWallet: { create: { balance: 1000 } },
      },
    });
    joinerId = joiner.id;
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
          tokenWallet: { create: { balance: 1000 } },
        },
      });
      currentJoinerId = joiner.id;

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
          tokenWallet: { create: { balance: 500 } },
        },
      });
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
          tokenWallet: { create: { balance: 1000 } },
        },
      });
      leaverId = leaver.id;

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
          tokenWallet: { create: { balance: 100 } },
        },
      });
      await expect(leavePool(poolId, other.id)).rejects.toThrow('not a participant');
      await prisma.user.delete({ where: { id: other.id } }).catch(() => {});
    });
  });

  describe('settlePool', () => {
    it('settles a pool and credits the winner', async () => {
      const winner = await prisma.user.create({
        data: {
          email: `winner-${Date.now()}@test.app`,
          username: `winner-${Date.now()}`,
          passwordHash: 'fake',
          tokenWallet: { create: { balance: 1000 } },
        },
      });

      const endsAt = new Date(Date.now() - 1000); // already ended
      const pool = await createPool(creatorId, 'Settle Test', undefined, 100, 10, endsAt);
      await joinPool(pool.id, winner.id);

      const settled = await settlePool(pool.id, winner.id);
      expect(settled.status).toBe('SETTLED');
      expect(settled.settledAt).toBeDefined();

      // Winner should receive potTotal - 10% platform fee via transaction record
      const winTx = await prisma.tokenTransaction.findFirst({
        where: { wallet: { userId: winner.id }, type: 'POOL_WIN' },
        orderBy: { createdAt: 'desc' },
      });
      expect(winTx).toBeDefined();
      expect(winTx!.amount).toBe(180); // 200 - 10% = 180
    });

    it('prevents settling a pool that has not ended', async () => {
      const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // future
      const pool = await createPool(creatorId, 'Future Pool', undefined, 10, undefined, endsAt);
      await expect(settlePool(pool.id, creatorId)).rejects.toThrow('Pool has not ended yet');
    });

    it('prevents settling with a non-participant winner', async () => {
      const endsAt = new Date(Date.now() - 1000);
      const pool = await createPool(creatorId, 'Bad Winner', undefined, 10, undefined, endsAt);

      const other = await prisma.user.create({
        data: {
          email: `other-winner-${Date.now()}@test.app`,
          username: `other-winner-${Date.now()}`,
          passwordHash: 'fake',
          tokenWallet: { create: { balance: 100 } },
        },
      });

      await expect(settlePool(pool.id, other.id)).rejects.toThrow('Winner must be a participant');
      await prisma.user.delete({ where: { id: other.id } }).catch(() => {});
    });

    it('creates platform fee and payout ledger entries', async () => {
      const ledgerWinner = await prisma.user.create({
        data: {
          email: `ledger-winner-${Date.now()}@test.app`,
          username: `ledger-winner-${Date.now()}`,
          passwordHash: 'fake',
          tokenWallet: { create: { balance: 1000 } },
        },
      });

      const endsAt = new Date(Date.now() - 1000);
      const pool = await createPool(creatorId, 'Ledger Settle', undefined, 100, 10, endsAt);
      await joinPool(pool.id, ledgerWinner.id);
      await settlePool(pool.id, ledgerWinner.id);

      const ledger = await getPoolLedger(pool.id);
      const feeEntry = ledger.ledger.find((e) => e.type === 'PLATFORM_FEE');
      const payoutEntry = ledger.ledger.find((e) => e.type === 'WINNING_PAYOUT');

      expect(feeEntry).toBeDefined();
      expect(feeEntry!.amount).toBe(20); // 10% of 200
      expect(payoutEntry).toBeDefined();
      expect(payoutEntry!.amount).toBe(180);
    });
  });
});
