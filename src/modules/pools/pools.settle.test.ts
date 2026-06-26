import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '../../config/database.js';

describe('pools.controller — settle authorization', () => {
  let testUserId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `pools-settle-${Date.now()}@test.app`,
        username: `pools-settle-${Date.now()}`,
        passwordHash: 'fake',
        tokenWallet: { create: { balance: 500 } },
      },
    });
    testUserId = user.id;
  });

  afterAll(async () => {
    await prisma.tokenTransaction.deleteMany();
    await prisma.tokenWallet.deleteMany();
    await prisma.poolLedger.deleteMany();
    await prisma.poolParticipant.deleteMany();
    await prisma.pool.deleteMany();
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
  });

  it('only pool creator can settle', async () => {
    const { settlePoolHandler } = await import('./pools.controller.js');
    const { createPool } = await import('./pools.service.js');

    const endsAt = new Date(Date.now() - 1000); // already ended
    const pool = await createPool(testUserId, 'Auth Test Pool', undefined, 10, 10, endsAt);

    const otherUser = await prisma.user.create({
      data: {
        email: `other-settler-${Date.now()}@test.app`,
        username: `other-settler-${Date.now()}`,
        passwordHash: 'fake',
        tokenWallet: { create: { balance: 500 } },
      },
    });

    const mockReq = {
      user: { userId: otherUser.id, email: '', username: '' },
      params: { poolId: pool.id },
      body: { winnerUserId: testUserId },
    } as any;
    const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any;
    const mockNext = vi.fn();

    await settlePoolHandler(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    const error = mockNext.mock.calls[0][0];
    expect(error.message).toBe('Only the pool creator can settle the pool');
    expect(error.statusCode).toBe(403);

    await prisma.user.delete({ where: { id: otherUser.id } }).catch(() => {});
  });
});
