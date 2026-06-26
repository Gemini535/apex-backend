import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '../../config/database.js';

// Mock Stripe before importing the service
vi.mock('./stripe.service.js', () => ({
  stripe: {
    customers: {
      create: vi.fn().mockResolvedValue({ id: 'cus_test123' }),
    },
    paymentIntents: {
      create: vi.fn().mockResolvedValue({
        id: 'pi_test123',
        client_secret: 'pi_test123_secret',
        amount: 100,
        status: 'requires_payment_method',
      }),
    },
  },
  createDeposit: vi.fn().mockImplementation(async (userId: string, amountCents: number) => ({
    paymentIntentId: 'pi_test123',
    clientSecret: 'pi_test123_secret',
    amount: amountCents,
    currency: 'usd',
  })),
  createWithdrawal: vi.fn().mockImplementation(async (userId: string, amount: number) => ({
    transferId: `manual_${Date.now()}`,
    amount,
    currency: 'usd',
    status: 'pending_manual_processing',
  })),
  handleWebhook: vi.fn().mockResolvedValue({ received: true }),
  getStripeCustomerId: vi.fn().mockResolvedValue(null),
}));

describe('payments.controller', () => {
  let testUserId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `payments-ctrl-${Date.now()}@test.app`,
        username: `payments-ctrl-${Date.now()}`,
        passwordHash: 'fake',
        tokenWallet: { create: { balance: 500 } },
      },
    });
    testUserId = user.id;
  });

  afterAll(async () => {
    await prisma.tokenTransaction.deleteMany();
    await prisma.tokenWallet.deleteMany();
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
  });

  describe('deposit validation', () => {
    it('requires idempotencyKey', async () => {
      const { depositHandler } = await import('./payments.controller.js');

      const mockReq = {
        user: { userId: testUserId, email: '', username: '' },
        body: { amount: 100 },
      } as any;
      const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any;
      const mockNext = vi.fn();

      await depositHandler(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      const error = mockNext.mock.calls[0][0];
      expect(error.message).toContain('idempotencyKey is required');
    });

    it('requires amount', async () => {
      const { depositHandler } = await import('./payments.controller.js');

      const mockReq = {
        user: { userId: testUserId, email: '', username: '' },
        body: { idempotencyKey: 'test-key-123' },
      } as any;
      const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any;
      const mockNext = vi.fn();

      await depositHandler(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      const error = mockNext.mock.calls[0][0];
      expect(error.message).toContain('amount');
    });
  });

  describe('withdraw validation', () => {
    it('requires idempotencyKey', async () => {
      const { withdrawHandler } = await import('./payments.controller.js');

      const mockReq = {
        user: { userId: testUserId, email: '', username: '' },
        body: { amount: 100 },
      } as any;
      const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any;
      const mockNext = vi.fn();

      await withdrawHandler(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      const error = mockNext.mock.calls[0][0];
      expect(error.message).toContain('idempotencyKey is required');
    });
  });
});
