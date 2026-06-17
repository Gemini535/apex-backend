import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../config/database.js';
import { getBalance, getTransactions, creditTokens, debitTokens } from './tokens.service.js';

describe('tokens.service', () => {
  let testUserId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `tokens-test-${Date.now()}@test.app`,
        username: `tokens-test-${Date.now()}`,
        passwordHash: 'fake',
        tokenWallet: { create: { balance: 100 } },
      },
    });
    testUserId = user.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
  });

  describe('getBalance', () => {
    it('returns the correct balance', async () => {
      const result = await getBalance(testUserId);
      expect(result.balance).toBe(100);
    });

    it('returns 0 for a user with no wallet', async () => {
      const user = await prisma.user.create({
        data: {
          email: `nowallet-${Date.now()}@test.app`,
          username: `nowallet-${Date.now()}`,
          passwordHash: 'fake',
        },
      });
      const result = await getBalance(user.id);
      expect(result.balance).toBe(0);
      await prisma.user.delete({ where: { id: user.id } });
    });
  });

  describe('creditTokens', () => {
    it('increases balance by the credited amount', async () => {
      const result = await creditTokens(testUserId, 50, 'BONUS', 'Test credit');
      expect(result.balance).toBe(150); // 100 + 50
    });

    it('creates a transaction record with correct balanceAfter', async () => {
      await creditTokens(testUserId, 25, 'BONUS', 'Transaction test');
      const txs = await prisma.tokenTransaction.findMany({
        where: { wallet: { userId: testUserId } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(txs[0].amount).toBe(25);
      expect(txs[0].balanceAfter).toBe(175); // 150 + 25
      expect(txs[0].type).toBe('BONUS');
      expect(txs[0].description).toBe('Transaction test');
    });

    it('throws on non-positive amount', async () => {
      await expect(creditTokens(testUserId, 0, 'BONUS')).rejects.toThrow('Credit amount must be positive');
      await expect(creditTokens(testUserId, -10, 'BONUS')).rejects.toThrow('Credit amount must be positive');
    });
  });

  describe('debitTokens', () => {
    it('decreases balance by the debited amount', async () => {
      // Balance is 175 from previous tests
      const result = await debitTokens(testUserId, 75, 'SPENT', 'Test debit');
      expect(result.balance).toBe(100); // 175 - 75
    });

    it('creates a transaction record with negative amount', async () => {
      await debitTokens(testUserId, 10, 'SPENT', 'Debit tx test');
      const txs = await prisma.tokenTransaction.findMany({
        where: { wallet: { userId: testUserId } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(txs[0].amount).toBe(-10);
      expect(txs[0].balanceAfter).toBe(90); // 100 - 10
    });

    it('throws on insufficient balance', async () => {
      // Balance is 90
      await expect(debitTokens(testUserId, 1000, 'SPENT')).rejects.toThrow('Insufficient token balance');
    });

    it('throws on non-positive amount', async () => {
      await expect(debitTokens(testUserId, 0, 'SPENT')).rejects.toThrow('Debit amount must be positive');
    });

    it('does not change balance when debit fails', async () => {
      const before = await getBalance(testUserId);
      await expect(debitTokens(testUserId, 99999, 'SPENT')).rejects.toThrow();
      const after = await getBalance(testUserId);
      expect(after.balance).toBe(before.balance);
    });
  });

  describe('getTransactions', () => {
    it('returns paginated transactions', async () => {
      const result = await getTransactions(testUserId, 1, 5);
      expect(result.transactions.length).toBeLessThanOrEqual(5);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(5);
      expect(result.total).toBeGreaterThan(0);
    });

    it('returns empty for user with no wallet', async () => {
      const user = await prisma.user.create({
        data: {
          email: `notx-${Date.now()}@test.app`,
          username: `notx-${Date.now()}`,
          passwordHash: 'fake',
        },
      });
      const result = await getTransactions(user.id);
      expect(result.transactions).toHaveLength(0);
      expect(result.total).toBe(0);
      await prisma.user.delete({ where: { id: user.id } });
    });
  });
});
