import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '../../config/database.js';
import { evaluateContract, goalThreshold } from './evaluate-contract.js';
import { createContract } from '../../modules/commitments/commitments.service.js';
import { getBalance } from '../../modules/tokens/tokens.service.js';
import { uploadBatch } from '../../modules/screentime/screentime.service.js';
import type { AppCategory } from '@prisma/client';

describe('evaluate-contract', () => {
  let userBal: string;
  let richUser: string;

  beforeAll(async () => {
    // User with a wallet we can debit from.
    const u = await prisma.user.create({
      data: {
        email: `ec-${Date.now()}@test.app`,
        username: `ec-${Date.now()}`,
        passwordHash: 'fake',
        tokenWallet: { create: { balance: 10_000 } },
      },
    });
    userBal = u.id;

    // Rich user for the "met goal" case.
    const r = await prisma.user.create({
      data: {
        email: `ec-rich-${Date.now()}@test.app`,
        username: `ec-rich-${Date.now()}`,
        passwordHash: 'fake',
        tokenWallet: { create: { balance: 100_000 } },
      },
    });
    richUser = r.id;
  });

  afterAll(async () => {
    await prisma.tokenTransaction.deleteMany();
    await prisma.commitmentContract.deleteMany();
    await prisma.screenTimeEntry.deleteMany();
    await prisma.brainState.deleteMany();
    await prisma.tokenWallet.deleteMany();
    await prisma.user.deleteMany({ where: { id: { in: [userBal, richUser] } } }).catch(() => {});
  });

  // Clean slate between tests so contract/user state doesn't leak.
  beforeEach(async () => {
    await prisma.tokenTransaction.deleteMany({ where: { wallet: { userId: userBal } } });
    await prisma.tokenTransaction.deleteMany({ where: { wallet: { userId: richUser } } });
    await prisma.commitmentContract.deleteMany({ where: { userId: userBal } });
    await prisma.commitmentContract.deleteMany({ where: { userId: richUser } });
    await prisma.screenTimeEntry.deleteMany({ where: { userId: richUser } });
    await prisma.brainState.deleteMany({ where: { userId: richUser } });
    // Reset wallet balances.
    await prisma.tokenWallet.update({ where: { userId: userBal }, data: { balance: 10_000 } });
    await prisma.tokenWallet.update({ where: { userId: richUser }, data: { balance: 100_000 } });
  });

  it('returns goalThreshold from env with sane default', () => {
    expect(goalThreshold()).toBeGreaterThan(0);
    expect(goalThreshold()).toBeLessThanOrEqual(1);
  });

  it('returns null for non-existent contract', async () => {
    await expect(
      evaluateContract('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow('Contract not found');
  });

  it('returns null for contract not yet past deadline', async () => {
    const future = new Date(Date.now() + 86_400_000); // tomorrow
    const contract = await createContract(userBal, {
      name: 'Future contract',
      pledgeAmountCents: 1000,
      targetScreenTime: 3600,
      startDate: new Date(),
      endDate: future,
    });

    const result = await evaluateContract(contract.id);
    expect(result).toBeNull();
  });

  it('resolves as FORFEITED when user has no screen time data', async () => {
    const past = new Date(Date.now() - 86_400_000); // yesterday
    const contract = await createContract(userBal, {
      name: 'Empty contract',
      pledgeAmountCents: 1000,
      targetScreenTime: 3600,
      startDate: past,
      endDate: new Date(),
    });

    const balanceBefore = (await getBalance(userBal)).balance;

    const result = await evaluateContract(contract.id);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('FORFEITED');

    // Balance should NOT have changed (stake stays debited).
    const balanceAfter = (await getBalance(userBal)).balance;
    expect(balanceAfter).toBe(balanceBefore);

    // Contract row updated.
    const row = await prisma.commitmentContract.findUnique({ where: { id: contract.id } });
    expect(row!.status).toBe('FORFEITED');
    expect(row!.forfeitedAt).not.toBeNull();
  });

  it('resolves as COMPLETED when user met the goal', async () => {
    const now = Date.now();
    const oneDayMs = 86_400_000;
    const target = 3600; // 1 hour focus per day

    // Contract window = exactly 1 day, ended. daysTotal = 1. With 1 day
    // hitting the target, hitRate = 1.0 >= 0.6 → COMPLETED.
    const startDate = new Date(now - oneDayMs);
    const endDate = new Date(now - 1); // 1ms before now, so it's past deadline

    const contract = await createContract(richUser, {
      name: 'Achievable contract',
      pledgeAmountCents: 5000,
      targetScreenTime: target,
      startDate,
      endDate,
    });

    // Upload focus time on each of the 2 UTC days the contract spans.
    await uploadBatch(richUser, [
      {
        appName: 'Safari',
        category: 'PRODUCTIVITY' as AppCategory,
        duration: target + 100,
        startedAt: new Date(startDate.getTime() + 1), // just after start
      },
      {
        appName: 'Safari',
        category: 'PRODUCTIVITY' as AppCategory,
        duration: target + 100,
        startedAt: new Date(endDate.getTime() - 1), // just before end
      },
    ]);

    // Upload enough focus time to hit the target.
    await uploadBatch(richUser, [
      {
        appName: 'Safari',
        category: 'PRODUCTIVITY' as AppCategory,
        duration: target + 100, // beat the target
        startedAt: new Date(),
      },
    ]);

    const balanceBefore = (await getBalance(richUser)).balance;

    const result = await evaluateContract(contract.id);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('COMPLETED');

    // Pledge credited back.
    const balanceAfter = (await getBalance(richUser)).balance;
    expect(balanceAfter).toBe(balanceBefore + 5000);

    // Contract row updated.
    const row = await prisma.commitmentContract.findUnique({ where: { id: contract.id } });
    expect(row!.status).toBe('COMPLETED');
    expect(row!.completedAt).not.toBeNull();

    // Regression: creditTokensTx writes exactly one CONTRACT_PAYOUT ledger
    // row per payout — the old code wrote a second, duplicate row via a
    // separate EARNED-type creditTokens() call plus a manual insert.
    const payoutRows = await prisma.tokenTransaction.count({
      where: { referenceId: contract.id, type: 'CONTRACT_PAYOUT' },
    });
    expect(payoutRows).toBe(1);
  });

  it('is idempotent — second call returns null', async () => {
    const past = new Date(Date.now() - 86_400_000);
    const contract = await createContract(userBal, {
      name: 'Idempotent contract',
      pledgeAmountCents: 1000,
      targetScreenTime: 3600,
      startDate: past,
      endDate: new Date(),
    });

    const first = await evaluateContract(contract.id);
    expect(first).not.toBeNull();

    const second = await evaluateContract(contract.id);
    expect(second).toBeNull();
  });
});
